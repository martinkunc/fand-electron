// PAS: RUNPROLG.PAS – the Prolog interpreter (L chapters / LPROC): runs the program compiled by
// RDPROLG with a copy stack of terms, an instance stack and a database heap, built-in predicates,
// FAND-file predicates (scanning data files as facts) and calls of FAND procedures.
//
// Porting notes:
// * Program representation: the RDPROLG segment (handle table, see rdprolg.ts): SgPtr(ofs) -> the
//   record; `TPTerm`/`TCommand`/`TPredicate`/`TBranch` offsets stay numbers. Run-time terms (TTerm:
//   Fun + Arity/Arg[] | II | RR | SS | Pos (TWork LongStr) | Elem/Next) are objects "allocated" from
//   Mem1 (copy stack); TInstance (Pred, PrevInst, RetInst, RetCmd, NextBranch, RetBranch, StkMark,
//   WMark, CallLevel, Vars[]) from Mem2.
// * TMemory: with GC'd objects the region allocator only keeps the byte accounting: CurLoc is the
//   number of bytes in use (BP7 sizes), Mark = CurLoc, Release(m) resets it (Release of an object
//   resets to where it was allocated). Alloc/Free (database heap) keep a free byte count. TS-only:
//   more than MemLimit bytes in Mem1+Mem2+Mem3 is RunError 624 (the FPC arena overflow), so a
//   runaway recursion ends like in FAND instead of exhausting the host.
// * Vars[] slots hold a PTerm, and in special cases other objects, as in Pascal: the packed input
//   (Uint8Array) of a database predicate with _PackInpOpt, a TAutoR work record (AutoRecursion),
//   a TDbBranch chain (AppendPackedTerm). NextBranch is the Pascal untyped cursor: a branch offset
//   (number, nil = null), a TDbBranch, a TFileScan or a built-in cursor (FileD, FieldD, KeyD, LinkD,
//   KeyFldD, a list PTerm, or a number for concat).
// * Packed terms: PackedTermPtr is an index into PTBuf (Pascal's local array A or a LongStr); reals
//   are 6-byte Real48 (BP7), see rdprolg.ts.
// * asm/DOS: Ovr (overlay fix-up; the NewExit here gets no Ovr) and the FPC helper InBlk (block test of
//   TMemory.Release) have no counterpart with the object model; Trace/SetCallLevel asm = the FPC
//   Pascal versions.
// * The reference FAND (FPC) differs from BP7, and we follow BP7, in: AutoRecursion (TAutoR and the
//   rebuilt term copy 4*Arity bytes of 8-byte pointers: `p(!,!)` on a functor gives broken terms),
//   ConsultDb (InSg is "within 64K after the segment base", so a database read from a T field right
//   after compiling is taken for the initial one: error 1533), reals printed by write (FPC double
//   format; we print BP7 Real: ` 1.5000000000E+00`).
// * Output of write/trace goes to System.Output (the CRT), as Pascal write/writeln.
// * CallFandProc: the FAND procedure frame is a ProcStkD whose V[BPOfs] slots hold the argument
//   values (PORTING.md 14); RUNPROC.CallProcedure binds TArg[i] (FromProlog) to the procedure's
//   parameters and copies the IsRetPar results back into this frame.

import { ref, aref, chr, ord, Copy, StrI, StrR, ValI, int16, Trunc, Div, getWord, setWord, getInteger, setInteger,
  ShortStr, TxtWrite, TxtWriteln, Output, GoExitSignal, type Ref, type Pointer } from './pasrt.ts';
import { readReal48, writeReal48 } from '../fand/numbers.ts';
import type { LongStrPtr, StringPtr, float } from './base.ts';
import {
  BaseVars, ExitRecord, ProcStkD, NewExit, RestoreExit, GoExit, MarkBoth, MarkStore, ReleaseStore, ReleaseBoth,
  SeekH, ReadH, WriteH, EquLongStr, SEquUpcase, SetMsgPar, Set2MsgPar, RdMsg, ChainLast, MaxLStrLen,
  IsLetter, IsDigit, EmptyStr,
} from './base.ts';
import {
  AccessVars, RdbPos, XString, _const, _conv, _and, _or, _length, _pos, _val, _min, _max, _maxcol, _maxrow, _copy,
  _leadchar, _trailchar, _repeatstr, _str, _getlocvar, _assign, _equ, _lt, _gt, f_Stored, f_Mask, LeftJust,
  WrMode, RdMode, CrMode, DelMode, FieldDMask, ForAllFDs, GetRecSpace, ReadRec, WriteRec, DeleteRec, DeletedFlag,
  ZeroAllFlds, IncNRecs, LinkLastRec, DelTFld, LongS_, _LongS, _ShortS, _R, _B, R_, B_, S_, _T, NewLMode, OldLMode,
  TestXFExist, RecallRec, DeleteXRec,
  type FileDPtr, type FieldDPtr, type FrmlPtr, type KeyDPtr, type KeyFldDPtr, type LinkDPtr, type RdbDPtr, type LockMode,
} from './access.ts';
import { ReadKey, _ESC_ } from './drivers.ts';
import { PromptYN, RunError } from './obaseww.ts';
import { SetInpLongStr, SetInpTTPos, FindChpt, OldError } from './compile.ts';
import { RunLongStr, RunShortStr, RunInt, RunReal, RunBool, LeadChar, TrailChar } from './runfrml.ts';
import { CallProcedure } from './runproc.ts';
import { SetMyBP, type InstrPtr } from './rdrun.ts';
import { CurrToKamen } from './keybd.ts';
import { FindText } from './editor.ts';
import { SetCPathVol } from './oaccess.ts';
import {
  RdPrologVars, ReadProlog, SgPtr, SgMark, SgRelease, InSg, SgDom, SgTerm, SgPred, SgCmd, SgStr, CurSgTable,
  PtrSz, FloatSz, TDbBranch, TFunDcl, TTermList, TWriteD, TScanInf, TFldList, TBranch, TDatabase,
  TProgRoots, TPredicate, TCommand,
  _IntT, _RealT, _StrT, _LongStrT, _ListT, _VarT, _UnderscT, _CioMaskOpt, _PackInpOpt, _FandCallOpt, _BuildInOpt,
  _DbaseOpt, _ConcatP, _NextLexP, _GetLexP, _FandFieldP, _FandFileP, _FandKeyP, _FandKeyFieldP, _FandLinkP,
  _FandLinkFieldP, _MemP, _LenP, _InvP, _AddP, _DelP, _UnionP, _MinusP, _InterP, _AbbrevP, _CallP,
  _IntD, _RealD, _StrD, _LongStrD, _ListD, _FunD,
  _PredC, _FailC, _CutC, _WriteC, _CompC, _AssertC, _RetractC, _SaveC, _ConsultC, _LoadLexC, _Trace, _SelfC,
  _AppPkC, _AppUnpkC, _ErrorC, _WaitC, _NotC, _AllC, _AutoC,
  type PDbBranch,
} from './rdprolg.ts';

export type PMemBlkHd = TMemBlkHd | null;
// PAS: RUNPROLG.PAS TMemBlkHd
export class TMemBlkHd {
  Chain: PMemBlkHd = null;
  Sz = 0;
}

/** TS-only: Mem1+Mem2+Mem3 bytes beyond which Get is RunError 624 (FPC: arena overflow). */
const MemLimit = 16 * 1024 * 1024;

export type PMemory = TMemory | null;
// PAS: RUNPROLG.PAS TMemory – region allocator (copy stack, instance stack, database heap)
export class TMemory {
  RestSz = 0;
  /** TS: bytes in use (Pascal: the next free location) */
  CurLoc = 0;
  CurBlk: PMemBlkHd = null;
  FreeList: PMemBlkHd = null;
  /** TS-only: bytes freed by Free and not yet reused by Alloc (Pascal: FreeList blocks) */
  FreeSz = 0;
  /** TS-only: where each object was allocated, for Release(object) */
  private At = new WeakMap<object, number>();
  // PAS: RUNPROLG.PAS TMemory.Init
  Init(): void {
    this.CurBlk = null;
    this.CurLoc = 0;
    this.RestSz = 0;
    this.FreeList = null;
    this.FreeSz = 0;
    this.At = new WeakMap();
  }
  // PAS: RUNPROLG.PAS TMemory.Get – Sz zeroed bytes; TS: returns Obj (a zeroed record/term), or a
  // zeroed Uint8Array(Sz) when none is given
  Get<T = Uint8Array>(Sz: number, Obj?: T): T {
    const rv = RunPrologVars;
    if (rv.Mem1.CurLoc + rv.Mem2.CurLoc + rv.Mem3.CurLoc + Sz > MemLimit) RunError(624);
    const p = (Obj === undefined ? new Uint8Array(Sz) : Obj) as T;
    if (typeof p === 'object' && p !== null) this.At.set(p as object, this.CurLoc);
    this.CurLoc += Sz;
    return p;
  }
  // PAS: RUNPROLG.PAS TMemory.Mark
  Mark(): Pointer {
    return this.CurLoc;
  }
  // PAS: RUNPROLG.PAS TMemory.Release – free everything allocated after mark P (a Mark result or an
  // object allocated here)
  Release(P: Pointer): void {
    if (P === null || P === undefined) this.CurLoc = 0;
    else if (typeof P === 'number') this.CurLoc = P;
    else {
      const n = this.At.get(P as object);
      if (n !== undefined) this.CurLoc = n;
    }
    if (this.CurLoc === 0) this.RestSz = 0;
  }
  // PAS: RUNPROLG.PAS TMemory.StoreStr
  StoreStr(s: string): StringPtr {
    this.Get(s.length + 1);
    return s;
  }
  // PAS: RUNPROLG.PAS TMemory.Alloc – from the free list (database heap)
  Alloc<T = Uint8Array>(Sz: number, Obj?: T): T {
    Sz = (Sz + 7) & 0xfff8;
    if (this.FreeSz >= Sz) {
      this.FreeSz -= Sz;
      return (Obj === undefined ? new Uint8Array(Sz) : Obj) as T;
    }
    return this.Get(Sz, Obj);
  }
  // PAS: RUNPROLG.PAS TMemory.Free
  Free(P: Pointer, Sz: number): void {
    this.FreeSz += (Sz + 7) & 0xfff8;
  }
}

export const RunPrologVars = {
  FreeMemList: null as PMemBlkHd,
  Mem1: new TMemory(), // copy-stack
  Mem2: new TMemory(), // instance-stack
  Mem3: new TMemory(), // db-heap
  ProlgCallLevel: 0,
};

const MaxPackedPredLen = 4000;

export type PTerm = TTerm | null;
// PAS: RUNPROLG.PAS TTerm – case Fun of 0: (Arity; Arg[0..]) | _IntT: (II) | _RealT: (RR) |
// _StrT: (SS) | _LongStrT: (Pos) | _ListT: (Elem, Next)
export class TTerm {
  Fun = 0;
  Arity = 0;
  Arg: PTerm[] = [];
  II = 0;
  RR: float = 0;
  SS = '';
  Pos = 0;
  Elem: PTerm = null;
  Next: PTerm = null;
}

export type PInstance = TInstance | null;
// PAS: RUNPROLG.PAS TInstance – Vars[0..] sized by the predicate's InstSz
export class TInstance {
  Pred = 0; // {PPredicate}
  PrevInst: PInstance = null;
  RetInst: PInstance = null;
  RetCmd = 0; // {PCommand}
  NextBranch: Pointer = null; // PBranch offset / PDbBranch / PFileScan / built-in cursor
  RetBranch = 0; // {PBranch}
  StkMark: Pointer = null;
  WMark = 0;
  CallLevel = 0;
  Vars: PTerm[];
  constructor(N: number) {
    this.Vars = new Array<PTerm>(Math.max(N, 0)).fill(null);
  }
}

export type PFileScan = TFileScan | null;
// PAS: RUNPROLG.PAS TFileScan
export class TFileScan {
  IRec = 0;
  Count = 0;
}

// private globals
let CurrInst: PInstance = null;
/** PAS: PackedTermPtr: Pchar – an index into PTBuf */
let PackedTermPtr = 0;
let PTBuf: Uint8Array = new Uint8Array(0);
let PTPMaxOfs = 0;
let TrcLevel = 0;
let CallLevel = 0;
let LexemList: PTerm = null;

/** TS-only: nil for a zero offset (`word(NextBranch):=n`). */
function NB(n: number): Pointer {
  return n === 0 ? null : n;
}
/** TS-only: Pascal write/writeln to Output. */
function write(...s: string[]): void {
  TxtWrite(Output, ...s);
}
function writeln(...s: string[]): void {
  TxtWriteln(Output, ...s);
}

