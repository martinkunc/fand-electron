// PAS: RECACC.PAS (include of ACCESS) – record I/O of CFile/CRecPtr and field access.
// Field values: 'S' byte strings, 'R' numbers (Real48/F/D codecs in src/engine/fand/numbers.ts),
// 'B' booleans, 'T' text positions / LongStr (Uint8Array).
// Re-exported by access.ts; state lives in AccessVars.
//
// Porting notes:
// * Record buffers are Uint8Arrays; a field is at CRecPtr[F.Displ..]. Positions in the file:
//   (N-1)*RecLen+FrstDispl.
// * 'R' and 'D' (non-'8', non-dBase) fields are 6-byte Real48 (BP7 float=real). The FPC helpers
//   Real48ToFloat/FloatToReal48 are used for NBytes=6, a double otherwise (FPC real).
// * 'F' fields: R_ scales by Power10[M] in Real48 precision (Real48Round) before FixFromReal,
//   as BP7 multiplies Reals (see type.ts).
// * DelDifTFld with CompRec=nil deletes the text (FPC; BP7 read the field at nil^).
// * SQL branches (FandSQL) are not compiled in.

import {
  StrI, StrR, ValI, ValR, Pos as StrPos, StrDelete, getInteger, setInteger, getLongint, setLongint, StrToBytes,
  BytesToStr, ref, type Ref,
} from './pasrt.ts';
import type { float, LongStrPtr } from './base.ts';
import { SetUpdHandle, RdWrCache, ReleaseStore, ReplaceChar, StrDate, ValDate, SetMsgPar } from './base.ts';
import { RunError } from './obaseww.ts';
import { RunShortStr, RunLongStr, RunReal, RunBool, AssgnFrml, LeadChar, TrailChar } from './runfrml.ts';
import { CopyTFString } from './olongstr.ts';
import { readReal48 } from '../fand/numbers.ts';
import {
  AccessVars, GetRecSpace, HasTWorkFlag, SetDeletedFlag, Code, CompStr, Power10, NewLMode, OldLMode, RunErrorM,
  XFNotValid, TestXFExist, UnPack, Pack, RealFromFix, FixFromReal, Real48Round, XString, T00Format, f_Stored,
  f_Encryp, f_Comma, LeftJust, RdMode, WrMode, DelMode,
  type FileDPtr, type FieldDPtr, type FrmlPtr, type KeyDPtr, type LinkDPtr, type TFile,
} from './access.ts';

const Alloc = 2048; // unused in RECACC.PAS
void Alloc;

// PAS: RECACC.PAS IncNRecs
export function IncNRecs(N: number): void {
  const cf = AccessVars.CFile!;
  cf.NRecs += N;
  SetUpdHandle(cf.Handle);
  if (cf.Typ === 'X') SetUpdHandle(cf.XF!.Handle);
}
// PAS: RECACC.PAS DecNRecs
export function DecNRecs(N: number): void {
  const cf = AccessVars.CFile!;
  cf.NRecs -= N;
  SetUpdHandle(cf.Handle);
  if (cf.Typ === 'X') SetUpdHandle(cf.XF!.Handle);
  cf.WasWrRec = true;
}
// PAS: RECACC.PAS SeekRec
export function SeekRec(N: number): void {
  const cf = AccessVars.CFile!;
  cf.IRec = N;
  if (cf.XF === null) cf.EOF = N >= cf.NRecs;
  else cf.EOF = N >= cf.XF.NRecs;
}
// PAS: RECACC.PAS PutRec
export function PutRec(): void {
  const cf = AccessVars.CFile!;
  cf.NRecs++;
  RdWrCache(false, cf.Handle, cf.NotCached(), cf.IRec * cf.RecLen + cf.FrstDispl, cf.RecLen, AccessVars.CRecPtr!);
  cf.IRec++;
  cf.EOF = true;
}
// PAS: RECACC.PAS ReadRec
export function ReadRec(N: number): void {
  const cf = AccessVars.CFile!;
  RdWrCache(true, cf.Handle, cf.NotCached(), (N - 1) * cf.RecLen + cf.FrstDispl, cf.RecLen, AccessVars.CRecPtr!);
}
// PAS: RECACC.PAS WriteRec
export function WriteRec(N: number): void {
  const cf = AccessVars.CFile!;
  RdWrCache(false, cf.Handle, cf.NotCached(), (N - 1) * cf.RecLen + cf.FrstDispl, cf.RecLen, AccessVars.CRecPtr!);
  cf.WasWrRec = true;
}

