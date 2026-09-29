// PAS: SORT.PAS – building .X index files and work indexes (external merge sort through FANDWORK).
//
// Porting notes:
// * asm: BP7 WRec.GetN/PutN/PutIR/Comp, WPage.Sort (quicksort with an explicit PushWord/PopWord
//   stack), XXPage.PutN/PutDownPage/PutMLX/ClearRest and the "pages to write" estimate in
//   WorkFile.Reset. The FPC Pascal rewrites are equivalent (WRec.Comp: unsigned byte compare of
//   the packed key X.S, shorter first, then IR[3],IR[2],IR[1] = input order; result 2 <, 4 >, 1 =).
// * Records are sorted by (packed key bytes, input record number IR) – a total order, so the
//   result does not depend on how the work pages were split. The WorkFile pages (<= 60 kB, sized
//   from StoreAvail) live in FANDWORK.$$$ (WorkHandle, MaxWSize restored + TruncH in Done), laid
//   out as in BP7: NxtChain@0, Chain@4, NRecs@8, records from 10 (WRec: N@0, IR@3, X.S@6).
// * XXPage builds the .X pages byte-for-byte as BP7 does (prefix compression M/L, leaf items
//   N + key, upper items N + DownPage + key, GreaterPage chain, NItems, sums): its page image is
//   an XPage (IsLeaf@0, GreaterPage@1, NItems@5, A@7), Off/MaxOff are offsets in that page.
// * WorkFile.GetCRec and Output are virtual: plain overridable methods (XWorkFile extends WorkFile).
// * CreateIndexFile inlines NewExit (Move(ExitBuf..)/SetJmp) – the PORTING.md 11 pattern;
//   on failure XF.SetNotValid + NoCreate, then GoExit after unlocking.
// * GetIndex: `k^ := kNew^` is a record assignment -> AssignRec(k, kNew).
// * Messages: RunMsgOn(Typ, pages)/RunMsgN/RunMsgOff progress; RunError(624) = not enough memory.
// * No interface variables, no unit initialization.

import { ref, getLongint, setLongint, getWord, setWord, BytesToStr, AssignRec, GoExitSignal } from './pasrt.ts';
import {
  BaseVars, ExitRecord, NewExit, RestoreExit, GoExit, StoreAvail, SaveCache, SetMsgPar, SLeadEqu, MyMove, ExChange,
  ChainLast, SeekH, ReadH, WriteH, TruncH, FlushH,
} from './base.ts';
import type { KeyDPtr, KeyFldDPtr, WKeyDPtr, XScanPtr, XWFilePtr, FrmlPtr, LockMode, FileDPtr } from './access.ts';
import {
  AccessVars, XScan, XWKey, XPage, XItem, XString, KeyFldD, RdMode, NullMode, EquKFlds, GetRecSpace, NewLMode, OldLMode,
  TryLockN, UnLockN, ReadRec, WriteRec, PutRec, DeletedFlag, SetDeletedFlag, type XFile,
} from './access.ts';
import { RunError, WrLLF10Msg, PromptYN, RunMsgOn, RunMsgN, RunMsgOff } from './obaseww.ts';
import { OpenDuplF, SubstDuplF } from './oaccess.ts';
import { RunEvalFrml, RunInt } from './runfrml.ts';
import type { InstrPtr } from './rdrun.ts';

// = ACCESS.XPageSize, XPageOverHead, oLeaf (not imported: used by field initialisers)
const XPageSize = 1024;
const XPageOverHead = 7;
const oLeaf = 3;
const _equ = 1;
const _lt = 2;
const _gt = 4;
/** BP7 sizeof(WRec) = N(3) + IR(3) + X.S(256) */
const SizeOfWRec = 262;
/** BP7 sizeof(WPage) = NxtChain(4) + Chain(4) + NRecs(2) + A(1) */
const SizeOfWPage = 11;
/** offset of WPage.A */
const oWA = 10;
/** BP7 sizeof(XXPage) = Chain, XW (4+4), Off, MaxOff (2+2), LastIndex (256), LastRecNr, Sum (4+4),
 *  IsLeaf (1), GreaterPage (4), NItems (2), A (XPageSize-XPageOverHead) */
const SizeOfXXPage = 4 + 4 + 2 + 2 + 256 + 4 + 4 + 1 + 4 + 2 + (XPageSize - XPageOverHead);

// PAS: SORT.PAS Ovr (overlay return helper; FPC: empty)
function Ovr(): void {}

// the index is sorted by key value and input order(IR) !!