// PAS: RUNPROLG.PAS Trace
function Trace(): boolean {
  return TrcLevel !== 0 && TrcLevel >= CallLevel;
}
// PAS: RUNPROLG.PAS SetCallLevel
function SetCallLevel(Lv: number): void {
  CallLevel = Lv;
  if (Lv === 0) TrcLevel = 0;
}
// PAS: RUNPROLG.PAS WaitC
function WaitC(): void {
  const c = ReadKey();
  if (c === _ESC_ && PromptYN(21)) GoExit();
}

// ================================================================ T D O M A I N

// PAS: RUNPROLG.PAS GetFunDcl
function GetFunDcl(D: number, I: number): TFunDcl {
  let fdofs = SgDom(D).FunDcl;
  while (I > 0) {
    I--;
    fdofs = (SgPtr(fdofs) as TFunDcl).Chain;
  }
  return SgPtr(fdofs) as TFunDcl;
}

// ================================================================ T T E R M

// PAS: RUNPROLG.PAS GetIntTerm
function GetIntTerm(I: number): TTerm {
  const t = RunPrologVars.Mem1.Get(1 + 2, new TTerm());
  t.Fun = _IntT;
  t.II = int16(I);
  return t;
}
// PAS: RUNPROLG.PAS GetRealTerm
function GetRealTerm(R: float): TTerm {
  const t = RunPrologVars.Mem1.Get(1 + FloatSz, new TTerm());
  t.Fun = _RealT;
  t.RR = R;
  return t;
}
// PAS: RUNPROLG.PAS GetBoolTerm
function GetBoolTerm(B: boolean): TTerm {
  const t = RunPrologVars.Mem1.Get(1 + 1, new TTerm());
  t.Fun = B ? 1 : 0;
  return t;
}
// PAS: RUNPROLG.PAS GetStringTerm
function GetStringTerm(S: string): TTerm {
  const t = RunPrologVars.Mem1.Get(1 + 1 + S.length, new TTerm());
  t.Fun = _StrT;
  t.SS = S;
  return t;
}
// PAS: RUNPROLG.PAS GetLongStrTerm
function GetLongStrTerm(N: number): TTerm {
  const t = RunPrologVars.Mem1.Get(1 + 4, new TTerm());
  t.Fun = _LongStrT;
  t.Pos = N;
  return t;
}
// PAS: RUNPROLG.PAS GetListTerm
function GetListTerm(aElem: PTerm, aNext: PTerm): TTerm {
  const t = RunPrologVars.Mem1.Get(1 + 2 * PtrSz, new TTerm());
  t.Fun = _ListT;
  t.Elem = aElem;
  t.Next = aNext;
  return t;
}
// PAS: RUNPROLG.PAS GetFunTerm
function GetFunTerm(aFun: number, aArity: number): TTerm {
  const t = RunPrologVars.Mem1.Get(1 + 1 + aArity * PtrSz, new TTerm());
  t.Fun = aFun;
  t.Arity = aArity;
  t.Arg = new Array<PTerm>(aArity).fill(null);
  return t;
}
// PAS: RUNPROLG.PAS ChainList – append list New at the end of the list in Frst (via Next)
function ChainList(Frst: Ref<PTerm>, New: PTerm): void {
  if (Frst.v === null) {
    Frst.v = New;
    return;
  }
  let t = Frst.v;
  while (t.Next !== null) t = t.Next;
  t.Next = New;
}

// PAS: RUNPROLG.PAS RdLongStr – a LongStr from the work file at Pos
function RdLongStr(Pos: number): LongStrPtr {
  const h = BaseVars.WorkHandle;
  SeekH(h, Pos);
  const lb = new Uint8Array(2);
  ReadH(h, 2, lb);
  const l = getWord(lb, 0);
  const p = new Uint8Array(l);
  if (l > 0) ReadH(h, l, p);
  return p;
}
// PAS: RUNPROLG.PAS WrLongStrLP – appends L bytes of P to the work file; returns its position
function WrLongStrLP(L: number, P: Uint8Array | null): number {
  const bv = BaseVars;
  const result = bv.MaxWSize;
  SeekH(bv.WorkHandle, bv.MaxWSize);
  const lb = new Uint8Array(2);
  setWord(lb, 0, L);
  WriteH(bv.WorkHandle, 2, lb);
  if (L > 0) WriteH(bv.WorkHandle, L, P!);
  bv.MaxWSize += L + 2;
  return result;
}
// PAS: RUNPROLG.PAS WrLongStr
function WrLongStr(S: LongStrPtr): number {
  return WrLongStrLP(S.length, S);
}

// PAS: RUNPROLG.PAS RunIExpr1
function RunIExpr1(T: TPTermLike): number {
  let i = 0;
  switch (T.Op) {
    case _length:
      i = RunSExpr(T.E1).length;
      break;
    case _val: {
      const s = RunSExpr(T.E1);
      const v = ref(0);
      const err = ref(0);
      ValI(s, v, err);
      i = int16(v.v);
      break;
    }
    case _pos: {
      const s = RunSExpr(T.E1);
      const ss = RunLSExpr(T.E2);
      const l = ss.length;
      i = FindText(s, '', ss, l);
      if (i > 0) i = i - s.length;
      break;
    }
  }
  return i;
}
type TPTermLike = ReturnType<typeof SgTerm>;
// PAS: RUNPROLG.PAS RunIExpr – integer (16-bit) expression
function RunIExpr(TOfs: number): number {
  const t = SgTerm(TOfs);
  if (t.Fun === _VarT) return CurrInst!.Vars[t.Idx]!.II;
  switch (t.Op) {
    case _const:
      return t.II;
    case '^':
      return int16(~RunIExpr(t.E1));
    case _and:
      return int16(RunIExpr(t.E1) & RunIExpr(t.E2));
    case _or:
      return int16(RunIExpr(t.E1) | RunIExpr(t.E2));
    case '+':
      return int16(RunIExpr(t.E1) + RunIExpr(t.E2));
    case '-':
      return int16(RunIExpr(t.E1) - RunIExpr(t.E2));
    case '*':
      return int16(Math.imul(RunIExpr(t.E1), RunIExpr(t.E2)));
    case '/':
      return int16(Div(RunIExpr(t.E1), RunIExpr(t.E2)));
    case _conv:
      return int16(Trunc(RunRExpr(t.E1)));
    case _min:
      return Math.min(RunIExpr(t.E1), RunIExpr(t.E2));
    case _max:
      return Math.max(RunIExpr(t.E1), RunIExpr(t.E2));
    case _maxcol:
      return BaseVars.TxtCols;
    case _maxrow:
      return BaseVars.TxtRows;
    default:
      return RunIExpr1(t);
  }
}
// PAS: RUNPROLG.PAS RunRExpr
function RunRExpr(TOfs: number): float {
  const t = SgTerm(TOfs);
  if (t.Fun === _VarT) return CurrInst!.Vars[t.Idx]!.RR;
  switch (t.Op) {
    case _const:
      return t.RR;
    case '+':
      return RunRExpr(t.E1) + RunRExpr(t.E2);
    case '-':
      return RunRExpr(t.E1) - RunRExpr(t.E2);
    case '*':
      return RunRExpr(t.E1) * RunRExpr(t.E2);
    case '/':
      return RunRExpr(t.E1) / RunRExpr(t.E2);
    case _conv:
      return RunIExpr(t.E1);
  }
  return 0;
}
// PAS: RUNPROLG.PAS RunSExpr1 – a '+' chain, truncated to 255 chars
function RunSExpr1(T: TPTermLike): string {
  let s = '';
  let tofs = 0;
  let t = T;
  let b: boolean;
  do {
    b = t.Fun === _StrT && t.Op === '+';
    const t1ofs = b ? t.E1 : tofs;
    const s2 = RunSExpr(t1ofs);
    s = s + s2.slice(0, Math.max(0, 255 - s.length));
    if (b) {
      tofs = t.E2;
      t = SgTerm(tofs);
    }
  } while (b);
  return s;
}
// PAS: RUNPROLG.PAS RunSExpr – TS: the var parameter s is the result
function RunSExpr(TOfs: number): string {
  const t = SgTerm(TOfs);
  if (t.Fun === _VarT) return CurrInst!.Vars[t.Idx]!.SS;
  let s = '';
  // label 2: s := copy(s, i, n) bounded by l
  const cut = (i: number, n: number, l: number): string => {
    n = Math.min(n, l + 1 - i);
    return s.substr(i - 1, n);
  };
  switch (t.Op) {
    case _const:
      return t.SS;
    case '+':
      return RunSExpr1(t);
    case _conv: {
      const p = RunLSExpr(t.E1);
      const l = Math.min(p.length, 255);
      let r = '';
      for (let k = 0; k < l; k++) r += chr(p[k]);
      return r;
    }
    case _copy: {
      s = RunSExpr(t.E1);
      let i = RunIExpr(t.E2) & 0xffff;
      const n = RunIExpr(t.E3) & 0xffff;
      const l = s.length;
      i = Math.max(1, Math.min(i, l + 1));
      return cut(i, n, l);
    }
    case _leadchar: {
      s = RunSExpr(t.E2);
      let i = 1;
      const l = s.length;
      const n = l;
      while (i <= l && s[i - 1] === chr(t.E1)) i++;
      return cut(i, n, l);
    }
    case _trailchar: {
      s = RunSExpr(t.E2);
      let l = s.length;
      while (l > 0 && s[l - 1] === chr(t.E1)) l--;
      return s.slice(0, l);
    }
    case _repeatstr: {
      s = RunSExpr(t.E1);
      let n = RunIExpr(t.E2) & 0xffff;
      const l = s.length;
      let r = '';
      while (n > 0 && r.length + l <= 255) {
        n--;
        r += s;
        if (l === 0) break; // TS: the result cannot change any more
      }
      return r;
    }
    case _str:
      return StrI(RunIExpr(t.E1));
  }
  return s;
}
// PAS: RUNPROLG.PAS RunLSExpr
function RunLSExpr(TOfs: number): LongStrPtr {
  const t = SgTerm(TOfs);
  if (t.Fun === _VarT) return RdLongStr(CurrInst!.Vars[t.Idx]!.Pos);
  switch (t.Op) {
    case _const: {
      const p = new Uint8Array(t.SS.length);
      for (let k = 0; k < t.SS.length; k++) p[k] = t.SS.charCodeAt(k);
      return p;
    }
    case '+': {
      const p = RunLSExpr(t.E1);
      const p2 = RunLSExpr(t.E2);
      const r = new Uint8Array(p.length + p2.length);
      r.set(p, 0);
      r.set(p2, p.length);
      return r;
    }
    case _conv: {
      const s = RunSExpr(t.E1);
      const p = new Uint8Array(s.length);
      for (let k = 0; k < s.length; k++) p[k] = s.charCodeAt(k);
      return p;
    }
  }
  return new Uint8Array(0);
}
// PAS: RUNPROLG.PAS UnifyTermsCC – two copy-stack terms
function UnifyTermsCC(T1: PTerm, T2: PTerm): boolean {
  if (T2 === null) return T1 === null;
  if (T1 === null || T1.Fun !== T2.Fun) return false;
  switch (T2.Fun) {
    case _IntT:
      return T1.II === T2.II;
    case _RealT:
      return T1.RR === T2.RR;
    case _StrT:
      return T1.SS === T2.SS;
    case _LongStrT:
      return EquLongStr(RdLongStr(T1.Pos), RdLongStr(T2.Pos));
    case _ListT:
      return UnifyTermsCC(T1.Elem, T2.Elem) && UnifyTermsCC(T1.Next, T2.Next);
    default:
      for (let i = 0; i <= T1.Arity - 1; i++) if (!UnifyTermsCC(T1.Arg[i], T2.Arg[i])) return false;
      return true;
  }
}
// PAS: RUNPROLG.PAS UnifyTermsCV – a copy-stack term with a program term (variables of CurrInst)
function UnifyTermsCV(T1: PTerm, T2Ofs: number): boolean {
  // PAS: RUNPROLG.PAS UnifyTermsCV.UnifyVList
  const UnifyVList = (TT1: Ref<PTerm>, T2o: number): boolean => {
    let t1 = TT1.v;
    let t2ofs = T2o;
    while (t2ofs !== 0) {
      const T2 = SgTerm(t2ofs);
      if (T2.Fun === _VarT) {
        if (T2.Bound) {
          let t = CurrInst!.Vars[T2.Idx];
          while (t !== null) {
            if (t1 === null || !UnifyTermsCC(t1.Elem, t.Elem)) return false;
            t = t.Next;
            t1 = t1.Next;
          }
        } else {
          CurrInst!.Vars[T2.Idx] = t1;
          t1 = null;
        }
        break; // goto 1
      } else if (T2.Fun === _UnderscT) {
        t1 = null;
        break;
      } else {
        if (t1 === null || !UnifyTermsCV(t1.Elem, T2.Elem)) return false;
        t1 = t1.Next;
        t2ofs = T2.Next;
      }
    }
    TT1.v = t1; // 1:
    return true;
  };
  if (T2Ofs === 0) return T1 === null;
  let t2 = SgTerm(T2Ofs);
  switch (t2.Fun) {
    case _VarT:
      if (t2.Bound) return UnifyTermsCC(T1, CurrInst!.Vars[t2.Idx]);
      CurrInst!.Vars[t2.Idx] = T1;
      return true;
    case _UnderscT:
      return true;
  }
  if (T1 === null || T1.Fun !== t2.Fun) return false;
  switch (t2.Fun) {
    case _IntT:
      return T1.II === RunIExpr(T2Ofs);
    case _RealT:
      return T1.RR === RunRExpr(T2Ofs);
    case _StrT:
      if (t2.Op === _const) return T1.SS === t2.SS;
      return T1.SS === RunSExpr(T2Ofs);
    case _LongStrT:
      return EquLongStr(RdLongStr(T1.Pos), RunLSExpr(T2Ofs));
    case _ListT: {
      const r = ref<PTerm>(T1);
      while (t2.Op === '+') {
        if (!UnifyVList(r, t2.E1)) return false;
        T2Ofs = t2.E2;
        t2 = SgTerm(T2Ofs);
      }
      return UnifyVList(r, T2Ofs) && r.v === null;
    }
    default:
      for (let i = 0; i <= T1.Arity - 1; i++) if (!UnifyTermsCV(T1.Arg[i], t2.Arg[i])) return false;
      return true;
  }
}
// PAS: RUNPROLG.PAS FindInCList
function FindInCList(tEl: PTerm, t: PTerm): boolean {
  while (t !== null) {
    if (UnifyTermsCC(tEl, t.Elem)) return true;
    t = t.Next;
  }
  return false;
}
// PAS: RUNPROLG.PAS CopyCList – a copy of the list cells (elements shared)
function CopyCList(T: PTerm): PTerm {
  if (T === null) return null;
  let root: PTerm = null;
  let prev: TTerm | null = null;
  do {
    const t1 = RunPrologVars.Mem1.Get(1 + 2 * PtrSz, new TTerm());
    t1.Fun = _ListT;
    t1.Elem = T.Elem;
    if (root === null) root = t1;
    else prev!.Next = t1;
    prev = t1;
    T = T.Next;
  } while (T !== null);
  return root;
}
// PAS: RUNPROLG.PAS CopyTerm – a program term instantiated into the copy stack
function CopyTerm(TOff: number): PTerm {
  // PAS: RUNPROLG.PAS CopyTerm.CopyVList
  const CopyVList = (tofs: number, Cpy: boolean): PTerm => {
    if (tofs === 0) return null;
    let root: PTerm = null;
    let prev: TTerm | null = null;
    for (;;) {
      const T = SgTerm(tofs);
      let t1: PTerm;
      if (T.Fun === _VarT) {
        t1 = CurrInst!.Vars[T.Idx];
        if (Cpy) t1 = CopyCList(t1);
      } else {
        t1 = RunPrologVars.Mem1.Get(1 + 2 * PtrSz, new TTerm());
        t1.Fun = _ListT;
        t1.Elem = CopyTerm(T.Elem);
      }
      if (root === null) root = t1;
      else prev!.Next = t1;
      if (T.Fun !== _VarT) {
        prev = t1;
        tofs = T.Next;
        if (tofs !== 0) continue;
      }
      break;
    }
    return root;
  };
  if (TOff === 0) return null;
  let t = SgTerm(TOff);
  switch (t.Fun) {
    case _IntT:
      return GetIntTerm(RunIExpr(TOff));
    case _RealT:
      return GetRealTerm(RunRExpr(TOff));
    case _StrT:
      if (t.Op === _const) return GetStringTerm(t.SS);
      return GetStringTerm(RunSExpr(TOff));
    case _LongStrT:
      return GetLongStrTerm(WrLongStr(RunLSExpr(TOff)));
    case _VarT:
      return CurrInst!.Vars[t.Idx];
    case _ListT: {
      const t2 = ref<PTerm>(null);
      let tofs = TOff;
      while (t.Op === '+') {
        ChainList(t2, CopyVList(t.E1, true));
        tofs = t.E2;
        t = SgTerm(tofs);
      }
      ChainList(t2, CopyVList(tofs, false));
      return t2.v;
    }
    default: {
      const t2 = GetFunTerm(t.Fun, t.Arity);
      for (let i = 0; i <= t.Arity - 1; i++) t2.Arg[i] = CopyTerm(t.Arg[i]);
      return t2;
    }
  }
}