// PAS: RECACC.PAS CreateRec – inserts CRecPtr as record N (moves N.. up)
export function CreateRec(N: number): void {
  IncNRecs(1);
  const cr = AccessVars.CRecPtr;
  AccessVars.CRecPtr = GetRecSpace();
  for (let i = AccessVars.CFile!.NRecs - 1; i >= N; i--) {
    ReadRec(i);
    WriteRec(i + 1);
  }
  ReleaseStore(AccessVars.CRecPtr);
  AccessVars.CRecPtr = cr;
  WriteRec(N);
}
// PAS: RECACC.PAS DeleteRec – removes record N (its texts: of CRecPtr)
export function DeleteRec(N: number): void {
  DelAllDifTFlds(AccessVars.CRecPtr!, null);
  for (let i = N; i <= AccessVars.CFile!.NRecs - 1; i++) {
    ReadRec(i + 1);
    WriteRec(i);
  }
  DecNRecs(1);
}

// PAS: RECACC.PAS LinkLastRec – CFile:=FD, CRecPtr:=new buffer with the last record
export function LinkLastRec(FD: FileDPtr, N: Ref<number>, WithT: boolean): boolean {
  AccessVars.CFile = FD;
  AccessVars.CRecPtr = GetRecSpace();
  const md = NewLMode(RdMode);
  let result = true;
  N.v = AccessVars.CFile!.NRecs;
  if (N.v === 0) {
    // 1:
    ZeroAllFlds();
    result = false;
    N.v = 1;
  } else ReadRec(N.v);
  OldLMode(md);
  return result;
}
// PAS: RECACC.PAS AsgnParFldFrml – assigns Z to F in the (single/last) record of a parameter file
export function AsgnParFldFrml(FD: FileDPtr, F: FieldDPtr, Z: FrmlPtr, Ad: boolean): void {
  const cf = AccessVars.CFile;
  const cr = AccessVars.CRecPtr;
  AccessVars.CFile = FD;
  const md = NewLMode(WrMode);
  const N = ref(0);
  if (!LinkLastRec(AccessVars.CFile, N, true)) {
    IncNRecs(1);
    WriteRec(N.v);
  }
  AssgnFrml(F, Z, true, Ad);
  WriteRec(N.v);
  OldLMode(md);
  ReleaseStore(AccessVars.CRecPtr);
  AccessVars.CFile = cf;
  AccessVars.CRecPtr = cr;
}

// PAS: RECACC.PAS SearchKey – binary search of a sorted non-indexed file (CFile) on Key
export function SearchKey(XX: XString, Key: KeyDPtr, NN: Ref<number>): boolean {
  const x = new XString();
  let L = 1;
  let R = 0;
  let Result = 4; // _gt
  NN.v = AccessVars.CFile!.NRecs;
  let N = NN.v;
  if (N === 0) return false;
  const KF = Key!.KFlds;
  do {
    if (Result === 4) R = N;
    else L = N + 1;
    N = Math.trunc((L + R) / 2);
    ReadRec(N);
    x.PackKF(KF);
    Result = CompStr(x.S, XX.S);
  } while (!(L >= R || Result === 1));
  if (N === NN.v && Result === 2) NN.v++;
  else {
    if (Key!.Duplic && Result === 1) {
      while (N > 1) {
        N--;
        ReadRec(N);
        x.PackKF(KF);
        if (CompStr(x.S, XX.S) !== 1) {
          N++;
          ReadRec(N);
          break; // goto 1
        }
      }
    }
    // 1:
    NN.v = N;
  }
  return Result === 1 || (Key!.Intervaltest && Result === 4);
}

