// PAS: INDEX.PAS (include of ACCESS) – index keys (XString), B-tree pages (XPage/XItem), index
// files (XWFile/XFile), keys (XKey, work keys XWKey) and the record scanner XScan.
// These objects are declared in ACCESS.PAS; they live here with their methods.
// NB: not a directory index module – always import it as './index.ts'.
//
// Page layout (BP7, packed): IsLeaf@0 (1), GreaterPage@1 (4), NItems@5 (2), A@7 (XPageSize-4).
// An XItem is a cursor (page bytes + offset); XPageOfs values are offsets from the page start.
// Item: Nr[1..3] (leaf: RecNr, else number of records below), DownPage: longint (not on leaf),
// then at O (oLeaf=3 / oNotLeaf=7): M = bytes equal with the previous key (not stored), L, L key bytes.
// Only the rightmost page of each non-leaf level has a GreaterPage; leaf pages chain via GreaterPage.
//
// BP7 semantics kept where the FPC port differs (PORTING.md 1):
// * XString.StoreD stores the Real48 (asm: sign flipped to bit 7, exponent and mantissa big-endian);
//   the FPC port moves 6 bytes of a double.
// * XString.StoreA with CompLex translates through CharOrdTab with the Czech 'ch' ligature
//   (ACCESS.PAS TranslateOrd: C followed by H becomes the single ordinal $4A).
// * XString.StoreD/StoreN/StoreF/StoreA skip the value when the key would exceed 255 bytes.

import { ref, fref, getLongint, setLongint, getWord, setWord, BytesToStr, StrToBytes, type Ref, type Pointer } from './pasrt.ts';
import type { float, StringPtr } from './base.ts';
import { BaseVars, SLeadEqu, SetMsgPar, RdWrCache, SaveCache } from './base.ts';
import type {
  FileDPtr, KeyDPtr, KeyFldDPtr, FrmlPtr, FrmlList, KeyInDPtr, LockMode, WKeyDPtr, XStringPtr, LinkDPtr,
  LocVarPtr, XWFilePtr, FieldDPtr,
} from './access.ts';
import {
  AccessVars, KeyInD, Power10, f_Comma, LeftJust, NoCrMode, NoExclMode, EquKFlds, DeletedFlag, SetDeletedFlag,
  ClearDeletedFlag, ReadRec, WriteRec, _ShortS, _R, _B, DelAllDifTFlds, CloseGoExit, XFNotValid, ChangeLMode, Pack,
  FixFromReal, TranslateOrd,
} from './access.ts';
import { RunError, CFileMsg, CFileError, WrLLF10Msg } from './obaseww.ts';
import { RunShortStr, RunReal, RunBool } from './runfrml.ts';
import { CreateIndexFile, ScanSubstWIndex } from './sort.ts';
import { writeReal48 } from '../fand/numbers.ts';

// = ACCESS.XPageSize, XPageOverHead, oLeaf, oNotLeaf (not imported: used by field initialisers)
const XPageSize = 1024;
const XPageOverHead = 7;
const oLeaf = 3;
const oNotLeaf = 7;
/** offset of XPage.A in the page */
const oA = 7;
const _equ = 1;
const _lt = 2;
const _gt = 4;

/** Offset of an item inside an XPage buffer. */
export type XPageOfs = number;

// PAS: INDEX.PAS NegateESDI (asm) – every byte negated (descending key fields); TS: on a byte string
function NegateStr(s: string): string {
  let r = '';
  for (let i = 0; i < s.length; i++) r += String.fromCharCode(~s.charCodeAt(i) & 0xff);
  return r;
}

// PAS: INDEX.PAS XString.StoreReal TabF: array[1..18] – bytes of a fix number
const TabF = [0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 6, 7, 7, 8, 8];

// PAS: ACCESS.PAS XString – an index key being built (S: string255, byte string)
export class XString {
  S = '';

  // PAS: INDEX.PAS XString.Clear
  Clear(): void {
    this.S = '';
  }
  // PAS: INDEX.PAS XString.StoreReal
  StoreReal(R: float, KF: KeyFldDPtr): void {
    const F = KF!.FldD!;
    if (F.Typ === 'R' || F.Typ === 'D') {
      let b = KF!.Descend;
      if (R < 0) {
        b = !b;
        R = -R;
      }
      this.StoreD(R, b);
      return;
    }
    if ((F.Flg & f_Comma) === 0) R = R * Power10[F.M];
    let n = F.L - 1;
    if (F.M > 0) n--;
    n = TabF[n];
    const A = new Uint8Array(20);
    FixFromReal(R, A, n);
    this.StoreF(A, n, KF!.Descend);
  }
  // PAS: INDEX.PAS XString.StoreStr
  StoreStr(V: string, KF: KeyFldDPtr): void {
    const F = KF!.FldD!;
    while (V.length < F.L) {
      if (F.M === LeftJust) V = V + ' ';
      else V = ' ' + V;
    }
    if (F.Typ === 'N') {
      // Pack(V[1],V,L): the digits V[1..] packed over the string itself from V[0]
      const buf = new Uint8Array(V.length + 1);
      buf[0] = V.length & 0xff;
      buf.set(StrToBytes(V), 1);
      Pack(buf.subarray(1), buf, F.L);
      const n = (F.L + 1) >> 1;
      this.StoreN(buf, n, KF!.Descend);
    } else this.StoreA(StrToBytes(V), F.L, KF!.CompLex, KF!.Descend);
  }
  // PAS: INDEX.PAS XString.StoreBool
  StoreBool(B: boolean, KF: KeyFldDPtr): void {
    this.StoreN(Uint8Array.of(B ? 1 : 0), 1, KF!.Descend);
  }
  // PAS: INDEX.PAS XString.StoreKF
  StoreKF(KF: KeyFldDPtr): void {
    const F: FieldDPtr = KF!.FldD;
    switch (F!.FrmlTyp) {
      case 'S':
        this.StoreStr(_ShortS(F), KF);
        break;
      case 'R':
        this.StoreReal(_R(F), KF);
        break;
      case 'B':
        this.StoreBool(_B(F), KF);
        break;
    }
  }
  // PAS: INDEX.PAS XString.PackKF
  PackKF(KF: KeyFldDPtr): void {
    this.Clear();
    while (KF !== null) {
      this.StoreKF(KF);
      KF = KF.Chain;
    }
  }
  // PAS: INDEX.PAS XString.PackFrml
  PackFrml(FL: FrmlList, KF: KeyFldDPtr): boolean {
    this.Clear();
    while (FL !== null) {
      const Z = FL.Frml;
      switch (KF!.FldD!.FrmlTyp) {
        case 'S':
          this.StoreStr(RunShortStr(Z), KF);
          break;
        case 'R':
          this.StoreReal(RunReal(Z), KF);
          break;
        case 'B':
          this.StoreBool(RunBool(Z), KF);
          break;
      }
      KF = KF!.Chain;
      FL = FL.Chain;
    }
    return KF !== null;
  }
  // PAS: INDEX.PAS XString.StoreD (private) – R as Real48 bytes, BP7 layout (the FPC port moves
  // 6 bytes of a double here, which is wrong for existing .X files)
  StoreD(R: float, Descend: boolean): void {
    // BP7 asm: [0]=not sign<<7 | exp>>1, [1]=exp&1<<7 | mant bits 38..32, then the mantissa bytes 4,3,2,1
    if (this.S.length + 6 > 255) return;
    const r = new Uint8Array(6);
    writeReal48(R, r);
    const sign = (r[5] >> 7) & 1;
    const b0 = ((sign ^ 1) << 7) | (r[0] >> 1);
    const b1 = ((r[0] & 1) << 7) | (r[5] & 0x7f);
    let v = String.fromCharCode(b0, b1, r[4], r[3], r[2], r[1]);
    if (Descend) v = NegateStr(v);
    this.S += v;
  }
  // PAS: INDEX.PAS XString.StoreN (private)
  StoreN(N: Uint8Array, Len: number, Descend: boolean): void {
    if (this.S.length + Len > 255) return;
    let v = BytesToStr(N, 0, Len);
    if (Descend) v = NegateStr(v);
    this.S += v;
  }
  // PAS: INDEX.PAS XString.StoreF (private) – the sign bit of the big-endian fix number flipped
  StoreF(F: Uint8Array, Len: number, Descend: boolean): void {
    if (this.S.length + Len > 255) return;
    const buf = F.slice(0, Len);
    buf[0] ^= 0x80;
    let v = BytesToStr(buf, 0, Len);
    if (Descend) v = NegateStr(v);
    this.S += v;
  }
  // PAS: INDEX.PAS XString.StoreA (private) – CompLex: BP7 TranslateOrd incl. the 'ch' ligature
  StoreA(A: Uint8Array, Len: number, CompLex: boolean, Descend: boolean): void {
    const V = CompLex ? BytesToStr(TranslateOrd(A, Len)) : BytesToStr(A, 0, Len); // ACCESS TranslateOrd, dx=0
    let slen = V.length;
    while (slen > 0 && V.charCodeAt(slen - 1) === 0x20) slen--;
    let v = V.slice(0, slen);
    if (slen < V.length) {
      slen++;
      v += '\x1f';
    }
    if (this.S.length + slen > 255) return;
    if (Descend) v = NegateStr(v);
    this.S += v;
  }
}