// PAS: SORT.PAS WRec – record on WPage: N[1..3] RecNr, IR[1..3] input order, X: XString.
// A cursor (buffer + offset) like XItem.
class WRec {
  Buf: Uint8Array;
  Ofs: number;
  constructor(Buf: Uint8Array, Ofs: number) {
    this.Buf = Buf;
    this.Ofs = Ofs;
  }
  /** X.S */
  get XS(): string {
    return BytesToStr(this.Buf, this.Ofs + 7, this.Buf[this.Ofs + 6]);
  }
  set XS(s: string) {
    const b = this.Buf;
    const o = this.Ofs + 6;
    b[o] = s.length;
    for (let i = 0; i < s.length; i++) b[o + 1 + i] = s.charCodeAt(i);
  }
  // PAS: SORT.PAS WRec.GetN
  GetN(): number {
    const b = this.Buf;
    const o = this.Ofs;
    return b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  }
  // PAS: SORT.PAS WRec.PutN
  PutN(NN: number): void {
    const b = this.Buf;
    const o = this.Ofs;
    b[o] = NN & 0xff;
    b[o + 1] = (NN >>> 8) & 0xff;
    b[o + 2] = (NN >>> 16) & 0xff;
  }
  // PAS: SORT.PAS WRec.PutIR
  PutIR(II: number): void {
    const b = this.Buf;
    const o = this.Ofs + 3;
    b[o] = II & 0xff;
    b[o + 1] = (II >>> 8) & 0xff;
    b[o + 2] = (II >>> 16) & 0xff;
  }
  // PAS: SORT.PAS WRec.Comp – X.S (unsigned bytes, shorter first), then IR[3], IR[1..2]
  Comp(R: WRec): number {
    const a = this.Buf;
    const ao = this.Ofs;
    const b = R.Buf;
    const bo = R.Ofs;
    const len1 = a[ao + 6];
    const len2 = b[bo + 6];
    const minlen = len1 < len2 ? len1 : len2;
    for (let i = 0; i < minlen; i++) {
      const c1 = a[ao + 7 + i];
      const c2 = b[bo + 7 + i];
      if (c1 !== c2) return c1 < c2 ? _lt : _gt;
    }
    if (len1 < len2) return _lt;
    if (len1 > len2) return _gt;
    if (a[ao + 5] !== b[bo + 5]) return a[ao + 5] < b[bo + 5] ? _lt : _gt;
    const w1 = getWord(a, ao + 3);
    const w2 = getWord(b, bo + 3);
    if (w1 !== w2) return w1 < w2 ? _lt : _gt;
    return _equ;
  }
}

// PAS: SORT.PAS WPage – ca. 64k pages in the work file: NxtChain, Chain, NRecs, A (records)
class WPage {
  Raw: Uint8Array;
  constructor(Size: number) {
    this.Raw = new Uint8Array(Size);
  }
  get NxtChain(): number {
    return getLongint(this.Raw, 0);
  }
  set NxtChain(v: number) {
    setLongint(this.Raw, 0, v);
  }
  get Chain(): number {
    return getLongint(this.Raw, 4);
  }
  set Chain(v: number) {
    setLongint(this.Raw, 4, v);
  }
  get NRecs(): number {
    return getWord(this.Raw, 8);
  }
  set NRecs(v: number) {
    setWord(this.Raw, 8, v);
  }
  // PAS: SORT.PAS WPage.Sort – quicksort of the N records, the longer interval on the stack
  Sort(N: number, RecLen: number): void {
    if (N <= 1) return;
    const V = new WRec(new Uint8Array(SizeOfWRec), 0);
    const buf = this.Raw;
    const oA = oWA;
    const X = new WRec(buf, 0);
    const Y = new WRec(buf, 0);
    const stack: number[] = []; // PushWord/PopWord
    stack.push(0, N - 1);
    do {
      let R = stack.pop()!;
      let L = stack.pop()!;
      do {
        const oZ = oA + ((L + R) >> 1) * RecLen;
        MyMove(buf.subarray(oZ, oZ + RecLen), V.Buf, RecLen);
        X.Ofs = oA + L * RecLen;
        Y.Ofs = oA + R * RecLen;
        do {
          let cx = X.Comp(V);
          while (cx === _lt) {
            X.Ofs += RecLen;
            cx = X.Comp(V);
          }
          let cy = V.Comp(Y);
          while (cy === _lt) {
            Y.Ofs -= RecLen;
            cy = V.Comp(Y);
          }
          if (X.Ofs <= Y.Ofs) {
            if ((cx | cy) !== _equ) ExChange(buf.subarray(X.Ofs), buf.subarray(Y.Ofs), RecLen);
            X.Ofs += RecLen;
            Y.Ofs -= RecLen;
          }
        } while (!(X.Ofs > Y.Ofs));
        const iX = Math.trunc((X.Ofs - oA) / RecLen);
        let iY: number;
        if (X.Ofs - RecLen > Y.Ofs) iY = iX - 2;
        else iY = iX - 1;
        if (iY === L) L = iX;
        else if (iX === R) R = iY;
        else if (iY - L < R - iX) {
          // push longest interval on stack
          if (iX < R) stack.push(iX, R);
          R = iY;
        } else {
          if (L < iY) stack.push(L, iY);
          L = iX;
        }
      } while (!(L >= R));
    } while (stack.length > 0);
  }
}