// PAS: RECACC.PAS LinkUpw – the ToFD record linked by LD from the current CFile record.
// Leaves CFile=LD^.ToFD and CRecPtr = a new buffer (the record, or zero with the key fields set).
export function LinkUpw(LD: LinkDPtr, N: Ref<number>, WithT: boolean): boolean {
  const ToFD = LD!.ToFD;
  const CF = AccessVars.CFile;
  const CP = AccessVars.CRecPtr;
  const K = LD!.ToKey!;
  let Arg = LD!.Args;
  const x = new XString();
  x.PackKF(Arg);
  AccessVars.CFile = ToFD;
  const RecPtr = GetRecSpace();
  AccessVars.CRecPtr = RecPtr;
  const md = NewLMode(RdMode);
  let LU: boolean;
  if (ToFD!.Typ === 'X') {
    TestXFExist();
    LU = K.SearchIntvl(x, false, N);
  } else if (AccessVars.CFile!.NRecs === 0) {
    LU = false;
    N.v = 1;
  } else LU = SearchKey(x, K, N);
  if (LU) ReadRec(N.v);
  else {
    // 1:
    ZeroAllFlds();
    let KF = K.KFlds;
    while (Arg !== null) {
      const F = Arg.FldD!;
      const F2 = KF!.FldD!;
      AccessVars.CFile = CF;
      AccessVars.CRecPtr = CP;
      if ((F2.Flg & f_Stored) !== 0) {
        switch (F.FrmlTyp) {
          case 'S': {
            const s = _ShortS(F);
            AccessVars.CFile = ToFD;
            AccessVars.CRecPtr = RecPtr;
            S_(F2, s);
            break;
          }
          case 'R': {
            const r = _R(F);
            AccessVars.CFile = ToFD;
            AccessVars.CRecPtr = RecPtr;
            R_(F2, r);
            break;
          }
          case 'B': {
            const b = _B(F);
            AccessVars.CFile = ToFD;
            AccessVars.CRecPtr = RecPtr;
            B_(F2, b);
            break;
          }
        }
      }
      Arg = Arg.Chain;
      KF = KF!.Chain;
    }
    AccessVars.CFile = ToFD;
    AccessVars.CRecPtr = RecPtr;
  }
  // 2:
  OldLMode(md);
  return LU;
}

// PAS: RECACC.PAS AssignNRecs – sets the number of records of CFile (Add: relative)
export function AssignNRecs(Add: boolean, N: number): void {
  const md = NewLMode(DelMode);
  const cf = AccessVars.CFile!;
  const OldNRecs = cf.NRecs;
  if (Add) N = N + OldNRecs;
  body: {
    if (N < 0 || N === OldNRecs) break body;
    if (N === 0 && cf.TF !== null) cf.TF.SetEmpty();
    if (cf.Typ === 'X') {
      if (N === 0) {
        cf.NRecs = 0;
        SetUpdHandle(cf.Handle);
        XFNotValid();
        break body;
      } else {
        SetMsgPar(cf.Name);
        RunErrorM(md, 821);
      }
    }
    if (N < OldNRecs) {
      DecNRecs(OldNRecs - N);
      break body;
    }
    AccessVars.CRecPtr = GetRecSpace();
    ZeroAllFlds();
    SetDeletedFlag();
    IncNRecs(N - OldNRecs);
    for (let i = OldNRecs + 1; i <= N; i++) WriteRec(i);
    ReleaseStore(AccessVars.CRecPtr);
  }
  // 1:
  OldLMode(md);
}

// ---------------------------------------------------------------- FIELD ACCESS

const FirstDate: float = 6.97248e5;

