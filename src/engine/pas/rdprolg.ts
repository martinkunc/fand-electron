// PAS: RDPROLG.PAS – compiles a Prolog chapter (L): #DOMAINS, #CONSTANTS, #DATABASE, #PREDICATES,
// #CLAUSES into a "segment" of records linked by 16-bit offsets, run by RUNPROLG. Has its own
// small lexer (RdLex/Accept/IsKeyWord/... are private re-implementations, not COMPILE's).
//
// Porting notes:
// * State: interface variable _Sg (current segment number) -> RdPrologVars._Sg. Private globals:
//   VarDcls/VarCount (clause variables), IntDom/RealDom/StrDom/LongStrDom/BoolDom/LexDom/LLexDom
//   (built-in domains), MemPred..InterPred/TxtPred (built-in predicates), UnderscoreTerm,
//   UnbdVarsInTerm/WasUnbd/WasOp, Roots (TProgRoots), PackedTermPtr/PTPMaxOfs (DB term packing
//   cursor), ClausePreds; FPC: SgTab[0..MaxSgNr=32], SgNr. RUNPROLG shares ProlgCallLevel,
//   Mem1/Mem2/Mem3 (its own allocators) and FreeMemList.
// * Segments: BP7 builds the program in one 64K heap segment and links records with word offsets
//   (SgPtr(ofs) = ptr(_Sg, ofs)); the finished segment is stored as a LongStr in the chapter's
//   OldTxt (ReadProlog(RecNr<>0)). FPC keeps a table of segment bases (SgRegister) and always
//   recompiles from the source (PROJMGR calls ReadProlog(0), RUNPROLG recompiles too), so nothing
//   binary is persisted – we follow FPC.
//   Representation: each segment is a handle table (TSgTable); GetZStor/StorStr append an object
//   (record class below, or a byte string) and return its index = the "offset"; SgPtr(h) returns
//   the object, SgOfs(obj) looks the index up (and adds an object allocated elsewhere, the way any
//   heap pointer after the segment base has an offset). Offset 0 is Roots (the first record, as in
//   Pascal) and also means nil in all chains. All `word{PXxx}` fields stay numbers.
//   `pofs: word absolute p` + SgFix(p) pairs become `p = SgPtr(pofs)`.
// * Variant records below have all fields of all variants (small variant records, PORTING.md 7);
//   same-offset same-type fields are aliases: TPTerm Op0..Op4 = Op, Elem = E1, Next = E2;
//   TCommand WrD1 = WrD, Arg1 = Arg. TPTerm.E[1..3] (variant 2) overlays E1..E3: use E1..E3.
// * Packed DB terms (RdDbTerm, RdDbClause; TDbBranch.Data): a byte stream – strings as Pascal
//   strings, integers 2 bytes, reals sizeof(float) (BP7: 6-byte Real48; FPC: 8-byte double), lists
//   as a word count + elements, functors as one index byte + args; each argument of a clause is
//   prefixed by its word length. SaveDb/ConsultDb (RUNPROLG) write/read this into a FAND 'T' field.
//   We use the BP7 Real48 (UFAND compatibility of saved databases).
// * FAND-file predicates: TCommand.KDOfs is a KeyDPtr (FPC); ArgI[] is a byte array of argument
//   indexes. TPredicate.Branch is: a PBranch offset (clauses), the offset of the _proc Instr
//   (FAND procedure), the offset of a PScanInf (FAND file) or a PDbBranch chain (database).
// * Sizes passed to GetZStor are the BP7 record sizes; they only feed the segment size check
//   (error 544 when the program exceeds MaxLStrLen, as the BP7 HeapTop-AA check).
// * TS-only: TSgTable, Sg* typed accessors, DTyp.

import { defineAliases, ref, fref, chr, ord, Copy, ValI, ValR, int16, type Ref, type Pointer } from './pasrt.ts';
import { writeReal48 } from '../fand/numbers.ts';
import type { float, SgOfsInt } from './base.ts';
import type { FileDPtr, FieldDPtr, KeyDPtr, FrmlPtr, RdbDPtr, LinkDPtr } from './access.ts';
import { AccessVars, _quotedstr, _identifier, _number, _assign, _or, _and, _const, _conv, _equ, _ne, _le, _lt, _ge, _gt,
  _length, _pos, _min, _max, _val, _copy, _str, _repeatstr, _leadchar, _trailchar, _maxrow, _maxcol, _getlocvar,
  ResetCompilePars, RdbPos } from './access.ts';
import { BaseVars, IsLetter, IsDigit, HexStrToLong, SetMsgPar, Set2MsgPar, ChainLast, MaxLStrLen, MarkBoth,
  ReleaseStore, ReleaseStore2 } from './base.ts';
import { Error, OldError, SkipBlank, ReadChar, RdBackSlashCode, TestLex, RdFileName, RdFldName, IsRoleName,
  FindChpt, GetOp } from './compile.ts';
import { Instr, TypAndFrml, _proc } from './rdrun.ts';
import { RunPrologVars, SaveDb } from './runprolg.ts';

export const _IntT = 249;
export const _RealT = 250;
export const _StrT = 251;
export const _LongStrT = 252;
export const _ListT = 253;
export const _VarT = 254;
export const _UnderscT = 255; // term fun
export const _CioMaskOpt = 0x80; // predicate Opt
export const _PackInpOpt = 0x40;
export const _FandCallOpt = 0x20;
export const _BuildInOpt = 0x10;
export const _DbaseOpt = 0x08;
export const _ConcatP = 2;
export const _NextLexP = 4;
export const _GetLexP = 5;
export const _FandFieldP = 6;
export const _FandFileP = 7;
export const _FandKeyP = 8;
export const _FandKeyFieldP = 9;
export const _FandLinkP = 10;
export const _FandLinkFieldP = 11;
export const _MemP = 14;
export const _LenP = 15;
export const _InvP = 16;
export const _AddP = 17;
export const _DelP = 18;
export const _UnionP = 20;
export const _MinusP = 21;
export const _InterP = 22;
export const _AbbrevP = 25;
export const _CallP = 32;

// TDomainTyp = (_UndefD, _IntD, _RealD, _StrD, _LongStrD, _ListD, _FunD, _RedefD)
export type TDomainTyp = number;
export const _UndefD = 0;
export const _IntD = 1;
export const _RealD = 2;
export const _StrD = 3;
export const _LongStrD = 4;
export const _ListD = 5;
export const _FunD = 6;
export const _RedefD = 7;

// TCommandTyp = (_PredC, _FailC, _CutC, _WriteC, _CompC, _AssertC, _RetractC, _SaveC, _ConsultC,
//   _LoadLexC, _Trace, _SelfC, _AppPkC, _AppUnpkC, _ErrorC, _WaitC, _NotC, _AllC, _AutoC)
export type TCommandTyp = number;
export const _PredC = 0;
export const _FailC = 1;
export const _CutC = 2;
export const _WriteC = 3;
export const _CompC = 4;
export const _AssertC = 5;
export const _RetractC = 6;
export const _SaveC = 7;
export const _ConsultC = 8;
export const _LoadLexC = 9;
export const _Trace = 10;
export const _SelfC = 11;
export const _AppPkC = 12;
export const _AppUnpkC = 13;
export const _ErrorC = 14;
export const _WaitC = 15;
export const _NotC = 16;
export const _AllC = 17;
export const _AutoC = 18;

/** TS-only: sizeof(pointer) of BP7 (TPredicate.InstSz counts instance variables in these units). */
export const PtrSz = 4;
/** TS-only: sizeof(float) in packed terms – BP7 Real48. */
export const FloatSz = 6;

// Record types. Fields typed `number` with a {PXxx} comment are segment offsets (handles).

export type PDomain = TDomain | null;
// PAS: RDPROLG.PAS TDomain – case: 0: (ElemDom; Name) | 1: (OrigDom) | 2: (FunDcl)
export class TDomain {
  Chain = 0;
  Typ: TDomainTyp = _UndefD;
  ElemDom = 0; // {PDomain} list element domain
  Name = '';
  OrigDom = 0; // {PDomain} _RedefD
  FunDcl = 0; // {PFunDcl} _FunD
}

export type PConst = TConst | null;
// PAS: RDPROLG.PAS TConst
export class TConst {
  Chain = 0;
  Dom = 0; // {PDomain}
  Expr = 0; // {PPTerm}
  Name = '';
}

export type PFunDcl = TFunDcl | null;
// PAS: RDPROLG.PAS TFunDcl – Arg[0..Arity-1] (allocated for the arity only)
export class TFunDcl {
  Chain = 0;
  Name = 0; // {PString}
  Arity = 0;
  Arg: number[] = [0, 0, 0]; // [0..2] of {PDomain}
}

export type PPTerm = TPTerm | null;
// PAS: RDPROLG.PAS TPTerm – case Fun of 0: (Arity; Arg[0..]) | 1: (Op; E1, E2, E3) ({_IntT.._ListT
// and Op<>_const}) | 2: (Op0; E[1..3] = E1..E3) | _IntT: (Op1; II) | _RealT: (Op2; RR) |
// _StrT, _LongStrT: (Op3; SS) | _ListT: (Op4; Elem, Next) | _VarT: (Idx; Bound).
// Op0..Op4 alias Op; Elem aliases E1 and Next E2.
export class TPTerm {
  Fun = 0;
  Arity = 0;
  Arg: number[] = []; // [0..Arity-1] of {PPTerm}
  Op = '\0';
  declare Op0: string;
  declare Op1: string;
  declare Op2: string;
  declare Op3: string;
  declare Op4: string;
  E1 = 0; // {PPTerm}
  E2 = 0;
  E3 = 0;
  II = 0;
  RR: float = 0;
  SS = '';
  declare Elem: number; // {PPTerm}
  declare Next: number; // {PPTerm}
  Idx = 0;
  Bound = false;
}
defineAliases(TPTerm, { Op0: 'Op', Op1: 'Op', Op2: 'Op', Op3: 'Op', Op4: 'Op', Elem: 'E1', Next: 'E2' });

export type PTermList = TTermList | null;
// PAS: RDPROLG.PAS TTermList
export class TTermList {
  Chain = 0; // {PTermList}
  Elem = 0; // {PPTerm}
}

export type PVarDcl = TVarDcl | null;
// PAS: RDPROLG.PAS TVarDcl – a real pointer chain (not in the segment)
export class TVarDcl {
  Chain: PVarDcl = null;
  Dom = 0; // {PDomain}
  Idx = 0;
  Bound = false;
  Used = false;
  Name = '';
}

export type PWriteD = TWriteD | null;
// PAS: RDPROLG.PAS TWriteD – case IsString of true: (SS) | false: (Idx; Dom)
export class TWriteD {
  Chain = 0; // {PWriteD}
  IsString = false;
  SS = '';
  Idx = 0;
  Dom = 0; // {PDomain}
}