// PAS: ACCESS.PAS XItem – Nr: array[1..3] (NN: RecNr on leaf, else number of records below),
// DownPage: longint (not on leaf), then at O: M (equal leading bytes), L, L index bytes.
export class XItem {
  /** the page bytes (XPage.Raw) */
  Pg: Uint8Array;
  /** offset of the item in Pg */
  Ofs: XPageOfs;
  constructor(Pg: Uint8Array, Ofs: XPageOfs) {
    this.Pg = Pg;
    this.Ofs = Ofs;
  }
  /** Nr: array[1..3] of byte (a view) – use GetN/PutN */
  get Nr(): Uint8Array {
    return this.Pg.subarray(this.Ofs, this.Ofs + 3);
  }
  get DownPage(): number {
    return getLongint(this.Pg, this.Ofs + 3);
  }
  set DownPage(v: number) {
    setLongint(this.Pg, this.Ofs + 3, v);
  }
  // PAS: INDEX.PAS XItem.GetN
  GetN(): number {
    const p = this.Pg;
    const o = this.Ofs;
    return p[o] | (p[o + 1] << 8) | (p[o + 2] << 16);
  }
  // PAS: INDEX.PAS XItem.PutN
  PutN(N: number): void {
    const p = this.Pg;
    const o = this.Ofs;
    p[o] = N & 0xff;
    p[o + 1] = (N >>> 8) & 0xff;
    p[o + 2] = (N >>> 16) & 0xff;
  }
  // PAS: INDEX.PAS XItem.GetM
  GetM(O: number): number {
    return this.Pg[this.Ofs + O];
  }
  // PAS: INDEX.PAS XItem.PutM
  PutM(O: number, M: number): void {
    this.Pg[this.Ofs + O] = M & 0xff;
  }
  // PAS: INDEX.PAS XItem.GetL
  GetL(O: number): number {
    return this.Pg[this.Ofs + O + 1];
  }
  // PAS: INDEX.PAS XItem.PutL
  PutL(O: number, L: number): void {
    this.Pg[this.Ofs + O + 1] = L & 0xff;
  }
  // PAS: INDEX.PAS XItem.Next
  Next(O: number): XItem {
    return new XItem(this.Pg, this.Ofs + O + this.Pg[this.Ofs + O + 1] + 2);
  }
  // PAS: INDEX.PAS XItem.UpdStr – rebuilds the key in S from the previous one; returns the next item offset
  UpdStr(O: number, S: Ref<string>): XPageOfs {
    const m = this.Pg[this.Ofs + O];
    const l = this.Pg[this.Ofs + O + 1];
    let s = S.v;
    if (s.length < m) s = s.padEnd(m, '\0'); // Pascal: whatever the string buffer holds
    S.v = s.slice(0, m) + BytesToStr(this.Pg, this.Ofs + O + 2, l);
    return this.Ofs + O + 2 + l;
  }
}
export type XItemPtr = XItem | null;

// PAS: ACCESS.PAS XPage – one B-tree page
export class XPage {
  /** RdPage/WrPage transfer the first XPageSize bytes; the rest is room for a temporary
   *  overflow (Pascal allocates 2*XPageSize where pages are inserted into or merged) */
  Raw = new Uint8Array(2 * XPageSize);
  get IsLeaf(): boolean {
    return this.Raw[0] !== 0;
  }
  set IsLeaf(v: boolean) {
    this.Raw[0] = v ? 1 : 0;
  }
  /** or free pages chaining */
  get GreaterPage(): number {
    return getLongint(this.Raw, 1);
  }
  set GreaterPage(v: number) {
    setLongint(this.Raw, 1, v);
  }
  get NItems(): number {
    return getWord(this.Raw, 5);
  }
  set NItems(v: number) {
    setWord(this.Raw, 5, v);
  }
  /** item array (a view; offsets of items are page offsets = 7 + index into A) */
  get A(): Uint8Array {
    return this.Raw.subarray(7);
  }