// TS-only: packed term cursor primitives
function PutInt(n: number): void {
  setInteger(PTBuf, PackedTermPtr, int16(n));
  PackedTermPtr += 2;
}
function PutReal(r: float): void {
  writeReal48(r, PTBuf, PackedTermPtr);
  PackedTermPtr += FloatSz;
}
function PutStr(s: string): void {
  const n = s.length + 1;
  if (PackedTermPtr + n >= PTPMaxOfs) RunError(1527);
  PTBuf[PackedTermPtr] = s.length;
  for (let k = 0; k < s.length; k++) PTBuf[PackedTermPtr + 1 + k] = s.charCodeAt(k);
  PackedTermPtr += n;
}
function GetPStr(buf: Uint8Array, p: number): string {
  let s = '';
  for (let k = 1; k <= buf[p]; k++) s += chr(buf[p + k]);
  return s;
}

// PAS: RUNPROLG.PAS PackTermC – a copy-stack term into the packed form
function PackTermC(T: PTerm): void {
  if (PackedTermPtr >= PTPMaxOfs) RunError(1527);
  if (T === null) {
    // []
    setWord(PTBuf, PackedTermPtr, 0);
    PackedTermPtr += 2;
    return;
  }
  switch (T.Fun) {
    case _IntT:
      PutInt(T.II);
      break;
    case _RealT:
      PutReal(T.RR);
      break;
    case _StrT:
      PutStr(T.SS);
      break;
    case _LongStrT:
      RunError(1543);
      break;
    case _ListT: {
      const wp = PackedTermPtr;
      PackedTermPtr += 2;
      let n = 0;
      let t: PTerm = T;
      while (t !== null) {
        PackTermC(t.Elem);
        t = t.Next;
        n++;
      }
      setWord(PTBuf, wp, n);
      break;
    }
    default:
      PTBuf[PackedTermPtr] = T.Fun;
      PackedTermPtr++;
      for (let i = 0; i <= T.Arity - 1; i++) PackTermC(T.Arg[i]);
  }
}
// PAS: RUNPROLG.PAS PackVList – the elements of a list part; returns their number
function PackVList(tofs: number): number {
  let n = 0;
  if (tofs === 0) return 0; // TS: `X + []` (Pascal reads the record at offset 0)
  do {
    const t = SgTerm(tofs);
    if (t.Fun === _VarT) {
      let t1 = CurrInst!.Vars[t.Idx];
      while (t1 !== null) {
        PackTermC(t1.Elem);
        t1 = t1.Next;
        n++;
      }
      break; // goto 1
    }
    PackTermV(t.Elem);
    n++;
    tofs = t.Next;
  } while (tofs !== 0);
  return n;
}
// PAS: RUNPROLG.PAS PackTermV – a program term into the packed form
function PackTermV(TOff: number): void {
  if (PackedTermPtr >= PTPMaxOfs) RunError(1527);
  let tofs = TOff;
  if (tofs === 0) {
    // []
    setWord(PTBuf, PackedTermPtr, 0);
    PackedTermPtr += 2;
    return;
  }
  let t = SgTerm(tofs);
  switch (t.Fun) {
    case _VarT:
      PackTermC(CurrInst!.Vars[t.Idx]);
      break;
    case _IntT:
      PutInt(RunIExpr(tofs));
      break;
    case _RealT:
      PutReal(RunRExpr(tofs));
      break;
    case _StrT:
      PutStr(RunSExpr(tofs));
      break;
    case _LongStrT:
      RunError(1543);
      break;
    case _ListT: {
      const wp = PackedTermPtr;
      PackedTermPtr += 2;
      let n = 0;
      while (t.Op === '+') {
        n += PackVList(t.E1);
        tofs = t.E2;
        t = SgTerm(tofs);
      }
      n += PackVList(tofs);
      setWord(PTBuf, wp, n);
      break;
    }
    default:
      PTBuf[PackedTermPtr] = t.Fun;
      PackedTermPtr++;
      for (let i = 0; i <= t.Arity - 1; i++) PackTermV(t.Arg[i]);
  }
}
// PAS: RUNPROLG.PAS GetPackedTerm
function GetPackedTerm(T: PTerm): LongStrPtr {
  const A = new Uint8Array(MaxPackedPredLen);
  PTBuf = A;
  PackedTermPtr = 0;
  PTPMaxOfs = MaxPackedPredLen - 2;
  PackTermC(T);
  return A.slice(0, PackedTermPtr);
}
// PAS: RUNPROLG.PAS UnpackTerm – the packed term at PackedTermPtr of domain D
function UnpackTerm(D: number): PTerm {
  let t: PTerm;
  const d = SgDom(D);
  switch (d.Typ) {
    case _IntD:
      t = GetIntTerm(getInteger(PTBuf, PackedTermPtr));
      PackedTermPtr += 2;
      break;
    case _RealD:
      t = GetRealTerm(readReal48(PTBuf, PackedTermPtr));
      PackedTermPtr += FloatSz;
      break;
    case _StrD:
      t = GetStringTerm(GetPStr(PTBuf, PackedTermPtr));
      PackedTermPtr += PTBuf[PackedTermPtr] + 1;
      break;
    case _LongStrD:
      return RunError(1543);
    case _ListD: {
      let n = getWord(PTBuf, PackedTermPtr);
      PackedTermPtr += 2;
      t = null;
      let tPrev: TTerm | null = null;
      while (n > 0) {
        const t1 = GetListTerm(UnpackTerm(d.ElemDom), null);
        if (t === null) t = t1;
        else tPrev!.Next = t1;
        tPrev = t1;
        n--;
      }
      break;
    }
    default: {
      const n = PTBuf[PackedTermPtr];
      PackedTermPtr++;
      const f = GetFunDcl(D, n);
      const tf = GetFunTerm(n, f.Arity);
      for (let i = 0; i <= f.Arity - 1; i++) tf.Arg[i] = UnpackTerm(f.Arg[i]);
      t = tf;
    }
  }
  return t;
}
// PAS: RUNPROLG.PAS PrintPackedTerm – TS: (buffer, position) for the Pchar; returns the new position
function PrintPackedTerm(B: Uint8Array, P: number, D: number): number {
  const d = SgDom(D);
  switch (d.Typ) {
    case _IntD:
      write(StrI(getInteger(B, P)));
      P += 2;
      break;
    case _RealD:
      write(StrR(readReal48(B, P)));
      P += FloatSz;
      break;
    case _StrD:
      write("'", GetPStr(B, P), "'");
      P += B[P] + 1;
      break;
    case _ListD: {
      write('[');
      const n = getWord(B, P);
      P += 2;
      for (let i = 1; i <= n; i++) {
        if (i > 1) write(',');
        P = PrintPackedTerm(B, P, d.ElemDom);
      }
      write(']');
      break;
    }
    default: {
      const f = GetFunDcl(D, B[P]);
      P++;
      write(SgStr(f.Name));
      if (f.Arity > 0) {
        write('(');
        for (let i = 1; i <= f.Arity; i++) {
          if (i > 1) write(',');
          P = PrintPackedTerm(B, P, f.Arg[i - 1]);
        }
        write(')');
      }
    }
  }
  return P;
}
// PAS: RUNPROLG.PAS PrintPackedPred – trace of an assert
function PrintPackedPred(Q: Uint8Array, POfs: number): void {
  const p = SgPred(POfs);
  let q = 0;
  write('CALL assert(', SgStr(p.Name));
  const n = p.Arity;
  if (n > 0) {
    write('(');
    for (let i = 1; i <= n; i++) {
      if (i > 1) write(',');
      q += 2;
      q = PrintPackedTerm(Q, q, p.Arg[i - 1]);
    }
    write(')');
  }
  writeln(')');
  WaitC();
}
// PAS: RUNPROLG.PAS PrintTerm
function PrintTerm(T: PTerm, DOfs: number): void {
  if (T === null) {
    write('[]');
    return;
  }
  switch (T.Fun) {
    case _IntT:
      write(StrI(T.II));
      break;
    case _RealT:
      write(StrR(T.RR));
      break;
    case _StrT:
      write("'", T.SS, "'");
      break;
    case _LongStrT: {
      const p = RdLongStr(T.Pos);
      let s = '';
      for (let i = 0; i < p.length; i++) s += chr(p[i]);
      write("'", s, "'");
      break;
    }
    case _ListT: {
      write('[');
      const d = SgDom(DOfs);
      let i = 0;
      let t: PTerm = T;
      for (;;) {
        // 1:
        PrintTerm(t!.Elem, d.ElemDom);
        t = t!.Next;
        if (t !== null) {
          write(',');
          i++;
          if (i === 3 && d.Name === 'L_Lexem') write('...');
          else continue;
        }
        break;
      }
      write(']');
      break;
    }
    default: {
      const fd = GetFunDcl(DOfs, T.Fun);
      write(SgStr(fd.Name));
      if (T.Arity === 0) return;
      write('(');
      for (let i = 0; i <= T.Arity - 1; i++) {
        if (i > 0) write(',');
        PrintTerm(T.Arg[i], fd.Arg[i]);
      }
      write(')');
    }
  }
}