export type PCommand = TCommand | null;
// PAS: RDPROLG.PAS TCommand – case Code of
//   _PredC, _AssertC, _RetractC, _AllC: (Arg; Pred; InpMask; OutpMask; Elem; Idx; Idx2; CompMask;
//     KDOfs; ArgI[0..]) | _WriteC: (WrD; NL) | _ErrorC: (WrD1; MsgNr) | _Trace: (TrcLevel) |
//   _CompC: (Typ; CompOp; E1Idx; E2) | _SaveC, _ConsultC, _LoadLexC: (DbPred; FD; FldD; Name) |
//   _AppPkC, _AppUnpkC: (apIdx; apDom; apTerm) | _AutoC: (Arg1; iWrk; iOutp; nPairs; Pair[0..5]).
// WrD1 aliases WrD, Arg1 aliases Arg.
export class TCommand {
  Chain = 0; // {PCommand}
  Code: TCommandTyp = _PredC;
  Arg = 0; // {PTermList}
  Pred = 0; // {PPredicate}
  InpMask = 0;
  OutpMask = 0; // only _CioMaskOpt
  Elem = 0; // _MemP..: ListDom, else PPTerm
  Idx = 0;
  Idx2 = 0; // _AllC
  CompMask = 0;
  KDOfs: KeyDPtr = null; // FPC: KeyDPtr (BP7: word offset in CFile's segment)
  ArgI: number[] = []; // [0..] of byte, only FAND file
  WrD = 0; // {PWriteD}
  NL = false;
  declare WrD1: number;
  MsgNr = 0;
  TrcLevel = 0;
  Typ: TDomainTyp = _UndefD;
  CompOp = '\0';
  E1Idx = 0;
  E2 = 0; // {PPTerm}
  DbPred = 0; // not _LoadLexC
  FD: FileDPtr = null;
  FldD: FieldDPtr = null;
  Name = '';
  apIdx = 0;
  apDom = 0; // Unpk
  apTerm = 0;
  declare Arg1: number; // like _PredC, autorecursion
  iWrk = 0;
  iOutp = 0;
  nPairs = 0;
  Pair = Array.from({ length: 6 }, () => ({ iInp: 0, iOutp: 0 })); // [0..5]
}
defineAliases(TCommand, { WrD1: 'WrD', Arg1: 'Arg' });

export type PBranch = TBranch | null;
// PAS: RDPROLG.PAS TBranch
export class TBranch {
  Chain = 0; // {PBranch}
  HeadIMask = 0;
  HeadOMask = 0;
  Head = 0; // {PTermList}
  Cmd = 0; // {PCommand}
}

export type PDbBranch = TDbBranch | null;
// PAS: RDPROLG.PAS TDbBranch – Chain + the packed bytes starting at LL (a real pointer chain).
// Data = the bytes from LL on (Pascal `move(A, b^.LL, n)`), so Pascal b^.LL is getWord(Data, 0)
// and b^.A[i] is Data[i+1]. For a clause the first word is the length of the first argument; for an
// appended term (AppendPackedTerm) it is the total length.
export class TDbBranch {
  Chain: PDbBranch = null;
  Data: Uint8Array = new Uint8Array(0);
}

export type PFldList = TFldList | null;
// PAS: RDPROLG.PAS TFldList
export class TFldList {
  Chain = 0; // {PFldList}
  FldD: FieldDPtr = null;
}

export type PScanInf = TScanInf | null;
// PAS: RDPROLG.PAS TScanInf
export class TScanInf {
  FD: FileDPtr = null;
  FL = 0; // {PFldList}
  Name = '';
}

export type PPredicate = TPredicate | null;
// PAS: RDPROLG.PAS TPredicate – Branch: PBranch chain (clauses), InstrPtr (FAND proc), offset of
// PScanInf (FAND file) or PDbBranch chain (database) depending on Opt.
// LocVarSz: FAND proc frame size, or the _xxxP code of a built-in.
export class TPredicate {
  Chain = 0; // {PPredicate}
  ChainDb = 0; // {PPredicate}
  Name = 0; // {PString}
  Branch: Pointer = null; // number (offset) or TDbBranch
  InstSz = 0;
  InpMask = 0;
  LocVarSz = 0;
  Opt = 0;
  Arity = 0;
  Arg: number[] = [0, 0, 0]; // [0..Arity-1] of {PDomain}
}

export type PDatabase = TDatabase | null;
// PAS: RDPROLG.PAS TDatabase
export class TDatabase {
  Chain = 0; // {PDatabase}
  Pred = 0; // {PPredicate}
  SOfs = 0; // {LongStrPtr} saved
  Name = '';
}

export type PProgRoots = TProgRoots | null;
// PAS: RDPROLG.PAS TProgRoots
export class TProgRoots {
  Domains = 0;
  Consts = 0;
  Predicates = 0;
  Databases = 0;
}

export const RdPrologVars = {
  _Sg: 0,
};

// TS-only: a segment – Tab[ofs] is the record (or byte string / LongStr) at that offset.
export class TSgTable {
  Tab: unknown[] = [];
  Ofs = new Map<unknown, number>();
  /** bytes the BP7 records would take (GetZStor sizes) – for the MaxLStrLen check */
  Size = 0;
}

const MaxPackedPredLen = 4000;

// private globals
let VarDcls: PVarDcl = null;
let VarCount = 0;
let IntDom = 0; // {PDomain}
let RealDom = 0;
let StrDom = 0;
let LongStrDom = 0;
let BoolDom = 0;
let LexDom = 0;
let LLexDom = 0;
let MemPred = 0; // {PPredicate}
let LenPred = 0;
let InvPred = 0;
let AddPred = 0;
let DelPred = 0;
let UnionPred = 0;
let MinusPred = 0;
let InterPred = 0;
let UnderscoreTerm = 0; // {PPTerm}
let UnbdVarsInTerm = false;
let WasUnbd = false;
let WasOp = false;
let Roots: TProgRoots = new TProgRoots();
/** PAS: PackedTermPtr: Pchar – here an index into PTBuf (the local array A of RdDbClause) */
let PackedTermPtr = 0;
let PTBuf: Uint8Array = new Uint8Array(0);
let PTPMaxOfs: SgOfsInt = 0;
let ClausePreds = 0;

// FPC segment table
const MaxSgNr = 32;
const SgTab: (TSgTable | null)[] = new Array<TSgTable | null>(MaxSgNr + 1).fill(null);
let SgNr = 0;

function CurSg(): TSgTable {
  const s = SgTab[RdPrologVars._Sg];
  if (!s) throw new globalThis.Error(`RDPROLG: segment ${RdPrologVars._Sg} not registered`);
  return s;
}

/** TS-only: the current segment table (SaveDb's size check). */
export function CurSgTable(): TSgTable {
  return CurSg();
}

// PAS: RDPROLG.PAS SgPtr – the record at offset Ofs of segment _Sg
export function SgPtr(Ofs: number): Pointer {
  return CurSg().Tab[Ofs] ?? null;
}
// PAS: RDPROLG.PAS SgFix – makes a pointer whose offset was set via `absolute` point into _Sg
export function SgFix(P: Ref<Pointer>): void {
  if (typeof P.v === 'number') P.v = SgPtr(P.v);
}
// PAS: RDPROLG.PAS SgOfs – offset of P in segment _Sg (error 544 beyond 64K)
export function SgOfs(P: Pointer): number {
  const sg = CurSg();
  let n = sg.Ofs.get(P);
  if (n === undefined) {
    // TS: an object allocated outside GetZStor (GetOp, SaveDb) lies after the segment base
    n = sg.Tab.length;
    if (n > 0xffff) OldError(544);
    sg.Tab.push(P);
    sg.Ofs.set(P, n);
  }
  return n;
}
// PAS: RDPROLG.PAS SegOf – 0 in FPC
export function SegOf(P: Pointer): number {
  return 0;
}
// PAS: RDPROLG.PAS SgRegister – new segment with base Base; returns its number
export function SgRegister(Base: Pointer): number {
  SgNr++;
  if (SgNr > MaxSgNr) OldError(544);
  SgTab[SgNr] = Base as TSgTable;
  return SgNr;
}
// PAS: RDPROLG.PAS SgMark
export function SgMark(): number {
  return SgNr;
}
// PAS: RDPROLG.PAS SgRelease
export function SgRelease(N: number): void {
  SgNr = N; // the tables above N stay readable until SgRegister reuses their numbers (as in FPC)
}
// PAS: RDPROLG.PAS InSg – P lies in segment _Sg
export function InSg(P: Pointer): boolean {
  return CurSg().Ofs.has(P);
}
// PAS: RDPROLG.PAS AdrOfs – address for pointer arithmetic (packed-term cursors are indexes here)
export function AdrOfs(P: Pointer): SgOfsInt {
  return typeof P === 'number' ? P : 0;
}

// TS-only typed accessors of segment records
export function SgDom(o: number): TDomain {
  return SgPtr(o) as TDomain;
}
export function SgTerm(o: number): TPTerm {
  return SgPtr(o) as TPTerm;
}
export function SgPred(o: number): TPredicate {
  return SgPtr(o) as TPredicate;
}
export function SgCmd(o: number): TCommand {
  return SgPtr(o) as TCommand;
}
export function SgStr(o: number): string {
  return SgPtr(o) as string;
}
/** TS-only: d^.Typ for a domain offset; offset 0 (Pascal reads Roots there) gives -1. */
function DTyp(o: number): number {
  return o === 0 ? -1 : SgDom(o).Typ;
}

// PAS: RDPROLG.PAS ChainLst – appends NewOfs to the word chain starting in Root
function ChainLst(Root: Ref<unknown>, NewOfs: number): void {
  if (!Root.v) {
    Root.v = NewOfs;
    return;
  }
  let w = SgPtr(Root.v as number) as { Chain: number };
  while (w.Chain !== 0) w = SgPtr(w.Chain) as { Chain: number };
  w.Chain = NewOfs;
}
// PAS: RDPROLG.PAS OOfs
function OOfs(p: Pointer): number {
  return SgOfs(p);
}
// PAS: RDPROLG.PAS GetZStor – TS: Obj is the zeroed record (Sz its BP7 size)
function GetZStor(Sz: number, Obj: unknown): number {
  const sg = CurSg();
  const n = sg.Tab.length;
  if (n > 0xffff) OldError(544);
  sg.Tab.push(Obj);
  if (typeof Obj === 'object' && Obj !== null) sg.Ofs.set(Obj, n);
  sg.Size += Sz;
  return n;
}
// PAS: RDPROLG.PAS OPtr – identity in FPC
function OPtr<T>(Sg: number, p: T): T {
  return p;
}
// PAS: RDPROLG.PAS StorStr
function StorStr(S: string): number {
  return GetZStor(S.length + 1, S);
}


// ================================================================ L E X A N A L