  // PAS: INDEX.PAS XPage.Off
  Off(): number {
    return this.IsLeaf ? oLeaf : oNotLeaf;
  }
  // PAS: INDEX.PAS XPage.XI
  XI(I: number): XItem {
    const o = this.Off();
    const r = this.Raw;
    let xofs = oA;
    while (I > 1) {
      xofs += o + r[xofs + o + 1] + 2;
      I--;
    }
    return new XItem(r, xofs);
  }
  // PAS: INDEX.PAS XPage.EndOff
  EndOff(): XPageOfs {
    return this.XI(this.NItems + 1).Ofs;
  }
  // PAS: INDEX.PAS XPage.Underflow
  Underflow(): boolean {
    return this.EndOff() - oA < (XPageSize - XPageOverHead) >> 1;
  }
  // PAS: INDEX.PAS XPage.Overflow
  Overflow(): boolean {
    return this.EndOff() > XPageSize;
  }
  // PAS: INDEX.PAS XPage.StrI
  StrI(I: number): string {
    if (I > this.NItems) return '';
    const o = this.Off();
    const s = ref('');
    let xofs = oA;
    for (let j = 1; j <= I; j++) xofs = new XItem(this.Raw, xofs).UpdStr(o, s);
    return s.v;
  }
  // PAS: INDEX.PAS XPage.SumN
  SumN(): number {
    if (this.IsLeaf) return this.NItems;
    let n = 0;
    let x = new XItem(this.Raw, oA);
    const o = this.Off();
    for (let i = 1; i <= this.NItems; i++) {
      n += x.GetN();
      x = x.Next(o);
    }
    return n;
  }
  // PAS: INDEX.PAS XPage.Insert – SS: the key string; XX receives the new item
  Insert(I: number, SS: string, XX: Ref<XItemPtr>): void {
    const S = SS;
    const r = this.Raw;
    const o = this.Off();
    const oE = this.EndOff();
    this.NItems = this.NItems + 1;
    const x = this.XI(I);
    let m = 0;
    if (I > 1) m = SLeadEqu(this.StrI(I - 1), S);
    const l = S.length - m;
    let sz = o + 2 + l;
    if (I < this.NItems) {
      let x2ofs = x.Ofs;
      const m2 = SLeadEqu(this.StrI(I), S);
      const d = m2 - x.GetM(o);
      if (d > 0) {
        const l2 = x.GetL(o);
        x2ofs += d;
        r.copyWithin(x2ofs, x.Ofs, x.Ofs + o);
        const x2 = new XItem(r, x2ofs);
        x2.PutM(o, m2);
        x2.PutL(o, l2 - d);
        sz -= d;
      }
      r.copyWithin(x2ofs + sz, x2ofs, oE);
    }
    XX.v = new XItem(r, x.Ofs);
    x.PutM(o, m);
    x.PutL(o, l);
    const xofs = x.Ofs + o + 2;
    for (let k = 0; k < l; k++) r[xofs + k] = S.charCodeAt(m + k);
  }
  // PAS: INDEX.PAS XPage.InsDownIndex
  InsDownIndex(I: number, Page: number, P: XPagePtr): void {
    const s = P!.StrI(P!.NItems);
    const x = ref<XItemPtr>(null);
    this.Insert(I, s, x);
    x.v!.PutN(P!.SumN());
    x.v!.DownPage = Page;
  }
  // PAS: INDEX.PAS XPage.Delete
  Delete(I: number): void {
    const r = this.Raw;
    const o = this.Off();
    const oE = this.EndOff();
    let x = this.XI(I);
    if (I < this.NItems) {
      let x2 = x.Next(o);
      const d = x2.GetM(o) - x.GetM(o);
      if (d <= 0) r.copyWithin(x.Ofs, x2.Ofs, oE);
      else {
        r.copyWithin(x.Ofs, x2.Ofs, x2.Ofs + o);
        x.PutL(o, x2.GetL(o) + d);
        const x1ofs = x.Ofs + o + 2 + d;
        const x2ofs = x2.Ofs + o + 2;
        r.copyWithin(x1ofs, x2ofs, oE);
      }
      x = this.XI(this.NItems);
    }
    r.fill(0, x.Ofs, oE);
    this.NItems = this.NItems - 1;
  }
  // PAS: INDEX.PAS XPage.AddPage
  AddPage(P: XPagePtr): void {
    this.GreaterPage = P!.GreaterPage;
    if (P!.NItems === 0) return;
    const xE = this.XI(this.NItems + 1).Ofs;
    const oE = P!.EndOff();
    const o = this.Off();
    let xofs = oA; // in P
    if (this.NItems > 0) {
      const m = SLeadEqu(this.StrI(this.NItems), P!.StrI(1));
      if (m > 0) {
        const pr = P!.Raw;
        const l = new XItem(pr, xofs).GetL(o) - m;
        const x1ofs = xofs;
        xofs += m;
        pr.copyWithin(xofs, x1ofs, x1ofs + o);
        const x = new XItem(pr, xofs);
        x.PutM(o, m);
        x.PutL(o, l);
      }
    }
    this.Raw.set(P!.Raw.subarray(xofs, oE), xE);
    this.NItems = this.NItems + P!.NItems;
  }
  // PAS: INDEX.PAS XPage.SplitPage – moves the first half of the items to P
  SplitPage(P: XPagePtr, ThisPage: number): void {
    const r = this.Raw;
    const o = this.Off();
    let xofs = oA;
    let x1ofs = oA;
    const oE = this.EndOff();
    let n = 0;
    while (xofs - oA < oE - xofs + r[xofs + o]) {
      xofs += o + r[xofs + o + 1] + 2;
      n++;
    }
    P!.Raw.fill(0, 0, XPageSize);
    P!.Raw.set(r.subarray(oA, xofs), oA);
    // s:=@A[o+1] (a string over the L byte): the first remaining item gets its whole key
    const s = this.StrI(n + 1);
    r[oA + o + 1] = s.length;
    for (let k = 0; k < s.length; k++) r[oA + o + 2 + k] = s.charCodeAt(k);
    r.copyWithin(x1ofs, xofs, xofs + o);
    r[x1ofs + o] = 0;
    x1ofs += o + r[x1ofs + o + 1] + 2;
    xofs += o + r[xofs + o + 1] + 2;
    r.copyWithin(x1ofs, xofs, oE);
    P!.NItems = n;
    this.NItems = this.NItems - n;
    xofs = this.EndOff();
    r.fill(0, xofs, oE);
    if (this.IsLeaf) P!.GreaterPage = ThisPage;
    else P!.GreaterPage = 0;
    P!.IsLeaf = this.IsLeaf;
  }
}
export type XPagePtr = XPage | null;

// PAS: ACCESS.PAS XWFile – an index file (also the work index file XWork)
export class XWFile {
  UpdLockCnt = 0;
  Handle = 0xff;
  FreeRoot = 0;
  MaxPage = 0;

  // PAS: INDEX.PAS XWFile.Err
  Err(N: number): never {
    if (this === AccessVars.XWork) {
      SetMsgPar(BaseVars.FandWorkXName);
      RunError(N);
    }
    AccessVars.CFile!.XF!.SetNotValid();
    CFileMsg(N, 'X');
    CloseGoExit();
  }
  // PAS: INDEX.PAS XWFile.TestErr
  TestErr(): void {
    if (BaseVars.HandleError !== 0) this.Err(700 + BaseVars.HandleError);
  }
  // PAS: INDEX.PAS XWFile.UsedFileSize
  UsedFileSize(): number {
    return (this.MaxPage + 1) * 2 ** 10; // shl XPageShft
  }
  // PAS: INDEX.PAS XWFile.NotCached
  NotCached(): boolean {
    return this !== AccessVars.XWork && AccessVars.CFile!.NotCached();
  }
  // PAS: INDEX.PAS XWFile.RdPage
  RdPage(P: XPagePtr, N: number): void {
    if (N === 0 || N > this.MaxPage) this.Err(831);
    RdWrCache(true, this.Handle, this.NotCached(), N * 2 ** 10, XPageSize, P!.Raw);
  }
  // PAS: INDEX.PAS XWFile.WrPage
  WrPage(P: XPagePtr, N: number): void {
    if (this.UpdLockCnt > 0) this.Err(645);
    RdWrCache(false, this.Handle, this.NotCached(), N * 2 ** 10, XPageSize, P!.Raw);
  }
  // PAS: INDEX.PAS XWFile.NewPage
  NewPage(P: XPagePtr): number {
    let result: number;
    if (this.FreeRoot !== 0) {
      result = this.FreeRoot;
      this.RdPage(P, this.FreeRoot);
      this.FreeRoot = P!.GreaterPage;
    } else {
      this.MaxPage++;
      if (this.MaxPage > 0x1fffff) this.Err(887);
      result = this.MaxPage;
    }
    P!.Raw.fill(0, 0, XPageSize);
    return result;
  }
  // PAS: INDEX.PAS XWFile.ReleasePage
  ReleasePage(P: XPagePtr, N: number): void {
    P!.Raw.fill(0, 0, XPageSize);
    P!.GreaterPage = this.FreeRoot;
    this.FreeRoot = N;
    this.WrPage(P, N);
  }
}