// PAS: RUNPROLG.PAS LenDbEntry – bytes of Arity packed arguments (each: word length + data) at S[Ofs]
function LenDbEntry(S: Uint8Array, Ofs: number, Arity: number): number {
  let n = 0;
  for (let i = 1; i <= Arity; i++) {
    const ll = getWord(S, Ofs + n);
    n += ll + 2;
  }
  return n;
}
// PAS: RUNPROLG.PAS SaveDb – the database DbOfs (PDatabase offset) as a LongStr; AA<>0: the initial
// database of the program (no predicate headers, segment size check)
export function SaveDb(DbOfs: number, AA: number): LongStrPtr {
  const out: number[] = [];
  const db = SgPtr(DbOfs) as TDatabase;
  const x = AA !== 0;
  let pofs = db.Pred;
  while (pofs !== 0) {
    const p = SgPred(pofs);
    if ((p.Opt & _FandCallOpt) === 0) {
      const arity = p.Arity;
      if (!x) {
        const nm = SgStr(p.Name);
        out.push(nm.length);
        for (let k = 0; k < nm.length; k++) out.push(nm.charCodeAt(k));
        out.push(arity);
      }
      let b = p.Branch as PDbBranch;
      while (b !== null) {
        const n = LenDbEntry(b.Data, 0, arity);
        if (x && CurSgTable().Size + out.length + n + 1 > MaxLStrLen) OldError(544);
        out.push(1);
        for (let k = 0; k < n; k++) out.push(b.Data[k]);
        b = b.Chain;
      }
      out.push(0);
    }
    pofs = p.ChainDb;
  }
  if (out.length > MaxLStrLen) {
    SetMsgPar(db.Name);
    RunError(1532);
  }
  return Uint8Array.from(out);
}
// PAS: RUNPROLG.PAS ConsultDb – the facts of a saved database S into the predicates of DbOfs
function ConsultDb(S: LongStrPtr, DbOfs: number): void {
  let q = 0;
  const db = SgPtr(DbOfs) as TDatabase;
  const bad = (): never => {
    SetMsgPar(db.Name);
    return RunError(1533);
  };
  let pofs = db.Pred;
  while (pofs !== 0) {
    const p = SgPred(pofs);
    if ((p.Opt & _FandCallOpt) === 0) {
      if (!InSg(S)) {
        if (q >= S.length || GetPStr(S, q) !== SgStr(p.Name)) bad();
        q += S[q] + 1;
        if (S[q] !== p.Arity) bad();
        q++;
      }
      while (S[q] === 1) {
        q++;
        const n = LenDbEntry(S, q, p.Arity);
        const b = RunPrologVars.Mem3.Alloc(n + PtrSz, new TDbBranch());
        ChainLast(fref2(p), b);
        b.Data = S.slice(q, q + n);
        q += n;
      }
      if (S[q] !== 0) bad();
      q++;
    }
    pofs = p.ChainDb;
  }
  if (S.length !== q) bad();
}
/** TS-only: p^.Branch as the root of a TDbBranch chain. */
function fref2(p: TPredicate): Ref<TDbBranch | null> {
  return {
    get v() {
      return p.Branch as TDbBranch | null;
    },
    set v(x: TDbBranch | null) {
      p.Branch = x;
    },
  };
}
// PAS: RUNPROLG.PAS Vokal
function Vokal(C: string): boolean {
  return [
    'a', '\xa0', '\x84', 'e', '\x82', '\x88', 'i', '\xa1', 'o', '\xa2', '\x93', '\x94', 'u', '\xa3', '\x96', '\x81',
    'y', '\x98',
  ].includes(CurrToKamen(C));
}
// PAS: RUNPROLG.PAS IsUpper
function IsUpper(C: string): boolean {
  return C !== '.' && C === chr(BaseVars.UpcCharTab[ord(C)]);
}
// PAS: RUNPROLG.PAS Abbrev – abbreviates the words of S ("Účetní doklad" -> "Úč. dokl.")
export function Abbrev(S: string): string {
  let t = '';
  let i = S.length;
  const Si = (k: number): string => (k >= 1 && k <= S.length ? S[k - 1] : '\0');
  const dotSp = (c: string): boolean => c === '.' || c === ' ';
  while (i > 0) {
    if (Si(i) === ' ') {
      while (Si(i) === ' ') {
        i--;
        if (i === 0) return t; // goto 9
      }
      if (t.length > 0) t = ShortStr(' ' + t);
    }
    let j = i;
    let lbl = 0; // 0: fall through, 1: label 1, 2: label 2
    if (IsUpper(Si(i))) lbl = 1;
    else {
      const skip = (vok: boolean): boolean => {
        while (Vokal(Si(i)) === vok) {
          i--;
          if (i === 0 || dotSp(Si(i))) return true;
        }
        return false;
      };
      if (skip(true) || skip(false) || skip(true)) lbl = 2;
      else {
        j = i;
        t = ShortStr('.' + t);
        lbl = 1;
      }
    }
    if (lbl === 1) while (i > 0 && !dotSp(Si(i))) i--; // 1:
    t = ShortStr(Copy(S, i + 1, j - i) + t); // 2:
  }
  if (t.length === S.length) {
    let k = 1;
    while (k < t.length - 1) {
      if (t[k - 1] === '.' && t[k] === ' ') t = t.slice(0, k) + t.slice(k + 1);
      else k++;
    }
  }
  return t; // 9:
}
// PAS: RUNPROLG.PAS NextFD – the next data file of CRdb and its parents
function NextFD(FD: FileDPtr): FileDPtr {
  let r: RdbDPtr;
  if (FD === null) {
    r = AccessVars.CRdb;
    FD = r!.FD;
  } else r = FD.ChptPos.R;
  for (;;) {
    FD = FD!.Chain;
    if (FD === null) {
      r = r!.ChainBack;
      if (r !== null) {
        FD = r.FD;
        continue;
      }
    } else if (FD.Typ === '0' || FD.ChptPos.R === null) continue;
    return FD;
  }
}
// PAS: RUNPROLG.PAS FindFD
function FindFD(FDName: string): FileDPtr {
  let fd: FileDPtr = null;
  do fd = NextFD(fd);
  while (!(fd === null || SEquUpcase(fd.Name, FDName)));
  return fd;
}
// PAS: RUNPROLG.PAS Pound
function Pound(s: string): string {
  return s === '' ? '@' : s;
}
// PAS: RUNPROLG.PAS RunBuildIn – one solution of a built-in predicate for CurrInst
function RunBuildIn(): boolean {
  const ci = CurrInst!;
  const Vars = ci.Vars;
  const c = SgCmd(ci.RetCmd);
  const w = c.InpMask;
  const fail = (): boolean => {
    // 1:
    ci.NextBranch = null;
    return false;
  };
  switch (SgPred(ci.Pred).LocVarSz) {
    case _NextLexP:
      if (LexemList !== null) LexemList = LexemList.Next;
      break;
    case _GetLexP:
      Vars[0] = LexemList;
      break;
    case _ConcatP:
      switch (w) {
        case 7: // iii
          if (ShortStr(Vars[0]!.SS + Vars[1]!.SS) !== Vars[2]!.SS) return fail();
          break;
        case 3: // iio
          Vars[2] = GetStringTerm(ShortStr(Vars[0]!.SS + Vars[1]!.SS));
          break;
        case 5: {
          // ioi
          const l = Vars[0]!.SS.length;
          if (Vars[0]!.SS !== Copy(Vars[2]!.SS, 1, l)) return fail();
          Vars[1] = GetStringTerm(Copy(Vars[2]!.SS, l + 1, 255));
          break;
        }
        case 6: {
          // oii
          const l = Vars[1]!.SS.length;
          const l2 = Vars[2]!.SS.length;
          if (Vars[1]!.SS !== Copy(Vars[2]!.SS, l2 - l + 1, l)) return fail();
          Vars[0] = GetStringTerm(Copy(Vars[2]!.SS, 1, l2 - l));
          break;
        }
        case 4: {
          // ooi
          let n = (ci.NextBranch as number | null) ?? 0;
          const s = Vars[2]!.SS;
          if (n === 0) n = s.length;
          if (n === 0) return fail();
          n--;
          Vars[0] = GetStringTerm(Copy(s, 1, s.length - n));
          Vars[1] = GetStringTerm(Copy(s, s.length - n + 1, n));
          ci.NextBranch = NB(n);
          break;
        }
      }
      break;
    case _MemP:
      switch (w) {
        case 3: {
          // ii
          const t1 = Vars[0];
          let t2 = Vars[1];
          while (t2 !== null) {
            if (UnifyTermsCC(t1, t2.Elem)) return true;
            t2 = t2.Next;
          }
          return fail();
        }
        case 2: {
          // oi
          let t2 = ci.NextBranch as PTerm;
          if (t2 === null) {
            t2 = Vars[1];
            if (t2 === null) return fail();
          }
          Vars[0] = t2.Elem;
          ci.NextBranch = t2.Next;
          break;
        }
      }
      break;
    case _FandFileP: {
      let fd = ci.NextBranch as FileDPtr;
      if (fd === null) {
        fd = NextFD(null);
        if (fd === null) return fail();
      }
      Vars[0] = GetStringTerm(fd.Name);
      let s = '';
      switch (fd.Typ) {
        case '6':
          if (fd.IsSQLFile) s = 'SQL';
          break;
        case 'X':
          s = 'X';
          break;
        case 'D':
          s = 'DBF';
          break;
        case '8':
          s = 'DTA';
          break;
      }
      Vars[1] = GetStringTerm(s);
      Vars[2] = GetStringTerm(fd.ChptPos.R!.FD!.Name);
      AccessVars.CFile = fd;
      SetCPathVol();
      Vars[3] = GetStringTerm(BaseVars.CPath);
      ci.NextBranch = NextFD(fd);
      break;
    }
    case _FandFieldP: {
      let f = ci.NextBranch as FieldDPtr;
      if (f === null) {
        const fd = FindFD(Vars[0]!.SS);
        if (fd === null) return fail();
        f = fd.FldD;
      }
      if (w === 3) {
        // ii
        while (f !== null && !SEquUpcase(f.Name, Vars[1]!.SS)) f = f.Chain;
        if (f === null) return fail();
      } else Vars[1] = GetStringTerm(f!.Name);
      const F = f!;
      Vars[2] = GetStringTerm(F.Typ);
      let m = 0;
      let l = F.L;
      if (F.Typ === 'F') {
        m = F.M;
        l--;
        if (m > 0) l -= m + 1;
      }
      Vars[3] = GetIntTerm(l);
      Vars[4] = GetIntTerm(m);
      m = F.Flg;
      if (F.Typ === 'N' || F.Typ === 'A') m = m | (F.M << 4);
      Vars[5] = GetIntTerm(m);
      const Mask = (F.Flg & f_Mask) !== 0 ? FieldDMask(F) ?? '' : EmptyStr;
      Vars[6] = GetStringTerm(Mask);
      ci.NextBranch = w === 3 ? null : F.Chain;
      break;
    }
    case _FandKeyP: {
      let k = ci.NextBranch as KeyDPtr;
      if (k === null) {
        const fd = FindFD(Vars[0]!.SS);
        if (fd === null) return fail();
        k = fd.Keys;
        if (k === null) return fail();
      }
      Vars[1] = GetStringTerm(Pound(k.Alias ?? ''));
      Vars[2] = GetBoolTerm(k.Intervaltest);
      Vars[3] = GetBoolTerm(k.Duplic);
      ci.NextBranch = k.Chain;
      break;
    }
    case _FandLinkP: {
      let ld = ci.NextBranch as LinkDPtr;
      if (ld === null) {
        ld = AccessVars.LinkDRoot;
        while (ld !== null && !SEquUpcase(ld.FromFD!.Name, Vars[0]!.SS)) ld = ld.Chain;
        if (ld === null) return fail();
      }
      const fd = ld.FromFD!;
      if (w === 3) {
        // ii
        while (ld !== null && (fd !== ld.FromFD || !SEquUpcase(ld.RoleName, Vars[1]!.SS))) ld = ld.Chain;
        if (ld === null) return fail();
        Vars[2] = GetStringTerm(ld.ToFD!.Name);
      } else if (w === 5) {
        // ioi
        while (ld !== null && (fd !== ld.FromFD || !SEquUpcase(ld.ToFD!.Name, Vars[2]!.SS))) ld = ld.Chain;
        if (ld === null) return fail();
        Vars[1] = GetStringTerm(ld.RoleName);
      } else {
        Vars[1] = GetStringTerm(ld.RoleName);
        Vars[2] = GetStringTerm(ld.ToFD!.Name);
      }
      Vars[3] = GetStringTerm(Pound(ld.ToKey!.Alias ?? ''));
      let s = '';
      let k = fd.Keys;
      while (k !== null) {
        if (k.IndexRoot === ld.IndexRoot) s = k.Alias ?? '';
        k = k.Chain;
      }
      Vars[4] = GetStringTerm(Pound(s));
      let n = ld.MemberRef;
      if (ld.IndexRoot !== 0) n += 4;
      Vars[5] = GetIntTerm(n);
      if (w === 3) ld = null;
      else
        do ld = ld!.Chain;
        while (!(ld === null || ld.FromFD === fd));
      ci.NextBranch = ld;
      break;
    }
    case _FandKeyFieldP: {
      let kf = ci.NextBranch as KeyFldDPtr;
      if (kf === null) {
        const fd = FindFD(Vars[0]!.SS);
        if (fd === null) return fail();
        let k = fd.Keys;
        while (k !== null && !SEquUpcase(Pound(k.Alias ?? ''), Vars[1]!.SS)) k = k.Chain;
        if (k === null) return fail();
        kf = k.KFlds;
      }
      Vars[2] = GetStringTerm(kf!.FldD!.Name);
      Vars[3] = GetBoolTerm(kf!.CompLex);
      Vars[4] = GetBoolTerm(kf!.Descend);
      ci.NextBranch = kf!.Chain;
      break;
    }
    case _FandLinkFieldP: {
      let kf = ci.NextBranch as KeyFldDPtr;
      if (kf === null) {
        let ld = AccessVars.LinkDRoot;
        while (ld !== null && (!SEquUpcase(ld.FromFD!.Name, Vars[0]!.SS) || !SEquUpcase(ld.RoleName, Vars[1]!.SS)))
          ld = ld.Chain;
        if (ld === null) return fail();
        kf = ld.Args;
      }
      Vars[2] = GetStringTerm(kf!.FldD!.Name);
      ci.NextBranch = kf!.Chain;
      break;
    }
    case _LenP: {
      let t1 = Vars[0];
      let n = 0;
      while (t1 !== null) {
        n++;
        t1 = t1.Next;
      }
      Vars[1] = GetIntTerm(n);
      break;
    }
    case _InvP: {
      let t1 = Vars[0];
      let t2: PTerm = null;
      while (t1 !== null) {
        t2 = GetListTerm(t1.Elem, t2);
        t1 = t1.Next;
      }
      Vars[1] = t2;
      break;
    }
    case _AddP: {
      const t1 = Vars[0];
      let t2 = Vars[1];
      Vars[2] = t2;
      while (t2 !== null) {
        if (UnifyTermsCC(t1, t2.Elem)) return true;
        t2 = t2.Next;
      }
      Vars[2] = GetListTerm(t1, Vars[1]);
      break;
    }
    case _DelP: {
      const q = ci;
      let t1 = ci.NextBranch as PTerm;
      if (t1 === null) t1 = Vars[1];
      for (;;) {
        // 2:
        if (t1 === null) return fail();
        Vars[0] = t1.Elem;
        CurrInst = ci.RetInst;
        const b = UnifyTermsCV(t1.Elem, (SgPtr(c.Arg) as TTermList).Elem);
        CurrInst = q;
        if (b) {
          let root: PTerm = null;
          let tprev: TTerm | null = null;
          let t = Vars[1];
          while (t !== t1) {
            const t2 = GetListTerm(t!.Elem, null);
            if (root === null) root = t2;
            else tprev!.Next = t2;
            tprev = t2;
            t = t!.Next;
          }
          t1 = t1.Next;
          if (root === null) root = t1;
          else tprev!.Next = t1;
          Vars[2] = root;
          ci.NextBranch = t1;
          return true;
        }
        RunPrologVars.Mem1.Release(q.StkMark);
        t1 = t1.Next;
      }
    }
    case _UnionP: {
      const t1 = ref<PTerm>(CopyCList(Vars[0]));
      let root: PTerm = null;
      let tprev: TTerm | null = null;
      let t2 = Vars[1];
      while (t2 !== null) {
        if (!FindInCList(t2.Elem, t1.v)) {
          const t = GetListTerm(t2.Elem, null);
          if (root === null) root = t;
          else tprev!.Next = t;
          tprev = t;
        }
        t2 = t2.Next;
      }
      ChainList(t1, root);
      Vars[2] = t1.v;
      break;
    }
    case _MinusP:
    case _InterP: {
      const inter = SgPred(ci.Pred).LocVarSz === _InterP;
      let root: PTerm = null;
      let tprev: TTerm | null = null;
      let t1 = Vars[0];
      const t2 = Vars[1];
      while (t1 !== null) {
        if (FindInCList(t1.Elem, t2) === inter) {
          const t = GetListTerm(t1.Elem, null);
          if (root === null) root = t;
          else tprev!.Next = t;
          tprev = t;
        }
        t1 = t1.Next;
      }
      Vars[2] = root;
      break;
    }
    case _AbbrevP:
      Vars[1] = GetStringTerm(Abbrev(Vars[0]!.SS));
      break;
    case _CallP: {
      const pos = new RdbPos();
      if (!FindChpt('L', Vars[0]!.SS, false, pos)) {
        SetMsgPar(Vars[0]!.SS);
        RunError(1554);
      }
      RunProlog(pos, Vars[1]!.SS);
      if (AccessVars.EdBreak !== 0) return fail();
      break;
    }
  }
  return true; // 3:
}
// PAS: RUNPROLG.PAS SyntxError – `error(N,...)`: message 3000+N, LastExitCode = position
function SyntxError(N: number, Ex: number): never {
  RdMsg(3000 + N);
  AccessVars.EdRecKey = BaseVars.MsgLine;
  BaseVars.LastExitCode = Ex;
  return GoExit();
}
// PAS: RUNPROLG.PAS AppendLex – TS: tPrev is a Ref
function AppendLex(tPrev: Ref<TTerm | null>, Pos: number, Typ: number, s: string): void {
  let t = GetFunTerm(0, 3);
  t.Arg[2] = GetStringTerm(s);
  t.Arg[0] = GetIntTerm(Pos);
  t.Arg[1] = GetIntTerm(Typ);
  t = GetListTerm(t, null);
  if (LexemList === null) LexemList = t;
  else tPrev.v!.Next = t;
  tPrev.v = t;
}
// PAS: RUNPROLG.PAS LoadLex – the lexems of text S as LexemList (lex(Pos,Typ,Text))
function LoadLex(S: LongStrPtr): void {
  LexemList = null;
  const LL = S.length;
  let l = LL;
  let p = 0;
  const tPrev = ref<TTerm | null>(null);
  const P = (): string => chr(S[p]);
  for (;;) {
    // 1:
    if (l === 0) {
      AppendLex(tPrev, LL, 0, '');
      return;
    }
    if (P() <= ' ') {
      p++;
      l--;
      continue;
    }
    if (P() === '{') {
      let n = 1;
      for (;;) {
        // 11:
        p++;
        l--;
        if (n === 0) break;
        if (l === 0) SyntxError(503, LL);
        if (P() === '{') n++;
        else if (P() === '}') n--;
      }
      continue;
    }
    let x = '';
    let typ: number;
    if (IsLetter(P())) {
      typ = 1;
      for (;;) {
        // 2:
        x += P();
        p++;
        l--;
        if (l > 0 && x.length < 255) {
          if (IsLetter(P())) continue;
          if (IsDigit(P()) || P() === '_') {
            typ = 2;
            continue;
          }
        }
        break;
      }
    } else if (IsDigit(P())) {
      typ = 3;
      for (;;) {
        // 3:
        x += P();
        p++;
        l--;
        if (l > 0 && x.length < 255 && IsDigit(P())) continue;
        break;
      }
    } else {
      x = P();
      p++;
      l--;
      typ = 0;
    }
    AppendLex(tPrev, LL - l, typ, x);
  }
}
// PAS: RUNPROLG.PAS SetCFile – CFile := the file named Name (CRdb chain, or CATALOG)
function SetCFile(Name: string): void {
  const a = AccessVars;
  let r = a.CRdb;
  while (r !== null) {
    a.CFile = r.FD;
    while (a.CFile !== null) {
      if (SEquUpcase(Name, a.CFile.Name)) return;
      a.CFile = a.CFile.Chain;
    }
    r = r.ChainBack;
  }
  if (SEquUpcase(Name, 'CATALOG')) a.CFile = a.CatFD;
  else RunError(1539);
}
// PAS: RUNPROLG.PAS RetractDbEntry
function RetractDbEntry(Q: PInstance, POfs: number, B: TDbBranch): void {
  const p = SgPred(POfs);
  let prev: TDbBranch | null = null; // null: the chain root p^.Branch
  for (;;) {
    // 1:
    const nx: PDbBranch = prev === null ? (p.Branch as PDbBranch) : prev.Chain;
    if (nx === null) break;
    if (nx === B) {
      if (prev === null) p.Branch = B.Chain;
      else prev.Chain = B.Chain;
      while (Q !== null) {
        if (Q.NextBranch === B) Q.NextBranch = B.Chain;
        Q = Q.PrevInst;
      }
      break;
    }
    prev = nx;
  }
  RunPrologVars.Mem3.Free(B, LenDbEntry(B.Data, 0, p.Arity) + 4);
}
// PAS: RUNPROLG.PAS AppendPackedTerm – `L += term`: the packed term appended to Vars[apIdx]
function AppendPackedTerm(C: TCommand): void {
  const A = new Uint8Array(MaxPackedPredLen);
  PTBuf = A;
  PackedTermPtr = 2; // @A[3]
  PTPMaxOfs = MaxPackedPredLen - 2;
  PackTermV(C.apTerm);
  const n = PackedTermPtr;
  setWord(A, 0, n);
  const b = RunPrologVars.Mem3.Alloc(PtrSz + n, new TDbBranch());
  b.Data = A.slice(0, n);
  ChainLast(aref(CurrInst!.Vars as unknown as (TDbBranch | null)[], C.apIdx), b);
}
// PAS: RUNPROLG.PAS UnpackAppendedTerms – the appended packed terms of Vars[apIdx] as one list
function UnpackAppendedTerms(C: TCommand): void {
  const Vars = CurrInst!.Vars;
  let b = Vars[C.apIdx] as unknown as PDbBranch;
  const pt = aref(Vars, C.apIdx);
  pt.v = null;
  while (b !== null) {
    PTBuf = b.Data;
    PackedTermPtr = 2; // @b^.A
    const t = UnpackTerm(C.apDom);
    ChainList(pt, t);
    const b1 = b;
    b = b.Chain;
    RunPrologVars.Mem3.Free(b1, getWord(b1.Data, 0) + 4);
  }
}
// PAS: RUNPROLG.PAS RunCommand – false: fail
function RunCommand(COff: number): boolean {
  const a = AccessVars;
  const c = SgCmd(COff);
  const ci = CurrInst!;
  switch (c.Code) {
    case _WriteC: {
      let wofs = c.WrD;
      while (wofs !== 0) {
        const w = SgPtr(wofs) as TWriteD;
        if (w.IsString) write(w.SS);
        else PrintTerm(ci.Vars[w.Idx], w.Dom);
        wofs = w.Chain;
      }
      if (c.NL) writeln();
      break;
    }
    case _CompC: {
      const i = c.E1Idx;
      if (c.CompOp === _assign) ci.Vars[i] = CopyTerm(c.E2);
      else {
        let res = _equ;
        switch (c.Typ) {
          case _IntD: {
            const i1 = ci.Vars[i]!.II;
            const i2 = RunIExpr(c.E2);
            if (i1 < i2) res = _lt;
            else if (i1 > i2) res = _gt;
            break;
          }
          case _RealD: {
            const r1 = ci.Vars[i]!.RR;
            const r2 = RunRExpr(c.E2);
            if (r1 < r2) res = _lt;
            else if (r1 > r2) res = _gt;
            break;
          }
          default:
            if (!UnifyTermsCV(ci.Vars[i], c.E2)) res = _gt;
        }
        if ((ord(res) & ord(c.CompOp)) === 0) return false;
      }
      break;
    }
    case _SaveC:
    case _ConsultC:
    case _LoadLexC: {
      const p1 = ref<Pointer>(null);
      MarkStore(p1);
      a.CFile = c.FD;
      if (a.CFile === null) {
        SetCFile(c.Name);
        c.FD = a.CFile;
      }
      const cf = a.CFile!;
      let md: LockMode;
      const n = ref(0);
      if (c.Code === _SaveC) {
        md = NewLMode(WrMode);
        if (!LinkLastRec(cf, n, true)) IncNRecs(1);
        DelTFld(c.FldD);
        const s = SaveDb(c.DbPred, 0);
        LongS_(c.FldD, s);
        WriteRec(cf.NRecs);
      } else {
        md = NewLMode(RdMode);
        LinkLastRec(cf, n, true);
        const s = _LongS(c.FldD);
        if (c.Code === _ConsultC) ConsultDb(s, c.DbPred);
        else LoadLex(s);
      }
      OldLMode(md);
      ReleaseStore(p1.v);
      break;
    }
    case _ErrorC: {
      let i1 = -1;
      let i = 1;
      let wofs = c.WrD;
      while (wofs !== 0) {
        const w = SgPtr(wofs) as TWriteD;
        if (w.IsString) {
          BaseVars.MsgPar[i] = w.SS;
          i++;
        } else {
          const t = ci.Vars[w.Idx]!;
          if (SgDom(w.Dom).Typ === _IntD) i1 = t.II;
          else {
            BaseVars.MsgPar[i] = t.SS;
            i++;
          }
        }
        wofs = w.Chain;
      }
      if (i1 === -1) {
        i1 = 0;
        if (LexemList !== null) i1 = LexemList.Elem!.Arg[0]!.II;
      }
      SyntxError(c.MsgNr, i1);
      break;
    }
    case _WaitC:
      WaitC();
      break;
    case _AppPkC:
      AppendPackedTerm(c);
      break;
    case _AppUnpkC:
      UnpackAppendedTerms(c);
      break;
  }
  return true;
}
// PAS: RUNPROLG.PAS CallFandProc – a predicate declared as @name(...): runs the FAND procedure
function CallFandProc(): void {
  const bv = BaseVars;
  const p = SgPred(CurrInst!.Pred);
  const pd = SgPtr(p.Branch as number) as NonNullable<InstrPtr>;
  const ps = new ProcStkD(); // GetZStore(p^.LocVarSz)
  let w = p.InpMask;
  if (typeof pd.PPos.R === 'number') {
    // Pascal: PtrUInt(pd^.Pos.R)<$10000 – still a segment offset
    const x = SgPtr(pd.PPos.R as number);
    if (pd.PPos.IRec === 0xffff) {
      pd.PPos.R = null;
      if (!FindChpt('P', x as string, false, pd.PPos)) RunError(1037);
    } else {
      // IRec=0: the procedure text formula (TS RdbPos keeps it in Frml)
      pd.PPos.R = null;
      pd.PPos.Frml = x as FrmlPtr;
    }
  }
  for (let i = 1; i <= p.Arity; i++) {
    const ta = pd.TArg[i];
    const Frml = ta.Frml!;
    if (Frml.Op === _getlocvar) ps.V[Frml.BPOfs] = ta.FTyp === 'B' ? false : 0; // zeroed frame
    const dofs = p.Arg[i - 1];
    const t = CurrInst!.Vars[i - 1]!;
    if ((w & 1) !== 0) {
      switch (ta.FTyp) {
        case 'R':
          Frml.R = t.Fun === _IntT ? t.II : t.RR;
          break;
        case 'B':
          Frml.B = t.Fun !== 0;
          break;
        default:
          if (Frml.Op === _const) Frml.S = t.SS;
          else {
            const s = SgDom(dofs).Typ === _LongStrD ? RdLongStr(t.Pos) : GetPackedTerm(t);
            ps.V[Frml.BPOfs] = AccessVars.TWork.Store(s);
          }
      }
    }
    w = w >>> 1;
  }
  ps.ChainBack = bv.MyBP;
  const oldBP = bv.MyBP;
  SetMyBP(ps);
  CallProcedure(pd);
  w = p.InpMask;
  const Vars = CurrInst!.Vars;
  for (let i = 1; i <= p.Arity; i++) {
    const ta = pd.TArg[i];
    const Frml = ta.Frml!;
    const dofs = p.Arg[i - 1];
    const d = SgDom(dofs);
    if (Frml.Op === _getlocvar) {
      switch (ta.FTyp) {
        case 'S':
          if ((w & 1) === 0) {
            if (d.Typ === _StrD) Vars[i - 1] = GetStringTerm(RunShortStr(Frml));
            else {
              const s = RunLongStr(Frml);
              if (d.Typ === _LongStrD) Vars[i - 1] = GetLongStrTerm(WrLongStr(s));
              else {
                PTBuf = s;
                PackedTermPtr = 0;
                Vars[i - 1] = UnpackTerm(dofs);
              }
            }
          }
          AccessVars.TWork.Delete(bv.MyBP!.V[Frml.BPOfs] as number);
          break;
        case 'R':
          if (d.Typ === _IntD) Vars[i - 1] = GetIntTerm(RunInt(Frml));
          else Vars[i - 1] = GetRealTerm(RunReal(Frml));
          break;
        default:
          Vars[i - 1] = GetBoolTerm(RunBool(Frml));
      }
    }
    w = w >>> 1;
  }
  SetMyBP(oldBP);
}
// PAS: RUNPROLG.PAS SiCFile – CFile of a FAND-file predicate (resolved by name on first use)
function SiCFile(SiOfs: number): TScanInf {
  const a = AccessVars;
  const si = SgPtr(SiOfs) as TScanInf;
  a.CFile = si.FD;
  if (a.CFile !== null) return si;
  SetCFile(si.Name);
  si.FD = a.CFile;
  return si;
}
// PAS: RUNPROLG.PAS AssertFand – assert of a FAND-file predicate: a new record
function AssertFand(P: TPredicate, C: TCommand): void {
  const a = AccessVars;
  const si = SiCFile(P.Branch as number);
  const md = NewLMode(CrMode);
  a.CRecPtr = GetRecSpace();
  ZeroAllFlds();
  let flofs = si.FL;
  let lofs = C.Arg;
  let i = 0;
  const trace = Trace();
  if (trace) write('CALL assert(', SgStr(P.Name), '(');
  while (flofs !== 0) {
    const fl = SgPtr(flofs) as TFldList;
    const l = SgPtr(lofs) as TTermList;
    const f = fl.FldD!;
    if ((f.Flg & f_Stored) !== 0) {
      const t = CopyTerm(l.Elem)!;
      const dofs = P.Arg[i];
      if (trace) {
        if (i > 0) write(',');
        PrintTerm(t, dofs);
      }
      switch (f.FrmlTyp) {
        case 'B':
          B_(f, t.Fun !== 0);
          break;
        case 'R':
          R_(f, t.Fun === _IntT ? t.II : t.RR);
          break;
        default:
          if (f.Typ === 'T') {
            const s = SgDom(dofs).Typ === _LongStrD ? RdLongStr(t.Pos) : GetPackedTerm(t);
            LongS_(f, s);
          } else S_(f, t.SS);
      }
    }
    flofs = fl.Chain;
    lofs = l.Chain;
    i++;
  }
  if (trace) {
    writeln('))');
    WaitC();
  }
  const cf = a.CFile!;
  TestXFExist();
  IncNRecs(1);
  if (cf.Typ === 'X') RecallRec(cf.NRecs);
  else WriteRec(cf.NRecs);
  OldLMode(md);
}
// PAS: RUNPROLG.PAS GetScan – the records of a FAND-file predicate call (by key when possible)
function GetScan(SIOfs: number, C: TCommand, Q: TInstance): PFileScan {
  const a = AccessVars;
  SiCFile(SIOfs);
  const cf = a.CFile!;
  let fs: PFileScan = RunPrologVars.Mem1.Get(8, new TFileScan());
  const md = NewLMode(RdMode);
  const k = C.KDOfs;
  if (k === null) {
    fs.IRec = 1;
    fs.Count = cf.NRecs;
  } else {
    TestXFExist();
    const xx = new XString();
    xx.Clear();
    let i = 0;
    let kf = k.KFlds;
    let f: FieldDPtr = null;
    while (kf !== null) {
      f = kf.FldD;
      const t = Q.Vars[C.ArgI[i]]!;
      switch (f!.FrmlTyp) {
        case 'R':
          xx.StoreReal(t.Fun === _IntT ? t.II : t.RR, kf);
          break;
        case 'B':
          xx.StoreBool(t.Fun !== 0, kf);
          break;
        default:
          if (t.Fun === _StrT) xx.StoreStr(t.SS, kf);
          else {
            const s = t.Fun === _LongStrT ? RdLongStr(t.Pos) : GetPackedTerm(t);
            let ss = '';
            for (let j = 0; j < Math.min(s.length, 255); j++) ss += chr(s[j]);
            xx.StoreStr(ss, kf);
          }
      }
      kf = kf.Chain;
      i++;
    }
    const irec = ref(0);
    k.FindNr(xx, irec);
    fs.IRec = irec.v;
    if (f!.Typ !== 'A' || xx.S[xx.S.length - 1] !== '\x1f') xx.S = xx.S + '\xff';
    else xx.S = xx.S.slice(0, -1) + '\xff';
    const n = ref(0);
    const b = k.FindNr(xx, n);
    fs.Count = 0;
    if (n.v >= fs.IRec) fs.Count = n.v - fs.IRec + (b ? 1 : 0);
  }
  OldLMode(md); // 1:
  if (fs.Count === 0) fs = null;
  return fs;
}
// PAS: RUNPROLG.PAS _MyS – a string field value without the justification blanks
function _MyS(F: FieldDPtr): string {
  if (F!.Typ === 'A') {
    if (F!.M === LeftJust) return TrailChar(' ', _ShortS(F));
    return LeadChar(' ', _ShortS(F));
  }
  return _ShortS(F);
}
// PAS: RUNPROLG.PAS ScanFile – the next matching record of a FAND-file predicate
function ScanFile(Q: PInstance): boolean {
  const a = AccessVars;
  const ci = CurrInst!;
  const fs = ci.NextBranch as PFileScan;
  if (fs === null) return false;
  const pofs = ci.Pred;
  const p = SgPred(pofs);
  const c = SgCmd(ci.RetCmd);
  const si = SgPtr(p.Branch as number) as TScanInf;
  a.CFile = si.FD;
  const cf = a.CFile!;
  a.CRecPtr = GetRecSpace();
  const md = NewLMode(RdMode);
  const k = c.KDOfs;
  let result = false;
  let RecNr = 0;
  scan: for (;;) {
    // 1:
    if (k === null) {
      do {
        RecNr = fs.IRec;
        if (RecNr > cf.NRecs) {
          ci.NextBranch = null;
          break scan; // goto 2
        }
        ReadRec(RecNr);
        fs.IRec++;
      } while (DeletedFlag());
      if (fs.IRec > cf.NRecs) ci.NextBranch = null;
    } else {
      if (fs.Count === 0 || fs.IRec > k.NRecs()) {
        ci.NextBranch = null;
        break scan;
      }
      RecNr = k.NrToRecNr(fs.IRec);
      ReadRec(RecNr);
      fs.IRec++;
      fs.Count--;
      if (fs.Count === 0 || fs.IRec > k.NRecs()) ci.NextBranch = null;
    }
    // compare with inp. parameters
    let flofs = si.FL;
    let w = c.CompMask;
    for (let i = 0; i <= p.Arity - 1; i++) {
      const fl = SgPtr(flofs) as TFldList;
      if ((w & 1) !== 0) {
        const t = ci.Vars[i]!;
        const f = fl.FldD!;
        switch (f.FrmlTyp) {
          case 'B':
            if ((_B(f) ? 1 : 0) !== t.Fun) continue scan;
            break;
          case 'R': {
            const r = _R(f);
            if (t.Fun === _IntT) {
              if (r !== t.II) continue scan;
            } else if (r !== t.RR) continue scan;
            break;
          }
          default:
            if (f.Typ === 'T') {
              const s = SgDom(p.Arg[i]).Typ === _LongStrD ? RdLongStr(t.Pos) : GetPackedTerm(t);
              if (!EquLongStr(s, _LongS(f))) continue scan;
            } else if (t.SS !== _MyS(f)) continue scan;
        }
      }
      flofs = fl.Chain;
      w = w >>> 1;
    }
    // create outp. parameters
    flofs = si.FL;
    w = c.OutpMask;
    for (let i = 0; i <= p.Arity - 1; i++) {
      const fl = SgPtr(flofs) as TFldList;
      if ((w & 1) !== 0) {
        const f = fl.FldD!;
        const d = SgDom(p.Arg[i]);
        switch (f.FrmlTyp) {
          case 'B':
            ci.Vars[i] = GetBoolTerm(_B(f));
            break;
          case 'R':
            if (d.Typ === _RealD) ci.Vars[i] = GetRealTerm(_R(f));
            else ci.Vars[i] = GetIntTerm(Trunc(_R(f)));
            break;
          default:
            if (f.Typ === 'T') {
              const s = _LongS(f);
              if (d.Typ === _LongStrD) ci.Vars[i] = GetLongStrTerm(WrLongStr(s));
              else {
                PTBuf = s;
                PackedTermPtr = 0;
                ci.Vars[i] = UnpackTerm(p.Arg[i]);
              }
            } else ci.Vars[i] = GetStringTerm(_MyS(f));
        }
      }
      flofs = fl.Chain;
      w = w >>> 1;
    }
    result = true;
    if (c.Code === _RetractC) {
      const md1 = NewLMode(DelMode);
      let cc = c;
      while (Q !== null) {
        const fs1 = Q.NextBranch as PFileScan;
        if (Q.Pred === pofs && fs1 !== null) {
          if (cf.Typ === 'X') {
            cc = SgCmd(Q.RetCmd);
            if (cc.KDOfs !== null) {
              const xx = new XString();
              xx.PackKF(k!.KFlds);
              k!.RecNrToPath(xx, RecNr);
              if (k!.PathToNr() <= fs1.IRec) fs1.IRec--;
            }
          } else if (RecNr <= fs1.IRec) fs1.IRec--;
        }
        Q = Q.PrevInst;
      }
      if (cf.Typ === 'X') {
        DeleteXRec(RecNr, true);
        fs.IRec--;
      } else DeleteRec(RecNr);
      OldLMode(md1);
    }
    break;
  }
  OldLMode(md); // 2:
  return result;
}