/** TS-only: the current lexem (a function, so TS does not narrow it across RdLex calls). */
function Lx(): string {
  return AccessVars.Lexem;
}
// PAS: RDPROLG.PAS IsCharUpper
function IsCharUpper(C: string): boolean {
  return chr(BaseVars.UpcCharTab[ord(C)]) === C;
}
// PAS: RDPROLG.PAS IsUpperIdentif
function IsUpperIdentif(): boolean {
  return Lx() === _identifier && IsCharUpper(AccessVars.LexWord[0]);
}
// PAS: RDPROLG.PAS RdLex
function RdLex(): void {
  const a = AccessVars;
  a.OldErrPos = a.CurrPos;
  SkipBlank(false);
  ReadChar();
  a.Lexem = a.CurrChar;
  switch (a.CurrChar) {
    case "'":
      a.Lexem = _quotedstr;
      ReadChar();
      a.LexWord = '';
      while (a.CurrChar !== "'" || a.ForwChar === "'") {
        if ((a.CurrChar as string) === '\x1a') Error(17);
        if (a.LexWord.length === 255) Error(6);
        if (a.CurrChar === "'") ReadChar();
        else if (a.CurrChar === '\\') RdBackSlashCode();
        a.LexWord = a.LexWord + a.CurrChar;
        ReadChar();
      }
      break;
    case ':':
      if (a.ForwChar === '-') {
        ReadChar();
        a.Lexem = _assign;
      }
      break;
    case '|':
      if (a.ForwChar === '|') {
        ReadChar();
        a.Lexem = _or;
      }
      break;
    case '&':
      if (a.ForwChar === '&') {
        ReadChar();
        a.Lexem = _and;
      }
      break;
    default:
      if (IsLetter(a.CurrChar)) {
        a.Lexem = _identifier;
        let w = a.CurrChar;
        let i = 1;
        while (IsLetter(a.ForwChar) || IsDigit(a.ForwChar)) {
          i++;
          if (i > 32) Error(2);
          ReadChar();
          w = w + a.CurrChar;
        }
        a.LexWord = w;
      } else if (IsDigit(a.CurrChar)) {
        a.Lexem = _number;
        let w = a.CurrChar;
        let i = 1;
        while (IsDigit(a.ForwChar)) {
          i++;
          if (i > 9) Error(3);
          ReadChar();
          w = w + a.CurrChar;
        }
        a.LexWord = w;
      }
  }
}
// PAS: RDPROLG.PAS TestIdentif
function TestIdentif(): void {
  if (Lx() !== _identifier) Error(29);
}
// PAS: RDPROLG.PAS Accept
function Accept(X: string): void {
  if (Lx() !== X) {
    if (X === _assign) Error(506);
    AccessVars.ExpChar = X;
    Error(1);
  }
  RdLex();
}
// PAS: RDPROLG.PAS TestKeyWord
function TestKeyWord(s: string): boolean {
  return Lx() === _identifier && AccessVars.LexWord === s;
}
// PAS: RDPROLG.PAS IsKeyWord
function IsKeyWord(s: string): boolean {
  if (TestKeyWord(s)) {
    RdLex();
    return true;
  }
  return false;
}
// PAS: RDPROLG.PAS AcceptKeyWord
function AcceptKeyWord(s: string): void {
  if (!IsKeyWord(s)) {
    SetMsgPar(s);
    Error(33);
  }
}
// PAS: RDPROLG.PAS RdInteger
function RdInteger(): number {
  if (Lx() !== _number) Error(525);
  const i = ref(0);
  const j = ref(0);
  ValI(AccessVars.LexWord, i, j);
  RdLex();
  return int16(i.v);
}

// ================================================================ T D O M A I N

// PAS: RDPROLG.PAS GetFunDclByName
function GetFunDclByName(D: number, I: Ref<number>): PFunDcl {
  I.v = 0;
  let fd = SgDom(D).FunDcl;
  while (fd !== 0 && SgStr((SgPtr(fd) as TFunDcl).Name) !== AccessVars.LexWord) {
    fd = (SgPtr(fd) as TFunDcl).Chain;
    I.v++;
  }
  return fd === 0 ? null : (SgPtr(fd) as TFunDcl);
}
// PAS: RDPROLG.PAS GetOrigDomain
function GetOrigDomain(D: number): number {
  if (D !== 0) while (SgDom(D).Typ === _RedefD) D = SgDom(D).OrigDom;
  return D;
}

// ================================================================ T D A T A B A S E

// PAS: RDPROLG.PAS FindDataBase
function FindDataBase(S: string): number {
  let dbofs = Roots.Databases;
  while (dbofs !== 0) {
    const db = SgPtr(dbofs) as TDatabase;
    if (db.Name === S) break;
    dbofs = db.Chain;
  }
  return dbofs;
}

// ================================================================ T P R O G R A M

// PAS: RDPROLG.PAS FindConst
function FindConst(D: number): number {
  let pofs = Roots.Consts;
  while (pofs !== 0) {
    const p = SgPtr(pofs) as TConst;
    if (p.Dom === D && p.Name === AccessVars.LexWord) return p.Expr;
    pofs = p.Chain;
  }
  return 0;
}
// PAS: RDPROLG.PAS RdConst
function RdConst(D: number, RT: Ref<number>): boolean {
  if (Lx() === _identifier) {
    const tofs = FindConst(D);
    if (tofs !== 0) {
      RdLex();
      RT.v = tofs;
      return true;
    }
  }
  return false;
}
// PAS: RDPROLG.PAS FindVarDcl
function FindVarDcl(): PVarDcl {
  let v = VarDcls;
  while (v !== null) {
    if (v.Name === AccessVars.LexWord) break;
    v = v.Chain;
  }
  return v;
}
// PAS: RDPROLG.PAS MakeVarDcl
function MakeVarDcl(DOfs: number, Idx: number): TVarDcl {
  const v = RunPrologVars.Mem1.Get(12 + AccessVars.LexWord.length, new TVarDcl());
  const r = ref(VarDcls);
  ChainLast(r, v);
  VarDcls = r.v;
  v.Dom = DOfs;
  v.Name = AccessVars.LexWord;
  if (Idx < 0) {
    v.Idx = VarCount;
    VarCount++;
  } else v.Idx = Idx;
  return v;
}
// PAS: RDPROLG.PAS RdVar – Kind 1: head-i, call-o 2: call-i 3: head-o 4: unbound allowed 5: unbound-o
// 6: const dcl; Idx = -1 except for a solo variable in the head. RT: the term, or (Kind 5) the index.
function RdVar(DOfs: number, Kind: number, Idx: number, RT: Ref<number>): boolean {
  if (IsKeyWord('_')) {
    if (Kind !== 1 && Kind !== 4) OldError(508);
    UnbdVarsInTerm = true;
    WasUnbd = true;
    RT.v = UnderscoreTerm;
    return true;
  }
  RT.v = 0;
  if (!IsUpperIdentif() || Kind === 6) {
    if (Kind === 5) Error(523);
    return false;
  }
  const err507 = (v: TVarDcl): never => {
    Set2MsgPar(SgDom(v.Dom).Name, SgDom(DOfs).Name);
    return OldError(507);
  };
  let v = FindVarDcl();
  if (v === null) v = MakeVarDcl(DOfs, Idx);
  else if (
    v.Dom !== DOfs &&
    !(v.Dom === StrDom && DOfs === LongStrDom) &&
    !(v.Dom === LongStrDom && DOfs === StrDom) &&
    !(v.Dom === IntDom && DOfs === RealDom) &&
    !(v.Dom === RealDom && DOfs === IntDom)
  ) {
    RdLex();
    err507(v);
  }
  RdLex();
  const bnd = v.Bound;
  switch (Kind) {
    case 1:
      v.Bound = true;
      if (bnd) v.Used = true;
      break;
    case 2:
      if (!bnd) Error(509);
      v.Used = true;
      break;
    case 3:
      v.Used = true;
      break;
    case 4:
      if (bnd) v.Used = true;
      else {
        v.Bound = true;
        UnbdVarsInTerm = true;
        WasUnbd = true;
      }
      break;
    case 5:
      v.Bound = true;
      if (bnd) OldError(523);
      RT.v = v.Idx;
      return true;
  }
  if (Idx === -1 || v.Idx !== Idx) {
    const t = new TPTerm();
    let tofs = GetZStor(5, t);
    t.Fun = _VarT;
    t.Idx = v.Idx;
    t.Bound = bnd;
    if (v.Dom !== DOfs) {
      if (!bnd) err507(v);
      tofs = GetOp1(DOfs, _conv, tofs);
    }
    RT.v = tofs;
  }
  return true;
}

// PAS: RDPROLG.PAS DomFun
function DomFun(DOfs: number): number {
  if (DOfs === IntDom) return _IntT;
  if (DOfs === RealDom) return _RealT;
  if (DOfs === StrDom) return _StrT;
  return _LongStrT;
}
// PAS: RDPROLG.PAS GetOp1
function GetOp1(DOfs: number, Op: string, E1: number): number {
  const t = new TPTerm();
  const tofs = GetZStor(1 + 1 + 2, t);
  t.Fun = DomFun(DOfs);
  t.Op = Op;
  WasOp = true;
  t.E1 = E1;
  return tofs;
}
// PAS: RDPROLG.PAS GetOp2
function GetOp2(DOfs: number, Op: string, E1: number, E2: number): number {
  const t = new TPTerm();
  const tofs = GetZStor(1 + 1 + 2 * 2, t);
  t.Fun = DomFun(DOfs);
  t.Op = Op;
  WasOp = true;
  t.E1 = E1;
  t.E2 = E2;
  return tofs;
}
// PAS: RDPROLG.PAS GetFunOp
function GetFunOp(DOfs: number, ResDOfs: number, Op: string, ArgTyp: string, Kind: number): number {
  const a = AccessVars;
  if (DOfs !== ResDOfs) OldError(510);
  const l = ArgTyp.length;
  if (l > 0) Accept('(');
  const t = new TPTerm();
  const tofs = GetZStor(1 + 1 + 2 * l, t);
  t.Fun = DomFun(DOfs);
  t.Op = Op;
  WasOp = true;
  for (let i = 1; i <= l; i++) {
    if (i > 1) Accept(',');
    let t1ofs = 0;
    switch (ArgTyp[i - 1]) {
      case 'l':
        t1ofs = RdAddExpr(LongStrDom, Kind);
        break;
      case 's':
        t1ofs = RdAddExpr(StrDom, Kind);
        break;
      case 'i':
        t1ofs = RdAddExpr(IntDom, Kind);
        break;
      case 'c':
        if (Lx() !== _quotedstr || a.LexWord.length !== 1) Error(560);
        t1ofs = ord(a.LexWord[0]);
        RdLex();
        break;
    }
    // t^.E[i]
    if (i === 1) t.E1 = t1ofs;
    else if (i === 2) t.E2 = t1ofs;
    else t.E3 = t1ofs;
  }
  if (l > 0) Accept(')');
  return tofs;
}

