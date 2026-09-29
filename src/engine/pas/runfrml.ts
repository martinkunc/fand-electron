// PAS: RUNFRML.PAS – the formula evaluator: RunReal/RunBool/RunLongStr/RunShortStr over FrmlElem
// trees, field assignment from a formula, field display decoding, owner sums (Owned).
//
// Porting notes:
// * asm/DOS: IntTSR (the `inttsr` function: patched `int NN` instruction; FPC does nothing but still
//   writes back into the local variable) -> keep the FPC behaviour; PortIn (`portin`: FPC returns 0);
//   BP7 asm LowCase / ConcatLongStr / CopyLongStr / RunShortStr (FPC Pascal versions are equivalent,
//   except that the BP7 LowCase never maps to #255 – the `jcxz` exits before the last table entry);
//   RunS `_readkey` hi(KbdChar) mapping (FPC Pascal branch = BP7 asm).
// * FPC FrmlInline(X) = the bytes stored after the FrmlElem by GetOp(Op, BytesAfter): here
//   `X.Inline: Uint8Array` (PORTING.md 7). Used by _instr/_inreal (InReal/InStr/LexInStr walk the
//   compiler's interval list: count byte, then values or ranges; floats are 8-byte doubles as the
//   compiler (RDFRML RdComp) writes them), _modulo (word weights), _trust (access-right bytes,
//   OverlapByteStr with AccRight).
// * `_getlocvar` and friends read the procedure frame at MyBP+BPOfs: MyBP.V[BPOfs] / LocVarAd
//   (PORTING.md 14). 'S' locals hold a TWork position (TWork.Read/Store/Delete).
// * FPC deviation: TypeDay skips the FAND.CFG working-days table (WDaysFirst/WDaysLast/WDaysTab)
//   under {$ifndef FPC}. BP7 wins: the table lookup is ported (affects addwdays/difwdays/typeday).
// * `_memavail` FPC clamps StoreAvail to 655360; kept (programs compare it with constants).
// * CompReal rounds both operands to M decimals with Power10 and BP7 Round semantics (int(x+0.5)).
// * LongStr results are fresh Uint8Arrays whose length is LL; Pascal routines that shorten or extend
//   a LongStr in place (LongLeadChar, CopyLine, RepeatStr, ConcatLongStr ...) return the new array.
//   The heap tricks that copy a result over CRecPtr/MarkStore (_access, _accrecno, _eval in
//   RunLongStr) just return the string.
// * `_recvarfld` keeps the record buffer in NewRP (Pascal casts it into LD), see access.ts FrmlElem.
// * RTL errors of the BP7 software Real48 (float = real, no Coproc): division by zero -> RunError 200,
//   sqrt of a negative number / ln of a non-positive number -> RunError 207 (SysRunError).
// * System.Random/RandSeed/Randomize are the BP7 generator (RandSeed*$08088405+1): TS-only
//   Random/Randomize here, RandSeed in RunFrmlVars (RUNPROC `randseed :=`, `randomize`).
// * Key global state: RunFrmlVars.TFD02/TF02/TF02Pos (source of the last T-field formula, set by
//   TestTFrml so AssgnFrml can copy T-texts between files without re-reading - CanCopyT/TryCopyT).
// * Private routines: RoundReal, LongLeadChar, RepeatStr, AccRecNoProc, RunUserFunc,
//   GetRecNoXString, RunReal.(RunRealStr, RMod, LastUpdate, TypeDay, AddWDays, DifWDays,
//   GetFileSize, RecNoFun, AbsLogRecNoFun, LinkProc, IntTSR, PortIn), RunLongStr.(ConcatLongStr,
//   CopyLongStr, AddToLongStr, StrMask, RunS, RunSelectStr, LowCase), RunBool.(InReal, LexInStr,
//   InStr, RunModulo, RunEquMask), TestTFrml, TryCopyT. RunReal/RunLongStr/RunBool nested routines
//   are module-level functions here.

import fs from 'node:fs';
import nodePath from 'node:path';
import {
  ref, fref, chr, ord, word, byte, int16, ShortStr, Copy, StrR, ValR, BytesToStr, GetPStr, SysRunError,
  GetEnv, ParamStr, ToUnicode, FromUnicode, UpCase, Clock, type Ref,
} from './pasrt.ts';
import type { float, LongStrPtr, WRect, ProcStkPtr } from './base.ts';
import {
  BaseVars, MaxLStrLen, StoreAvail, MinW, MaxI, MinI, CountDLines, GetDLine, FindCtrlM, SkipCtrlMJ,
  EqualsMask, OverlapByteStr, MouseInRectProc, SetMsgPar, Set2MsgPar, ValDate, StrDate, AddMonth, DifMonth,
  Today, CurrTime, RDate, OpenH, CloseH, FileSizeH, GetDateTimeH, IsNetCVol, UnixPath, _isoldfile, RdOnly,
  Shared,
} from './base.ts';
import { DosView, DosFExpand, GetDirDos, HostToDos } from './handle.ts';
import {
  AccessVars, WordVarArr, Power10, LeftJust, f_Stored, f_Encryp, f_Comma, RdMode, FrmlElem, XString, XScan,
  RunErrorM, FieldDMask, LocVarAd, GetRecSpace, ClearRecSpace, HasTWorkFlag, DeletedFlag, CompLongStr,
  CompLexLongStr, CompLongShortStr, CompLexLongShortStr, NewLMode, OldLMode, TestXFExist, XNRecs,
  SearchKey, LinkUpw, LinkLastRec, ReadRec, _R, _B, _T, _ShortS, _LongS, S_, LongS_, R_, B_, T_, DelTFld,
  DbtFormat, FptFormat,
  _field, _getlocvar, _const, _plus, _minus, _times, _access, _recvarfld, _eval, _divide, _cond, _newfile,
  _getwordvar, _div, _mod, _unminus, _today, _pi, _random, _round, _abs, _int, _frac, _sqr, _sqrt, _sin,
  _cos, _arctan, _ln, _exp, _nrecs, _nrecsabs, _generation, _lastupdate, _catfield, _currtime, _typeday,
  _addwdays, _difwdays, _addmonth, _difmonth, _recno, _recnoabs, _recnolog, _accrecno, _link, _memavail,
  _maxcol, _maxrow, _exitcode, _edrecno, _txtpos, _txtxy, _cprinter, _mousex, _mousey, _filesize, _inttsr,
  _userfunc, _indexnrecs, _owned, _color, _portin, _setmybp, _valdate, _val, _length, _linecnt, _ord,
  _prompt, _pos, _diskfree, _copy, _concat, _leadchar, _trailchar, _upcase, _lowcase, _copyline, _repeatstr,
  _gettxt, _nodiakr, _selectstr, _clipbd, _char, _strdate, _str, _replace, _getpath, _password, _readkey,
  _username, _accright, _version, _edfield, _edfile, _edkey, _edreckey, _getenv, _keyof, _keybuf, _edbool,
  _and, _or, _lneg, _limpl, _lequ, _instr, _inreal, _compreal, _compstr, _mouseevent, _ismouse, _mousein,
  _modulo, _promptyn, _edupdated, _keypressed, _escprompt, _isdeleted, _lvdeleted, _trust, _isnewrec,
  _testmode, _equmask, _lt, _equ, _gt,
  type FieldDPtr, type FieldList, type FileDPtr, type FrmlPtr, type KeyDPtr, type LinkDPtr, type LocVarPtr,
  type TFilePtr, type WRectFrml, type TFile,
} from './access.ts';
import { RdRunVars, SetMyBP, PushProcStk, PopProcStk } from './rdrun.ts';
import { CenterWw, PromptYN } from './obaseww.ts';
import { Generation, RdCatPathVol, TestMountVol, SetTxtPathVol, RdCatField } from './oaccess.ts';
import { GetTxt, CopyTFFromGetTxt, CopyTFString } from './olongstr.ts';
import { DriversVars, GetMouseEvent, ReadKbd, KeyPressed, ReadKey, AddToKbdBuf, ConvToNoDiakr, _ESC_ } from './drivers.ts';
import { WwMixVars, PutSelect, SelectStr, GetSelect, SelectDiskFile, PassWord } from './wwmix.ts';
import { GetEvalFrml } from './rdproc.ts';
import { RunProcedure } from './runproc.ts';
import { TestIsNewRec, PromptR, PromptS, PromptB } from './runedi.ts';
import { FindText } from './editor.ts';
import { bp7RandomizeSeed } from '../fand/coding.ts';