// PAS: ACCESS.PAS XFile – the .X index file of a FileD
export class XFile extends XWFile {
  NRecs = 0; // FreeRoot..NrKeys read/written by 1 instr.
  NRecsAbs = 0;
  NotValid = false;
  NrKeys = 0;
  NoCreate = false;
  FirstDupl = false;

  // PAS: INDEX.PAS XFile.SetEmpty
  SetEmpty(): void {
    const p = new XPage();
    this.WrPage(p, 0);
    p.IsLeaf = true;
    this.FreeRoot = 0;
    this.NRecs = 0;
    let k = AccessVars.CFile!.Keys;
    while (k !== null) {
      const n = k.IndexRoot;
      this.MaxPage = n;
      this.WrPage(p, n);
      k = k.Chain;
    }
    this.WrPrefix();
  }
  // PAS: INDEX.PAS XFile.RdPrefix – FreeRoot, MaxPage, NRecs, NRecsAbs, NotValid, NrKeys at 2
  RdPrefix(): void {
    const b = new Uint8Array(18);
    RdWrCache(true, this.Handle, this.NotCached(), 2, 18, b);
    this.FreeRoot = getLongint(b, 0);
    this.MaxPage = getLongint(b, 4);
    this.NRecs = getLongint(b, 8);
    this.NRecsAbs = getLongint(b, 12);
    this.NotValid = b[16] !== 0;
    this.NrKeys = b[17];
  }
  // PAS: INDEX.PAS XFile.WrPrefix – Signum $04FF, then the 18 bytes of RdPrefix
  WrPrefix(): void {
    RdWrCache(false, this.Handle, this.NotCached(), 0, 2, Uint8Array.of(0xff, 0x04));
    this.NRecsAbs = AccessVars.CFile!.NRecs;
    this.NrKeys = AccessVars.CFile!.GetNrKeys() & 0xff;
    const b = new Uint8Array(18);
    setLongint(b, 0, this.FreeRoot);
    setLongint(b, 4, this.MaxPage);
    setLongint(b, 8, this.NRecs);
    setLongint(b, 12, this.NRecsAbs);
    b[16] = this.NotValid ? 1 : 0;
    b[17] = this.NrKeys;
    RdWrCache(false, this.Handle, this.NotCached(), 2, 18, b);
  }
  // PAS: INDEX.PAS XFile.SetNotValid
  SetNotValid(): void {
    this.NotValid = true;
    this.MaxPage = 0;
    this.WrPrefix();
    SaveCache(0);
  }
}

// PAS: ACCESS.PAS XKey – a key (index) of a file
export class XKey {
  Chain: KeyDPtr = null;
  KFlds: KeyFldDPtr = null;
  Intervaltest = false;
  Duplic = false;
  InWork = false;
  IndexRoot = 0;
  IndexLen = 0;
  NR = 0; // used only by XWKey
  Alias: StringPtr = null;