// PAS: RUNPROLG.PAS SaveLMode
function SaveLMode(): void {
  const cf = AccessVars.CFile!;
  cf.ExLMode = cf.LMode;
}
// PAS: RUNPROLG.PAS SetOldLMode
function SetOldLMode(): void {
  OldLMode(AccessVars.CFile!.ExLMode);
}

// PAS: RUNPROLG.PAS TraceCall – X=1: CALL (input args), X=0: RETURN/MEMBER (output args)
function TraceCall(Q: TInstance, X: number): void {
  const p = SgPred(Q.Pred);
  const c = SgCmd(Q.RetCmd);
  if (X === 1) write('CALL ');
  else if (c.Code === _AllC) write('MEMBER ');
  else write('RETURN ');
  switch (c.Code) {
    case _RetractC:
      write('retract(');
      break;
    case _NotC:
      write('not(');
      break;
    case _AllC:
      write('all_XX(');
      break;
  }
  write(SgStr(p.Name));
  if (p.Arity > 0) {
    write('(');
    let w = (p.Opt & _CioMaskOpt) !== 0 ? c.InpMask ?? 0 : p.InpMask;
    for (let i = 0; i <= p.Arity - 1; i++) {
      if (i > 0) write(',');
      let dofs = p.Arg[i];
      if ((w & 1) === X) {
        if (X === 1 && (p.Opt & _PackInpOpt) !== 0) PrintPackedTerm(Q.Vars[i] as unknown as Uint8Array, 0, dofs);
        else {
          if ((p.Opt & _BuildInOpt) !== 0) {
            switch (p.LocVarSz) {
              case _MemP:
              case _AddP:
              case _DelP:
                dofs = c.Elem;
                if (i === 0) dofs = SgDom(dofs).ElemDom;
                break;
              case _LenP:
                if (i === 0) dofs = c.Elem;
                break;
              case _InvP:
              case _UnionP:
              case _MinusP:
              case _InterP:
                dofs = c.Elem;
                break;
            }
          }
          PrintTerm(Q.Vars[i], dofs);
        }
      } else write('_');
      w = w >>> 1;
    }
    write(')');
  }
  if (c.Code === _RetractC || c.Code === _NotC || c.Code === _AllC) write(')');
  writeln();
  WaitC();
}