// PAS: SORT.PAS WorkFile = object(TObject) – sorts WRecs of the records GetCRec delivers and
// hands them in order to Output (through FANDWORK.$$$ when they do not fit in one page)
class WorkFile {
  Handle = 0;
  RecLen = 0;
  MaxOnWPage = 0;
  WPageSize = 0;
  MaxWPage = 0;
  WRoot = 0;
  NChains = 0;
  PgWritten = 0;
  WBaseSize = 0;
  PW: WPage | null = null;
  PW1: WPage | null = null;
  PW2: WPage | null = null;
  FreeNr: number[] = [0, 0, 0, 0, 0, 0]; // [1..5]
  NFreeNr = 0;
  IRec = 0;
  RecNr = 0;
  KFRoot: KeyFldDPtr = null;

  // PAS: SORT.PAS WorkFile.Init (constructor)
  Init(): this {
    this.WBaseSize = BaseVars.MaxWSize;
    this.Handle = BaseVars.WorkHandle;
    return this;
  }
  // PAS: SORT.PAS WorkFile.Done (destructor)
  Done(): void {
    BaseVars.MaxWSize = this.WBaseSize;
    TruncH(this.Handle, BaseVars.MaxWSize);
    FlushH(this.Handle);
  }
  // PAS: SORT.PAS WorkFile.TestErr (private)
  TestErr(): void {
    if (BaseVars.HandleError !== 0) {
      SetMsgPar(BaseVars.FandWorkName);
      RunError(700 + BaseVars.HandleError);
    }
  }
  // PAS: SORT.PAS WorkFile.Reset
  Reset(KF: KeyFldDPtr, RestBytes: number, Typ: string, NRecs: number): void {
    const kB60 = 0x0f000;
    this.KFRoot = KF;
    this.RecLen = 7;
    while (KF !== null) {
      const F = KF.FldD!;
      if (F.Typ === 'D') this.RecLen += 6;
      else this.RecLen += F.NBytes;
      KF = KF.Chain;
    }
    const bytes = Math.trunc((StoreAvail() - RestBytes - SizeOfWRec) / 3);
    if (bytes < 4096) RunError(624);
    if (bytes < kB60) this.WPageSize = bytes & 0xf000;
    else this.WPageSize = kB60;
    this.MaxOnWPage = Math.trunc((this.WPageSize - SizeOfWPage + 1) / this.RecLen);
    if (this.MaxOnWPage < 4) RunError(624);
    this.MaxWPage = 0;
    this.NFreeNr = 0;
    this.PW = new WPage(this.WPageSize);
    this.WRoot = this.GetFreeNr();
    let pages = Math.trunc((NRecs + this.MaxOnWPage - 1) / this.MaxOnWPage);
    // how many pages must be written ?
    let bx = pages;
    let cx = pages;
    let ax = 1;
    while (bx > 1) {
      cx = cx + pages;
      if (bx & 1) {
        cx -= ax;
        bx = (bx >>> 1) + 1;
      } else bx = bx >>> 1;
      ax = ax << 1;
    }
    if (cx === 0) cx = 1;
    pages = cx;
    RunMsgOn(Typ, pages);
  }
  // PAS: SORT.PAS WorkFile.SortMerge
  SortMerge(): void {
    const PW = this.PW!;
    this.PgWritten = 0;
    let n = 0;
    const r = new WRec(PW.Raw, oWA);
    let nxt = this.WRoot;
    this.NChains = 1;
    const x = new XString();
    while (this.GetCRec()) {
      if (n === this.MaxOnWPage) {
        PW.Sort(n, this.RecLen);
        const pg = nxt;
        nxt = this.GetFreeNr();
        this.NChains++;
        this.WriteWPage(n, pg, nxt, 0);
        n = 0;
        r.Ofs = oWA;
      }
      r.PutN(this.RecNr);
      r.PutIR(this.IRec);
      x.PackKF(this.KFRoot);
      r.XS = x.S;
      n++;
      r.Ofs += this.RecLen;
    }
    PW.Sort(n, this.RecLen);
    this.WriteWPage(n, nxt, 0, 0);
    if (this.NChains > 1) this.Merge();
    RunMsgOff();
  }
  // PAS: SORT.PAS WorkFile.GetCRec (virtual)
  GetCRec(): boolean {
    return false;
  }
  // PAS: SORT.PAS WorkFile.Output (virtual)
  Output(R: WRec): void {}
  // PAS: SORT.PAS WorkFile.GetFreeNr (private)
  GetFreeNr(): number {
    if (this.NFreeNr > 0) {
      const result = this.FreeNr[this.NFreeNr];
      this.NFreeNr--;
      return result;
    }
    this.MaxWPage++;
    BaseVars.MaxWSize += this.WPageSize;
    return this.MaxWPage;
  }
  // PAS: SORT.PAS WorkFile.Merge (private) – merges pairs of chains until one is left
  Merge(): void {
    let nxt = 0;
    this.PW1 = new WPage(this.WPageSize);
    this.PW2 = new WPage(this.WPageSize);
    const PW1 = this.PW1;
    const PW2 = this.PW2;
    for (;;) {
      // 1:
      if (this.NChains === 1) return;
      let npairs = this.NChains >> 1;
      let pg1 = this.WRoot;
      let pg2 = 0;
      let neu: number;
      if (this.NChains === 2) neu = 0;
      else {
        this.WRoot = this.GetFreeNr();
        neu = this.WRoot;
      }
      let goto2 = false;
      if (nxt > 0) {
        pg2 = pg1;
        pg1 = nxt;
        this.ReadWPage(PW1, pg1);
        goto2 = true;
      }
      while (goto2 || npairs > 0) {
        if (!goto2) {
          this.ReadWPage(PW1, pg1);
          pg2 = PW1.NxtChain;
        }
        goto2 = false;
        // 2:
        this.ReadWPage(PW2, pg2);
        nxt = PW2.NxtChain;
        const nxtnew = npairs === 1 ? 0 : this.GetFreeNr();
        this.NChains--;
        this.Merge2Chains(pg1, pg2, neu, nxtnew);
        npairs--;
        pg1 = nxt;
        neu = nxtnew;
      }
    }
  }
  // PAS: SORT.PAS WorkFile.Merge2Chains (private) – PW1 (chain Pg1) + PW2 (chain Pg2) -> chain Pg
  Merge2Chains(Pg1: number, Pg2: number, Pg: number, Nxt: number): void {
    const w1 = this.PW1!;
    const w2 = this.PW2!;
    const w = this.PW!;
    const l = this.RecLen;
    let eof1 = false;
    let eof2 = false;
    const r1 = new WRec(w1.Raw, oWA);
    const r2 = new WRec(w2.Raw, oWA);
    let rofs = oWA;
    let max1ofs = r1.Ofs + w1.NRecs * l;
    let max2ofs = r2.Ofs + w2.NRecs * l;
    const maxofs = rofs + this.MaxOnWPage * l;
    let lbl = 1;
    for (;;) {
      if (lbl === 1) {
        if (rofs === maxofs) {
          const chn = this.GetFreeNr();
          this.WriteWPage(this.MaxOnWPage, Pg, Nxt, chn);
          Pg = chn;
          Nxt = 0;
          rofs = oWA;
        }
        if (eof1) lbl = 3;
        else if (eof2) lbl = 2;
        else if (r1.Comp(r2) === _gt) lbl = 3;
        else lbl = 2;
      }
      if (lbl === 2) {
        MyMove(w1.Raw.subarray(r1.Ofs, r1.Ofs + l), w.Raw.subarray(rofs), l);
        rofs += l;
        r1.Ofs += l;
        lbl = 1;
        if (r1.Ofs === max1ofs) {
          this.PutFreeNr(Pg1);
          Pg1 = w1.Chain;
          if (Pg1 !== 0) {
            this.ReadWPage(w1, Pg1);
            r1.Ofs = oWA;
            max1ofs = r1.Ofs + w1.NRecs * l;
          } else if (eof2) lbl = 4;
          else eof1 = true;
        }
      } else if (lbl === 3) {
        MyMove(w2.Raw.subarray(r2.Ofs, r2.Ofs + l), w.Raw.subarray(rofs), l);
        rofs += l;
        r2.Ofs += l;
        lbl = 1;
        if (r2.Ofs === max2ofs) {
          this.PutFreeNr(Pg2);
          Pg2 = w2.Chain;
          if (Pg2 !== 0) {
            this.ReadWPage(w2, Pg2);
            r2.Ofs = oWA;
            max2ofs = r2.Ofs + w2.NRecs * l;
          } else if (eof1) lbl = 4;
          else eof2 = true;
        }
      }
      if (lbl === 4) {
        this.WriteWPage(Math.trunc((rofs - oWA) / l), Pg, Nxt, 0);
        return;
      }
    }
  }
  // PAS: SORT.PAS WorkFile.PutFreeNr (private)
  PutFreeNr(N: number): void {
    this.NFreeNr++;
    this.FreeNr[this.NFreeNr] = N;
  }
  // PAS: SORT.PAS WorkFile.ReadWPage (private)
  ReadWPage(W: WPage, Pg: number): void {
    SeekH(this.Handle, this.WBaseSize + (Pg - 1) * this.WPageSize);
    ReadH(this.Handle, this.WPageSize, W.Raw);
    this.TestErr();
  }
  // PAS: SORT.PAS WorkFile.WriteWPage (private) – the last merge (NChains=1) goes to Output
  WriteWPage(N: number, Pg: number, Nxt: number, Chn: number): void {
    const PW = this.PW!;
    this.PgWritten++;
    RunMsgN(this.PgWritten);
    if (this.NChains === 1) {
      const r = new WRec(PW.Raw, oWA);
      while (N > 0) {
        this.Output(r);
        N--;
        r.Ofs += this.RecLen;
      }
    } else {
      PW.NRecs = N;
      PW.NxtChain = Nxt;
      PW.Chain = Chn;
      SeekH(this.Handle, this.WBaseSize + (Pg - 1) * this.WPageSize);
      WriteH(this.Handle, this.WPageSize, PW.Raw);
      this.TestErr();
    }
  }
}