  // PAS: INDEX.PAS XKey.XF – the file of the index: CFile^.XF or XWork
  XF(): XWFilePtr {
    if (this.InWork) return AccessVars.XWork;
    return AccessVars.CFile!.XF;
  }
  // PAS: INDEX.PAS XKey.NRecs
  NRecs(): number {
    if (this.InWork) return this.NR;
    return AccessVars.CFile!.XF!.NRecs;
  }
  // PAS: INDEX.PAS XKey.Search
  Search(XX: XString, AfterEqu: boolean, RecNr: Ref<number>): boolean {
    const av = AccessVars;
    const XPath = av.XPath;
    const xf = this.XF()!;
    const p = new XPage();
    av.XPathN = 1;
    let page = this.IndexRoot;
    AfterEqu = AfterEqu && this.Duplic;
    for (;;) {
      XPath[av.XPathN].Page = page;
      xf.RdPage(p, page);
      let x = new XItem(p.Raw, oA);
      const o = p.Off();
      const nItems = p.NItems;
      if (nItems === 0) {
        RecNr.v = av.CFile!.NRecs + 1;
        XPath[1].I = 1;
        return false;
      }
      // the BP7 asm (FPC: Pascal): dx = position of the first byte where XX > the previous key
      let iItem = 1;
      let dx = 1;
      let result = _gt;
      const xxlen = XX.S.length;
      const pg = p.Raw;
      for (;;) {
        const m_val = pg[x.Ofs + o];
        const l_val = pg[x.Ofs + o + 1];
        if (dx > m_val) {
          let rest = xxlen - m_val;
          if (rest < 0) rest = 0;
          const cx = l_val < rest ? l_val : rest;
          let k = 0;
          let res = 0;
          while (k < cx) {
            const c1 = XX.S.charCodeAt(m_val + k);
            const c2 = pg[x.Ofs + o + 2 + k];
            if (c1 !== c2) {
              res = c1 < c2 ? -1 : 1;
              break;
            }
            k++;
          }
          if (res < 0) {
            result = _lt;
            break;
          }
          if (res > 0) dx = m_val + k + 1;
          else if (rest < l_val) {
            result = _lt;
            break;
          } else if (rest > l_val) dx = m_val + cx + 1;
          else if (!AfterEqu) {
            result = _equ;
            break;
          } else dx = m_val + cx + 1;
        }
        if (iItem === nItems) {
          result = _gt;
          iItem++;
          break;
        }
        iItem++;
        x = x.Next(o);
      }
      XPath[av.XPathN].I = iItem;
      if (p.IsLeaf) {
        if (iItem > nItems) RecNr.v = av.CFile!.NRecs + 1;
        else RecNr.v = x.GetN();
        if (result === _equ) {
          if (RecNr.v === 0 || RecNr.v > av.CFile!.NRecs) xf.Err(833);
          return true;
        }
        return false;
      }
      if (iItem > nItems) page = p.GreaterPage;
      else page = x.DownPage;
      av.XPathN++;
    }
  }
  // PAS: INDEX.PAS XKey.SearchIntvl
  SearchIntvl(XX: XString, AfterEqu: boolean, RecNr: Ref<number>): boolean {
    return this.Search(XX, AfterEqu, RecNr) || (this.Intervaltest && RecNr.v <= AccessVars.CFile!.NRecs);
  }
  // PAS: INDEX.PAS XKey.PathToNr
  PathToNr(): number {
    const av = AccessVars;
    const xf = this.XF()!;
    const p = new XPage();
    let n = 0;
    for (let j = 1; j <= av.XPathN - 1; j++) {
      xf.RdPage(p, av.XPath[j].Page);
      let x = new XItem(p.Raw, oA);
      for (let i = 1; i <= av.XPath[j].I - 1; i++) {
        n += x.GetN();
        x = x.Next(oNotLeaf);
      }
    }
    n += av.XPath[av.XPathN].I;
    if (n > this.NRecs() + 1) xf.Err(834);
    return n;
  }
  // PAS: INDEX.PAS XKey.NrToPath
  NrToPath(I: number): void {
    const av = AccessVars;
    const xf = this.XF()!;
    const p = new XPage();
    let page = this.IndexRoot;
    av.XPathN = 0;
    for (;;) {
      xf.RdPage(p, page);
      av.XPathN++;
      av.XPath[av.XPathN].Page = page;
      if (p.IsLeaf) {
        if (I > p.NItems + 1) xf.Err(837);
        av.XPath[av.XPathN].I = I;
        return;
      }
      let x = new XItem(p.Raw, oA);
      let found = false;
      for (let j = 1; j <= p.NItems; j++) {
        if (I <= x.GetN()) {
          av.XPath[av.XPathN].I = j;
          page = x.DownPage;
          found = true;
          break;
        }
        I -= x.GetN();
        x = x.Next(oNotLeaf);
      }
      if (found) continue;
      av.XPath[av.XPathN].I = p.NItems + 1;
      page = p.GreaterPage;
    }
  }
  // PAS: INDEX.PAS XKey.PathToRecNr
  PathToRecNr(): number {
    const av = AccessVars;
    const xf = this.XF()!;
    const p = new XPage();
    const xp = av.XPath[av.XPathN];
    xf.RdPage(p, xp.Page);
    const recnr = p.XI(xp.I).GetN();
    if (recnr === 0 || recnr > av.CFile!.NRecs) xf.Err(835);
    return recnr;
  }
  // PAS: INDEX.PAS XKey.RecNrToPath
  RecNrToPath(XX: XString, RecNr: number): boolean {
    const av = AccessVars;
    const xf = this.XF()!;
    // the path to the next leaf item (Pascal: nested function with gotos)
    const IncPath = (J: number, Pg: Ref<number>): boolean => {
      const p = new XPage();
      if (J === 0) return false;
      const xp = av.XPath[J]; // with XPath[J]
      const Page = fref(xp, 'Page');
      for (;;) {
        xf.RdPage(p, xp.Page);
        if (xp.I > p.NItems) {
          if (IncPath(J - 1, Page)) {
            xp.I = 0;
            continue;
          }
          return false;
        }
        xp.I++;
        if (xp.I > p.NItems) {
          if (p.GreaterPage === 0) {
            xp.I = 0;
            if (IncPath(J - 1, Page)) continue;
            return false;
          }
          Pg.v = p.GreaterPage;
        } else Pg.v = p.XI(xp.I).DownPage;
        return true;
      }
    };
    XX.PackKF(this.KFlds);
    this.Search(XX, false, ref(0));
    const p = new XPage();
    const xp = av.XPath[av.XPathN]; // with XPath[XPathN]
    // 1:
    for (;;) {
      xf.RdPage(p, xp.Page);
      let x = p.XI(xp.I);
      if (p.StrI(xp.I) !== XX.S) return false;
      // 2:
      for (;;) {
        if (x.GetN() === RecNr) return true;
        xp.I++;
        if (xp.I > p.NItems) {
          if (IncPath(av.XPathN - 1, fref(xp, 'Page'))) {
            xp.I = 1;
            break; // goto 1
          }
          return false;
        }
        x = x.Next(oLeaf);
        if (x.GetL(oLeaf) !== 0) return false;
      }
    }
  }
  // PAS: INDEX.PAS XKey.NrToRecNr
  NrToRecNr(I: number): number {
    this.NrToPath(I);
    return this.PathToRecNr();
  }
  // PAS: INDEX.PAS XKey.NrToStr
  NrToStr(I: number): string {
    const av = AccessVars;
    const p = new XPage();
    this.NrToPath(I);
    const xp = av.XPath[av.XPathN];
    this.XF()!.RdPage(p, xp.Page);
    return p.StrI(xp.I);
  }
  // PAS: INDEX.PAS XKey.RecNrToNr
  RecNrToNr(RecNr: number): number {
    const x = new XString();
    if (this.RecNrToPath(x, RecNr)) return this.PathToNr();
    return 0;
  }
  // PAS: INDEX.PAS XKey.FindNr
  FindNr(X: XString, IndexNr: Ref<number>): boolean {
    const result = this.Search(X, false, ref(0));
    IndexNr.v = this.PathToNr();
    return result;
  }
  // PAS: INDEX.PAS XKey.InsertOnPath
  InsertOnPath(XX: XString, RecNr: number): void {
    const av = AccessVars;
    const XPath = av.XPath;
    const xf = this.XF()!;
    const InsertItem = (XX: XString, P: XPage, UpP: XPage, Page: number, I: number, X: Ref<XItemPtr>, UpPage: Ref<number>): void => {
      P.Insert(I, XX.S, X);
      UpPage.v = 0;
      if (P.Overflow()) {
        UpPage.v = xf.NewPage(UpP);
        P.SplitPage(UpP, Page);
        if (I <= UpP.NItems) X.v = UpP.XI(I);
        else X.v = P.XI(I - UpP.NItems);
        XX.S = UpP.StrI(UpP.NItems);
      }
    };
    const ChainPrevLeaf = (P: XPage, N: number): void => {
      for (let j = av.XPathN - 1; j >= 1; j--) {
        if (XPath[j].I > 1) {
          xf.RdPage(P, XPath[j].Page);
          let i = XPath[j].I - 1;
          for (;;) {
            const page = P.XI(i).DownPage;
            xf.RdPage(P, page);
            if (P.IsLeaf) {
              P.GreaterPage = N;
              xf.WrPage(P, page);
              return;
            }
            i = P.NItems;
          }
        }
      }
    };
    const p = new XPage();
    const p1 = new XPage();
    const upp = new XPage();
    const x = ref<XItemPtr>(null);
    const uppage = ref(0);
    let page = 0;
    let upsum = 0;
    for (let j = av.XPathN; j >= 1; j--) {
      page = XPath[j].Page;
      xf.RdPage(p, page);
      const i = XPath[j].I;
      if (p.IsLeaf) {
        InsertItem(XX, p, upp, page, i, x, uppage);
        x.v!.PutN(RecNr);
      } else {
        if (i <= p.NItems) {
          x.v = p.XI(i);
          let n = x.v.GetN() + 1;
          if (uppage.v !== 0) n -= upsum;
          x.v.PutN(n);
        }
        if (uppage.v !== 0) {
          const downpage = uppage.v;
          InsertItem(XX, p, upp, page, i, x, uppage);
          x.v!.DownPage = downpage;
          x.v!.PutN(upsum);
        }
      }
      xf.WrPage(p, page);
      if (uppage.v !== 0) {
        xf.WrPage(upp, uppage.v);
        upsum = upp.SumN();
        if (upp.IsLeaf) ChainPrevLeaf(p1, uppage.v);
      }
    }
    if (uppage.v !== 0) {
      const page1 = xf.NewPage(p1);
      p1.GreaterPage = page1;
      p1.InsDownIndex(1, uppage.v, upp);
      xf.WrPage(p, page1);
      xf.WrPage(p1, page);
      if (upp.IsLeaf) {
        upp.GreaterPage = page1;
        xf.WrPage(upp, uppage.v);
      }
    }
  }
  // PAS: INDEX.PAS XKey.Insert
  Insert(RecNr: number, Try: boolean): boolean {
    const x = new XString();
    x.PackKF(this.KFlds);
    if (this.Search(x, true, ref(0))) {
      if (Try) return false;
      XFNotValid();
      CFileError(822);
    }
    this.InsertOnPath(x, RecNr);
    return true;
  }
  // PAS: INDEX.PAS XKey.DeleteOnPath
  DeleteOnPath(): void {
    const av = AccessVars;
    const xf = this.XF()!;
    const BalancePages = (P1: XPage, P2: XPage): boolean => {
      const n = P1.GreaterPage;
      P1.AddPage(P2);
      const sz = P1.EndOff();
      if (sz <= XPageSize) return true;
      P2.Raw.set(P1.Raw.subarray(0, sz));
      P2.SplitPage(P1, n);
      return false;
    };
    const XIDown = (P: XPage, P1: XPage, I: number): number => {
      let Page1: number;
      if (I > P.NItems) Page1 = P.GreaterPage;
      else Page1 = P.XI(I).DownPage;
      xf.RdPage(P1, Page1);
      return Page1;
    };
    let p = new XPage();
    const p1 = new XPage();
    let upp = new XPage(); // Pascal: p2 with upp absolute p2
    let uppage = 0;
    let page = 0;
    let page1 = 0;
    for (let j = av.XPathN; j >= 1; j--) {
      page = av.XPath[j].Page;
      xf.RdPage(p, page);
      let i = av.XPath[j].I;
      if (p.IsLeaf) p.Delete(i);
      else if (upp.Underflow()) {
        xf.WrPage(upp, uppage);
        let i1 = i - 1;
        let i2 = i;
        if (i1 === 0) {
          i1 = 1;
          i2 = 2;
        }
        page1 = XIDown(p, p1, i1);
        const page2 = XIDown(p, upp, i2); // p2
        const released = BalancePages(p1, upp);
        xf.WrPage(p1, page1);
        p.Delete(i1);
        if (released) {
          xf.ReleasePage(upp, page2);
          if (i1 > p.NItems) p.GreaterPage = page1;
          else {
            p.InsDownIndex(i1, page1, p1);
            p.Delete(i2);
          }
        } else {
          xf.WrPage(upp, page2);
          p.InsDownIndex(i1, page1, p1);
          if (i2 <= p.NItems) {
            p.Delete(i2);
            p.InsDownIndex(i2, page2, upp);
          }
        }
      } else {
        if (upp.Overflow()) {
          page1 = xf.NewPage(p1);
          upp.SplitPage(p1, uppage);
          xf.WrPage(p1, page1);
          p.InsDownIndex(i, page1, p1);
          i++;
        }
        xf.WrPage(upp, uppage);
        if (i <= p.NItems) {
          p.Delete(i);
          p.InsDownIndex(i, uppage, upp);
        }
      }
      uppage = page;
      const px = upp;
      upp = p;
      p = px;
    }
    if (upp.Overflow()) {
      page1 = xf.NewPage(p1);
      upp.SplitPage(p1, uppage);
      page = xf.NewPage(p);
      p.GreaterPage = page;
      p.InsDownIndex(1, page1, p1);
      xf.WrPage(p1, page1);
      xf.WrPage(p, uppage);
      xf.WrPage(upp, page);
    } else {
      page1 = upp.GreaterPage;
      if (upp.NItems === 0 && page1 > 0) {
        xf.RdPage(p1, page1);
        upp.Raw.set(p1.Raw.subarray(0, XPageSize));
        xf.ReleasePage(p1, page1);
      }
      xf.WrPage(upp, uppage);
    }
  }
  // PAS: INDEX.PAS XKey.Delete
  Delete(RecNr: number): boolean {
    const xx = new XString();
    const b = this.RecNrToPath(xx, RecNr);
    if (b) this.DeleteOnPath();
    return b;
  }
}