// PAS: RUNPROLG.PAS TAutoR
class TAutoR {
  i = 0;
  wasCall = false;
  t: PTerm = null;
  Arg: PTerm[] = [];
}

// PAS: RUNPROLG.PAS AutoRecursion – one step of `p(!,...)`: true = call p on the next subterm
function AutoRecursion(q: TInstance, p: TPredicate, c: TCommand): boolean {
  const dofs0 = p.Arg[0];
  const d0 = SgDom(dofs0);
  const iOutp = c.iOutp;
  let t1 = q.Vars[c.iWrk];
  let t: PTerm = null;
  // label 2: default outputs of the pairs; then 3: false
  const pairs = (): boolean => {
    for (let j = 0; j <= c.nPairs - 1; j++) {
      const i = c.Pair[j].iInp;
      const i2 = c.Pair[j].iOutp;
      if (i > 0) t = q.Vars[i];
      else {
        switch (SgDom(p.Arg[i2]).Typ) {
          case _ListD:
            t = null;
            break;
          case _StrD:
            t = GetStringTerm('');
            break;
          case _LongStrD:
            t = GetLongStrTerm(WrLongStrLP(0, null));
            break;
          case _IntD:
            t = GetIntTerm(0);
            break;
          case _RealD:
            t = GetRealTerm(0);
            break;
        }
      }
      q.Vars[i2] = t;
    }
    return false;
  };
  if (d0.Typ === _ListD) {
    if (t1 === null) {
      t = q.Vars[0];
      if (t === null) {
        if (iOutp > 0) q.Vars[iOutp] = t;
        return pairs();
      }
      q.Vars[c.iWrk] = t;
      q.Vars[0] = t.Next;
      return true;
    }
    if (iOutp > 0) {
      t = q.Vars[iOutp];
      if (t !== t1.Next) t1 = GetListTerm(t1.Elem, t);
      q.Vars[iOutp] = t1;
    }
    return false;
  }
  let w = t1 as unknown as TAutoR | null;
  let f: TFunDcl;
  let i: number;
  if (w === null) {
    t = q.Vars[0]!;
    f = GetFunDcl(dofs0, t.Fun);
    w = RunPrologVars.Mem2.Get(9 + 4 * f.Arity, new TAutoR());
    w.Arg = new Array<PTerm>(f.Arity).fill(null);
    w.t = t;
    i = 0;
    q.Vars[c.iWrk] = w as unknown as PTerm;
  } else {
    t = w.t!;
    f = GetFunDcl(dofs0, t.Fun);
    i = w.i;
    if (iOutp > 0) w.Arg[i] = q.Vars[iOutp];
    i++;
  }
  while (i < f.Arity) {
    if (f.Arg[i] === dofs0) {
      if (w.wasCall) for (let j = 0; j <= c.nPairs - 1; j++) q.Vars[c.Pair[j].iInp] = q.Vars[c.Pair[j].iOutp];
      q.Vars[0] = t.Arg[i];
      w.i = i;
      w.wasCall = true;
      return true; // 1:
    }
    if (iOutp > 0) w.Arg[i] = t.Arg[i];
    i++;
  }
  if (iOutp > 0) {
    let same = true;
    for (let k = 0; k < f.Arity; k++) if (t.Arg[k] !== w.Arg[k]) same = false;
    if (!same) {
      const tn = GetFunTerm(t.Fun, f.Arity);
      for (let k = 0; k < f.Arity; k++) tn.Arg[k] = w.Arg[k];
      q.Vars[iOutp] = tn;
    } else q.Vars[iOutp] = t;
  }
  if (!w.wasCall) return pairs();
  return false; // 3:
}