// PAS: RECACC.PAS IsNullValue – all bytes $FF
function IsNullValue(p: Uint8Array, l: number): boolean {
  for (let i = 0; i < l; i++) if (p[i] !== 0xff) return false;
  return true;
}
// PAS: RECACC.PAS Real48ToFloat (FPC)
function Real48ToFloat(p: Uint8Array): float {
  return readReal48(p, 0);
}
// PAS: RECACC.PAS FloatToReal48 (FPC) – rounds the double mantissa to 39 bits; exp>255 saturates
function FloatToReal48(R: float, p: Uint8Array): void {
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, R, true);
  const q = dv.getBigInt64(0, true);
  let ex = Number((q >> 52n) & 0x7ffn);
  let m = q & 0x000fffffffffffffn;
  if (ex === 0 || ex === 0x7ff) {
    p.fill(0, 0, 6);
    return;
  }
  m += 1n << 12n;
  if ((m & (1n << 52n)) !== 0n) {
    m = 0n;
    ex++;
  }
  m = (m >> 13n) & 0x7fffffffffn;
  ex -= 1023 - 129;
  if (ex < 1) {
    p.fill(0, 0, 6);
    return;
  }
  if (ex > 255) ex = 255;
  p[0] = ex;
  p[1] = Number(m & 0xffn);
  p[2] = Number((m >> 8n) & 0xffn);
  p[3] = Number((m >> 16n) & 0xffn);
  p[4] = Number((m >> 24n) & 0xffn);
  p[5] = Number((m >> 32n) & 0x7fn);
  if (q < 0n) p[5] |= 0x80;
}
/** TS: RealPtr(p)^ with FPC real = double (never used by FAND: 'R'/'D' fields have NBytes=6). */
function RealAt(p: Uint8Array): float {
  return new DataView(p.buffer, p.byteOffset, 8).getFloat64(0, true);
}
function SetRealAt(p: Uint8Array, R: float): void {
  new DataView(p.buffer, p.byteOffset, 8).setFloat64(0, R, true);
}

/** TS: the field bytes – Pascal `P:=CRecPtr; inc(P,F^.Displ)` */
function FldPtr(F: FieldDPtr): Uint8Array {
  return AccessVars.CRecPtr!.subarray(F!.Displ);
}

// PAS: RECACC.PAS _ShortS
export function _ShortS(F: FieldDPtr): string {
  const f = F!;
  if ((f.Flg & f_Stored) !== 0) {
    const l = f.L;
    const P = FldPtr(f);
    const S = new Uint8Array(l); // S[0]:=char(l), S[1..l] undefined for other types
    switch (f.Typ) {
      case 'A':
      case 'N':
        if (f.Typ === 'A') {
          S.set(P.subarray(0, l));
          if ((f.Flg & f_Encryp) !== 0) Code(S, l);
          if (IsNullValue(S, l)) S.fill(0x20);
        } else if (IsNullValue(P, f.NBytes)) S.fill(0x20);
        else UnPack(P, S, l);
        break;
      case 'T': {
        const ss = _LongS(f);
        const n = ss.length > 255 ? 255 : ss.length;
        const r = BytesToStr(ss, 0, n);
        ReleaseStore(ss);
        return r;
      }
    }
    return BytesToStr(S);
  }
  return RunShortStr(f.Frml);
}

// PAS: RECACC.PAS _LongS
export function _LongS(F: FieldDPtr): LongStrPtr {
  const f = F!;
  if ((f.Flg & f_Stored) !== 0) {
    const P = FldPtr(f);
    const l = f.L;
    let S: Uint8Array = new Uint8Array(0);
    switch (f.Typ) {
      case 'A':
      case 'N':
        S = new Uint8Array(l);
        if (f.Typ === 'A') {
          S.set(P.subarray(0, l));
          if ((f.Flg & f_Encryp) !== 0) Code(S, l);
          if (IsNullValue(S, l)) S = new Uint8Array(0);
        } else if (IsNullValue(P, f.NBytes)) S = new Uint8Array(0);
        else UnPack(P, S, l);
        break;
      case 'T': {
        if (HasTWorkFlag()) S = AccessVars.TWork.Read(1, _T(f));
        else {
          const md = NewLMode(RdMode);
          S = AccessVars.CFile!.TF!.Read(1, _T(f));
          OldLMode(md);
        }
        if ((f.Flg & f_Encryp) !== 0) Code(S, S.length);
        if (S.length > 0 && IsNullValue(S, S.length)) S = new Uint8Array(0);
        break;
      }
    }
    return S;
  }
  return RunLongStr(f.Frml);
}