// PAS: ACCESS.PAS XWKey – a work index (in XWork): local index variables, subsets
export class XWKey extends XKey {
  // PAS: INDEX.PAS XWKey.Open
  Open(KF: KeyFldDPtr, Dupl: boolean, Intvl: boolean): void {
    this.KFlds = KF;
    this.Duplic = Dupl;
    this.InWork = true;
    this.Intervaltest = Intvl;
    this.NR = 0;
    const p = new XPage();
    this.IndexRoot = this.XF()!.NewPage(p);
    p.IsLeaf = true;
    this.XF()!.WrPage(p, this.IndexRoot);
    this.IndexLen = 0;
    while (KF !== null) {
      this.IndexLen = (this.IndexLen + KF.FldD!.NBytes) & 0xff;
      KF = KF.Chain;
    }
  }
  // PAS: INDEX.PAS XWKey.Close
  Close(): void {
    this.ReleaseTree(this.IndexRoot, true);
    this.IndexRoot = 0;
  }
  // PAS: INDEX.PAS XWKey.Release
  Release(): void {
    this.ReleaseTree(this.IndexRoot, false);
    this.NR = 0;
  }
  // PAS: INDEX.PAS XWKey.ReleaseTree
  ReleaseTree(Page: number, IsClose: boolean): void {
    const xf = this.XF()!;
    if (Page === 0 || Page > xf.MaxPage) return;
    const p = new XPage();
    xf.RdPage(p, Page);
    if (!p.IsLeaf) {
      const n = p.NItems;
      for (let i = 1; i <= n; i++) {
        this.ReleaseTree(p.XI(i).DownPage, IsClose);
        xf.RdPage(p, Page);
      }
      if (p.GreaterPage !== 0) this.ReleaseTree(p.GreaterPage, IsClose);
    }
    if (Page !== this.IndexRoot || IsClose) xf.ReleasePage(p, Page);
    else {
      p.Raw.fill(0, 0, XPageSize);
      p.IsLeaf = true;
      xf.WrPage(p, Page);
    }
  }
  // PAS: INDEX.PAS XWKey.OneRecIdx
  OneRecIdx(KF: KeyFldDPtr, N: number): void {
    this.Open(KF, true, false);
    this.Insert(N, true);
    this.NR++;
  }
  // PAS: INDEX.PAS XWKey.InsertAtNr
  InsertAtNr(I: number, RecNr: number): void {
    const x = new XString();
    x.PackKF(this.KFlds);
    this.NR++;
    this.NrToPath(I);
    this.InsertOnPath(x, RecNr);
  }
  // PAS: INDEX.PAS XWKey.InsertGetNr
  InsertGetNr(RecNr: number): number {
    const x = new XString();
    this.NR++;
    x.PackKF(this.KFlds);
    this.Search(x, true, ref(0));
    const result = this.PathToNr();
    this.InsertOnPath(x, RecNr);
    return result;
  }
  // PAS: INDEX.PAS XWKey.DeleteAtNr
  DeleteAtNr(I: number): void {
    this.NrToPath(I);
    this.DeleteOnPath();
    this.NR--;
  }
  // PAS: INDEX.PAS XWKey.AddToRecNr
  AddToRecNr(RecNr: number, Dif: number): void {
    if (this.NRecs() === 0) return;
    this.NrToPath(1);
    const av = AccessVars;
    const xf = this.XF()!;
    const p = new XPage();
    let pg = av.XPath[av.XPathN].Page;
    let j = av.XPath[av.XPathN].I;
    do {
      xf.RdPage(p, pg);
      let n = p.NItems - j + 1;
      let x = p.XI(j);
      while (n > 0) {
        const nn = x.GetN();
        if (nn >= RecNr) x.PutN(nn + Dif);
        x = x.Next(oLeaf);
        n--;
      }
      xf.WrPage(p, pg);
      pg = p.GreaterPage;
      j = 1;
    } while (pg !== 0);
  }
}