// PAS: SORT.PAS XXPage – for building XPage: the page under construction on one level
class XXPage {
  Chain: XXPage | null = null;
  XW: XWorkFile | null = null;
  Off = 0;
  MaxOff = 0;
  LastIndex = '';
  LastRecNr = 0;
  Sum = 0;
  /** IsLeaf, GreaterPage, NItems, A: the page image written by XF^.WrPage(XPagePtr(@IsLeaf)) */
  P = new XPage();
  get IsLeaf(): boolean {
    return this.P.IsLeaf;
  }
  set IsLeaf(v: boolean) {
    this.P.IsLeaf = v;
  }
  get GreaterPage(): number {
    return this.P.GreaterPage;
  }
  set GreaterPage(v: number) {
    this.P.GreaterPage = v;
  }
  get NItems(): number {
    return this.P.NItems;
  }
  set NItems(v: number) {
    this.P.NItems = v;
  }

  // PAS: SORT.PAS XXPage.Reset
  Reset(OwnerXW: XWorkFile): void {
    this.XW = OwnerXW;
    this.Sum = 0;
    this.NItems = 0;
    this.MaxOff = XPageSize;
    this.Off = XPageOverHead; // ofs(A)
  }
  // PAS: SORT.PAS XXPage.PutN
  PutN(N: number): void {
    const r = this.P.Raw;
    r[this.Off] = N & 0xff;
    r[this.Off + 1] = (N >>> 8) & 0xff;
    r[this.Off + 2] = (N >>> 16) & 0xff;
    this.Off += 3;
  }
  // PAS: SORT.PAS XXPage.PutDownPage
  PutDownPage(DownPage: number): void {
    setLongint(this.P.Raw, this.Off, DownPage);
    this.Off += 4;
  }
  // PAS: SORT.PAS XXPage.PutMLX
  PutMLX(M: number, L: number): void {
    const r = this.P.Raw;
    r[this.Off] = M;
    r[this.Off + 1] = L;
    for (let i = 0; i < L; i++) r[this.Off + 2 + i] = this.LastIndex.charCodeAt(M + i);
    this.Off += 2 + L;
  }
  // PAS: SORT.PAS XXPage.ClearRest
  ClearRest(): void {
    if (this.MaxOff > this.Off) this.P.Raw.fill(0, this.Off, this.MaxOff);
  }
  // PAS: SORT.PAS XXPage.PageFull – writes the page, adds its item to the upper level
  PageFull(): void {
    const XW = this.XW!;
    this.ClearRest();
    if (this.Chain === null) {
      this.Chain = new XXPage();
      this.Chain.Reset(XW);
    }
    let n: number;
    if (this.IsLeaf) n = XW.NxtXPage;
    else n = XW.XF!.NewPage(XW.XPP);
    this.Chain.AddToUpper(this, n);
    if (this.IsLeaf) {
      XW.NxtXPage = XW.XF!.NewPage(XW.XPP);
      this.GreaterPage = XW.NxtXPage;
    }
    XW.XF!.WrPage(this.P, n);
  }
  // PAS: SORT.PAS XXPage.AddToLeaf
  AddToLeaf(R: WRec, KD: KeyDPtr): void {
    const av = AccessVars;
    const RS = R.XS;
    for (;;) {
      // 1:
      let m = 0;
      let l = RS.length;
      const n = R.GetN();
      if (l > 0 && this.NItems > 0) {
        m = SLeadEqu(RS, this.LastIndex);
        if (m === l && m === this.LastIndex.length) {
          if (n === this.LastRecNr) return; // overlapping intervals from key in ..
          if (!KD!.InWork && !KD!.Duplic) {
            if (!this.XW!.MsgWritten) {
              SetMsgPar(av.CFile!.Name);
              if (av.IsTestRun) {
                if (!PromptYN(832)) GoExit();
              } else WrLLF10Msg(828);
              this.XW!.MsgWritten = true;
            }
            ReadRec(n);
            let k = av.CFile!.Keys;
            while (k !== KD) {
              k!.Delete(n);
              k = k!.Chain;
            }
            SetDeletedFlag();
            WriteRec(n);
            return;
          }
        }
        l = l - m;
      }
      if (this.Off + 5 + l > this.MaxOff) {
        this.PageFull();
        this.Reset(this.XW!);
        continue;
      }
      this.LastIndex = RS;
      this.LastRecNr = n;
      this.Sum++;
      this.NItems++;
      this.PutN(n);
      this.PutMLX(m, l);
      return;
    }
  }
  // PAS: SORT.PAS XXPage.AddToUpper
  AddToUpper(P: XXPage, DownPage: number): void {
    for (;;) {
      // 1:
      let m = 0;
      let l = P.LastIndex.length;
      if (l > 0 && this.NItems > 0) {
        m = SLeadEqu(P.LastIndex, this.LastIndex);
        l = l - m;
      }
      if (this.Off + 9 + l > this.MaxOff) {
        this.PageFull();
        this.Reset(this.XW!);
        continue;
      }
      this.LastIndex = P.LastIndex;
      this.Sum += P.Sum;
      this.NItems++;
      this.PutN(P.Sum);
      this.PutDownPage(DownPage);
      this.PutMLX(m, l);
      return;
    }
  }
}