// PAS: RUNPROLG.PAS RunProlog – run PredName (arity 0, else RunError 1545; nil = the first predicate)
export function RunProlog(Pos: RdbPos, PredName: StringPtr): void {
  const rv = RunPrologVars;
  const a = AccessVars;
  const bv = BaseVars;
  rv.ProlgCallLevel++;
  const er = new ExitRecord();
  NewExit(null, er);
  bv.LastExitCode = 1;
  const oldSg = RdPrologVars._Sg;
  const oldSgMark = SgMark();
  const oldCurrInst = CurrInst;
  ForAllFDs(SaveLMode);
  const WMark = bv.MaxWSize;
  const pm1 = ref<Pointer>(null);
  const pm2 = ref<Pointer>(null);
  const pp = ref<Pointer>(null);
  let pp1: Pointer = null;
  let pp2: Pointer = null;
  let pp3: Pointer = null;
  let tl = 0;
  let cl = 0;
  if (rv.ProlgCallLevel === 1) {
    MarkBoth(pm1, pm2);
    rv.FreeMemList = null;
    rv.Mem1.Init();
    rv.Mem2.Init();
    rv.Mem3.Init();
    TrcLevel = 0;
    CallLevel = 0;
  } else {
    MarkStore(pp);
    pp1 = rv.Mem1.Mark();
    pp2 = rv.Mem2.Mark();
    pp3 = rv.Mem3.Mark();
    tl = TrcLevel;
    cl = CallLevel;
  }
  let foreign = true; // TS: an exception other than GoExit is propagating
  try {
    RunPrologBody(Pos, PredName);
    foreign = false;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
    a.EdBreak = 2; // 7:
    foreign = false;
  } finally {
    // 8:
    RestoreExit(er);
    RdPrologVars._Sg = oldSg;
    SgRelease(oldSgMark);
    CurrInst = oldCurrInst;
    if (!foreign) ForAllFDs(SetOldLMode);
    bv.MaxWSize = WMark;
    if (rv.ProlgCallLevel === 1) ReleaseBoth(pm1.v, pm2.v);
    else {
      ReleaseStore(pp.v);
      rv.Mem1.Release(pp1);
      rv.Mem2.Release(pp2);
      rv.Mem3.Release(pp3);
      TrcLevel = tl;
      CallLevel = cl;
    }
    rv.ProlgCallLevel--;
  }
}