// PAS: INDEX.PAS AddFFs – pads the key to IndexLen+1 with $FF (upper bound of a key prefix)
function AddFFs(K: KeyDPtr, s: Ref<string>): void {
  const l = Math.min(K!.IndexLen + 1, 255);
  let v = s.v.slice(0, l);
  while (v.length < l) v += '\xff';
  s.v = v;
}

// PAS: INDEX.PAS CompKIFrml – X1/X2 of the key intervals from their formulas
function CompKIFrml(K: KeyDPtr, KI: KeyInDPtr, AddFF: boolean): void {
  const x = new XString();
  while (KI !== null) {
    x.PackFrml(KI.FL1, K!.KFlds);
    KI.X1 = x.S;
    if (KI.FL2 !== null) x.PackFrml(KI.FL2, K!.KFlds);
    if (AddFF) AddFFs(K, fref(x, 'S'));
    KI.X2 = x.S;
    KI = KI.Chain;
  }
}

// PAS: ACCESS.PAS XScan = object(TObject) – iterates the records of a file (all, by key,
// by key intervals, owner records, work index, local record var). Construct with
// `new XScan().Init(FD, Key, KIRoot, WithT)`; Pascal's private fields are plain fields here.
// Kind: 0 all records, 1 by key, 2 key intervals / owner, 3,4 SQL (not ported), 5 local record var.
export class XScan {
  FD: FileDPtr = null;
  Key: KeyDPtr = null;
  Bool: FrmlPtr = null;
  Kind = 0;
  NRecs = 0;
  IRec = 0;
  RecNr = 0;
  hasSQLFilter = false;
  EOF = false;
  // private in Pascal
  KIRoot: KeyInDPtr = null;
  OwnerLV: LocVarPtr = null;
  SK: KeyFldDPtr = null;
  X: XItemPtr = null;
  P: XPagePtr = null;
  NOnPg = 0;
  KI: KeyInDPtr = null;
  NOfKI = 0;
  iOKey = 0;
  TempWX = false;
  NotFrst = false;
  withT = false;
  Strm: Pointer = null; // SQLStreamPtr or LVRecPtr

  // PAS: INDEX.PAS XScan.Init (constructor)
  Init(aFD: FileDPtr, aKey: KeyDPtr, aKIRoot: KeyInDPtr, aWithT: boolean): this {
    this.FD = aFD;
    this.Key = aKey;
    this.KIRoot = aKIRoot;
    this.withT = aWithT;
    if (aKey !== null) {
      this.P = new XPage();
      this.Kind = 1;
      if (aKIRoot !== null) this.Kind = 2;
    }
    return this;
  }
  // PAS: DRIVERS.PAS TObject.Done (destructor)
  Done(): void {}
  // PAS: INDEX.PAS XScan.Reset
  Reset(ABool: FrmlPtr, SQLFilter: boolean): void {
    const av = AccessVars;
    av.CFile = this.FD;
    this.Bool = ABool;
    if (SQLFilter) {
      if (av.CFile!.IsSQLFile) this.hasSQLFilter = true;
      else this.Bool = null;
    }
    switch (this.Kind) {
      case 0:
        this.NRecs = av.CFile!.NRecs;
        break;
      case 1:
      case 3:
        if (!this.Key!.InWork) TestXFExist();
        this.NRecs = this.Key!.NRecs();
        break;
      case 2: {
        if (!this.Key!.InWork) TestXFExist();
        CompKIFrml(this.Key, this.KIRoot, true);
        this.NRecs = 0;
        let k = this.KIRoot;
        while (k !== null) {
          const x1 = new XString();
          x1.S = k.X1 ?? '';
          this.Key!.FindNr(x1, fref(k, 'XNrBeg'));
          const x2 = new XString();
          x2.S = k.X2 ?? '';
          const n = ref(0);
          const b = this.Key!.FindNr(x2, n);
          k.N = 0;
          if (n.v >= k.XNrBeg) k.N = n.v - k.XNrBeg + (b ? 1 : 0);
          this.NRecs += k.N;
          k = k.Chain;
        }
        break;
      }
    }
    this.SeekRec(0);
  }
  // PAS: INDEX.PAS XScan.ResetSort
  ResetSort(aSK: KeyFldDPtr, BoolZ: Ref<FrmlPtr>, OldMd: LockMode, SQLFilter: boolean): void {
    if (this.Kind === 4) {
      this.SK = aSK;
      if (SQLFilter) {
        this.Reset(BoolZ.v, true);
        BoolZ.v = null;
      } else this.Reset(null, false);
      return;
    }
    if (aSK !== null) {
      this.Reset(BoolZ.v, false);
      ScanSubstWIndex(this, aSK, 'S');
      BoolZ.v = null;
    } else this.Reset(null, false);
    const cf = AccessVars.CFile!;
    if (cf.NotCached()) {
      let m: LockMode;
      switch (this.Kind) {
        case 0:
          m = NoCrMode;
          if (cf.XF !== null) m = NoExclMode;
          break;
        case 1:
          m = OldMd;
          if (this.Key!.InWork) m = NoExclMode;
          break;
        default:
          return;
      }
      m = Math.max(m, OldMd);
      if (m !== OldMd) ChangeLMode(m, 0, true);
    }
  }
  // PAS: INDEX.PAS XScan.SubstWIndex
  SubstWIndex(WK: WKeyDPtr): void {
    this.Key = WK;
    if (this.Kind !== 3) this.Kind = 1;
    if (this.P === null) this.P = new XPage();
    this.NRecs = this.Key!.NRecs();
    this.Bool = null;
    this.SeekRec(0);
    this.TempWX = true;
  }
  // PAS: INDEX.PAS XScan.ResetOwner
  ResetOwner(XX: XStringPtr, aBool: FrmlPtr): void {
    AccessVars.CFile = this.FD;
    this.Bool = aBool;
    TestXFExist();
    this.KIRoot = new KeyInD();
    this.Key!.FindNr(XX!, fref(this.KIRoot, 'XNrBeg'));
    AddFFs(this.Key, fref(XX!, 'S'));
    const n = ref(0);
    const b = this.Key!.FindNr(XX!, n);
    this.NRecs = n.v - this.KIRoot.XNrBeg + (b ? 1 : 0);
    this.KIRoot.N = this.NRecs;
    this.Kind = 2;
    this.SeekRec(0);
  }
  // PAS: INDEX.PAS XScan.ResetOwnerIndex
  ResetOwnerIndex(LD: LinkDPtr, LV: LocVarPtr, aBool: FrmlPtr): void {
    AccessVars.CFile = this.FD;
    TestXFExist();
    this.Bool = aBool;
    this.OwnerLV = LV;
    this.Kind = 2;
    if (!EquKFlds((LV!.RecPtr as XWKey).KFlds, LD!.ToKey!.KFlds)) RunError(1181);
    this.SeekRec(0);
  }
  // PAS: INDEX.PAS XScan.ResetLV
  ResetLV(aRP: Uint8Array | null): void {
    this.Strm = aRP;
    this.Kind = 5;
    this.NRecs = 1;
  }
  // PAS: INDEX.PAS XScan.Close
  Close(): void {
    AccessVars.CFile = this.FD;
    if (this.TempWX) (this.Key as XWKey).Close();
  }
  // PAS: INDEX.PAS XScan.SeekRec
  SeekRec(I: number): void {
    const av = AccessVars;
    av.CFile = this.FD;
    if (this.Kind === 2 && this.OwnerLV !== null) {
      this.IRec = 0;
      this.NRecs = 0x20000000;
      this.iOKey = 0;
      this.NextIntvl();
      this.EOF = I >= this.NRecs;
      return;
    }
    this.IRec = I;
    this.EOF = I >= this.NRecs;
    if (!this.EOF) {
      switch (this.Kind) {
        case 1:
        case 3: {
          this.Key!.NrToPath(I + 1);
          const xp = av.XPath[av.XPathN];
          this.SeekOnPage(xp.Page, xp.I);
          break;
        }
        case 2: {
          let k = this.KIRoot!;
          while (I >= k.N) {
            I -= k.N;
            k = k.Chain!;
          }
          this.KI = k;
          this.SeekOnKI(I);
          break;
        }
      }
    }
  }
  // PAS: INDEX.PAS XScan.GetRec
  GetRec(): void {
    const av = AccessVars;
    av.CFile = this.FD;
    for (;;) {
      // 1:
      this.EOF = this.IRec >= this.NRecs;
      if (this.EOF) return;
      this.IRec++;
      switch (this.Kind) {
        case 0:
          this.RecNr = this.IRec;
          break;
        case 1:
        case 2:
          this.RecNr = this.X!.GetN();
          this.NOnPg = (this.NOnPg - 1) & 0xffff;
          if (this.NOnPg > 0) this.X = this.X!.Next(oLeaf);
          else if (this.Kind === 2 && this.NOfKI === 0) this.NextIntvl();
          else if (this.P!.GreaterPage > 0) this.SeekOnPage(this.P!.GreaterPage, 1);
          break;
        case 5:
          av.CRecPtr!.set((this.Strm as Uint8Array).subarray(0, av.CFile!.RecLen + 1));
          return;
        default:
          return;
      }
      // 2:
      ReadRec(this.RecNr);
      if (DeletedFlag()) continue;
      // 3:
      if (!RunBool(this.Bool)) continue;
      return;
    }
  }
  // PAS: INDEX.PAS XScan.SeekOnKI (private)
  SeekOnKI(I: number): void {
    const av = AccessVars;
    this.NOfKI = this.KI!.N - I;
    this.Key!.NrToPath(this.KI!.XNrBeg + I);
    const xp = av.XPath[av.XPathN];
    this.SeekOnPage(xp.Page, xp.I);
  }
  // PAS: INDEX.PAS XScan.SeekOnPage (private)
  SeekOnPage(Page: number, I: number): void {
    this.Key!.XF()!.RdPage(this.P, Page);
    this.NOnPg = (this.P!.NItems - I + 1) & 0xffff;
    if (this.Kind === 2) {
      if (this.NOnPg > this.NOfKI) this.NOnPg = this.NOfKI;
      this.NOfKI -= this.NOnPg;
    }
    this.X = this.P!.XI(I);
  }
  // PAS: INDEX.PAS XScan.NextIntvl (private)
  NextIntvl(): void {
    const av = AccessVars;
    if (this.OwnerLV !== null) {
      const k = this.OwnerLV.RecPtr as XWKey;
      const xx = new XString();
      while (this.iOKey < k.NRecs()) {
        this.iOKey++;
        av.CFile = this.OwnerLV.FD;
        xx.S = k.NrToStr(this.iOKey);
        av.CFile = this.FD;
        const nBeg = ref(0);
        this.Key!.FindNr(xx, nBeg);
        AddFFs(this.Key, fref(xx, 'S'));
        const n = ref(0);
        const b = this.Key!.FindNr(xx, n);
        n.v = n.v - nBeg.v + (b ? 1 : 0);
        if (n.v > 0) {
          this.NOfKI = n.v;
          this.Key!.NrToPath(nBeg.v);
          const xp = av.XPath[av.XPathN];
          this.SeekOnPage(xp.Page, xp.I);
          return;
        }
      }
      this.NRecs = this.IRec; // EOF
    } else {
      do this.KI = this.KI!.Chain;
      while (!(this.KI === null || this.KI.N > 0));
      if (this.KI !== null) this.SeekOnKI(0);
    }
  }
}
export type XScanPtr = XScan | null;