// PAS: RDPROLG.PAS RdPrimExpr
function RdPrimExpr(DOfs: number, Kind: number): number {
  const a = AccessVars;
  let tofs = 0;
  // label 2 of Pascal: an integer constant n
  const intConst = (n: number): number => {
    const t = new TPTerm();
    const o = GetZStor(1 + 1 + 2, t);
    t.Fun = _IntT;
    t.II = int16(n);
    t.Op = _const;
    return o;
  };
  // label 1 of Pascal: a number (minus: preceded by '-')
  const number = (minus: boolean): number => {
    let s = a.LexWord;
    RdLex();
    if (DOfs === IntDom) {
      const n = ref(0);
      const i = ref(0);
      ValI(s, n, i);
      if (minus) n.v = -n.v;
      return intConst(n.v);
    } else if (DOfs === RealDom) {
      if (Lx() === '.' && IsDigit(a.ForwChar)) {
        RdLex();
        s = s + '.' + a.LexWord;
        RdLex();
      }
      const r = ref(0);
      const i = ref(0);
      ValR(s, r, i);
      if (minus) r.v = -r.v;
      const t = new TPTerm();
      const o = GetZStor(1 + 1 + FloatSz, t);
      t.Fun = _RealT;
      t.RR = r.v;
      t.Op = _const;
      return o;
    }
    return OldError(510);
  };
  switch (Lx()) {
    case '^': {
      if (DOfs !== IntDom) Error(510);
      const op = Lx();
      RdLex();
      tofs = GetOp1(DOfs, op, RdPrimExpr(DOfs, Kind));
      break;
    }
    case '(':
      RdLex();
      tofs = RdAddExpr(DOfs, Kind);
      Accept(')');
      break;
    case _quotedstr: {
      if (DOfs !== StrDom && DOfs !== LongStrDom) Error(510);
      const t = new TPTerm();
      tofs = GetZStor(1 + 1 + 1 + a.LexWord.length, t);
      t.Fun = DomFun(DOfs);
      t.Op = _const;
      t.SS = a.LexWord;
      RdLex();
      break;
    }
    case '$': {
      if (DOfs !== IntDom) Error(510);
      let i = 0;
      let s = '';
      while (/^[0-9a-fA-F]$/.test(a.ForwChar)) {
        i++;
        if (i > 4) Error(3);
        ReadChar();
        s = s + a.CurrChar;
      }
      if (i === 0) Error(504);
      const n = HexStrToLong(s);
      RdLex();
      tofs = intConst(n);
      break;
    }
    case '-':
      RdLex();
      if (Lx() !== _number) Error(525);
      tofs = number(true);
      break;
    case _number:
      tofs = number(false);
      break;
    default: {
      const rt = ref(0);
      if (RdVar(DOfs, Kind, -1, rt) || RdConst(DOfs, rt)) tofs = rt.v;
      else if (IsKeyWord('length')) tofs = GetFunOp(DOfs, IntDom, _length, 's', Kind);
      else if (IsKeyWord('pos')) tofs = GetFunOp(DOfs, IntDom, _pos, 'sl', Kind);
      else if (IsKeyWord('min')) tofs = GetFunOp(DOfs, IntDom, _min, 'ii', Kind);
      else if (IsKeyWord('max')) tofs = GetFunOp(DOfs, IntDom, _max, 'ii', Kind);
      else if (IsKeyWord('val')) tofs = GetFunOp(DOfs, IntDom, _val, 's', Kind);
      else if (IsKeyWord('copy')) tofs = GetFunOp(DOfs, StrDom, _copy, 'sii', Kind);
      else if (IsKeyWord('str')) tofs = GetFunOp(DOfs, StrDom, _str, 'i', Kind);
      else if (IsKeyWord('repeatstr')) tofs = GetFunOp(DOfs, StrDom, _repeatstr, 'si', Kind);
      else if (IsKeyWord('leadchar')) tofs = GetFunOp(DOfs, StrDom, _leadchar, 'cs', Kind);
      else if (IsKeyWord('trailchar')) tofs = GetFunOp(DOfs, StrDom, _trailchar, 'cs', Kind);
      else if (IsKeyWord('maxrow')) tofs = GetFunOp(DOfs, IntDom, _maxrow, '', Kind);
      else if (IsKeyWord('maxcol')) tofs = GetFunOp(DOfs, IntDom, _maxcol, '', Kind);
      else Error(511);
    }
  }
  return tofs;
}
// PAS: RDPROLG.PAS RdMultExpr
function RdMultExpr(DOfs: number, Kind: number): number {
  let tofs = RdPrimExpr(DOfs, Kind);
  while (
    DOfs !== StrDom &&
    DOfs !== LongStrDom &&
    (Lx() === '*' || Lx() === '/' || ((Lx() === _and || Lx() === _or) && DOfs === IntDom))
  ) {
    const op = Lx();
    RdLex();
    tofs = GetOp2(DOfs, op, tofs, RdPrimExpr(DOfs, Kind));
  }
  return tofs;
}
// PAS: RDPROLG.PAS RdAddExpr
function RdAddExpr(DOfs: number, Kind: number): number {
  let tofs = RdMultExpr(DOfs, Kind);
  while (Lx() === '+' || (Lx() === '-' && (DOfs === IntDom || DOfs === RealDom))) {
    const op = Lx();
    RdLex();
    tofs = GetOp2(DOfs, op, tofs, RdMultExpr(DOfs, Kind));
  }
  return tofs;
}
// PAS: RDPROLG.PAS RdListTerm
function RdListTerm(DOfs: number, Kind: number): number {
  const rt = ref(0);
  let tofs: number;
  if (RdVar(DOfs, Kind, -1, rt) || RdConst(DOfs, rt)) tofs = rt.v;
  else {
    if (Lx() !== '[') Error(510);
    RdLex();
    tofs = 0;
    if (Lx() === ']') RdLex();
    else {
      let tPrev = 0;
      for (;;) {
        const t1t = new TPTerm();
        const t1 = GetZStor(1 + 1 + 2 * 2, t1t);
        t1t.Fun = _ListT;
        t1t.Op = _const;
        t1t.Elem = RdTerm(SgDom(DOfs).ElemDom, Kind);
        if (tofs === 0) tofs = t1;
        else SgTerm(tPrev).Next = t1;
        tPrev = t1;
        if (Lx() === ',') {
          RdLex();
          continue;
        }
        break;
      }
      if (Lx() === '|') {
        RdLex();
        if (!RdVar(DOfs, Kind, -1, fref(SgTerm(tPrev), 'Next'))) Error(511);
      }
      Accept(']');
    }
  }
  if (Lx() === '+') {
    const t1 = tofs;
    const t = new TPTerm();
    tofs = GetZStor(1 + 1 + 2 * 2, t);
    t.Op = '+';
    RdLex();
    t.Fun = _ListT;
    t.E1 = t1;
    t.E2 = RdListTerm(DOfs, Kind);
    WasOp = true;
  }
  return tofs;
}
// PAS: RDPROLG.PAS RdTerm
function RdTerm(DOfs: number, Kind: number): number {
  const wo = WasOp;
  const wu = WasUnbd;
  WasOp = false;
  WasUnbd = false;
  let tofs = 0;
  switch (SgDom(DOfs).Typ) {
    case _IntD:
    case _RealD:
    case _StrD:
    case _LongStrD:
      tofs = RdAddExpr(DOfs, Kind);
      break;
    case _ListD:
      tofs = RdListTerm(DOfs, Kind);
      break;
    default: {
      const rt = ref(0);
      if (RdVar(DOfs, Kind, -1, rt) || RdConst(DOfs, rt)) tofs = rt.v;
      else {
        TestIdentif();
        const idx = ref(0);
        const f = GetFunDclByName(DOfs, idx);
        if (f === null) Error(512);
        RdLex();
        const n = f.Arity;
        const t = new TPTerm();
        tofs = GetZStor(1 + 1 + 2 * n, t);
        t.Fun = idx.v;
        t.Arity = n;
        t.Arg = new Array<number>(n).fill(0);
        if (n > 0) {
          Accept('(');
          for (let i = 0; i <= n - 1; i++) {
            if (i > 0) Accept(',');
            t.Arg[i] = RdTerm(f.Arg[i], Kind);
          }
          Accept(')');
        }
      }
      // goto 1
      WasOp = wo;
      WasUnbd = wu;
      return tofs;
    }
  }
  if (WasOp) {
    if (WasUnbd) OldError(540);
    if (Kind === 6) OldError(549);
  }
  WasOp = wo;
  WasUnbd = wu;
  return tofs;
}

// PAS: RDPROLG.PAS MakeDomain
function MakeDomain(DTyp: TDomainTyp, Nm: string): number {
  const d = new TDomain();
  const dofs = GetZStor(7 - 1 + Nm.length, d);
  ChainLst(fref(Roots, 'Domains'), dofs);
  d.Typ = DTyp;
  d.Name = Nm;
  return dofs;
}
// PAS: RDPROLG.PAS GetDomain
function GetDomain(Create: boolean, Nm: string): number {
  const find = (): number => {
    let dofs = Roots.Domains;
    while (dofs !== 0 && SgDom(dofs).Name !== Nm) dofs = SgDom(dofs).Chain;
    return dofs;
  };
  let dofs = find();
  if (dofs === 0) {
    if (Copy(Nm, 1, 2) === 'L_') {
      const d1ofs = GetOrigDomain(GetDomain(Create, Copy(Nm, 3, 255)));
      if (d1ofs === 0) Error(517);
      Nm = 'L_' + SgDom(d1ofs).Name;
      dofs = find();
      if (dofs === 0) {
        dofs = MakeDomain(_ListD, Nm);
        SgDom(dofs).ElemDom = d1ofs;
      }
    } else if (Create) {
      if (Nm.length === 0 || !IsCharUpper(Nm[0])) Error(514);
      dofs = MakeDomain(_UndefD, Nm);
    }
  }
  return dofs;
}
// PAS: RDPROLG.PAS RdDomain
function RdDomain(): number {
  TestIdentif();
  const dofs = GetDomain(false, AccessVars.LexWord);
  if (dofs === 0) Error(517);
  RdLex();
  return GetOrigDomain(dofs);
}

// PAS: RDPROLG.PAS RdDomains
function RdDomains(): void {
  const a = AccessVars;
  for (;;) {
    // 1:
    TestIdentif();
    let dofs = GetDomain(true, a.LexWord);
    let d = SgDom(dofs);
    if (d.Typ !== _UndefD) Error(505);
    RdLex();
    while (Lx() === ',') {
      RdLex();
      d.Typ = _RedefD;
      TestIdentif();
      d.OrigDom = GetDomain(true, a.LexWord);
      dofs = d.OrigDom;
      d = SgDom(dofs);
      if (d.Typ !== _UndefD) OldError(505);
      RdLex();
    }
    Accept('=');
    SkipBlank(false);
    TestIdentif();
    if (IsCharUpper(a.LexWord[0])) {
      const d1 = GetDomain(true, a.LexWord);
      if (d1 === dofs) Error(505);
      RdLex();
      d.Typ = _RedefD;
      d.OrigDom = d1;
    } else {
      d.Typ = _FunD;
      for (;;) {
        // 2:
        const n = ref(0);
        if (GetFunDclByName(dofs, n) !== null) Error(505);
        if (IsCharUpper(a.LexWord[0])) Error(515);
        const nm = StorStr(a.LexWord);
        RdLex();
        const arr: number[] = [];
        if (Lx() === '(') {
          RdLex();
          for (;;) {
            // 3:
            TestIdentif();
            arr.push(GetDomain(true, a.LexWord));
            RdLex();
            if (Lx() === ',') {
              RdLex();
              continue;
            }
            break;
          }
          Accept(')');
        }
        const fd = new TFunDcl();
        const fdofs = GetZStor(11 - 3 * 2 + arr.length * 2, fd);
        ChainLst(fref(d, 'FunDcl'), fdofs);
        fd.Name = nm;
        fd.Arity = arr.length;
        fd.Arg = arr;
        if (Lx() === ';') {
          RdLex();
          TestIdentif();
          continue;
        }
        break;
      }
    }
    // 4:
    if (!(Lx() === '\x1a' || Lx() === '#')) continue;
    break;
  }
  let dofs = Roots.Domains;
  while (dofs !== 0) {
    const d = SgDom(dofs);
    switch (d.Typ) {
      case _UndefD:
        SetMsgPar(d.Name);
        OldError(516);
        break;
      case _FunD: {
        let fdofs = d.FunDcl;
        while (fdofs !== 0) {
          const fd = SgPtr(fdofs) as TFunDcl;
          for (let i = 1; i <= fd.Arity; i++) fd.Arg[i - 1] = GetOrigDomain(fd.Arg[i - 1]);
          fdofs = fd.Chain;
        }
        break;
      }
    }
    dofs = d.Chain;
  }
}