// PAS: RECACC.PAS _RforD – 'F'/'D' of a dBase file (text)
function _RforD(F: FieldDPtr, P: Uint8Array): float {
  const f = F!;
  let r = 0;
  const s = ref(BytesToStr(P, 0, f.NBytes));
  switch (f.Typ) {
    case 'F': {
      ReplaceChar(s, ',', '.');
      if ((f.Flg & f_Comma) !== 0) {
        const i = StrPos('.', s.v);
        if (i > 0) s.v = StrDelete(s.v, i, 1);
      }
      const v = ref(0);
      const err = ref(0);
      ValR(LeadChar(' ', TrailChar(' ', s.v)), v, err);
      r = v.v;
      break;
    }
    case 'D':
      r = ValDate(s.v, 'YYYYMMDD');
      break;
  }
  return r;
}

// PAS: RECACC.PAS _R
export function _R(F: FieldDPtr): float {
  const f = F!;
  if ((f.Flg & f_Stored) !== 0) {
    const p = FldPtr(f);
    const cf = AccessVars.CFile!;
    if (cf.Typ === 'D') return _RforD(f, p);
    switch (f.Typ) {
      case 'F': {
        const r = RealFromFix(p, f.NBytes);
        if ((f.Flg & f_Comma) === 0) return r / Power10[f.M];
        return r;
      }
      case 'D':
        if (cf.Typ === '8') {
          const ip = getInteger(p, 0);
          return ip === 0 ? 0.0 : ip + FirstDate;
        }
      // else goto 1
      // falls through
      case 'R':
        // 1:
        if (IsNullValue(p, f.NBytes)) return 0;
        if (f.NBytes === 6) return Real48ToFloat(p);
        return RealAt(p);
    }
    return 0;
  }
  return RunReal(f.Frml);
}

// PAS: RECACC.PAS _B
export function _B(F: FieldDPtr): boolean {
  const f = F!;
  if ((f.Flg & f_Stored) !== 0) {
    const c = FldPtr(f)[0];
    if (AccessVars.CFile!.Typ === 'D') return c === 0x59 || c === 0x79 || c === 0x54 || c === 0x74; // YyTt
    return !(c === 0 || c === 0xff);
  }
  return RunBool(f.Frml);
}

// PAS: RECACC.PAS _T – the text position stored in a 'T' field
export function _T(F: FieldDPtr): number {
  const p = FldPtr(F);
  if (AccessVars.CFile!.Typ === 'D') {
    const n = ref(0);
    const err = ref(0);
    ValI(LeadChar(' ', BytesToStr(p, 0, 10)), n, err);
    return n.v;
  }
  if (IsNullValue(p, 4)) return 0;
  return getLongint(p, 0);
}

// PAS: RECACC.PAS S_
export function S_(F: FieldDPtr, S: string): void {
  const f = F!;
  if ((f.Flg & f_Stored) === 0) return;
  const p = FldPtr(f);
  const L = f.L;
  const M = f.M;
  switch (f.Typ) {
    case 'A': {
      if (S.length < L) S = M === LeftJust ? S + ' '.repeat(L - S.length) : ' '.repeat(L - S.length) + S;
      let i = 1;
      if (S.length > L && M !== LeftJust) i = S.length + 1 - L;
      for (let k = 0; k < L; k++) p[k] = S.charCodeAt(i - 1 + k) & 0xff;
      if ((f.Flg & f_Encryp) !== 0) Code(p, L);
      break;
    }
    case 'N': {
      if (S.length < L) S = M === LeftJust ? S + '0'.repeat(L - S.length) : '0'.repeat(L - S.length) + S;
      let i = 1;
      if (S.length > L && M !== LeftJust) i = S.length + 1 - L;
      Pack(StrToBytes(S.slice(i - 1)), p, L);
      break;
    }
    case 'T': {
      const ss = StrToBytes(S); // CopyToLongStr(S)
      LongS_(f, ss);
      ReleaseStore(ss);
      break;
    }
  }
}