// PAS: SORT.PAS XWorkFile = object(WorkFile) – builds the indexes KD (a chain) from Scan
class XWorkFile extends WorkFile {
  PX: XXPage | null = null;
  KD: KeyDPtr = null;
  Scan: XScanPtr = null;
  MsgWritten = false;
  NxtXPage = 0;
  XF: XWFilePtr = null;
  XPP: XPage | null = null;

  // PAS: SORT.PAS XWorkFile.Init (constructor) – WorkFile.Init is the same method without arguments
  override Init(AScan: XScanPtr = null, AK: KeyDPtr = null): this {
    super.Init();
    this.Scan = AScan;
    AccessVars.CFile = AScan!.FD;
    this.KD = AK;
    this.XF = AK!.XF();
    return this;
  }
  // PAS: SORT.PAS XWorkFile.Main
  Main(Typ: string): void {
    const Scan = this.Scan!;
    const XF = this.XF!;
    this.XPP = new XPage();
    this.NxtXPage = XF.NewPage(this.XPP);
    this.MsgWritten = false;
    let frst = true;
    while (this.KD !== null) {
      this.PX = new XXPage();
      this.PX.Reset(this);
      this.PX.IsLeaf = true;
      const k = Scan.Key;
      const kf = this.KD.KFlds;
      if (Scan.Kind === 1 && Scan.Bool === null && (EquKFlds(k!.KFlds, kf) || kf === null)) this.CopyIndex(k, kf, Typ);
      else {
        if (frst) frst = false;
        else Scan.SeekRec(0);
        this.Reset(this.KD.KFlds, SizeOfXXPage * 9, Typ, Scan.NRecs);
        this.SortMerge();
      }
      this.FinishIndex();
      this.PX = null;
      this.KD = this.KD.Chain;
    }
    XF.ReleasePage(this.XPP, this.NxtXPage);
  }
  // PAS: SORT.PAS XWorkFile.CopyIndex – the scan's own index: its leaves in order, no sorting
  CopyIndex(K: KeyDPtr, KF: KeyFldDPtr, Typ: string): void {
    const av = AccessVars;
    const r = new WRec(new Uint8Array(SizeOfWRec), 0);
    r.XS = '';
    const p = new XPage();
    K!.NrToPath(1);
    let page = av.XPath[av.XPathN].Page;
    RunMsgOn(Typ, K!.NRecs());
    let i = 0;
    while (page !== 0) {
      K!.XF()!.RdPage(p, page);
      let x = new XItem(p.Raw, XPageOverHead);
      let n = p.NItems;
      while (n > 0) {
        r.PutN(x.GetN());
        if (KF === null) x = x.Next(oLeaf);
        else {
          const s = ref(r.XS);
          x = new XItem(p.Raw, x.UpdStr(oLeaf, s));
          r.XS = s.v;
        }
        this.Output(r);
        n--;
      }
      i += p.NItems;
      RunMsgN(i);
      page = p.GreaterPage;
    }
    RunMsgOff();
  }
  // PAS: SORT.PAS XWorkFile.GetCRec
  override GetCRec(): boolean {
    const Scan = this.Scan!;
    Scan.GetRec();
    this.RecNr = Scan.RecNr;
    this.IRec = Scan.IRec;
    return !Scan.EOF;
  }
  // PAS: SORT.PAS XWorkFile.Output
  override Output(R: WRec): void {
    this.PX!.AddToLeaf(R, this.KD);
  }
  // PAS: SORT.PAS XWorkFile.FinishIndex (private) – writes the last page of each level, the top
  // one at IndexRoot; NRecs = the items of all levels' current pages
  FinishIndex(): void {
    const XF = this.XF!;
    let n = 0;
    let sum = 0;
    let p: XXPage | null = this.PX!;
    for (;;) {
      // 1:
      sum = sum + p.Sum;
      p.ClearRest();
      p.GreaterPage = n;
      const p1: XXPage | null = p.Chain;
      if (p1 === null) n = this.KD!.IndexRoot;
      else n = this.NxtXPage;
      XF.WrPage(p.P, n);
      p = p1;
      if (p === null) break;
      this.NxtXPage = XF.NewPage(this.XPP);
    }
    if (this.KD!.InWork) (this.KD as XWKey).NR = sum;
    else (XF as XFile).NRecs = sum;
  }
}