// PAS: RUNPROLG.PAS RunProlog (from the compilation to label 8) – TS-only split; the Pascal labels
// are the states of the loop below
function RunPrologBody(Pos: RdbPos, PredName: StringPtr): void {
  const rv = RunPrologVars;
  const a = AccessVars;
  const bv = BaseVars;
  let ChptLRdb: RdbDPtr;
  if (Pos.IRec === 0) {
    SetInpLongStr(RunLongStr(Pos.Frml), true);
    RdPrologVars._Sg = ReadProlog(0);
    ChptLRdb = a.CRdb;
  } else {
    ChptLRdb = Pos.R;
    a.CFile = ChptLRdb!.FD;
    a.CRecPtr = GetRecSpace();
    ReadRec(Pos.IRec);
    SetInpTTPos(_T(a.ChptTxt), ChptLRdb!.Encrypted);
    RdPrologVars._Sg = ReadProlog(0);
  }
  void ChptLRdb;
  const Roots = SgPtr(0) as TProgRoots;

  let dbofs = Roots.Databases;
  while (dbofs !== 0) {
    const db = SgPtr(dbofs) as TDatabase;
    ConsultDb(SgPtr(db.SOfs) as LongStrPtr, dbofs);
    dbofs = db.Chain;
  }
  let TopInst: PInstance = null;
  CurrInst = null;
  let q: PInstance = null;
  let q1: PInstance = null;
  let cofs = 0;
  let b: Pointer = 0; // Pascal b / bofs / bd (absolute): a branch offset or a TDbBranch
  let lofs = 0;
  let w = 0;
  let i = 0;
  const A = new Uint8Array(MaxPackedPredLen);
  let pofs = Roots.Predicates; // main
  let p = SgPred(pofs);
  if (PredName !== null) {
    while (pofs !== 0 && SgStr(SgPred(pofs).Name) !== PredName) pofs = SgPred(pofs).Chain;
    if (pofs === 0 || SgPred(pofs).Arity !== 0) {
      Set2MsgPar(Pos.R?.FD?.Name ?? '', PredName);
      RunError(1545);
    }
    p = SgPred(pofs);
  }
  const bofs = (): number => (typeof b === 'number' ? b : 0);
  const setP = (o: number): void => {
    pofs = o;
    p = SgPred(o);
  };
  let L = 1;
  for (;;) {
    switch (L) {
      case 1: {
        // new instance; remember prev. inst, branch, cmd
        q = rv.Mem2.Get(p.InstSz + 30, new TInstance(Math.trunc(p.InstSz / PtrSz)));
        q.Pred = pofs;
        q.PrevInst = TopInst;
        TopInst = q;
        q.RetInst = CurrInst;
        q.RetBranch = bofs();
        q.RetCmd = cofs;
        if (TrcLevel !== 0) {
          CallLevel = (CurrInst?.CallLevel ?? 0) + 1;
          q.CallLevel = CallLevel;
        }
        // copy input parameters
        b = p.Branch;
        i = 0;
        const c = SgCmd(cofs);
        w = (p.Opt & _CioMaskOpt) !== 0 ? c.InpMask ?? 0 : p.InpMask;
        while (lofs !== 0) {
          const l = SgPtr(lofs) as TTermList;
          if ((w & 1) !== 0) {
            if ((p.Opt & _PackInpOpt) !== 0) {
              PTBuf = A;
              PackedTermPtr = 0;
              PTPMaxOfs = MaxPackedPredLen - 2;
              PackTermV(l.Elem);
              const n = PackedTermPtr;
              const s = rv.Mem1.Get(2 + n, A.slice(0, n));
              q.Vars[i] = s as unknown as PTerm;
            } else q.Vars[i] = CopyTerm(l.Elem);
          }
          i++;
          lofs = l.Chain;
          w = w >>> 1;
        }
        if ((p.Opt & (_FandCallOpt + _DbaseOpt)) === _FandCallOpt + _DbaseOpt) q.NextBranch = GetScan(bofs(), c, q);
        if (Trace()) TraceCall(q, 1);
        q.StkMark = rv.Mem1.Mark();
        q.WMark = bv.MaxWSize;
        CurrInst = q;
        if ((p.Opt & (_FandCallOpt + _DbaseOpt)) === _FandCallOpt) {
          CallFandProc();
          L = 4;
          continue;
        }
        L = 2;
        continue;
      }
      case 2: {
        // branch / redo
        if ((p.Opt & _BuildInOpt) !== 0) {
          // build-in predicates
          L = RunBuildIn() ? 4 : 5;
          continue;
        }
        if ((p.Opt & _DbaseOpt) !== 0) {
          // database predicates
          if ((p.Opt & _FandCallOpt) !== 0) {
            L = ScanFile(TopInst) ? 4 : 5;
            continue;
          }
          let bd = b as PDbBranch;
          if (bd === null) {
            L = 5;
            continue;
          }
          cofs = q!.RetCmd;
          const c = SgCmd(cofs);
          let found = false;
          while (!found) {
            // 21:
            let s = 0;
            w = c.InpMask;
            found = true;
            for (i = 0; i <= p.Arity - 1; i++) {
              const ll = getWord(bd!.Data, s);
              if ((w & 1) !== 0 && !EquLongStr(q!.Vars[i] as unknown as Uint8Array, bd!.Data.subarray(s + 2, s + 2 + ll))) {
                bd = bd!.Chain;
                if (bd === null) {
                  q!.NextBranch = null;
                  break;
                }
                found = false;
                break;
              }
              s += ll + 2;
              w = w >>> 1;
            }
            if (bd === null) break;
          }
          if (bd === null) {
            L = 5;
            continue;
          }
          // 22:
          q!.NextBranch = bd.Chain;
          let s = 0;
          w = c.OutpMask;
          for (i = 0; i <= p.Arity - 1; i++) {
            const ll = getWord(bd.Data, s);
            if ((w & 1) !== 0) {
              PTBuf = bd.Data;
              PackedTermPtr = s + 2;
              q!.Vars[i] = UnpackTerm(p.Arg[i]); // unpack db outp. parameters
            }
            s += ll + 2;
            w = w >>> 1;
          }
          if (c.Code === _RetractC) RetractDbEntry(TopInst, pofs, bd);
          b = bd;
          L = 4;
          continue;
        }
        L = 23; // SgFix(b)
        continue;
      }
      case 23: {
        // normal predicates: unify branch head
        const br = SgPtr(b as number) as TBranch;
        q!.NextBranch = NB(br.Chain);
        i = 0;
        lofs = br.Head;
        w = br.HeadIMask;
        let ok = true;
        while (lofs !== 0) {
          const l = SgPtr(lofs) as TTermList;
          if ((w & 1) !== 0 && !UnifyTermsCV(q!.Vars[i], l.Elem)) {
            ok = false;
            break;
          }
          i++;
          lofs = l.Chain;
          w = w >>> 1;
        }
        if (!ok) {
          b = br.Chain;
          L = b === 0 ? 5 : 23;
          continue;
        }
        // execute all commands
        cofs = br.Cmd;
        L = 30;
        continue;
      }
      case 30: {
        // while cofs<>0 do
        if (cofs === 0) {
          L = 31;
          continue;
        }
        const c = SgCmd(cofs);
        L = 3;
        switch (c.Code) {
          case _PredC:
          case _RetractC:
          case _NotC:
            L = 24;
            break;
          case _AllC:
            q!.Vars[c.Idx] = null;
            L = 24;
            break;
          case _CutC:
            q!.NextBranch = null;
            while (TopInst !== q) {
              q1 = TopInst!.PrevInst;
              rv.Mem2.Release(TopInst);
              TopInst = q1;
            }
            break;
          case _FailC:
            L = 5;
            break;
          case _Trace:
            TrcLevel = c.TrcLevel;
            if (TrcLevel !== 0) {
              TrcLevel++;
              CallLevel = 1;
              q!.CallLevel = 1;
            } else {
              CallLevel = 0;
              q!.CallLevel = 0;
            }
            break;
          case _AssertC: {
            const p1 = SgPred(c.Pred);
            if ((p1.Opt & _FandCallOpt) !== 0) AssertFand(p1, c);
            else {
              lofs = c.Arg;
              PTBuf = A;
              PackedTermPtr = 0;
              PTPMaxOfs = MaxPackedPredLen - 2;
              while (lofs !== 0) {
                const l = SgPtr(lofs) as TTermList;
                const wp = PackedTermPtr;
                PackedTermPtr += 2;
                PackTermV(l.Elem);
                setWord(A, wp, PackedTermPtr - wp - 2);
                lofs = l.Chain;
              }
              const n = PackedTermPtr;
              const b1 = rv.Mem3.Alloc(PtrSz + n, new TDbBranch());
              b1.Data = A.slice(0, n);
              ChainLast(fref2(p1), b1);
              if (Trace()) PrintPackedPred(A, c.Pred);
            }
            break;
          }
          case _AutoC:
            L = 25;
            break;
          case _SelfC:
            if (TopInst !== q) {
              q1 = TopInst;
              while (q1!.PrevInst !== q) q1 = q1!.PrevInst;
              rv.Mem2.Release(q1);
              TopInst = q;
            }
            rv.Mem1.Release(q!.StkMark);
            bv.MaxWSize = q!.WMark;
            setP(q!.Pred);
            b = p.Branch;
            L = 6;
            break;
          default:
            if (!RunCommand(cofs)) L = 5;
        }
        continue;
      }
      case 24: {
        const c = SgCmd(cofs);
        setP(c.Pred);
        lofs = c.Arg;
        L = 1;
        continue;
      }
      case 25: {
        const c = SgCmd(cofs);
        if (AutoRecursion(q!, p, c)) {
          lofs = c.Arg;
          L = 1;
        } else L = 3;
        continue;
      }
      case 3:
        // resume command
        cofs = SgCmd(cofs).Chain;
        L = 30;
        continue;
      case 31: {
        // copy output parameters
        const br = SgPtr(b as number) as TBranch;
        i = 0;
        lofs = br.Head;
        w = br.HeadOMask;
        while (lofs !== 0) {
          const l = SgPtr(lofs) as TTermList;
          if ((w & 1) !== 0) q!.Vars[i] = CopyTerm(l.Elem);
          i++;
          lofs = l.Chain;
          w = w >>> 1;
        }
        L = 4;
        continue;
      }
      case 4:
        // called predicate finished
        cofs = q!.RetCmd;
        if (SgCmd(cofs).Code === _NotC) {
          TopInst = q!.PrevInst;
          L = 5;
          continue;
        }
        L = 41;
        continue;
      case 41: {
        if (Trace()) TraceCall(q!, 0);
        // unify output with caller terms
        b = q!.RetBranch;
        setP(q!.Pred);
        q1 = q;
        q = q!.RetInst;
        if (q === null) {
          a.EdBreak = 0;
          bv.LastExitCode = 0;
          return; // 8:
        }
        CurrInst = q;
        const c = SgCmd(cofs);
        w = (p.Opt & _CioMaskOpt) !== 0 ? c.OutpMask : ~p.InpMask & 0xffff;
        i = 0;
        lofs = c.Arg;
        let ok = true;
        while (lofs !== 0) {
          const l = SgPtr(lofs) as TTermList;
          if ((w & 1) === 1 && !UnifyTermsCV(q1!.Vars[i], l.Elem)) {
            ok = false;
            break;
          }
          i++;
          lofs = l.Chain;
          w = w >>> 1;
        }
        if (!ok) {
          L = 5;
          continue;
        }
        // return to caller
        if (c.Code === _AllC) {
          ChainList(aref(q.Vars, c.Idx), GetListTerm(CopyTerm(c.Elem), null));
          q1 = TopInst;
          while (q1 !== q) {
            q1!.StkMark = rv.Mem1.Mark();
            q1!.WMark = bv.MaxWSize;
            q1 = q1!.PrevInst;
          }
          L = 5;
          continue;
        }
        if (q1!.NextBranch === null && q1 === TopInst) {
          TopInst = q1!.PrevInst;
          rv.Mem2.Release(q1);
        }
        SetCallLevel(q.CallLevel);
        L = c.Code === _AutoC ? 25 : 3;
        continue;
      }
      case 5: {
        // backtracking
        q1 = null;
        q = TopInst as PInstance;
        while (q !== null && q.NextBranch === null) {
          const code = SgCmd(q.RetCmd).Code;
          if (code === _NotC || code === _AllC) break;
          q1 = q;
          q = q.PrevInst;
        }
        if (q === null) {
          if (Trace()) {
            writeln('FAIL');
            WaitC();
          }
          a.EdBreak = 1;
          bv.LastExitCode = 0;
          return; // 8:
        }
        rv.Mem1.Release(q.StkMark);
        bv.MaxWSize = q.WMark;
        if (q.NextBranch === null) {
          q1 = q;
          q = q1.RetInst!;
          b = q1.RetBranch;
          cofs = q1.RetCmd;
          CurrInst = q;
          TopInst = q1.PrevInst;
          rv.Mem2.Release(q1);
          const c = SgCmd(cofs);
          if (c.Code === _NotC) {
            if (Trace()) {
              writeln('FAIL\r\nRETURN not()');
              WaitC();
            }
          } else {
            q.Vars[c.Idx2] = q.Vars[c.Idx];
            q.Vars[c.Idx] = null;
            if (Trace()) {
              writeln('RETURN all_()');
              WaitC();
            }
          }
          SetCallLevel(q.CallLevel);
          setP(q.Pred);
          L = 3;
          continue;
        }
        if (Trace()) {
          writeln('FAIL');
          WaitC();
        }
        TopInst = q;
        CurrInst = TopInst;
        b = q.NextBranch;
        setP(q.Pred);
        SetCallLevel(q.CallLevel);
        if (q1 !== null) rv.Mem2.Release(q1);
        L = 6;
        continue;
      }
      case 6:
        if (Trace()) {
          writeln('REDO ', SgStr(p.Name));
          WaitC();
        }
        L = 2;
        continue;
    }
  }
}