// PAS: RDPROLG.PAS RdConstants
function RdConstants(): void {
  const a = AccessVars;
  for (;;) {
    // 1:
    const dofs = RdDomain();
    Accept(':');
    for (;;) {
      // 2:
      TestIdentif();
      if (IsCharUpper(a.LexWord[0])) Error(515);
      if (FindConst(dofs) !== 0) Error(505);
      const p = new TConst();
      const pofs = GetZStor(8 - 1 + a.LexWord.length, p);
      p.Name = a.LexWord;
      RdLex();
      p.Dom = dofs;
      Accept('=');
      p.Expr = RdTerm(dofs, 6);
      ChainLst(fref(Roots, 'Consts'), pofs);
      if (Lx() === ',') {
        RdLex();
        continue;
      }
      break;
    }
    if (!(Lx() === '\x1a' || Lx() === '#')) continue;
    break;
  }
}

// PAS: RDPROLG.PAS GetPredicate
function GetPredicate(): number {
  let pofs = Roots.Predicates;
  while (pofs !== 0) {
    if (AccessVars.LexWord === SgStr(SgPred(pofs).Name)) {
      RdLex();
      return pofs;
    }
    pofs = SgPred(pofs).Chain;
  }
  pofs = ClausePreds;
  while (pofs !== 0) {
    if (AccessVars.LexWord === SgStr(SgPred(pofs).Name)) {
      RdLex();
      return pofs;
    }
    pofs = SgPred(pofs).Chain;
  }
  return 0;
}
// PAS: RDPROLG.PAS RdPredicate
function RdPredicate(): number {
  const pofs = GetPredicate();
  if (pofs === 0) Error(513);
  return pofs;
}

// PAS: RDPROLG.PAS GetOutpMask
function GetOutpMask(P: TPredicate): number {
  return (0xffff >>> (16 - P.Arity)) & ~P.InpMask & 0xffff;
}

// PAS: RDPROLG.PAS RdPredicateDcl
function RdPredicateDcl(FromClauses: boolean, Db: PDatabase): void {
  const a = AccessVars;
  let o = 0;
  if (Db !== null) o = _DbaseOpt + _CioMaskOpt;
  if (Lx() === '@') {
    RdLex();
    o = o | _FandCallOpt;
  } else if (Db !== null) o = o | _PackInpOpt;
  TestIdentif();
  if (IsCharUpper(a.LexWord[0])) Error(518);
  if (GetPredicate() !== 0) OldError(505);
  const nm = StorStr(a.LexWord);
  let si: TScanInf | null = null;
  let siofs = 0;
  const pos = new RdbPos();
  let skipRdLex = false;
  if ((o & _FandCallOpt) !== 0) {
    if (Db !== null) {
      si = new TScanInf();
      siofs = GetZStor(8 - 1 + a.LexWord.length, si);
      si.Name = a.LexWord;
      a.CFile = RdFileName();
      if (a.CFile!.typSQLFile) OldError(155);
      si.FD = a.CFile;
      skipRdLex = true; // goto 2
    } else {
      SkipBlank(false);
      if (a.ForwChar === '[') {
        RdLex();
        RdLex();
        TestLex(_quotedstr);
        const z = GetOp(_const, a.LexWord.length + 1)!;
        z.S = a.LexWord;
        // Pascal: pos.R:=ptr(0,OOfs(z)) – a segment offset, fixed up by CallFandProc
        pos.R = OOfs(z) as unknown as RdbDPtr;
        pos.IRec = 0;
        Accept(_quotedstr);
        TestLex(']');
      } else {
        if (!FindChpt('P', a.LexWord, false, pos)) Error(37);
        pos.R = StorStr(a.LexWord) as unknown as RdbDPtr;
        pos.IRec = 0xffff;
      }
    }
  }
  if (!skipRdLex) RdLex();
  // 2:
  let n = 0;
  let w = 0;
  let m = 1;
  const arr: number[] = [];
  if (Lx() === '(') {
    RdLex();
    for (;;) {
      // 3:
      let dofs = 0;
      let fandFld = false;
      if (Db !== null) {
        if ((o & _FandCallOpt) !== 0) {
          const f = RdFldName(a.CFile)!;
          const fl = new TFldList();
          const flofs = GetZStor(6, fl);
          fl.FldD = OPtr(SegOf(a.CFile), f);
          ChainLst(fref(si!, 'FL'), flofs);
          dofs = 0;
          Accept('/');
          dofs = RdDomain();
          const d = SgDom(dofs);
          switch (f.FrmlTyp) {
            case 'B':
              if (dofs !== BoolDom) OldError(510);
              break;
            case 'R':
              if (dofs !== RealDom && (f.Typ !== 'F' || dofs !== IntDom)) OldError(510);
              break;
            default:
              if (f.Typ === 'T') {
                if (dofs !== LongStrDom && (d.Typ !== _FunD || dofs === BoolDom)) OldError(510);
              } else if (dofs !== StrDom) OldError(510);
          }
          fandFld = true; // goto 4
        }
      } else if (Lx() === '&') RdLex();
      else w = w | m;
      if (!fandFld) {
        dofs = RdDomain();
        if (dofs === LongStrDom && Db !== null) OldError(541);
        if ((o & _FandCallOpt) !== 0 && SgDom(dofs).Typ === _FunD && dofs !== BoolDom) OldError(528);
      }
      // 4:
      arr.push(dofs);
      n++;
      m = (m << 1) & 0xffff;
      if (Lx() === ',') {
        if (n === 15) Error(519);
        RdLex();
        continue;
      }
      break;
    }
    Accept(')');
  }
  const p = new TPredicate();
  const pofs = GetZStor(24 - 6 + 2 * n, p);
  if (FromClauses) {
    const r = ref(ClausePreds as Pointer);
    ChainLst(r, pofs);
    ClausePreds = r.v as number;
  } else ChainLst(fref(Roots, 'Predicates'), pofs);
  if (Db !== null) {
    p.ChainDb = Db.Pred;
    Db.Pred = pofs;
  }
  p.Name = nm;
  p.Arity = n;
  p.Arg = arr;
  p.Opt = o;
  p.InpMask = w;
  p.InstSz = PtrSz * n;
  if ((o & _FandCallOpt) !== 0) {
    if ((o & _DbaseOpt) !== 0) p.Branch = siofs;
    else {
      const ip = new Instr(_proc);
      const ipofs = GetZStor(5 + 6 + 2 + n * 10, ip);
      ip.PPos = pos;
      ip.N = n;
      ip.TArg = [new TypAndFrml()]; // [0] unused
      let bpOfs = 8; // sizeof(ProcStkD) of BP7, as ResetLVBD
      for (let i = 1; i <= n; i++) {
        const dofs = p.Arg[i - 1];
        let typ: string;
        if (dofs === RealDom || dofs === IntDom) typ = 'R';
        else if (dofs === BoolDom) typ = 'B';
        else typ = 'S';
        const isOutp = (w & 1) === 0;
        let z: FrmlPtr;
        if (isOutp) {
          z = GetOp(_getlocvar, 2)!;
          z.BPOfs = bpOfs;
          switch (typ) {
            case 'S':
              bpOfs += 4;
              break;
            case 'R':
              bpOfs += FloatSz;
              break;
            default:
              bpOfs += 1;
          }
        } else {
          switch (typ) {
            case 'R':
              z = GetOp(_const, FloatSz);
              break;
            case 'B':
              z = GetOp(_const, 1);
              break;
            default:
              if (dofs === StrDom) z = GetOp(_const, 256);
              else {
                z = GetOp(_getlocvar, 2)!;
                z.BPOfs = bpOfs;
                bpOfs += 4;
              }
          }
        }
        const ta = new TypAndFrml();
        ta.FTyp = typ;
        ta.Frml = OPtr(RdPrologVars._Sg, z);
        ta.FromProlog = true;
        ta.IsRetPar = isOutp;
        ip.TArg[i] = ta;
        w = w >>> 1;
      }
      p.Branch = ipofs;
      p.LocVarSz = bpOfs;
    }
  }
}

// PAS: RDPROLG.PAS GetCommand
function GetCommand(Code: TCommandTyp, N: number): number {
  const c = new TCommand();
  const cofs = GetZStor(3 + N, c);
  c.Code = Code;
  return cofs;
}
// PAS: RDPROLG.PAS RdTermList
function RdTermList(C: TCommand, D: number, Kind: number): void {
  const l = new TTermList();
  const lofs = GetZStor(4, l);
  ChainLst(fref(C, 'Arg'), lofs);
  l.Elem = RdTerm(D, Kind);
}