// PAS: SORT.PAS CreateIndexFile – rebuilds CFile's .X when NotValid
export function CreateIndexFile(): void {
  const av = AccessVars;
  const er = new ExitRecord();
  let cr: Uint8Array | null = null;
  let md: LockMode = NullMode;
  let fail = true;
  const XF = av.CFile!.XF!;
  NewExit(Ovr, er);
  try {
    cr = av.CRecPtr;
    av.CRecPtr = GetRecSpace();
    md = NewLMode(RdMode);
    TryLockN(0, 0); // ClearCacheCFile;
    if (XF.Handle === 0xff) RunError(903);
    XF.RdPrefix();
    if (XF.NotValid) {
      XF.SetEmpty();
      const Scan = new XScan().Init(av.CFile, null, null, false);
      Scan.Reset(null, false);
      const XW = new XWorkFile().Init(Scan, av.CFile!.Keys);
      XW.Main('X');
      XW.Done();
      XF.NotValid = false;
      XF.WrPrefix();
      if (!SaveCache(0)) GoExit(); // FlushHandles;
    }
    fail = false;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
  } finally {
    RestoreExit(er);
  }
  // 1:
  av.CRecPtr = cr;
  if (fail) {
    XF.SetNotValid();
    XF.NoCreate = true;
  }
  UnLockN(0);
  OldLMode(md);
  if (fail) GoExit();
}
// PAS: SORT.PAS CreateWIndex
export function CreateWIndex(Scan: XScanPtr, K: WKeyDPtr, Typ: string): void {
  const av = AccessVars;
  const cr = av.CRecPtr;
  av.CRecPtr = GetRecSpace();
  const XW = new XWorkFile().Init(Scan, K);
  XW.Main(Typ);
  XW.Done();
  av.CRecPtr = cr;
}
// PAS: SORT.PAS ScanSubstWIndex
export function ScanSubstWIndex(Scan: XScanPtr, SK: KeyFldDPtr, Typ: string): void {
  const k2 = new XWKey();
  if (Scan!.FD!.IsSQLFile && Scan!.Kind === 3) {
    // F6-autoreport & sort
    const k = Scan!.Key!;
    let n = k.IndexLen;
    let kf = SK;
    while (kf !== null) {
      n += kf.FldD!.NBytes;
      kf = kf.Chain;
    }
    if (n > 255) {
      WrLLF10Msg(155);
      return;
    }
    kf = k.KFlds;
    const kfroot = ref<KeyFldDPtr>(null);
    let kf2: KeyFldD | null = null;
    while (kf !== null) {
      kf2 = new KeyFldD();
      AssignRec(kf2, kf);
      ChainLast(kfroot, kf2);
      kf = kf.Chain;
    }
    kf2!.Chain = SK;
    SK = kfroot.v;
  }
  k2.Open(SK, true, false);
  CreateWIndex(Scan, k2, Typ);
  Scan!.SubstWIndex(k2);
}
// PAS: SORT.PAS SortAndSubst – physically reorders CFile by SK (via a duplicate file)
export function SortAndSubst(SK: KeyFldDPtr): void {
  const av = AccessVars;
  const cf = av.CFile;
  av.CRecPtr = GetRecSpace();
  const Scan = new XScan().Init(av.CFile, null, null, false);
  Scan.Reset(null, false);
  ScanSubstWIndex(Scan, SK, 'S');
  const FD2: FileDPtr = OpenDuplF(false);
  RunMsgOn('S', Scan.NRecs);
  Scan.GetRec();
  while (!Scan.EOF) {
    RunMsgN(Scan.IRec);
    av.CFile = FD2;
    PutRec();
    Scan.GetRec();
  }
  if (!SaveCache(0)) GoExit();
  av.CFile = cf;
  SubstDuplF(FD2, false);
  Scan.Close();
  RunMsgOff();
}
// PAS: SORT.PAS GetIndex – the GETINDEX instruction
export function GetIndex(PD: InstrPtr): void {
  const av = AccessVars;
  const pd = PD!;
  const lv = pd.giLV!;
  av.CFile = lv.FD;
  const k = lv.RecPtr as XWKey;
  let md = NewLMode(RdMode);
  const x = new XString();
  if (pd.giMode === ' ') {
    const ld = pd.giLD;
    let kf: KeyFldDPtr = ld !== null ? ld.ToKey!.KFlds : null; // Pascal reads ld^ even when nil
    const lv2 = pd.giLV2;
    const Scan = new XScan().Init(av.CFile, pd.giKD, pd.giKIRoot, false);
    const cond: FrmlPtr = RunEvalFrml(pd.giCond);
    switch (pd.giOwnerTyp) {
      case 'i':
        Scan.ResetOwnerIndex(ld, lv2, cond);
        break;
      case 'r':
        av.CFile = ld!.ToFD;
        av.CRecPtr = lv2!.RecPtr as Uint8Array;
        x.PackKF(kf);
        // goto 1
        av.CFile = lv.FD;
        Scan.ResetOwner(x, cond);
        break;
      case 'F':
        av.CFile = ld!.ToFD;
        md = NewLMode(RdMode);
        av.CRecPtr = GetRecSpace();
        ReadRec(RunInt(pd.giLV2 as unknown as FrmlPtr)); // giLV2 holds the RecNr formula here
        x.PackKF(kf);
        OldLMode(md);
        // 1:
        av.CFile = lv.FD;
        Scan.ResetOwner(x, cond);
        break;
      default:
        Scan.Reset(cond, pd.giSQLFilter);
    }
    kf = pd.giKFlds;
    if (kf === null) kf = k.KFlds;
    const kNew = new XWKey();
    kNew.Open(kf, true, false);
    CreateWIndex(Scan, kNew, 'X');
    k.Close();
    AssignRec(k, kNew);
  } else {
    av.CRecPtr = GetRecSpace();
    const nr = RunInt(pd.giCond);
    if (nr > 0 && nr <= av.CFile!.NRecs) {
      ReadRec(nr);
      if (pd.giMode === '+') {
        if (!DeletedFlag()) {
          x.PackKF(k.KFlds);
          if (!k.RecNrToPath(x, nr)) {
            k.InsertOnPath(x, nr);
            k.NR++;
          }
        }
      } else if (k.Delete(nr)) k.NR--;
    }
  }
  OldLMode(md);
}
// PAS: SORT.PAS CopyIndex
export function CopyIndex(K: WKeyDPtr, FromK: KeyDPtr): void {
  K!.Release();
  const md = NewLMode(RdMode);
  const Scan = new XScan().Init(AccessVars.CFile, FromK, null, false);
  Scan.Reset(null, false);
  CreateWIndex(Scan, K, 'W');
  OldLMode(md);
}