// PAS: RECACC.PAS LongS_ – stores the text (T field: TWork or the T-file) and sets its position
export function LongS_(F: FieldDPtr, S: LongStrPtr): void {
  const f = F!;
  if ((f.Flg & f_Stored) === 0) return;
  if (S.length === 0) {
    T_(f, 0);
    return;
  }
  if ((f.Flg & f_Encryp) !== 0) Code(S, S.length);
  let Pos: number;
  if (HasTWorkFlag()) Pos = AccessVars.TWork.Store(S);
  else {
    const md = NewLMode(WrMode);
    Pos = AccessVars.CFile!.TF!.Store(S);
    OldLMode(md);
  }
  if ((f.Flg & f_Encryp) !== 0) Code(S, S.length);
  T_(f, Pos);
}

// PAS: RECACC.PAS R_
export function R_(F: FieldDPtr, R: float): void {
  const f = F!;
  if ((f.Flg & f_Stored) === 0) return;
  const p = FldPtr(f);
  const m = f.M;
  const cf = AccessVars.CFile!;
  switch (f.Typ) {
    case 'F':
      if (cf.Typ === 'D') {
        if ((f.Flg & f_Comma) !== 0) R = R / Power10[m];
        const s = StrR(R, f.NBytes, m);
        for (let k = 0; k < f.NBytes; k++) p[k] = s.charCodeAt(k) & 0xff;
      } else {
        if ((f.Flg & f_Comma) === 0) R = Real48Round(Real48Round(R) * Power10[m]);
        FixFromReal(R, p, f.NBytes);
      }
      break;
    case 'D':
      switch (cf.Typ) {
        case '8':
          if (Math.trunc(R) === 0) setInteger(p, 0, 0);
          else setInteger(p, 0, Math.trunc(R - FirstDate));
          break;
        case 'D': {
          const s = StrDate(R, 'YYYYMMDD');
          for (let k = 0; k < 8; k++) p[k] = s.charCodeAt(k) & 0xff;
          break;
        }
        default:
          if (f.NBytes === 6) FloatToReal48(R, p);
          else SetRealAt(p, R);
      }
      break;
    case 'R':
      if (f.NBytes === 6) FloatToReal48(R, p);
      else SetRealAt(p, R);
      break;
  }
}

// PAS: RECACC.PAS B_
export function B_(F: FieldDPtr, B: boolean): void {
  const f = F!;
  if (f.Typ === 'B' && (f.Flg & f_Stored) !== 0) {
    const p = FldPtr(f);
    if (AccessVars.CFile!.Typ === 'D') p[0] = B ? 0x54 : 0x46; // 'T' : 'F'
    else p[0] = B ? 1 : 0;
  }
}

// PAS: RECACC.PAS T_
export function T_(F: FieldDPtr, Pos: number): void {
  const f = F!;
  if (f.Typ === 'T' && (f.Flg & f_Stored) !== 0) {
    const p = FldPtr(f);
    if (AccessVars.CFile!.Typ === 'D') {
      if (Pos === 0) p.fill(0x20, 0, 10);
      else {
        const s = StrI(Pos, 10);
        for (let k = 0; k < 10; k++) p[k] = s.charCodeAt(k) & 0xff;
      }
    } else setLongint(p, 0, Pos);
  } else RunError(906);
}