// PAS: RDPROLG.PAS RdCommand – 0 if the current lexem does not start a command
function RdCommand(): number {
  const a = AccessVars;
  let cofs = 0;
  let c: TCommand;
  if (Lx() === '!') {
    RdLex();
    return GetCommand(_CutC, 0);
  } else if (Lx() !== _identifier) return 0;
  if (IsUpperIdentif()) {
    let v = FindVarDcl();
    if (v === null) v = MakeVarDcl(0, -1);
    RdLex();
    let dofs = v.Dom;
    let op: string;
    if (v.Bound) {
      switch (Lx()) {
        case '=':
          op = _equ;
          break;
        case '<':
          if (a.ForwChar === '>') {
            ReadChar();
            op = _ne;
          } else if (a.ForwChar === '=') {
            ReadChar();
            op = _le;
          } else op = _lt;
          break;
        case '>':
          if (a.ForwChar === '=') {
            ReadChar();
            op = _ge;
          } else op = _gt;
          break;
        default:
          return Error(524);
      }
      if (dofs !== IntDom && dofs !== RealDom && !(op === _equ || op === _ne)) Error(538);
      RdLex();
    } else {
      if (!v.Used) {
        Accept(':');
        dofs = RdDomain();
        v.Dom = dofs;
      }
      Accept('=');
      op = _assign;
    }
    cofs = GetCommand(_CompC, 1 + 1 + 2 * 2);
    c = SgCmd(cofs);
    c.Typ = dofs === 0 ? _UndefD : SgDom(dofs).Typ;
    c.E1Idx = v.Idx;
    c.CompOp = op;
    c.E2 = RdTerm(dofs, 2);
    if (v.Bound) v.Used = true;
    v.Bound = true;
    return cofs;
  }
  if (IsKeyWord('fail')) return GetCommand(_FailC, 0);
  if (IsKeyWord('wait')) return GetCommand(_WaitC, 0);
  if (IsKeyWord('trace')) {
    cofs = GetCommand(_Trace, 2);
    Accept('(');
    SgCmd(cofs).TrcLevel = RdInteger();
    Accept(')'); // 8:
    return cofs;
  }
  // write/writeln/error: the item list (labels 2, 20, 8)
  const rdWriteItems = (c: TCommand, first: boolean): void => {
    let item = first;
    for (;;) {
      if (item) {
        // 2:
        let wofs: number;
        if (Lx() === _quotedstr) {
          const w = new TWriteD();
          wofs = GetZStor(3 + 1 + a.LexWord.length, w);
          w.IsString = true;
          w.SS = a.LexWord;
        } else {
          const w = new TWriteD();
          wofs = GetZStor(3 + 2 + 2, w);
          TestIdentif();
          const v = FindVarDcl();
          if (v === null) Error(511);
          else if (!v.Bound) Error(509);
          v.Used = true;
          w.Dom = v.Dom;
          w.Idx = v.Idx;
          if (c.Code === _ErrorC && v.Dom !== StrDom && (c.WrD !== 0 || v.Dom !== IntDom)) Error(558);
        }
        RdLex();
        ChainLst(fref(c, 'WrD'), wofs);
      }
      // 20:
      if (Lx() === ',') {
        RdLex();
        item = true;
        continue;
      }
      break;
    }
    Accept(')'); // 8:
  };
  if (IsKeyWord('error')) {
    Accept('(');
    cofs = GetCommand(_ErrorC, 2 + 2);
    c = SgCmd(cofs);
    c.MsgNr = RdInteger();
    rdWriteItems(c, false);
    return cofs;
  }
  let nl: boolean | null = null;
  if (IsKeyWord('writeln')) nl = true;
  else if (IsKeyWord('write')) nl = false;
  if (nl !== null) {
    // 1:
    cofs = GetCommand(_WriteC, 2 + 1);
    c = SgCmd(cofs);
    c.NL = nl;
    Accept('(');
    rdWriteItems(c, true);
    return cofs;
  }
  let pofs = -1;
  let pfx = 0;
  if (Copy(a.LexWord, 1, 6) === 'union_') [pofs, pfx] = [UnionPred, 6];
  else if (Copy(a.LexWord, 1, 6) === 'minus_') [pofs, pfx] = [MinusPred, 6];
  else if (Copy(a.LexWord, 1, 6) === 'inter_') [pofs, pfx] = [InterPred, 6];
  if (pfx === 6) {
    // 21:
    const dofs = GetDomain(false, 'L_' + Copy(a.LexWord, 7, 255));
    if (DTyp(dofs) !== _ListD) Error(548);
    RdLex();
    Accept('(');
    cofs = GetCommand(_PredC, 5 * 2);
    c = SgCmd(cofs);
    c.Pred = pofs;
    c.Elem = dofs;
    RdTermList(c, dofs, 2);
    Accept(',');
    RdTermList(c, dofs, 2);
    Accept(',');
    RdTermList(c, dofs, 1);
    Accept(')'); // 8:
    return cofs;
  }
  if (Copy(a.LexWord, 1, 4) === 'mem_') [pofs, pfx] = [MemPred, 4];
  else if (Copy(a.LexWord, 1, 4) === 'len_') [pofs, pfx] = [LenPred, 4];
  else if (Copy(a.LexWord, 1, 4) === 'inv_') [pofs, pfx] = [InvPred, 4];
  else if (Copy(a.LexWord, 1, 4) === 'add_') [pofs, pfx] = [AddPred, 4];
  else if (Copy(a.LexWord, 1, 4) === 'del_') [pofs, pfx] = [DelPred, 4];
  if (pfx === 4) {
    // 22:
    const dofs = GetDomain(false, 'L_' + Copy(a.LexWord, 5, 255));
    if (DTyp(dofs) !== _ListD) Error(548);
    const d = SgDom(dofs);
    RdLex();
    Accept('(');
    cofs = GetCommand(_PredC, 5 * 2);
    c = SgCmd(cofs);
    c.Pred = pofs;
    c.Elem = dofs; // ListDom
    if (pofs === MemPred) {
      UnbdVarsInTerm = false;
      RdTermList(c, d.ElemDom, 4);
      const n = UnbdVarsInTerm ? 2 : 3;
      c.InpMask = n;
      c.OutpMask = ~n & 0xffff;
      Accept(',');
      RdTermList(c, dofs, 2);
    } else {
      if (pofs === AddPred) {
        RdTermList(c, d.ElemDom, 2);
        Accept(',');
      } else if (pofs === DelPred) {
        RdTermList(c, d.ElemDom, 1);
        Accept(',');
      }
      RdTermList(c, dofs, 2);
      Accept(',');
      if (pofs === LenPred) RdTermList(c, IntDom, 1);
      else RdTermList(c, dofs, 1);
    }
    Accept(')'); // 8:
    return cofs;
  }
  let code: TCommandTyp;
  if (IsKeyWord('loadlex')) {
    code = _LoadLexC;
    Accept('(');
    pofs = 0; // goto 4
  } else {
    if (IsKeyWord('save')) code = _SaveC;
    else if (IsKeyWord('consult')) code = _ConsultC;
    else return 0; // 9: (cofs=0)
    // 3:
    Accept('(');
    TestIdentif();
    pofs = FindDataBase(a.LexWord);
    if (pofs === 0) Error(531);
    RdLex();
    Accept(',');
  }
  // 4:
  cofs = GetCommand(code, 2 + 4 + 4 + 1 + a.LexWord.length);
  c = SgCmd(cofs);
  c.DbPred = pofs;
  c.Name = a.LexWord;
  const fd = ref<FileDPtr>(null);
  const ld = ref<LinkDPtr>(null);
  if (!IsRoleName(false, fd, ld)) Error(9);
  if (fd.v!.typSQLFile) OldError(155);
  Accept('.');
  c.FldD = OPtr(SegOf(fd.v), RdFldName(fd.v));
  if (c.FldD!.Typ !== 'T') OldError(537);
  Accept(')'); // 8:
  return cofs;
}
// PAS: RDPROLG.PAS RdPredCommand
function RdPredCommand(Code: TCommandTyp): number {
  const a = AccessVars;
  const pofs = RdPredicate();
  const p = SgPred(pofs);
  const IsFandDb = (p.Opt & (_DbaseOpt + _FandCallOpt)) === _DbaseOpt + _FandCallOpt;
  if ((p.Opt & _DbaseOpt) !== _DbaseOpt && (Code === _AssertC || Code === _RetractC)) OldError(526);
  let kind = 1;
  let m = 1;
  let w = p.InpMask;
  let sz = 2 + 2;
  let InpMask = 0;
  let OutpMask = 0;
  const lRoot = ref<Pointer>(0);
  if ((p.Opt & _CioMaskOpt) !== 0) {
    sz += 4;
    if (Code === _AssertC) w = 0xffff;
    else kind = 4;
  }
  if (p.Arity > 0) {
    Accept('(');
    for (let i = 0; i <= p.Arity - 1; i++) {
      if (i > 0) Accept(',');
      UnbdVarsInTerm = false;
      if (kind !== 4) kind = (w & 1) !== 0 ? 2 : 1;
      const dofs = p.Arg[i];
      const l = new TTermList();
      const lofs = GetZStor(4, l);
      ChainLst(lRoot, lofs);
      l.Elem = RdTerm(dofs, kind);
      if ((p.Opt & _CioMaskOpt) !== 0) {
        if (UnbdVarsInTerm) {
          if (l.Elem !== UnderscoreTerm) OutpMask = OutpMask | m;
        } else InpMask = InpMask | m;
      }
      m = (m << 1) & 0xffff;
      w = w >>> 1;
    }
    Accept(')');
  }
  if ((p.Opt & _BuildInOpt) !== 0) {
    switch (p.LocVarSz) {
      case _ConcatP:
        if (![3, 4, 5, 6, 7].includes(InpMask)) OldError(534);
        break;
      case _FandFieldP:
      case _FandLinkP:
        if ((InpMask & 1) === 0) OldError(555);
        if (p.LocVarSz === _FandLinkP) {
          InpMask = InpMask & 7;
          if (InpMask === 7) InpMask = 5;
        } else InpMask = InpMask & 3;
        OutpMask = ~InpMask & 0xffff;
        break;
    }
  }
  // FAND-file: find first key, which is a subset of the input fields
  let i = 0;
  w = 0;
  let k: KeyDPtr = null;
  const aI: number[] = [0]; // a[1..255]
  if (IsFandDb && Code !== _AssertC) {
    sz += 10;
    const si = SgPtr(p.Branch as number) as TScanInf;
    a.CFile = si.FD;
    if (a.CFile!.Typ === 'X') {
      k = a.CFile!.Keys;
      keys: while (k !== null) {
        let kf = k.KFlds;
        let inOut = false;
        let matched = true;
        while (kf !== null) {
          m = 1;
          let n = 0;
          i++;
          let flofs = si.FL;
          let found = false;
          while (flofs !== 0) {
            const f = (SgPtr(flofs) as TFldList).FldD;
            flofs = (SgPtr(flofs) as TFldList).Chain;
            if (f === OPtr(SegOf(a.CFile), kf.FldD)) {
              w = w | m;
              aI[i] = n;
              if (flofs !== 0 && f === (SgPtr(flofs) as TFldList).FldD && (OutpMask & (m << 1)) !== 0 && f!.Typ === 'A')
                inOut = true;
              found = true; // goto 1
              break;
            }
            m = (m << 1) & 0xffff;
            n++;
          }
          if (!found) {
            matched = false; // goto 2
            break;
          }
          kf = kf.Chain; // 1:
        }
        if (matched && (InpMask & w) === w) {
          sz += i;
          if (!inOut) w = 0;
          break keys; // goto 3
        }
        // 2:
        k = k.Chain;
        i = 0;
        w = 0;
      }
    }
  }
  // 3:
  if (Code === _AllC) sz = Math.max(sz, 14);
  const cofs = GetCommand(Code, sz);
  const c = SgCmd(cofs);
  c.Pred = pofs;
  c.Arg = lRoot.v as number;
  if ((p.Opt & _CioMaskOpt) !== 0) {
    c.InpMask = InpMask;
    c.OutpMask = OutpMask;
    if (IsFandDb) {
      c.CompMask = InpMask & ~w & 0xffff;
      if (i > 0) {
        c.ArgI = aI.slice(1, i + 1);
        c.KDOfs = k;
      }
    }
  }
  return cofs;
}
// PAS: RDPROLG.PAS RdDbTerm – packs the term of domain DOfs at PackedTermPtr
function RdDbTerm(DOfs: number): void {
  const a = AccessVars;
  const d = SgDom(DOfs);
  if (PackedTermPtr >= PTPMaxOfs) Error(527);
  const putInt = (n: number): void => {
    // 2:
    const v = int16(n) & 0xffff;
    PTBuf[PackedTermPtr] = v & 0xff;
    PTBuf[PackedTermPtr + 1] = v >> 8;
    PackedTermPtr += 2;
  };
  const number = (minus: boolean): void => {
    // 1:
    let s = a.LexWord;
    RdLex();
    if (d.Typ === _IntD) {
      const n = ref(0);
      const i = ref(0);
      ValI(s, n, i);
      if (minus) n.v = -n.v;
      putInt(n.v);
    } else {
      if (d.Typ !== _RealD) Error(510);
      if (Lx() === '.' && IsDigit(a.ForwChar)) {
        RdLex();
        s = s + '.' + a.LexWord;
        RdLex();
      }
      const r = ref(0);
      const i = ref(0);
      ValR(s, r, i); // Pascal ignores `minus` for reals here
      writeReal48(r.v, PTBuf, PackedTermPtr);
      PackedTermPtr += FloatSz;
    }
  };
  switch (Lx()) {
    case _quotedstr: {
      if (d.Typ !== _StrD) Error(510);
      const n = a.LexWord.length + 1;
      if (PackedTermPtr + n >= PTPMaxOfs) Error(527);
      PTBuf[PackedTermPtr] = a.LexWord.length;
      for (let i = 0; i < a.LexWord.length; i++) PTBuf[PackedTermPtr + 1 + i] = a.LexWord.charCodeAt(i);
      PackedTermPtr += n;
      RdLex();
      break;
    }
    case '$': {
      if (d.Typ !== _IntD) Error(510);
      let i = 0;
      let s = '';
      while (/^[0-9a-fA-F]$/.test(a.ForwChar)) {
        i++;
        if (i > 4) Error(3);
        ReadChar();
        s = s + a.CurrChar;
      }
      if (i === 0) Error(504);
      const n = HexStrToLong(s);
      RdLex();
      putInt(n);
      break;
    }
    case '-':
      RdLex();
      if (Lx() !== _number) Error(525);
      number(true);
      break;
    case _number:
      number(false);
      break;
    case '[': {
      if (d.Typ !== _ListD) Error(510);
      RdLex();
      const wp = PackedTermPtr;
      PackedTermPtr += 2;
      let n = 0;
      if (Lx() !== ']') {
        for (;;) {
          RdDbTerm(d.ElemDom);
          n++;
          if (Lx() === ',') {
            RdLex();
            continue;
          }
          break;
        }
      }
      Accept(']');
      PTBuf[wp] = n & 0xff;
      PTBuf[wp + 1] = (n >> 8) & 0xff;
      break;
    }
    default: {
      TestIdentif();
      if (d.Typ !== _FunD) Error(510);
      const idx = ref(0);
      const f = GetFunDclByName(DOfs, idx);
      if (f === null) Error(512);
      PTBuf[PackedTermPtr] = idx.v;
      PackedTermPtr++;
      RdLex();
      const n = f.Arity;
      if (n > 0) {
        Accept('(');
        for (let i = 0; i <= n - 1; i++) {
          if (i > 0) Accept(',');
          RdDbTerm(f.Arg[i]);
        }
        Accept(')');
      }
    }
  }
}
// PAS: RDPROLG.PAS RdDbClause – a fact of a database predicate, packed into Mem3
function RdDbClause(P: TPredicate): void {
  Accept('(');
  const A = new Uint8Array(MaxPackedPredLen);
  PTBuf = A;
  PackedTermPtr = 0;
  PTPMaxOfs = MaxPackedPredLen - 2;
  for (let i = 0; i <= P.Arity - 1; i++) {
    if (i > 0) Accept(',');
    const wp = PackedTermPtr;
    PackedTermPtr += 2;
    RdDbTerm(P.Arg[i]);
    const l = PackedTermPtr - wp - 2;
    A[wp] = l & 0xff;
    A[wp + 1] = l >> 8;
  }
  const n = PackedTermPtr;
  const b = RunPrologVars.Mem3.Alloc(PtrSz + n, new TDbBranch());
  b.Data = A.slice(0, n);
  ChainLast(fref(P, 'Branch') as unknown as Ref<TDbBranch | null>, b);
  Accept(')');
  Accept('.');
}
// PAS: RDPROLG.PAS CheckPredicates
function CheckPredicates(POff: number): void {
  let pofs = POff;
  while (pofs !== 0) {
    const p = SgPred(pofs);
    if ((p.Opt & (_DbaseOpt + _FandCallOpt + _BuildInOpt)) === 0 && !p.Branch) {
      SetMsgPar(SgStr(p.Name));
      OldError(522);
    }
    if ((p.Opt & _DbaseOpt) !== 0) {
      if ((p.Opt & _FandCallOpt) !== 0) {
        const si = SgPtr(p.Branch as number) as TScanInf;
        si.FD = null;
      } else p.Branch = null;
    }
    pofs = p.Chain;
  }
}
// PAS: RDPROLG.PAS RdAutoRecursionHead – head `p(!, ...)`: a structural recursion over the first arg
function RdAutoRecursionHead(P: TPredicate, B: TBranch): void {
  if (P.Opt !== 0) Error(550);
  const cofs = GetCommand(_AutoC, 2 + 3 + 6 * 2);
  const c = SgCmd(cofs);
  B.Cmd = cofs;
  P.InstSz += PtrSz;
  c.iWrk = Math.trunc(P.InstSz / PtrSz) - 1;
  let w = P.InpMask;
  for (let i = 0; i <= P.Arity - 1; i++) {
    const isInput = (w & 1) !== 0;
    const l = new TTermList();
    const lofs = GetZStor(4, l);
    ChainLst(fref(c, 'Arg'), lofs);
    const t = new TPTerm();
    const tofs = GetZStor(1 + 2 + 1, t);
    t.Fun = _VarT;
    t.Idx = i;
    t.Bound = isInput;
    l.Elem = tofs;
    const l1 = new TTermList();
    const l1ofs = GetZStor(4, l1);
    ChainLst(fref(B, 'Head'), l1ofs);
    const dofs = P.Arg[i];
    const d = SgDom(dofs);
    if (i > 0) Accept(',');
    else if (!(d.Typ === _FunD || d.Typ === _ListD)) Error(556);
    let pair = false;
    let j = 0;
    if (Lx() === '!') {
      if (i > 0) {
        if (isInput || dofs !== P.Arg[0] || c.iOutp > 0) Error(551);
        c.iOutp = i;
      } else if (!isInput) Error(552);
    } else if (TestKeyWord('_')) {
      if (!isInput) {
        if (d.Typ === _FunD) Error(575);
        j = 0;
        pair = true; // goto 1
      }
    } else {
      if (!IsUpperIdentif()) Error(511);
      let v = FindVarDcl();
      if (v === null) v = MakeVarDcl(dofs, i);
      if (isInput) {
        if (v.Bound) Error(553);
        v.Bound = true;
      } else {
        if (v.Used) Error(553);
        v.Used = true;
      }
      if (v.Bound && v.Used) {
        j = v.Idx;
        pair = true;
      }
    }
    if (pair) {
      // 1:
      const k = c.nPairs;
      c.nPairs++;
      if (isInput) {
        c.Pair[k].iInp = i;
        c.Pair[k].iOutp = j;
      } else {
        c.Pair[k].iInp = j;
        c.Pair[k].iOutp = i;
      }
    }
    RdLex();
    w = w >>> 1;
  }
  Accept(')');
}
// PAS: RDPROLG.PAS RdSemicolonClause – `; ...` after the body: an alternative branch
function RdSemicolonClause(P: TPredicate, B: TBranch): void {
  RdLex();
  let x: string;
  let v: PVarDcl = null;
  let cofs = 0;
  let chain = true; // 2: ChainLst(b^.cmd,cofs)
  if (IsUpperIdentif()) {
    x = 'a';
    v = FindVarDcl();
    if (P.InpMask !== (1 << (P.Arity - 1)) - 1) Error(562);
    if (v === null || v.Bound || SgDom(v.Dom).Typ !== _ListD) Error(561);
    RdLex();
    Accept('+');
    Accept('=');
    v.Bound = true;
    cofs = GetCommand(_AppPkC, 6);
    const c = SgCmd(cofs);
    c.apIdx = v.Idx;
    c.apTerm = RdTerm(v.Dom, 2);
    ChainLst(fref(B, 'Cmd'), cofs);
    if (Lx() === ',') {
      RdLex();
      AcceptKeyWord('self');
      cofs = GetCommand(_SelfC, 0);
    } else cofs = GetCommand(_FailC, 0); // 1:
  } else if (TestKeyWord('error')) {
    x = 'e';
    cofs = GetCommand(_CutC, 0);
  } else if (IsKeyWord('self')) {
    x = 's';
    chain = false; // goto 3
  } else {
    x = 'f';
    cofs = GetCommand(_FailC, 0); // 1:
  }
  if (chain) ChainLst(fref(B, 'Cmd'), cofs); // 2:
  // 3:
  const nb = new TBranch();
  const bofs = GetZStor(10, nb);
  ChainLst(fref(P, 'Branch'), bofs);
  B = nb;
  switch (x) {
    case 'e':
      B.Cmd = RdCommand();
      break;
    case 'f':
      if (GetOutpMask(P) !== 0) Error(559);
      break;
    case 's':
      B.Cmd = GetCommand(_SelfC, 0);
      break;
    case 'a': {
      cofs = GetCommand(_AppUnpkC, 4);
      const c = SgCmd(cofs);
      c.apIdx = v!.Idx;
      c.apDom = v!.Dom;
      B.Cmd = cofs;
      break;
    }
  }
}
// PAS: RDPROLG.PAS RdClauses
function RdClauses(): void {
  for (;;) {
    // 1:
    if (Lx() === ':') {
      RdLex();
      RdPredicateDcl(true, null);
    } else {
      TestIdentif();
      const pofs = RdPredicate();
      const p = SgPred(pofs);
      if ((p.Opt & (_FandCallOpt + _BuildInOpt)) !== 0) OldError(529);
      if ((p.Opt & _DbaseOpt) !== 0) RdDbClause(p);
      else RdClause(p);
    }
    // 6:
    if (!(Lx() === '\x1a' || Lx() === '#')) continue;
    break;
  }
  CheckPredicates(ClausePreds);
  ClausePreds = 0;
}
// PAS: RDPROLG.PAS RdClauses (one clause of a normal predicate) – TS-only split
function RdClause(p: TPredicate): void {
  const a = AccessVars;
  VarDcls = null;
  VarCount = p.Arity;
  const x = RunPrologVars.Mem1.Mark();
  const b = new TBranch();
  const bofs = GetZStor(10, b);
  ChainLst(fref(p, 'Branch'), bofs);
  let auto = false;
  if (p.Arity > 0) {
    Accept('(');
    if (Lx() === '!') {
      RdAutoRecursionHead(p, b);
      auto = true; // goto 4
    } else {
      let w = p.InpMask;
      let m = 1;
      for (let i = 0; i <= p.Arity - 1; i++) {
        if (i > 0) Accept(',');
        const dofs = p.Arg[i];
        const kind = (w & 1) === 0 ? 3 : 1;
        const l = new TTermList();
        const lofs = GetZStor(4, l);
        ChainLst(fref(b, 'Head'), lofs);
        SkipBlank(false);
        const tofs = ref(0);
        let set = false;
        if (IsUpperIdentif() && (a.ForwChar === ',' || a.ForwChar === ')')) {
          // solo variable
          RdVar(dofs, kind, i, tofs);
          if (tofs.v !== 0) set = true; // goto 11
        } else {
          tofs.v = 0;
          set = true;
        }
        if (set) {
          // 11:
          if ((w & 1) !== 0) b.HeadIMask = b.HeadIMask | m;
          else b.HeadOMask = b.HeadOMask | m;
          if (tofs.v === 0) tofs.v = RdTerm(dofs, kind);
          l.Elem = tofs.v;
        }
        w = w >>> 1;
        m = (m << 1) & 0xffff;
      }
      Accept(')');
    }
  }
  if (!auto && Lx() !== '.') {
    Accept(_assign);
    for (;;) {
      // 2:
      let WasNotC = false;
      if (IsKeyWord('self')) {
        const cofs = GetCommand(_SelfC, 0);
        ChainLst(fref(b, 'Cmd'), cofs);
        break; // goto 4
      }
      if (IsKeyWord('not')) {
        Accept('(');
        WasNotC = true;
      }
      let cofs = RdCommand();
      if (cofs === 0) {
        if (Lx() === _identifier && Copy(a.LexWord, 1, 4) === 'all_') {
          const dofs = GetDomain(false, 'L_' + Copy(a.LexWord, 5, 255));
          if (DTyp(dofs) !== _ListD) Error(548);
          const d = SgDom(dofs);
          RdLex();
          Accept('(');
          cofs = RdPredCommand(_AllC);
          const c = SgCmd(cofs);
          Accept(',');
          c.Elem = RdTerm(d.ElemDom, 2);
          Accept(',');
          c.Idx = VarCount;
          VarCount++;
          RdVar(dofs, 5, -1, fref(c, 'Idx2'));
          Accept(')');
        } else if (IsKeyWord('assert')) {
          Accept('(');
          cofs = RdPredCommand(_AssertC);
          Accept(')');
        } else if (IsKeyWord('retract')) {
          Accept('(');
          cofs = RdPredCommand(_RetractC);
          Accept(')');
        } else cofs = RdPredCommand(_PredC);
      }
      ChainLst(fref(b, 'Cmd'), cofs);
      if (WasNotC) {
        const c = SgCmd(cofs);
        if (c.Code !== _PredC) OldError(546);
        const p1 = SgPred(c.Pred);
        let lofs = c.Arg;
        let w = (p1.Opt & _CioMaskOpt) !== 0 ? c.InpMask : p1.InpMask;
        while (lofs !== 0) {
          const l = SgPtr(lofs) as TTermList;
          if ((w & 1) === 0) {
            const tofs = l.Elem;
            if (tofs === 0 || SgTerm(tofs).Fun !== _UnderscT) OldError(547);
          }
          lofs = l.Chain;
          w = w >>> 1;
        }
        Accept(')');
        c.Code = _NotC;
      }
      if (Lx() === ',') {
        RdLex();
        continue;
      }
      if (Lx() === ';') RdSemicolonClause(p, b);
      break;
    }
  }
  // 4:
  Accept('.');
  let v = VarDcls as PVarDcl;
  while (v !== null) {
    if (!v.Used || !v.Bound) {
      SetMsgPar(v.Name);
      if (!v.Used) OldError(521);
      else OldError(520);
    }
    v = v.Chain;
  }
  p.InstSz = Math.max(p.InstSz, PtrSz * VarCount);
  RunPrologVars.Mem1.Release(x);
}