// PAS: INDEX.PAS TestXFExist
export function TestXFExist(): void {
  const xf = AccessVars.CFile!.XF;
  if (xf !== null && xf.NotValid) {
    if (xf.NoCreate) CFileError(819);
    CreateIndexFile();
  }
}
// PAS: INDEX.PAS XNRecs
export function XNRecs(K: KeyDPtr): number {
  const cf = AccessVars.CFile!;
  if (cf.Typ === 'X' && K !== null) {
    TestXFExist();
    return cf.XF!.NRecs;
  }
  return cf.NRecs;
}
// PAS: INDEX.PAS TryInsertAllIndexes
export function TryInsertAllIndexes(RecNr: number): void {
  const cf = AccessVars.CFile!;
  TestXFExist();
  let K = cf.Keys;
  while (K !== null) {
    if (!K.Insert(RecNr, true)) break; // goto 1
    K = K.Chain;
  }
  if (K === null) {
    cf.XF!.NRecs++;
    return;
  }
  // 1:
  let K1 = cf.Keys;
  while (K1 !== null && K1 !== K) {
    K1.Delete(RecNr);
    K1 = K1.Chain;
  }
  SetDeletedFlag();
  WriteRec(RecNr);
  const xf = cf.XF!;
  if (xf.FirstDupl) {
    SetMsgPar(cf.Name);
    WrLLF10Msg(828);
    xf.FirstDupl = false;
  }
}
// PAS: INDEX.PAS RecallRec
export function RecallRec(RecNr: number): void {
  const cf = AccessVars.CFile!;
  TestXFExist();
  cf.XF!.NRecs++;
  let K = cf.Keys;
  while (K !== null) {
    K.Insert(RecNr, false);
    K = K.Chain;
  }
  ClearDeletedFlag();
  WriteRec(RecNr);
}
// PAS: INDEX.PAS DeleteAllIndexes
export function DeleteAllIndexes(RecNr: number): void {
  let K = AccessVars.CFile!.Keys;
  while (K !== null) {
    K.Delete(RecNr);
    K = K.Chain;
  }
}
// PAS: INDEX.PAS DeleteXRec
export function DeleteXRec(RecNr: number, DelT: boolean): void {
  TestXFExist();
  DeleteAllIndexes(RecNr);
  if (DelT) DelAllDifTFlds(AccessVars.CRecPtr!, null);
  SetDeletedFlag();
  WriteRec(RecNr);
  AccessVars.CFile!.XF!.NRecs--;
}
// PAS: INDEX.PAS OverwrXRec
export function OverwrXRec(RecNr: number, P2: Uint8Array, P: Uint8Array): void {
  const av = AccessVars;
  av.CRecPtr = P2;
  if (DeletedFlag()) {
    av.CRecPtr = P;
    RecallRec(RecNr);
    return;
  }
  TestXFExist();
  const x = new XString();
  const x2 = new XString();
  let K = av.CFile!.Keys;
  while (K !== null) {
    av.CRecPtr = P;
    x.PackKF(K.KFlds);
    av.CRecPtr = P2;
    x2.PackKF(K.KFlds);
    if (x.S !== x2.S) {
      K.Delete(RecNr);
      av.CRecPtr = P;
      K.Insert(RecNr, false);
    }
    K = K.Chain;
  }
  av.CRecPtr = P;
  WriteRec(RecNr);
}