// PAS: RECACC.PAS ZeroAllFlds
export function ZeroAllFlds(): void {
  AccessVars.CRecPtr!.fill(0, 0, AccessVars.CFile!.RecLen);
  let F = AccessVars.CFile!.FldD;
  while (F !== null) {
    if ((F.Flg & f_Stored) !== 0 && F.Typ === 'A') S_(F, '');
    F = F.Chain;
  }
}

// PAS: RECACC.PAS DelTFld – deletes the text of F (TWork or the T-file) and zeroes the position
export function DelTFld(F: FieldDPtr): void {
  const n = _T(F);
  if (HasTWorkFlag()) AccessVars.TWork.Delete(n);
  else {
    const md = NewLMode(WrMode);
    AccessVars.CFile!.TF!.Delete(n);
    OldLMode(md);
  }
  T_(F, 0);
}
// PAS: RECACC.PAS DelDifTFld – deletes the text of F in Rec when CompRec has another one (nil: always)
export function DelDifTFld(Rec: Uint8Array, CompRec: Uint8Array | null, F: FieldDPtr): void {
  const cr = AccessVars.CRecPtr;
  if (CompRec === null) {
    AccessVars.CRecPtr = Rec;
    DelTFld(F);
    AccessVars.CRecPtr = cr;
    return;
  }
  AccessVars.CRecPtr = CompRec;
  const n = _T(F);
  AccessVars.CRecPtr = Rec;
  if (n !== _T(F)) DelTFld(F);
  AccessVars.CRecPtr = cr;
}
// PAS: RECACC.PAS ClearRecSpace – drops the TWork texts of a record buffer
export function ClearRecSpace(p: Uint8Array): void {
  const cf = AccessVars.CFile!;
  if (cf.TF !== null) {
    const cr = AccessVars.CRecPtr;
    AccessVars.CRecPtr = p;
    if (HasTWorkFlag()) {
      let f = cf.FldD;
      while (f !== null) {
        if ((f.Flg & f_Stored) !== 0 && f.Typ === 'T') {
          AccessVars.TWork.Delete(_T(f));
          T_(f, 0);
        }
        f = f.Chain;
      }
    }
    AccessVars.CRecPtr = cr;
  }
}
// PAS: RECACC.PAS DelAllDifTFlds
export function DelAllDifTFlds(Rec: Uint8Array, CompRec: Uint8Array | null): void {
  let F = AccessVars.CFile!.FldD;
  while (F !== null) {
    if (F.Typ === 'T' && (F.Flg & f_Stored) !== 0) DelDifTFld(Rec, CompRec, F);
    F = F.Chain;
  }
}
// PAS: RECACC.PAS DelTFlds
export function DelTFlds(): void {
  let F = AccessVars.CFile!.FldD;
  while (F !== null) {
    if ((F.Flg & f_Stored) !== 0 && F.Typ === 'T') DelTFld(F);
    F = F.Chain;
  }
}
// PAS: RECACC.PAS CopyRecWithT – p2 := p1 with own copies of the texts (leaves CRecPtr=p2 if any T)
export function CopyRecWithT(p1: Uint8Array, p2: Uint8Array): void {
  const cf = AccessVars.CFile!;
  p2.set(p1.subarray(0, cf.RecLen));
  let F = cf.FldD;
  while (F !== null) {
    if (F.Typ === 'T' && (F.Flg & f_Stored) !== 0) {
      let tf1: TFile = cf.TF!;
      let tf2: TFile = tf1;
      AccessVars.CRecPtr = p1;
      if (tf1.Format !== T00Format) {
        const s = _LongS(F);
        AccessVars.CRecPtr = p2;
        LongS_(F, s);
        ReleaseStore(s);
      } else {
        if (HasTWorkFlag()) tf1 = AccessVars.TWork;
        let pos = _T(F);
        AccessVars.CRecPtr = p2;
        if (HasTWorkFlag()) tf2 = AccessVars.TWork;
        pos = CopyTFString(tf2, cf, tf1, pos);
        T_(F, pos);
      }
    }
    F = F.Chain;
  }
}