// PAS: RDPROLG.PAS MakePred – a built-in predicate
function MakePred(PredName: string, ArgTyp: string, PredKod: number, PredMask: number): number {
  const n = ArgTyp.length;
  const p = new TPredicate();
  const pofs = GetZStor(24 - 6 + n * 2, p);
  ChainLst(fref(Roots, 'Predicates'), pofs);
  p.Name = StorStr(PredName);
  p.Arity = n;
  p.LocVarSz = PredKod;
  p.Arg = [];
  for (let i = 1; i <= n; i++) {
    let dofs = 0;
    switch (ArgTyp[i - 1]) {
      case 's':
        dofs = StrDom;
        break;
      case 'l':
        dofs = LongStrDom;
        break;
      case 'i':
        dofs = IntDom;
        break;
      case 'r':
        dofs = RealDom;
        break;
      case 'b':
        dofs = BoolDom;
        break;
      case 'x':
        dofs = LLexDom;
        break;
    }
    p.Arg[i - 1] = dofs;
  }
  if (PredMask === 0xffff) p.Opt = _BuildInOpt + _CioMaskOpt;
  else {
    p.Opt = _BuildInOpt;
    p.InpMask = PredMask;
  }
  p.InstSz = n * PtrSz;
  return pofs;
}

// PAS: RDPROLG.PAS ReadProlog – compiles the current input; returns the segment number
export function ReadProlog(RecNr: number): number {
  const a = AccessVars;
  const rv = RunPrologVars;
  const p1 = ref<Pointer>(null);
  const p2 = ref<Pointer>(null);
  MarkBoth(p1, p2);
  const cr = a.CRecPtr;
  const oldSgMark = SgMark();
  let pp1: Pointer = null;
  let pp2: Pointer = null;
  let pp3: Pointer = null;
  if (rv.ProlgCallLevel === 0) {
    rv.FreeMemList = null;
    rv.Mem1.Init();
    rv.Mem2.Init();
    rv.Mem3.Init();
  } else {
    pp1 = rv.Mem1.Mark();
    pp2 = rv.Mem2.Mark();
    pp3 = rv.Mem3.Mark();
  }
  const ss = new TSgTable(); // AlignSegment(2); ss:=GetStore(2)
  RdPrologVars._Sg = SgRegister(ss);
  const result = RdPrologVars._Sg;
  ClausePreds = 0;
  Roots = new TProgRoots();
  GetZStor(8, Roots); // offset 0: Roots:=GetZStore(sizeof(TProgRoots))
  const us = new TPTerm();
  UnderscoreTerm = GetZStor(1, us);
  us.Fun = _UnderscT;
  StrDom = MakeDomain(_StrD, 'String');
  LongStrDom = MakeDomain(_LongStrD, 'LongString');
  IntDom = MakeDomain(_IntD, 'Integer');
  RealDom = MakeDomain(_RealD, 'Real');
  BoolDom = MakeDomain(_FunD, 'Boolean');
  let d = SgDom(BoolDom);
  let f = new TFunDcl();
  let fofs = GetZStor(11 - 3 * 2, f);
  f.Name = StorStr('false');
  f.Arg = [];
  ChainLst(fref(d, 'FunDcl'), fofs);
  f = new TFunDcl();
  fofs = GetZStor(11 - 3 * 2, f);
  f.Name = StorStr('true');
  f.Arg = [];
  ChainLst(fref(d, 'FunDcl'), fofs);
  const pm = new TPredicate();
  const pofs = GetZStor(24 - 6, pm);
  pm.Name = StorStr('main');
  pm.Arg = [];
  Roots.Predicates = pofs;
  LexDom = MakeDomain(_FunD, 'Lexem');
  d = SgDom(LexDom);
  f = new TFunDcl();
  fofs = GetZStor(11, f);
  f.Name = StorStr('lex');
  f.Arity = 3;
  f.Arg = [IntDom, IntDom, StrDom];
  ChainLst(fref(d, 'FunDcl'), fofs);
  LLexDom = MakeDomain(_ListD, 'L_Lexem');
  SgDom(LLexDom).ElemDom = LexDom;
  MemPred = MakePred('mem_?', 'ii', _MemP, 0xffff);
  MakePred('concat', 'sss', _ConcatP, 0xffff);
  MakePred('call', 'ss', _CallP, 3 /*ii*/);
  LenPred = MakePred('len_?', 'ii', _LenP, 1 /*io*/);
  InvPred = MakePred('inv_?', 'ii', _InvP, 1 /*io*/);
  AddPred = MakePred('add_?', 'iii', _AddP, 3 /*iio*/);
  DelPred = MakePred('del_?', 'iii', _DelP, 2 /*oio*/);
  UnionPred = MakePred('union_?', 'iii', _UnionP, 3 /*iio*/);
  MinusPred = MakePred('minus_?', 'iii', _MinusP, 3 /*iio*/);
  InterPred = MakePred('inter_?', 'iii', _InterP, 3 /*iio*/);
  MakePred('abbrev', 'ss', _AbbrevP, 1 /*io*/);
  MakePred('fandfile', 'ssss', _FandFileP, 0 /*oooo*/);
  MakePred('fandfield', 'sssiiis', _FandFieldP, 0xffff);
  MakePred('fandkey', 'ssbb', _FandKeyP, 1 /*iooo*/);
  MakePred('fandkeyfield', 'sssbb', _FandKeyFieldP, 3 /*iiooo*/);
  MakePred('fandlink', 'sssssi', _FandLinkP, 0xffff);
  MakePred('fandlinkfield', 'sss', _FandLinkFieldP, 3 /*iio*/);
  MakePred('nextlex', '', _NextLexP, 0);
  MakePred('getlex', 'x', _GetLexP, 0 /*o*/);
  ResetCompilePars();
  RdLex();
  while (Lx() !== '\x1a') {
    Accept('#');
    if (IsKeyWord('DOMAINS')) RdDomains();
    else if (IsKeyWord('CONSTANTS')) RdConstants();
    else if (IsKeyWord('DATABASE')) {
      let s = '';
      if (Lx() === '-') {
        RdLex();
        TestIdentif();
        s = a.LexWord;
        RdLex();
      }
      let dbofs = FindDataBase(s);
      if (dbofs === 0) {
        const db = new TDatabase();
        dbofs = GetZStor(8 - 1 + s.length, db);
        ChainLst(fref(Roots, 'Databases'), dbofs);
        db.Name = s;
      }
      const db = SgPtr(dbofs) as TDatabase;
      do RdPredicateDcl(false, db);
      while (!(Lx() === '\x1a' || Lx() === '#'));
    } else if (IsKeyWord('PREDICATES')) {
      do RdPredicateDcl(false, null);
      while (!(Lx() === '\x1a' || Lx() === '#'));
    } else {
      AcceptKeyWord('CLAUSES');
      RdClauses();
    }
  }
  if (ss.Size > MaxLStrLen) OldError(544);
  let dbofs = Roots.Databases;
  while (dbofs !== 0) {
    const db = SgPtr(dbofs) as TDatabase;
    const sv = SaveDb(dbofs, 1);
    ss.Size += sv.length + 2;
    db.SOfs = OOfs(OPtr(RdPrologVars._Sg, sv));
    dbofs = db.Chain;
  }
  CheckPredicates(Roots.Predicates);
  if (rv.ProlgCallLevel === 0) ReleaseStore2(p2.v);
  else {
    rv.Mem1.Release(pp1);
    rv.Mem2.Release(pp2);
    rv.Mem3.Release(pp3);
  }
  if (RecNr !== 0) {
    // BP7 stores the binary segment into the chapter's OldTxt here (StoreChptTxt(ChptOldTxt,ss,true);
    // WriteRec(RecNr)). FPC never calls ReadProlog(RecNr<>0) and always recompiles; the handle-table
    // segment has no byte image, so nothing is stored.
    a.CFile = a.Chpt;
    a.CRecPtr = cr;
    ReleaseStore(p1.v);
    SgRelease(oldSgMark);
  } else if (rv.ProlgCallLevel === 0) {
    // TS: a compile check (PROJMGR, FPC: ReadProlog(0)) does not keep the segment number: FPC never
    // releases it, so the 33rd L chapter compiled in a session failed with error 544; BP7 has no
    // segment table (SgRelease is a no-op there), so it has no such limit.
    SgRelease(oldSgMark);
  }
  return result;
}