export const RunFrmlVars = {
  TFD02: null as FileDPtr,
  TF02: null as TFilePtr,
  TF02Pos: 0,
  /** TS-only: System.RandSeed (BP7 generator, see Random) */
  RandSeed: 0,
};

// ---------------------------------------------------------------- TS-only helpers

/** TS-only: the frame slot MyBP+BPOfs (PORTING.md 14); an unset slot reads as 0. */
function FrameV(BPOfs: number): number | boolean {
  const bp = BaseVars.MyBP;
  if (bp === null) return SysRunError(204);
  return bp.V[BPOfs] ?? 0;
}
/** TS-only: a real division of the BP7 software Real48 (division by zero = RunError 200). */
function RDivide(a: float, b: float): float {
  if (b === 0) SysRunError(200);
  return a / b;
}
/** TS-only: System.Random (BP7: RandSeed := RandSeed*$08088405+1, result RandSeed/2^32). */
export function Random(): float {
  const v = RunFrmlVars;
  v.RandSeed = (Math.imul(v.RandSeed, 0x08088405) + 1) | 0;
  return (v.RandSeed >>> 0) / 4294967296;
}
/** TS-only: System.Randomize (BP7 seeds from the DOS clock: RandSeed.lo := hour:min, .hi := sec:hund). */
export function Randomize(): void {
  RunFrmlVars.RandSeed = bp7RandomizeSeed(Clock.now());
}
/** TS-only: DOS.DiskFree(Drive) – free bytes of drive (0 = current), -1 on error. */
function DiskFree(Drive: number): float {
  try {
    const p = Drive === 0 ? '.' : ToUnicode(UnixPath(chr(0x40 + Drive) + ':\\'));
    const st = fs.statfsSync(p);
    return Math.min(st.bavail * st.bsize, 0x7fffffff);
  } catch {
    return -1;
  }
}
/** TS-only: DOS.FExpand on a host path (as oaccess.ts). */
function FExpand(Path: string): string {
  if (DosView.On) return DosFExpand(Path);
  const u = ToUnicode(Path);
  let r = nodePath.resolve(u);
  if ((u === '' || u.endsWith('/') || u.endsWith(nodePath.sep)) && !r.endsWith(nodePath.sep)) r += nodePath.sep;
  return FromUnicode(r);
}
/** TS-only: a byte string as a LongStr. */
function StrToLong(s: string): LongStrPtr {
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
/** TS-only: the colour table `AColors: array[0..53] of byte absolute colors`. */
function AColor(i: number): number {
  const c = BaseVars.Colors as unknown as Record<string, number | Uint8Array>;
  if (i < 16) return BaseVars.Colors.userColor[i];
  const names = Object.keys(c).filter((k) => k !== 'userColor');
  return (c[names[i - 16]] as number) ?? 0;
}

// ---------------------------------------------------------------- simple routines

// PAS: RUNFRML.PAS CompReal – compare after rounding to M decimals (M<0: exact); ord(_lt/_equ/_gt)
export function CompReal(R1: float, R2: float, M: number): number {
  if (M > 0) {
    R1 = R1 * Power10[M];
    R2 = R2 * Power10[M];
  }
  if (M >= 0) {
    if (R1 >= 0) R1 = Math.trunc(R1 + 0.5);
    else R1 = Math.trunc(R1 - 0.5);
    if (R2 >= 0) R2 = Math.trunc(R2 + 0.5);
    else R2 = Math.trunc(R2 - 0.5);
  }
  if (R1 > R2) return ord(_gt);
  if (R1 < R2) return ord(_lt);
  return ord(_equ);
}
// PAS: RUNFRML.PAS RoundReal
function RoundReal(RR: float, M: number): float {
  M = MaxI(0, MinI(M, 10));
  let R = RR * Power10[M];
  if (R < 0) R = R - 0.50001;
  else R = R + 0.50001;
  return Math.trunc(R) / Power10[M];
}
// PAS: RUNFRML.PAS CompBool
export function CompBool(B1: boolean, B2: boolean): number {
  if (B1 > B2) return ord(_gt);
  if (B1 < B2) return ord(_lt);
  return ord(_equ);
}
// PAS: RUNFRML.PAS CopyToLongStr
export function CopyToLongStr(SS: string): LongStrPtr {
  return StrToLong(SS);
}
// PAS: RUNFRML.PAS LeadChar – strip leading C
export function LeadChar(C: string, S: string): string {
  let i = 0;
  while (i < S.length && S[i] === C) i++;
  return S.slice(i);
}
// PAS: RUNFRML.PAS TrailChar – strip trailing C
export function TrailChar(C: string, S: string): string {
  let n = S.length;
  while (n > 0 && S[n - 1] === C) n--;
  return S.slice(0, n);
}
// PAS: RUNFRML.PAS LongLeadChar – strip leading C, CNew<>#0 replaces instead
function LongLeadChar(C: string, CNew: string, S: LongStrPtr): LongStrPtr {
  const c = ord(C);
  const l = S.length;
  let i = 1;
  while (i <= l) {
    if (S[i - 1] !== c) break;
    if (CNew !== '\0') S[i - 1] = ord(CNew);
    i++;
  }
  if (CNew === '\0') return S.slice(i - 1);
  return S;
}
// PAS: RUNFRML.PAS LongTrailChar – strip trailing C (in place), CNew<>#0 replaces instead
export function LongTrailChar(C: string, CNew: string, S: LongStrPtr): LongStrPtr {
  const c = ord(C);
  let l = S.length;
  while (l > 0) {
    if (S[l - 1] !== c) break;
    if (CNew !== '\0') S[l - 1] = ord(CNew);
    l--;
  }
  if (CNew === '\0') return S.subarray(0, l);
  return S;
}
// PAS: RUNFRML.PAS CopyLine – lines N..N+M-1 of S
export function CopyLine(S: LongStrPtr, N: number, M: number): LongStrPtr {
  N = word(N);
  M = word(M);
  let i = 1;
  if (N > 1) {
    i = FindCtrlM(S, 1, N - 1);
    i = SkipCtrlMJ(S, i);
  }
  const j = FindCtrlM(S, i, M);
  const l = j - i;
  if (l <= 0) return new Uint8Array(0);
  return S.slice(i - 1, i - 1 + l);
}
// PAS: RUNFRML.PAS RepeatStr
function RepeatStr(S: LongStrPtr, N: number): LongStrPtr {
  const l = S.length;
  if (l === 0) return S;
  if (N <= 0) return new Uint8Array(0);
  let n = 1;
  while (N > 1 && (n + 1) * l <= MaxLStrLen) {
    n++;
    N--;
  }
  const r = new Uint8Array(n * l);
  for (let k = 0; k < n; k++) r.set(S, k * l);
  return r;
}
// PAS: RUNFRML.PAS AccRecNoProc – CFile:=X^.RecFD, CRecPtr:=its record P1
function AccRecNoProc(X: FrmlElem, Msg: number): void {
  const a = AccessVars;
  a.CFile = X.RecFD;
  const md = NewLMode(RdMode);
  a.CRecPtr = GetRecSpace();
  const N = RunInt(X.P1);
  if (N <= 0 || N > a.CFile!.NRecs) {
    Set2MsgPar(a.CFile!.Name, X.RecFldD!.Name);
    RunErrorM(md, Msg);
  }
  ReadRec(N);
  OldLMode(md);
}
// PAS: RUNFRML.PAS RunUserFunc – pushes the frame, runs the body; the result slot (caller pops)
function RunUserFunc(X: FrmlElem): Ref<number | boolean> {
  const bv = BaseVars;
  const oldbp = bv.MyBP;
  const oldprocbp = bv.ProcMyBP;
  const fc = X.FC!;
  const lvb = RdRunVars.LVBD;
  lvb.Root = fc.LVB.Root; // LVBD := x^.fc^.LVB (record copy into the unit variable)
  lvb.NParam = fc.LVB.NParam;
  lvb.Size = fc.LVB.Size;
  PushProcStk();
  let lv = RdRunVars.LVBD.Root;
  let fl = X.FrmlL;
  while (fl !== null) {
    LVAssignFrml(lv, oldbp, false, fl.Frml);
    lv = lv!.Chain;
    fl = fl.Chain;
  }
  bv.ProcMyBP = bv.MyBP;
  RunProcedure(fc.Instr);
  const result = LocVarAd(lv!);
  bv.ProcMyBP = oldprocbp;
  return result;
}
// PAS: RUNFRML.PAS GetRecNoXString – the key string of the RECNO/KEYOF arguments
function GetRecNoXString(Z: FrmlElem, X: XString): void {
  let i = 0;
  X.Clear();
  let kf = Z.Key!.KFlds;
  while (kf !== null) {
    i++;
    const zz = Z.Arg[i];
    switch (kf.FldD!.FrmlTyp) {
      case 'S':
        X.StoreStr(RunShortStr(zz), kf);
        break;
      case 'R':
        X.StoreReal(RunReal(zz), kf);
        break;
      case 'B':
        X.StoreBool(RunBool(zz), kf);
        break;
    }
    kf = kf.Chain;
  }
}
// PAS: RUNFRML.PAS Owned – sum/count over the member records of LD (owner = CRecPtr)
export function Owned(Bool: FrmlPtr, Sum: FrmlPtr, LD: LinkDPtr): float {
  const a = AccessVars;
  const x = new XString();
  x.PackKF(LD!.ToKey!.KFlds);
  const cf = a.CFile;
  const cr = a.CRecPtr;
  a.CFile = LD!.FromFD;
  const md = NewLMode(RdMode);
  TestXFExist();
  const K = GetFromKey(LD);
  let r: float;
  if (Bool === null && Sum === null && !a.CFile!.IsSQLFile) {
    const nBeg = ref(0);
    const n = ref(0);
    K!.FindNr(x, nBeg);
    x.S = x.S + '\xff';
    K!.FindNr(x, n);
    r = n.v - nBeg.v;
  } else {
    r = 0;
    a.CRecPtr = GetRecSpace();
    const Scan = new XScan().Init(a.CFile, K, null, true);
    Scan.ResetOwner(x, null);
    for (;;) {
      // 1:
      Scan.GetRec();
      if (Scan.EOF) break;
      if (RunBool(Bool)) {
        if (Sum === null) r = r + 1;
        else r = r + RunReal(Sum);
      }
    }
    Scan.Close();
  }
  OldLMode(md);
  a.CFile = cf;
  a.CRecPtr = cr;
  return r;
}

// ---------------------------------------------------------------- RunReal

// PAS: RUNFRML.PAS RunReal.RunRealStr
function RunRealStr(X: FrmlElem): float {
  switch (X.Op) {
    case _valdate:
      return ValDate(RunShortStr(X.P1), X.Mask);
    case _val: {
      const R = ref(0);
      const I = ref(0);
      ValR(LeadChar(' ', TrailChar(' ', RunShortStr(X.P1))), R, I);
      return R.v;
    }
    case _length:
      return RunLongStr(X.P1).length;
    case _linecnt: {
      const S = RunLongStr(X.P1);
      return Math.trunc(CountDLines(S, S.length, '\r'));
    }
    case _ord: {
      const S = RunLongStr(X.P1);
      let n = 0;
      if (S.length > 0) n = S[0];
      return n;
    }
    case _prompt:
      return PromptR(RunShortStr(X.P1), X.P2, X.FldD);
    case _pos: {
      const S = RunLongStr(X.P2);
      const Mask = RunShortStr(X.P1);
      let N = 1;
      if (X.P3 !== null) N = word(RunInt(X.P3));
      let J = 1;
      let I: number;
      for (;;) {
        // 1:
        const L = S.length + 1 - J;
        I = 0;
        if (N > 0 && L > 0) {
          I = FindText(Mask, X.Options, S.subarray(J - 1), L);
          if (I > 0) {
            J = J + I - Mask.length;
            N--;
            if (N > 0) continue;
            I = J - 1;
          }
        }
        break;
      }
      return I;
    }
    case _diskfree: {
      const S = RunLongStr(X.P1);
      return DiskFree(byte(ord(UpCase(chr(S.length > 0 ? S[0] : 0))) - ord('@')));
    }
    default:
      return 0;
  }
}
// PAS: RUNFRML.PAS RunReal.RMod
function RMod(X: FrmlElem): float {
  const R1 = RunReal(X.P1);
  const R2 = RunReal(X.P2);
  return Math.trunc(R1 - Math.trunc(RDivide(R1, R2)) * R2);
}
/** TS-only: DOS.UnpackTime of a packed DOS date/time. */
function UnpackTime(P: number): { year: number; month: number; day: number; hour: number; min: number; sec: number } {
  return {
    sec: (P & 0x1f) * 2,
    min: (P >>> 5) & 0x3f,
    hour: (P >>> 11) & 0x1f,
    day: (P >>> 16) & 0x1f,
    month: (P >>> 21) & 0x0f,
    year: ((P >>> 25) & 0x7f) + 1980,
  };
}
// PAS: RUNFRML.PAS RunReal.LastUpdate
function LastUpdate(Handle: number): float {
  const dt = UnpackTime(GetDateTimeH(Handle));
  return RDate(dt.year, dt.month, dt.day, dt.hour, dt.min, dt.sec, 0);
}
// PAS: RUNFRML.PAS RunReal.TypeDay – BP7: the FAND.CFG working-days table first
function TypeDay(R: float): number {
  const bv = BaseVars;
  if (R >= bv.WDaysFirst && R <= bv.WDaysLast) {
    const d = word(Math.trunc(R - bv.WDaysFirst));
    for (let i = 1; i <= bv.NWDaysTab; i++) {
      const it = bv.WDaysTab[i];
      if (it !== undefined && it.Nr === d) return it.Typ;
    }
  }
  let d = Math.trunc(R) % 7;
  switch (d) {
    case 0:
      d = 2; // Su
      break;
    case 6:
      d = 1; // Sa
      break;
    default:
      d = 0;
  }
  return d;
}
// PAS: RUNFRML.PAS RunReal.AddWDays
function AddWDays(R: float, N: number, d: number): float {
  N = int16(N);
  if (N > 0) {
    while (N > 0 && R <= 748383.0 /* 2050 */) {
      R = R + 1;
      if (TypeDay(R) === d) N--;
    }
  } else {
    while (N < 0 && R >= 1) {
      R = R - 1;
      if (TypeDay(R) === d) N++;
    }
  }
  return R;
}
// PAS: RUNFRML.PAS RunReal.DifWDays
function DifWDays(R1: float, R2: float, d: number): float {
  let N = 0;
  let x1 = R1;
  let x2 = R2;
  let neg = false;
  if (x1 > x2) {
    x1 = R2;
    x2 = R1;
    neg = true;
  }
  x1 = x1 + 1;
  if (x1 >= 697248.0 /* 1910 */ && x2 <= 748383.0 /* 2050 */) {
    while (x1 <= x2) {
      if (TypeDay(x1) === d) N = int16(N + 1);
      x1 = x1 + 1;
    }
  }
  if (neg) N = -N;
  return Math.trunc(N);
}
// PAS: RUNFRML.PAS RunReal.GetFileSize – size of the file CPath, -1 when it cannot be opened
function GetFileSize(): number {
  const bv = BaseVars;
  TestMountVol(bv.CPath[0] ?? '\0');
  let um = RdOnly;
  if (IsNetCVol()) um = Shared;
  const h = OpenH(_isoldfile, um);
  if (bv.HandleError !== 0) return -1;
  const result = FileSizeH(h);
  CloseH(h);
  return result;
}
// PAS: RUNFRML.PAS RunReal.RecNoFun
function RecNoFun(Z: FrmlElem): number {
  const a = AccessVars;
  const x = new XString();
  GetRecNoXString(Z, x);
  const cf = a.CFile;
  const cr = a.CRecPtr;
  const k = Z.Key;
  a.CFile = Z.FD;
  const md = NewLMode(RdMode);
  a.CRecPtr = GetRecSpace();
  const n = ref(0);
  if (a.CFile!.NRecs > 0) {
    let b: boolean;
    if (a.CFile!.Typ === 'X') {
      TestXFExist();
      b = k!.SearchIntvl(x, false, n);
    } else b = SearchKey(x, k, n);
    if (!b) n.v = -n.v;
  } else n.v = -1;
  OldLMode(md);
  a.CFile = cf;
  a.CRecPtr = cr;
  return n.v;
}
// PAS: RUNFRML.PAS RunReal.AbsLogRecNoFun – RECNOABS/RECNOLOG
function AbsLogRecNoFun(Z: FrmlElem): number {
  const a = AccessVars;
  let result = 0;
  const cf = a.CFile;
  const cr = a.CRecPtr;
  const k = Z.Key;
  const N = RunInt(Z.Arg[1]);
  if (N <= 0) return result;
  a.CFile = Z.FD;
  const md = NewLMode(RdMode);
  body: {
    if (N > a.CFile!.NRecs) break body;
    if (a.CFile!.Typ === 'X') {
      TestXFExist();
      if (Z.Op === _recnolog) {
        a.CRecPtr = GetRecSpace();
        ReadRec(N);
        if (DeletedFlag()) break body;
        result = k!.RecNrToNr(N);
      } else {
        // _recnoabs
        if (N > k!.NRecs()) break body;
        result = k!.NrToRecNr(N);
      }
    } else result = N;
  }
  // 1:
  OldLMode(md);
  a.CFile = cf;
  a.CRecPtr = cr;
  return result;
}
// PAS: RUNFRML.PAS RunReal.LinkProc – LINK(file[recno] / recvar, role): the linked record number
function LinkProc(X: FrmlElem): float {
  const a = AccessVars;
  const cf = a.CFile;
  const cr = a.CRecPtr;
  const LD = X.LinkLD!;
  a.CFile = LD.FromFD;
  const N = ref(0);
  if (X.LinkFromRec) a.CRecPtr = X.LinkLV!.RecPtr as Uint8Array;
  else {
    N.v = RunInt(X.LinkRecFrml);
    const md = NewLMode(RdMode);
    if (N.v <= 0 || N.v > a.CFile!.NRecs) {
      Set2MsgPar(a.CFile!.Name, LD.RoleName);
      RunErrorM(md, 609);
    }
    a.CRecPtr = GetRecSpace();
    ReadRec(N.v);
    OldLMode(md);
  }
  if (!LinkUpw(LD, N, false)) N.v = -N.v;
  a.CFile = cf;
  a.CRecPtr = cr;
  return Math.trunc(N.v);
}
// PAS: RUNFRML.PAS RunReal.IntTSR – FPC: no interrupt call; a local variable argument is written back
function IntTSR(X: FrmlElem): number {
  const IntNr = RunInt(X.P1);
  const FunNr = RunInt(X.P2);
  void IntNr;
  void FunNr;
  const z = X.P3;
  let s = '';
  let b = false;
  let r = 0;
  switch (chr(X.N31)) {
    case 'r':
      break; // p:=z (a record buffer)
    case 'S':
      s = RunShortStr(z);
      break;
    case 'B':
      b = RunBool(z);
      break;
    case 'R':
      r = RunReal(z);
      break;
  }
  if (z !== null && z instanceof FrmlElem && z.Op === _getlocvar) {
    const bp = BaseVars.MyBP!;
    switch (chr(X.N31)) {
      case 'R':
        bp.V[z.BPOfs] = r;
        break;
      case 'S': {
        const ss = CopyToLongStr(s);
        const tw = AccessVars.TWork;
        tw.Delete(FrameV(z.BPOfs) as number);
        bp.V[z.BPOfs] = tw.Store(ss);
        break;
      }
      case 'B':
        bp.V[z.BPOfs] = b;
        break;
    }
  }
  return 0; // FPC: the result of the (not executed) interrupt
}
// PAS: RUNFRML.PAS RunReal.PortIn (FPC: 0)
function PortIn(IsWord: boolean, Port: number): number {
  return 0;
}

// PAS: RUNFRML.PAS RunReal
export function RunReal(X: FrmlPtr): float {
  const a = AccessVars;
  const bv = BaseVars;
  if (X === null) return 0;
  for (;;) {
    // 1:
    switch (X.Op) {
      case _field:
        return _R(X.Field);
      case _getlocvar:
        return FrameV(X.BPOfs) as number;
      case _const:
        return X.R;
      case _plus:
        return RunReal(X.P1) + RunReal(X.P2);
      case _minus:
        return RunReal(X.P1) - RunReal(X.P2);
      case _times:
        return RunReal(X.P1) * RunReal(X.P2);
      case _access: {
        const cf = a.CFile;
        const cr = a.CRecPtr;
        const RecNo = ref(0);
        if (X.LD !== null) LinkUpw(X.LD, RecNo, false);
        else LinkLastRec(X.File2, RecNo, false);
        const result = RunReal(X.P1);
        a.CFile = cf;
        a.CRecPtr = cr;
        return result;
      }
      case _recvarfld: {
        const cf = a.CFile;
        const cr = a.CRecPtr;
        a.CFile = X.File2;
        a.CRecPtr = X.NewRP;
        const result = RunReal(X.P1);
        a.CFile = cf;
        a.CRecPtr = cr;
        return result;
      }
      case _eval:
        return RunReal(GetEvalFrml(X));
      case _divide:
        return RDivide(RunReal(X.P1), RunReal(X.P2));
      case _cond: {
        // 2:
        let c: FrmlElem = X;
        for (;;) {
          if (c.P1 !== null && !RunBool(c.P1)) {
            if (c.P3 === null) return 0;
            c = c.P3;
            continue;
          }
          break;
        }
        X = c.P2;
        if (X === null) return 0;
        continue; // goto 1
      }
      case _newfile: {
        const cf = a.CFile;
        const cr = a.CRecPtr;
        a.CFile = X.NewFile;
        a.CRecPtr = X.NewRP;
        const result = RunReal(X.Frml);
        a.CFile = cf;
        a.CRecPtr = cr;
        return result;
      }
      case _getwordvar:
        return Math.trunc(WordVarArr[X.N01]);
      case _div:
        return Math.trunc(RDivide(RunReal(X.P1), RunReal(X.P2)));
      case _mod:
        return RMod(X);
      case _unminus:
        return -RunReal(X.P1);
      case _today:
        return Today();
      case _pi:
        return Math.PI;
      case _random:
        return Random();
      case _round:
        return RoundReal(RunReal(X.P1), RunInt(X.P2));
      case _abs:
        return Math.abs(RunReal(X.P1));
      case _int:
        return Math.trunc(RunReal(X.P1));
      case _frac: {
        const r = RunReal(X.P1);
        return r - Math.trunc(r);
      }
      case _sqr: {
        const r = RunReal(X.P1);
        return r * r;
      }
      case _sqrt: {
        const r = RunReal(X.P1);
        if (r < 0) SysRunError(207);
        return Math.sqrt(r);
      }
      case _sin:
        return Math.sin(RunReal(X.P1));
      case _cos:
        return Math.cos(RunReal(X.P1));
      case _arctan:
        return Math.atan(RunReal(X.P1));
      case _ln: {
        const r = RunReal(X.P1);
        if (r <= 0) SysRunError(207);
        return Math.log(r);
      }
      case _exp: {
        const R = RunReal(X.P1);
        if (R <= -50 || R > 88) return 0;
        return Math.exp(R);
      }
      case _nrecs:
      case _nrecsabs: {
        const cf = a.CFile;
        a.CFile = X.FD;
        const md = NewLMode(RdMode);
        let RecNo: number;
        if (X.Op === _nrecs) RecNo = XNRecs(a.CFile!.Keys);
        else RecNo = a.CFile!.NRecs;
        OldLMode(md);
        a.CFile = cf;
        return Math.trunc(RecNo);
      }
      case _generation: {
        const cf = a.CFile;
        a.CFile = X.FD;
        const result = Math.trunc(Generation());
        a.CFile = cf;
        return result;
      }
      case _lastupdate: {
        const cf = a.CFile;
        a.CFile = X.FD;
        const md = NewLMode(RdMode);
        const result = LastUpdate(a.CFile!.Handle);
        OldLMode(md);
        a.CFile = cf;
        return result;
      }
      case _catfield: {
        RdCatPathVol(X.CatIRec);
        TestMountVol(bv.CPath[0] ?? '\0');
        const h = OpenH(_isoldfile, RdOnly);
        const result = LastUpdate(h);
        CloseH(h);
        return result;
      }
      case _currtime:
        return CurrTime();
      case _typeday:
        return TypeDay(RunReal(X.P1));
      case _addwdays:
        return AddWDays(RunReal(X.P1), RunInt(X.P2), X.N21);
      case _difwdays:
        return DifWDays(RunReal(X.P1), RunReal(X.P2), X.N21);
      case _addmonth:
        return AddMonth(RunReal(X.P1), RunReal(X.P2));
      case _difmonth:
        return DifMonth(RunReal(X.P1), RunReal(X.P2));
      case _recno:
        return RecNoFun(X);
      case _recnoabs:
      case _recnolog:
        return AbsLogRecNoFun(X);
      case _accrecno: {
        const cf = a.CFile;
        const cr = a.CRecPtr;
        AccRecNoProc(X, 640);
        const result = _R(X.RecFldD);
        a.CFile = cf;
        a.CRecPtr = cr;
        return result;
      }
      case _link:
        return LinkProc(X);
      case _memavail: {
        const n = StoreAvail();
        if (n > 655360) return 655360.0;
        return Math.trunc(n);
      }
      case _maxcol:
        return Math.trunc(bv.TxtCols);
      case _maxrow:
        return Math.trunc(bv.TxtRows);
      case _exitcode:
        return bv.LastExitCode;
      case _edrecno:
        return a.EdRecNo;
      case _txtpos:
        return a.LastTxtPos;
      case _txtxy:
        return a.TxtXY;
      case _cprinter:
        return bv.prCurr;
      case _mousex:
        if (DriversVars.IsGraphMode) return DriversVars.Event.WhereG.X;
        return DriversVars.Event.Where.X + 1;
      case _mousey:
        if (DriversVars.IsGraphMode) return DriversVars.Event.WhereG.Y;
        return DriversVars.Event.Where.Y + 1;
      case _filesize:
        SetTxtPathVol(X.TxtPath, X.TxtCatIRec);
        return GetFileSize();
      case _inttsr:
        return IntTSR(X);
      case _userfunc: {
        const result = RunUserFunc(X).v as number;
        PopProcStk();
        return result;
      }
      case _indexnrecs:
        return X.WKey!.NRecs();
      case _owned:
        return Owned(X.ownBool, X.ownSum, X.ownLD);
      case _color:
        return AColor(MinW(word(RunInt(X.P1)), 53));
      case _portin:
        return PortIn(RunBool(X.P1), word(RunInt(X.P2)));
      case _setmybp: {
        const cr = bv.MyBP;
        SetMyBP(bv.ProcMyBP);
        const result = RunReal(X.P1);
        SetMyBP(cr);
        return result;
      }
      default:
        return RunRealStr(X);
    }
  }
}
// PAS: RUNFRML.PAS RunInt – trunc(RunReal)
export function RunInt(Z: FrmlPtr): number {
  return Math.trunc(RunReal(Z));
}

// ---------------------------------------------------------------- RunLongStr

// PAS: RUNFRML.PAS RunLongStr.ConcatLongStr (FPC) – S1+S2, at most MaxLStrLen
function ConcatLongStr(S1: LongStrPtr, S2: LongStrPtr): LongStrPtr {
  let n = S2.length;
  if (n > MaxLStrLen - S1.length) n = MaxLStrLen - S1.length;
  const r = new Uint8Array(S1.length + n);
  r.set(S1, 0);
  r.set(S2.subarray(0, n), S1.length);
  return r;
}
// PAS: RUNFRML.PAS RunLongStr.CopyLongStr (FPC) – Number bytes from From (1-based)
function CopyLongStr(S: LongStrPtr, From: number, Number: number): LongStrPtr {
  From = word(From);
  Number = word(Number);
  if (From > 0) From--;
  if (From >= S.length) return new Uint8Array(0);
  const avail = S.length - From;
  if (avail < Number) Number = avail;
  return S.slice(From, From + Number);
}
// PAS: RUNFRML.PAS RunLongStr.AddToLongStr – append at most MaxLStrLen-LL bytes of P
function AddToLongStr(S: number[], P: ArrayLike<number>, L: number): void {
  L = MinW(word(L), MaxLStrLen - S.length);
  for (let i = 0; i < L; i++) S.push(P[i]);
}
// PAS: RUNFRML.PAS RunLongStr.StrMask – STR(number, mask)
function StrMask(R: float, Mask: Ref<string>): void {
  let sw = 2;
  let l = Mask.v.length;
  let n = 0;
  let pos = l + 1;
  let pos1 = pos;
  for (let i = l; i >= 1; i--) {
    const c = Mask.v[i - 1];
    if (c === ',') {
      if (sw === 2) sw = 1;
    } else if (c === '0' || c === '*' || c === '_') {
      if (c === '_') {
        if (sw === 1) pos1 = i;
      } else pos = i;
      // 1:
      if (sw === 1) sw = 0;
      else if (sw === 2) n++;
    }
  }
  if (sw === 2) n = 0;
  R = R * Power10[n];
  R = RoundReal(R, 0);
  let minus = false;
  let Num: string;
  if (R === 0) Num = '';
  else {
    if (R < 0) {
      minus = true;
      R = -R;
    }
    if (Number.isNaN(R)) Num = 'NAN';
    else if (!Number.isFinite(R)) Num = 'INF';
    else Num = StrR(R, 1, 0);
    pos = MinW(pos, pos1);
  }
  let i = Num.length;
  if (Num === 'INF' || Num === 'NAN') {
    let m = Num;
    while (m.length < l) m = ' ' + m;
    Mask.v = m;
    return;
  }
  const M = Mask.v.split('');
  while (l > 0) {
    const c = M[l - 1];
    let lbl = 0; // 2 or 3: the Pascal labels
    switch (c) {
      case '0':
      case '*':
        if (i > 0) lbl = 3;
        break;
      case '.':
      case ',':
        if (i === 0 && l < pos) lbl = 2;
        break;
      case '-':
        if (minus) minus = false;
        else M[l - 1] = ' ';
        break;
      case '_':
        if (i === 0) {
          if (l >= pos) M[l - 1] = '0';
          else lbl = 2;
        } else lbl = 3;
        break;
    }
    if (lbl === 2) {
      if (minus) {
        minus = false;
        M[l - 1] = '-';
      } else M[l - 1] = ' ';
    } else if (lbl === 3) {
      M[l - 1] = Num[i - 1];
      i--;
    }
    l--;
  }
  let res = M.join('');
  if (i > 0) res = ShortStr(Copy(Num, 1, i) + res);
  if (minus) res = ShortStr('-' + res);
  Mask.v = res;
}
// PAS: RUNFRML.PAS RunLongStr.RunS – the functions with a short string result
function RunS(Z: FrmlElem): LongStrPtr {
  const a = AccessVars;
  const dv = DriversVars;
  let s = '';
  switch (Z.Op) {
    case _char:
      s = chr(Math.trunc(RunReal(Z.P1)));
      break;
    case _strdate:
      s = StrDate(RunReal(Z.P1), Z.Mask);
      break;
    case _str:
      if (Z.P3 !== null) {
        const r = RunReal(Z.P1);
        const l = word(RunInt(Z.P2));
        const m = byte(RunInt(Z.P3));
        // Str's width is an integer: the word l = 65535 (from -1) is width -1
        if (m === 255) s = StrR(r, int16(l));
        else s = StrR(r, int16(l), m);
        s = ShortStr(s);
      } else {
        const ms = ref(RunShortStr(Z.P2));
        StrMask(RunReal(Z.P1), ms);
        s = ms.v;
      }
      break;
    case _replace: {
      const t = RunLongStr(Z.P2);
      s = RunShortStr(Z.P1);
      let j = 1;
      const snew = RunShortStr(Z.P3);
      const tnew: number[] = [];
      let l: number;
      for (;;) {
        // 1:
        l = t.length - (j - 1);
        if (l > 0) {
          const i = FindText(s, Z.Options, t.subarray(j - 1), l);
          if (i > 0) {
            AddToLongStr(tnew, t.subarray(j - 1), i - s.length - 1);
            AddToLongStr(tnew, StrToLong(snew), snew.length);
            j += i - 1;
            continue;
          }
        }
        break;
      }
      AddToLongStr(tnew, t.subarray(j - 1), l);
      return Uint8Array.from(tnew);
    }
    case _prompt:
      s = PromptS(RunShortStr(Z.P1), Z.P2, Z.FldD);
      break;
    case _getpath:
      s = '.*';
      if (Z.P1 !== null) s = RunShortStr(Z.P1);
      s = SelectDiskFile(s, 35, false);
      break;
    case _catfield:
      s = RdCatField(Z.CatIRec, Z.CatFld);
      if (Z.CatFld === a.CatPathName) s = FExpand(s);
      break;
    case _password:
      s = PassWord(false);
      break;
    case _readkey:
      ReadKbd();
      s = chr(dv.KbdChar & 0xff);
      if (s === '\0') {
        const h = (dv.KbdChar >> 8) & 0xff;
        if (h === 0) s += '\x03';
        else if (h === 3) s += '\x84';
        else s += chr(h);
      }
      break;
    case _username:
      s = a.UserName;
      break;
    case _accright:
      s = a.AccRight;
      break;
    case _version:
      s = BaseVars.Version;
      break;
    case _edfield:
      s = a.EdField;
      break;
    case _edfile:
      s = '';
      if (RdRunVars.EditDRoot !== null) s = RdRunVars.EditDRoot.FD!.Name;
      break;
    case _edkey:
      s = a.EdKey;
      break;
    case _edreckey:
      s = a.EdRecKey;
      break;
    case _getenv:
      s = RunShortStr(Z.P1);
      if (s === '') s = ParamStr(0);
      else s = ShortStr(GetEnv(s));
      break;
    case _keyof: {
      const cf = a.CFile;
      const cr = a.CRecPtr;
      a.CFile = Z.LV!.FD;
      a.CRecPtr = Z.LV!.RecPtr as Uint8Array;
      const x = new XString();
      x.PackKF(Z.PackKey!.KFlds);
      s = x.S;
      a.CFile = cf;
      a.CRecPtr = cr;
      break;
    }
    case _keybuf:
      while (KeyPressed()) AddToKbdBuf(ReadKey());
      s = dv.KbdBuffer;
      break;
    case _recno: {
      const x = new XString();
      GetRecNoXString(Z, x);
      s = x.S;
      break;
    }
    case _edbool: {
      s = '';
      const e = RdRunVars.EditDRoot;
      if (e !== null && e.Select && e.BoolTxt !== null) s = e.BoolTxt;
      break;
    }
  }
  return CopyToLongStr(s);
}
// PAS: RUNFRML.PAS RunLongStr.RunSelectStr – SELECTSTR(x, y, items, head, lowtxt, mode)
function RunSelectStr(Z: FrmlElem): LongStrPtr {
  const ss = WwMixVars.ss;
  const s = RunLongStr(Z.P3);
  let n = CountDLines(s, s.length, Z.Delim);
  for (let i = 1; i <= n; i++) {
    const x = ShortStr(GetDLine(s, s.length, Z.Delim, i), 80);
    if (x !== '') PutSelect(x);
  }
  const mode = ShortStr(RunShortStr(Z.P6), 5);
  for (let i = 0; i < mode.length; i++) {
    switch (UpCase(mode[i])) {
      case 'A':
        ss.Abcd = true;
        break;
      case 'S':
        ss.Subset = true;
        break;
      case 'I':
        ss.ImplAll = true;
        break;
    }
  }
  SetMsgPar(RunShortStr(Z.P4));
  SelectStr(RunInt(Z.P1), RunInt(Z.P2), 110, RunShortStr(Z.P5));
  const s2: number[] = [];
  n = 1;
  BaseVars.LastExitCode = 0;
  if (DriversVars.KbdChar === _ESC_) BaseVars.LastExitCode = 1;
  else {
    let x: string;
    do {
      x = GetSelect();
      if (x !== '') {
        if (n > 1) {
          s2.push(13);
          n++;
        }
        for (let i = 0; i < x.length; i++) s2.push(x.charCodeAt(i));
        n += x.length;
      }
    } while (ss.Subset && x !== '');
  }
  return Uint8Array.from(s2); // n-1 bytes
}
// PAS: RUNFRML.PAS RunLongStr.LowCase (BP7 asm: A..Z, and chars >= $80 through UpcCharTab[128..254])
function LowCase(S: LongStrPtr): void {
  const tab = BaseVars.UpcCharTab;
  for (let i = 0; i < S.length; i++) {
    const c = S[i];
    if (c < 0x80) {
      if (c >= 0x41 && c <= 0x5a) S[i] = c + 0x20;
    } else {
      for (let j = 128; j <= 254; j++) {
        if (tab[j] === c && j !== c) {
          S[i] = j;
          break;
        }
      }
    }
  }
}
// PAS: RUNFRML.PAS RunLongStr
export function RunLongStr(X: FrmlPtr): LongStrPtr {
  const a = AccessVars;
  const bv = BaseVars;
  if (X === null) return new Uint8Array(0);
  for (;;) {
    // 1:
    switch (X.Op) {
      case _field:
        return _LongS(X.Field);
      case _getlocvar:
        return a.TWork.Read(1, FrameV(X.BPOfs) as number);
      case _access: {
        const cf = a.CFile;
        const cr = a.CRecPtr;
        a.CFile = X.File2;
        const md = NewLMode(RdMode);
        const RecNo = ref(0);
        if (X.LD !== null) {
          a.CFile = cf;
          LinkUpw(X.LD, RecNo, true);
        } else LinkLastRec(X.File2, RecNo, true);
        const S = RunLongStr(X.P1);
        OldLMode(md); // possibly reading .T
        ClearRecSpace(a.CRecPtr!);
        a.CFile = cf;
        a.CRecPtr = cr;
        return S;
      }
      case _recvarfld: {
        const cf = a.CFile;
        const cr = a.CRecPtr;
        a.CFile = X.File2;
        a.CRecPtr = X.NewRP;
        const result = RunLongStr(X.P1);
        a.CFile = cf;
        a.CRecPtr = cr;
        return result;
      }
      case _eval:
        return RunLongStr(GetEvalFrml(X));
      case _newfile: {
        const cf = a.CFile;
        const cr = a.CRecPtr;
        a.CFile = X.NewFile;
        a.CRecPtr = X.NewRP;
        const result = RunLongStr(X.Frml);
        a.CFile = cf;
        a.CRecPtr = cr;
        return result;
      }
      case _cond: {
        // 2:
        let c: FrmlElem = X;
        for (;;) {
          if (c.P1 !== null && !RunBool(c.P1)) {
            if (c.P3 === null) return new Uint8Array(0);
            c = c.P3;
            continue;
          }
          break;
        }
        X = c.P2;
        if (X === null) return new Uint8Array(0);
        continue; // goto 1
      }
      case _copy: {
        const S = RunLongStr(X.P1);
        const L1 = RunInt(X.P2);
        const L2 = RunInt(X.P3);
        if (L1 < 0 || L2 < 0) return new Uint8Array(0);
        return CopyLongStr(S, L1, L2);
      }
      case _concat: {
        const S = RunLongStr(X.P1);
        return ConcatLongStr(S, RunLongStr(X.P2));
      }
      case _const:
        return CopyToLongStr(X.S);
      case _leadchar:
        return LongLeadChar(chr(X.N11), chr(X.N12), RunLongStr(X.P1));
      case _trailchar:
        return LongTrailChar(chr(X.N11), chr(X.N12), RunLongStr(X.P1));
      case _upcase: {
        const S = RunLongStr(X.P1);
        const tab = bv.UpcCharTab;
        for (let i = 0; i < S.length; i++) S[i] = tab[S[i]];
        return S;
      }
      case _lowcase: {
        const S = RunLongStr(X.P1);
        LowCase(S);
        return S;
      }
      case _copyline: {
        let j = 1;
        if (X.P3 !== null) j = RunInt(X.P3);
        return CopyLine(RunLongStr(X.P1), RunInt(X.P2), j);
      }
      case _repeatstr:
        return RepeatStr(RunLongStr(X.P1), int16(RunInt(X.P2)));
      case _accrecno: {
        const cf = a.CFile;
        const cr = a.CRecPtr;
        AccRecNoProc(X, 640);
        const S = _LongS(X.RecFldD);
        a.CFile = cf;
        a.CRecPtr = cr;
        return S;
      }
      case _gettxt:
        return GetTxt(X);
      case _nodiakr: {
        const S = RunLongStr(X.P1);
        ConvToNoDiakr(S, S.length, bv.Fonts.VFont);
        return S;
      }
      case _userfunc: {
        const cr = RunUserFunc(X);
        const L1 = cr.v as number;
        cr.v = 0;
        PopProcStk();
        const result = a.TWork.Read(1, L1);
        a.TWork.Delete(L1);
        return result;
      }
      case _setmybp: {
        const cr = bv.MyBP;
        SetMyBP(bv.ProcMyBP);
        const result = RunLongStr(X.P1);
        SetMyBP(cr);
        return result;
      }
      case _selectstr:
        return RunSelectStr(X);
      case _clipbd:
        return a.TWork.Read(1, a.ClpBdPos);
      default:
        return RunS(X);
    }
  }
}

// PAS: RUNFRML.PAS RunShortStr – RunLongStr truncated to 255
export function RunShortStr(X: FrmlPtr): string {
  const s = RunLongStr(X);
  let n = s.length;
  if (n > 255) n = 255;
  return BytesToStr(s, 0, n);
}

// ---------------------------------------------------------------- RunBool

// PAS: RUNFRML.PAS RunBool.InReal – R in the constant list L (count byte + doubles, $FF = interval)
function InReal(R: float, L: Uint8Array, M: number): boolean {
  const dv = new DataView(L.buffer, L.byteOffset, L.byteLength);
  const Cr = (o: number): float => dv.getFloat64(o, true);
  let o = 0;
  for (;;) {
    // 1:
    const N = L[o];
    o++;
    if (N === 0) return false;
    if (N === 0xff) {
      if (CompReal(R, Cr(o), M) === ord(_lt)) o += 2 * 8;
      else {
        o += 8;
        if (CompReal(R, Cr(o), M) !== ord(_gt)) return true;
        o += 8;
      }
    } else {
      for (let I = 1; I <= N; I++) {
        if (CompReal(R, Cr(o), M) === ord(_equ)) return true;
        o += 8;
      }
    }
  }
}
// PAS: RUNFRML.PAS RunBool.LexInStr – lexical (CompLexLongShortStr) string list test
function LexInStr(S: LongStrPtr, L: Uint8Array): boolean {
  let o = 0;
  for (;;) {
    // 1:
    const N = L[o];
    o++;
    if (N === 0) return false;
    if (N === 0xff) {
      if (CompLexLongShortStr(S, GetPStr(L, o)) === ord(_lt)) {
        o += L[o] + 1;
        o += L[o] + 1;
      } else {
        o += L[o] + 1;
        if (CompLexLongShortStr(S, GetPStr(L, o)) !== ord(_gt)) return true;
        o += L[o] + 1;
      }
    } else {
      for (let I = 1; I <= N; I++) {
        if (CompLexLongShortStr(S, GetPStr(L, o)) === ord(_equ)) return true;
        o += L[o] + 1;
      }
    }
  }
}
// PAS: RUNFRML.PAS RunBool.InStr – binary (CompLongShortStr) string list test
function InStr(S: LongStrPtr, L: Uint8Array): boolean {
  let o = 0;
  for (;;) {
    // 1:
    const N = L[o];
    o++;
    if (N === 0) return false;
    if (N === 0xff) {
      if (CompLongShortStr(S, GetPStr(L, o)) === ord(_lt)) {
        o += L[o] + 1;
        o += L[o] + 1;
      } else {
        o += L[o] + 1;
        if (CompLongShortStr(S, GetPStr(L, o)) !== ord(_gt)) return true;
        o += L[o] + 1;
      }
    } else {
      for (let I = 1; I <= N; I++) {
        if (CompLongShortStr(S, GetPStr(L, o)) === ord(_equ)) return true;
        o += L[o] + 1;
      }
    }
  }
}
// PAS: RUNFRML.PAS RunBool.RunModulo – MODULO(s, n, w1, ..): (n - sum(ci*wi) mod n) mod 10 = check digit
function RunModulo(X: FrmlElem): boolean {
  const N = X.W11;
  const S = RunShortStr(X.P1);
  if (S.length !== N) return false;
  let M = 0;
  const B1 = X.Inline ?? new Uint8Array(0);
  for (let I = 1; I <= N - 1; I++) {
    const w = (B1[2 * (I - 1)] ?? 0) | ((B1[2 * (I - 1) + 1] ?? 0) << 8);
    M = int16(M + w * (S.charCodeAt(I - 1) & 0x0f));
  }
  const I = (X.W12 - (M % X.W12)) % 10;
  return I === (S.charCodeAt(N - 1) & 0x0f);
}
// PAS: RUNFRML.PAS RunBool.RunEquMask
function RunEquMask(X: FrmlElem): boolean {
  const s = RunLongStr(X.P1);
  return EqualsMask(s, s.length, RunShortStr(X.P2));
}

// PAS: RUNFRML.PAS RunBool
export function RunBool(X: FrmlPtr): boolean {
  const a = AccessVars;
  const bv = BaseVars;
  const dv = DriversVars;
  if (X === null) return true;
  switch (X.Op) {
    case _and:
      if (RunBool(X.P1)) return RunBool(X.P2);
      return false;
    case _or:
      if (RunBool(X.P1)) return true;
      return RunBool(X.P2);
    case _lneg:
      return !RunBool(X.P1);
    case _limpl:
      if (RunBool(X.P1)) return RunBool(X.P2);
      return true;
    case _lequ:
      return RunBool(X.P1) === RunBool(X.P2);
    case _instr: {
      const S = RunLongStr(X.P1);
      const L = X.Inline ?? Uint8Array.of(0);
      if (X.N11 === 1) return LexInStr(LongTrailChar(' ', '\0', S), L);
      return InStr(S, L);
    }
    case _inreal:
      return InReal(RunReal(X.P1), X.Inline ?? Uint8Array.of(0), X.N11);
    case _compreal:
      return (CompReal(RunReal(X.P1), RunReal(X.P2), X.N22) & X.N21) !== 0;
    case _compstr: {
      const S = RunLongStr(X.P1);
      const S2 = RunLongStr(X.P2);
      let res: number;
      if (X.N22 === 1) res = CompLexLongStr(LongTrailChar(' ', '\0', S), LongTrailChar(' ', '\0', S2));
      else res = CompLongStr(S, S2);
      return (res & X.N21) !== 0;
    }
    case _const:
      return X.B;
    case _mouseevent:
      for (;;) {
        // 2:
        dv.Event.What = 0;
        GetMouseEvent();
        if (dv.Event.What === 0) return false;
        if ((dv.Event.What & X.W01) === 0) continue;
        return true;
      }
    case _ismouse:
      return (dv.Event.What & X.W01) !== 0 && (dv.Event.Buttons & X.W02) === X.W02;
    case _mousein: {
      const w1 = word(RunInt(X.P1));
      const w2 = word(RunInt(X.P2));
      return MouseInRectProc(w1, w2, RunInt(X.P3) - w1 + 1, RunInt(X.P4) - w2 + 1);
    }
    case _getlocvar:
      return FrameV(X.BPOfs) === true;
    case _modulo:
      return RunModulo(X);
    case _field:
      return _B(X.Field);
    case _access: {
      const cf = a.CFile;
      const cr = a.CRecPtr;
      const RecNo = ref(0);
      let b: boolean;
      if (X.LD !== null) b = LinkUpw(X.LD, RecNo, false);
      else b = LinkLastRec(X.File2, RecNo, false);
      let result: boolean;
      if (X.P1 === null) result = b;
      else result = RunBool(X.P1);
      a.CFile = cf;
      a.CRecPtr = cr;
      return result;
    }
    case _recvarfld: {
      const cf = a.CFile;
      const cr = a.CRecPtr;
      a.CFile = X.File2;
      a.CRecPtr = X.NewRP;
      const result = RunBool(X.P1);
      a.CFile = cf;
      a.CRecPtr = cr;
      return result;
    }
    case _eval:
      return RunBool(GetEvalFrml(X));
    case _newfile: {
      const cf = a.CFile;
      const cr = a.CRecPtr;
      a.CFile = X.NewFile;
      a.CRecPtr = X.NewRP;
      const result = RunBool(X.Frml);
      a.CFile = cf;
      a.CRecPtr = cr;
      return result;
    }
    case _prompt:
      return PromptB(RunShortStr(X.P1), X.P2, X.FldD);
    case _promptyn:
      SetMsgPar(RunShortStr(X.P1));
      return PromptYN(110);
    case _accrecno: {
      const cf = a.CFile;
      const cr = a.CRecPtr;
      AccRecNoProc(X, 640);
      const result = _B(X.RecFldD);
      a.CFile = cf;
      a.CRecPtr = cr;
      return result;
    }
    case _edupdated:
      return a.EdUpdated;
    case _keypressed:
      return KeyPressed();
    case _escprompt:
      return a.EscPrompt;
    case _isdeleted: {
      const cr = a.CRecPtr;
      const cf = a.CFile;
      AccRecNoProc(X, 642);
      const result = DeletedFlag();
      a.CRecPtr = cr;
      a.CFile = cf;
      return result;
    }
    case _lvdeleted: {
      const cr = a.CRecPtr;
      const cf = a.CFile;
      a.CRecPtr = X.LV!.RecPtr as Uint8Array;
      a.CFile = X.LV!.FD;
      const result = DeletedFlag();
      a.CRecPtr = cr;
      a.CFile = cf;
      return result;
    }
    case _trust:
      return a.UserCode === 0 || OverlapByteStr(X.Inline !== null ? GetPStr(X.Inline, 0) : '', a.AccRight);
    case _isnewrec:
      return TestIsNewRec();
    case _testmode:
      return a.IsTestRun;
    case _equmask:
      return RunEquMask(X);
    case _userfunc: {
      const result = RunUserFunc(X).v === true;
      PopProcStk();
      return result;
    }
    case _setmybp: {
      const cr = bv.MyBP;
      SetMyBP(bv.ProcMyBP);
      const result = RunBool(X.P1);
      SetMyBP(cr);
      return result;
    }
  }
  return false;
}

// ---------------------------------------------------------------- assignments

// PAS: RUNFRML.PAS TestTFrml – is Z a stored T field / text local (sets TFD02, TF02, TF02Pos)
function TestTFrml(F: FieldDPtr, Z: FrmlPtr): void {
  const a = AccessVars;
  const v = RunFrmlVars;
  const z = Z!;
  switch (z.Op) {
    case _newfile:
      a.CFile = z.NewFile;
      a.CRecPtr = z.NewRP;
      TestTFrml(F, z.Frml);
      break;
    case _field: {
      const f1 = z.Field!;
      if (f1.Typ !== 'T' || (f1.Flg & f_Stored) === 0) return;
      if (F === null) {
        if ((f1.Flg & f_Encryp) !== 0) return;
      } else if ((F.Flg & f_Encryp) !== (f1.Flg & f_Encryp)) return;
      v.TFD02 = a.CFile;
      v.TF02 = a.CFile!.TF;
      if (HasTWorkFlag()) v.TF02 = a.TWork;
      v.TF02Pos = _T(f1);
      break;
    }
    case _getlocvar:
      if (F !== null && (F.Flg & f_Encryp) !== 0) return;
      v.TFD02 = a.CFile;
      v.TF02 = a.TWork;
      v.TF02Pos = FrameV(z.BPOfs) as number;
      break;
    case _access: {
      const cf = a.CFile;
      a.CFile = z.File2;
      const md = NewLMode(RdMode);
      const n = ref(0);
      if (z.LD !== null) {
        a.CFile = cf;
        LinkUpw(z.LD, n, true);
      } else LinkLastRec(z.File2, n, true);
      TestTFrml(F, z.P1);
      a.CFile = z.File2;
      OldLMode(md);
      break;
    }
    case _recvarfld:
      a.CFile = z.File2;
      a.CRecPtr = z.NewRP;
      TestTFrml(F, z.P1);
      break;
  }
}
// PAS: RUNFRML.PAS CanCopyT – can the T-field text of Z be copied into F without decoding
export function CanCopyT(F: FieldDPtr, Z: FrmlPtr): boolean {
  const a = AccessVars;
  const cf = a.CFile;
  const cr = a.CRecPtr;
  RunFrmlVars.TF02 = null;
  TestTFrml(F, Z);
  a.CFile = cf;
  a.CRecPtr = cr;
  return RunFrmlVars.TF02 !== null;
}
// PAS: RUNFRML.PAS TryCopyT – copy the text of Z into TF directly (GETTXT or a T source)
function TryCopyT(F: FieldDPtr, TF: TFile, pos: Ref<number>, Z: FrmlPtr): boolean {
  if (TF.Format === DbtFormat || TF.Format === FptFormat) return false;
  if (Z!.Op === _gettxt) {
    pos.v = CopyTFFromGetTxt(TF, Z);
    return true;
  }
  const v = RunFrmlVars;
  if (CanCopyT(F, Z) && v.TF02!.Format === TF.Format) {
    pos.v = CopyTFString(TF, v.TFD02, v.TF02, v.TF02Pos);
    return true;
  }
  return false;
}

// PAS: RUNFRML.PAS AssgnFrml – F := X in CRecPtr (T fields: Delete old text, Add = '+=')
export function AssgnFrml(F: FieldDPtr, X: FrmlPtr, Delete: boolean, Add: boolean): void {
  const a = AccessVars;
  const f = F!;
  switch (f.FrmlTyp) {
    case 'S':
      if (f.Typ === 'T') {
        const tf = HasTWorkFlag() ? a.TWork : a.CFile!.TF!;
        const pos = ref(0);
        if (TryCopyT(F, tf, pos, X)) {
          if (Delete) DelTFld(F);
          T_(F, pos.v);
        } else {
          const S = RunLongStr(X);
          if (Delete) DelTFld(F);
          LongS_(F, S);
        }
      } else S_(F, RunShortStr(X));
      break;
    case 'R':
      if (Add) R_(F, _R(F) + RunReal(X));
      else R_(F, RunReal(X));
      break;
    case 'B':
      B_(F, RunBool(X));
      break;
  }
}
// PAS: RUNFRML.PAS LVAssignFrml – local variable LV := X; OldBP is the caller's frame for X
export function LVAssignFrml(LV: LocVarPtr, OldBP: ProcStkPtr, Add: boolean, X: FrmlPtr): void {
  const a = AccessVars;
  const lv = LV!;
  const p = LocVarAd(lv);
  const bp = BaseVars.MyBP;
  SetMyBP(OldBP);
  switch (lv.FTyp) {
    case 'S': {
      const pos = ref(0);
      if (!TryCopyT(null, a.TWork, pos, X)) {
        const s = RunLongStr(X);
        pos.v = a.TWork.Store(s);
      }
      a.TWork.Delete((p.v as number) ?? 0);
      p.v = pos.v;
      break;
    }
    case 'R':
      if (Add) {
        const r = RunReal(X);
        p.v = ((p.v as number) ?? 0) + r;
      } else p.v = RunReal(X);
      break;
    case 'B':
      p.v = RunBool(X);
      break;
  }
  SetMyBP(bp);
}

// ---------------------------------------------------------------- display

// PAS: RUNFRML.PAS DecodeFieldRSB – display text of a value of F in LWw columns
export function DecodeFieldRSB(F: FieldDPtr, LWw: number, R: float, T: string, B: boolean, Txt: Ref<string>): void {
  const f = F!;
  const L = f.L;
  const M = f.M;
  const pad = (C: string): void => {
    // 1:
    if (M === LeftJust) {
      while (T.length < L) T = T + C;
    } else {
      while (T.length < L) T = C + T;
    }
  };
  switch (f.Typ) {
    case 'D':
      T = StrDate(R, FieldDMask(f) ?? '');
      break;
    case 'N':
      pad('0');
      break;
    case 'A':
      pad(' ');
      break;
    case 'B':
      if (B) T = BaseVars.AbbrYes;
      else T = BaseVars.AbbrNo;
      break;
    case 'R':
      T = ShortStr(StrR(R, L));
      break;
    default: // 'F'
      if ((f.Flg & f_Comma) !== 0) R = R / Power10[M];
      T = ShortStr(StrR(RoundReal(R, M), L, M));
  }
  if (T.length > L) T = T.slice(0, L - 1) + '>';
  if (T.length > LWw) {
    if (M === LeftJust) T = T.slice(0, LWw);
    else T = Copy(T, T.length - LWw + 1, LWw);
  }
  Txt.v = T;
}

// PAS: RUNFRML.PAS DecodeField – display text of F from CRecPtr
export function DecodeField(F: FieldDPtr, LWw: number, Txt: Ref<string>): void {
  const f = F!;
  let r = 0;
  let s = '';
  let b = false;
  switch (f.FrmlTyp) {
    case 'R':
      r = _R(F);
      break;
    case 'S':
      if (f.Typ === 'T') {
        if ((f.Flg & f_Stored) !== 0 && _T(F) === 0) Txt.v = '.';
        else Txt.v = '*';
        return;
      }
      s = _ShortS(F);
      break;
    default:
      b = _B(F);
  }
  DecodeFieldRSB(F, LWw, r, s, b, Txt);
}

// PAS: RUNFRML.PAS RunWFrml – evaluate a window rectangle (C1,R1,C2,R2 formulas; WFlags relative)
export function RunWFrml(X: WRectFrml, WFlags: number, W: WRect): void {
  W.C1 = byte(RunInt(X.C1));
  W.R1 = byte(RunInt(X.R1));
  W.C2 = byte(RunInt(X.C2));
  W.R2 = byte(RunInt(X.R2));
  CenterWw(fref(W, 'C1'), fref(W, 'R1'), fref(W, 'C2'), fref(W, 'R2'), WFlags);
}
// PAS: RUNFRML.PAS RunWordImpl – RunInt(Z) or Impl when it is 0
export function RunWordImpl(Z: FrmlPtr, Impl: number): number {
  let n = word(RunInt(Z));
  if (n === 0) n = Impl;
  return n;
}
// PAS: RUNFRML.PAS FieldInList
export function FieldInList(F: FieldDPtr, FL: FieldList): boolean {
  let result = false;
  while (FL !== null) {
    if (FL.FldD === F) result = true;
    FL = FL.Chain;
  }
  return result;
}
// PAS: RUNFRML.PAS GetFromKey – the key of LD^.FromFD with LD's index root
export function GetFromKey(LD: LinkDPtr): KeyDPtr {
  let K = LD!.FromFD!.Keys;
  while (K!.IndexRoot !== LD!.IndexRoot) K = K!.Chain;
  return K;
}
// PAS: RUNFRML.PAS RunEvalFrml – `eval(...)`: compile the string formula at run time
export function RunEvalFrml(Z: FrmlPtr): FrmlPtr {
  if (Z !== null && Z.Op === _eval) Z = GetEvalFrml(Z);
  return Z;
}
