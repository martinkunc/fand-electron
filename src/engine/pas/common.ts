// PAS: COMMONFPC.PAS (FPC) / COMMON.PAS (BP7 asm) – include of BASE: chains, strings, dates,
// style strings, messages, debugging. Re-exported by base.ts; state lives in BaseVars.
//
// Porting notes:
// * asm (BP7 COMMON.PAS): MyMove, IsLetter, IsDigit, the chain routines, ReplaceChar, SEquUpcase,
//   SLeadEqu, EquMask1/EqualsMask, EquLongStr, EquArea, Min/Max, SwapLong, ExChange,
//   OverlapByteStr, CountDLines, GetDLine, AddBackSlash, DelBackSlash, MouseInRect*, HexStrToLong.
//   COMMONFPC.PAS rewrites them in Pascal; the results match except:
//   - ReplaceChar/AddBackSlash/DelBackSlash take `S:string` by value, but a BP7 assembler routine
//     gets the caller's string address and modifies it in place; FPC ReplaceChar only changes a
//     copy (no effect). Here they take Ref<string> and must modify the caller's string (BP7).
//   - EqualsMask: in BP7 the char after '*' is always matched literally (even '?'), and a '*'
//     only ends the match successfully when it is the last mask char; FPC treats '?' after '*' as
//     a wildcard. BP7 semantics are ported (EquMask1).
//   - BP7 ListAt tests `es:si` instead of `es:di` for nil (a bug that never triggers for valid I).
//   - AddBackSlash/DelBackSlash use DirectorySeparator (FPC; BP7 '\'): engine paths are host paths.
//   - GetDLine caps the line at 255 chars (FPC; BP7 stores only the low byte of the length).
// * Chains: every FAND list element has Chain as its first field; ChainLast/LastInChain/ListAt
//   work on any such record (generic Chained<T> here).
// * Dates (pure Pascal in both): FAND day numbers with RDate/SplitDate (OlympYear leap rules),
//   AddMonth/DifMonth, ValDate/StrDate masks (AnalDateMask/EncodeMask private); Today uses
//   BaseVars.userToday when set, else the host date; time of day is a day fraction (tt+100*ss+
//   6000*mm+360000*hh)/8640000. Word parameters are truncated to 16 bits; DifMonth keeps the BP7
//   16-bit integer result.
// * Display: WrStyleStr/WrLongStyleStr write to Output (pasrt TxtWrite; DRIVERS AssignCrt routes
//   it to the screen) with ^S ^W ^Q ^D ^B ^E ^A toggling colors.t* attributes (private
//   CStyle/CColor stacks); LenStyleStr skips those control chars.
// * Messages: MsgPar[1..4] (ScreenStr = string[80]) in BaseVars; WriteMsg/ClearLL use the last line.

import {
  Move, ShortStr, StrI, ValI, Round, Trunc, Frac, word, int16, int32, ref, GetDate, GetTime,
  DirectorySeparator, BytesToStr, TxtWrite, Output, type Ref,
} from './pasrt.ts';
import type { float, LongStrPtr, string2, string4, string8, string9 } from './base.ts';
import { BaseVars, RdMsg } from './base.ts';
import { DriversVars, ReadKey, ScrClr } from './drivers.ts';

/** A chained record: Chain is the first field of every FAND list element. */
export interface Chained<T> {
  Chain: T | null;
}

// PAS: COMMONFPC.PAS MyMove
export function MyMove(a1: Uint8Array, a2: Uint8Array, n: number): void {
  Move(a1, a2, n);
}
// PAS: COMMONFPC.PAS IsLetter
export function IsLetter(C: string): boolean {
  const b = C.charCodeAt(0);
  return C === '_' || (b >= 0x41 && b <= 0x5a) || (b >= 0x61 && b <= 0x7a) || b >= 0x80;
}
// PAS: COMMONFPC.PAS IsDigit
export function IsDigit(C: string): boolean {
  return C >= '0' && C <= '9' && C.length === 1;
}
// PAS: COMMONFPC.PAS ChainLast – append New (its Chain := nil) to the list rooted in Frst
export function ChainLast<T extends Chained<T>>(Frst: Ref<T | null>, New: T): void {
  New.Chain = null;
  if (Frst.v === null) {
    Frst.v = New;
    return;
  }
  let p = Frst.v;
  while (p.Chain !== null) p = p.Chain;
  p.Chain = New;
}
// PAS: COMMONFPC.PAS LastInChain – for an empty list Pascal returns @Frst, i.e. an element
// whose Chain is the root itself; the TS result then is a view writing Frst.
export function LastInChain<T extends Chained<T>>(Frst: Ref<T | null>): Chained<T> {
  let p = Frst.v;
  if (p === null) {
    return {
      get Chain() {
        return Frst.v;
      },
      set Chain(x: T | null) {
        Frst.v = x;
      },
    };
  }
  while (p.Chain !== null) p = p.Chain;
  return p;
}
// PAS: COMMONFPC.PAS ListLength
export function ListLength<T extends Chained<T>>(P: T | null): number {
  let n = 0;
  while (P !== null) {
    n++;
    P = P.Chain;
  }
  return n;
}
// PAS: COMMONFPC.PAS ListAt – I-th element counting from 0
export function ListAt<T extends Chained<T>>(P: T | null, I: number): T | null {
  while (I > 0 && P !== null) {
    P = P.Chain;
    I--;
  }
  return P;
}
// PAS: COMMONFPC.PAS ReplaceChar – BP7 (asm) modifies the caller's string, hence the Ref
export function ReplaceChar(S: Ref<string>, C1: string, C2: string): void {
  if (S.v.indexOf(C1) < 0) return;
  S.v = S.v.split(C1).join(C2);
}
// PAS: COMMONFPC.PAS SEquUpcase
export function SEquUpcase(S1: string, S2: string): boolean {
  if (S1.length !== S2.length) return false;
  const t = BaseVars.UpcCharTab;
  for (let i = 0; i < S1.length; i++) {
    if (t[S1.charCodeAt(i) & 0xff] !== t[S2.charCodeAt(i) & 0xff]) return false;
  }
  return true;
}
// PAS: COMMONFPC.PAS StrPas – Src: zero-terminated bytes
export function StrPas(Src: Uint8Array): string {
  let n = 0;
  while (n < 255 && n < Src.length && Src[n] !== 0) n++;
  return BytesToStr(Src, 0, n);
}
// PAS: COMMONFPC.PAS StrLPCopy
export function StrLPCopy(Dest: Uint8Array, s: string, MaxL: number): void {
  Dest.fill(0, 0, MaxL);
  let n = s.length;
  if (n >= MaxL) n = MaxL - 1;
  for (let i = 0; i < n; i++) Dest[i] = s.charCodeAt(i);
}
// PAS: COMMONFPC.PAS SLeadEqu
export function SLeadEqu(S1: string, S2: string): number {
  const len = S1.length < S2.length ? S1.length : S2.length;
  let i = 0;
  while (i < len && S1[i] === S2[i]) i++;
  return i;
}
// PAS: COMMON.PAS EquMask1 (BP7 asm, recursive) – mask from Mask[mi..] (0-based) against p[pi..l-1].
// After '*' the next mask char is always literal; '*' at the very end matches the rest.
function EquMask1(p: Uint8Array, l: number, Mask: string, mi: number, pi: number): boolean {
  const ot = BaseVars.CharOrdTab;
  const ordAt = (i: number): number => ot[p[i] ?? 0];
  let cx = Mask.length - mi;
  let dx = l - pi;
  for (;;) {
    if (cx === 0) return dx === 0; // @fin
    const bl = Mask[mi];
    mi++;
    cx--;
    if (dx === 0) return bl === '*' && cx === 0;
    if (bl === '*') {
      if (cx === 0) return true;
      const al = ot[Mask.charCodeAt(mi) & 0xff];
      mi++;
      cx--;
      for (;;) {
        // @2: search the literal char
        while (ordAt(pi) !== al) {
          pi++;
          dx--;
          if (dx === 0) return false;
        }
        // @3
        pi++;
        dx--;
        if (EquMask1(p, l, Mask, mi, pi)) return true;
        if (dx === 0) return false;
      }
    }
    if (bl === '?') {
      pi++;
      dx--;
      continue;
    }
    if (ot[bl.charCodeAt(0) & 0xff] !== ordAt(pi)) return false;
    pi++;
    dx--;
  }
}
// PAS: COMMONFPC.PAS EqualsMask – p[0..l-1] against a '*'/'?' mask via CharOrdTab (BP7 EquMask1)
export function EqualsMask(p: Uint8Array, l: number, Mask: string): boolean {
  return EquMask1(p, l, Mask, 0, 0);
}
// PAS: COMMONFPC.PAS EquLongStr
export function EquLongStr(S1: LongStrPtr, S2: LongStrPtr): boolean {
  if (S1.length !== S2.length) return false;
  for (let i = 0; i < S1.length; i++) if (S1[i] !== S2[i]) return false;
  return true;
}
// PAS: COMMONFPC.PAS EquArea
export function EquArea(P1: Uint8Array, P2: Uint8Array, L: number): boolean {
  for (let i = 0; i < L; i++) if (P1[i] !== P2[i]) return false;
  return true;
}
// PAS: COMMONFPC.PAS MinI
export function MinI(X: number, Y: number): number {
  return X <= Y ? X : Y;
}
// PAS: COMMONFPC.PAS MaxI
export function MaxI(X: number, Y: number): number {
  return X >= Y ? X : Y;
}
// PAS: COMMONFPC.PAS MinW
export function MinW(X: number, Y: number): number {
  return X <= Y ? X : Y;
}
// PAS: COMMONFPC.PAS MaxW
export function MaxW(X: number, Y: number): number {
  return X >= Y ? X : Y;
}
// PAS: COMMONFPC.PAS MinL
export function MinL(X: number, Y: number): number {
  return X < Y ? X : Y;
}
// PAS: COMMONFPC.PAS MaxL
export function MaxL(X: number, Y: number): number {
  return X < Y ? Y : X;
}
// PAS: COMMONFPC.PAS SwapLong
export function SwapLong(N: number): number {
  return (((N & 0xff) << 24) | (((N >> 8) & 0xff) << 16) | (((N >> 16) & 0xff) << 8) | ((N >> 24) & 0xff)) | 0;
}
// PAS: COMMONFPC.PAS ExChange
export function ExChange(X: Uint8Array, Y: Uint8Array, L: number): void {
  for (let i = 0; i < L; i++) {
    const t = X[i];
    X[i] = Y[i];
    Y[i] = t;
  }
}
// PAS: COMMONFPC.PAS OverlapByteStr – do two byte strings share a char
export function OverlapByteStr(p1: string, p2: string): boolean {
  for (let i = 0; i < p1.length; i++) if (p2.indexOf(p1[i]) >= 0) return true;
  return false;
}
// PAS: COMMONFPC.PAS CountDLines
export function CountDLines(Buf: Uint8Array, L: number, C: string): number {
  if (L === 0) return 0;
  const c = C.charCodeAt(0);
  let n = 1;
  for (let i = 0; i < L; i++) if (Buf[i] === c) n++;
  return n;
}
// PAS: COMMONFPC.PAS GetDLine
export function GetDLine(Buf: Uint8Array, L: number, C: string, I: number): string {
  const c = C.charCodeAt(0);
  let j = 0;
  I = word(I - 1);
  while (I > 0 && j < L) {
    if (Buf[j] === c) I--;
    j++;
  }
  if (c === 13 && j < L && Buf[j] === 10) j++;
  const start = j;
  while (j < L && Buf[j] !== c) j++;
  let len = j - start;
  if (len > 255) len = 255;
  return BytesToStr(Buf, start, len);
}
// PAS: COMMONFPC.PAS FindCtrlM – i is a 1-based position in s
export function FindCtrlM(s: LongStrPtr, i: number, n: number): number {
  const l = s.length;
  while (i <= l) {
    if (s[i - 1] === 13) {
      if (n > 1) n--;
      else return i;
    }
    i++;
  }
  return l + 1;
}
// PAS: COMMONFPC.PAS SkipCtrlMJ
export function SkipCtrlMJ(s: LongStrPtr, i: number): number {
  const l = s.length;
  if (i <= l) {
    i++;
    if (i <= l && s[i - 1] === 10) i++;
  }
  return i;
}
// PAS: COMMONFPC.PAS AddBackSlash
export function AddBackSlash(S: Ref<string>): void {
  if (S.v.length > 0 && S.v[S.v.length - 1] !== DirectorySeparator) S.v = ShortStr(S.v + DirectorySeparator);
}
// PAS: COMMONFPC.PAS DelBackSlash
export function DelBackSlash(S: Ref<string>): void {
  if (S.v.length > 3 && S.v[S.v.length - 1] === DirectorySeparator) S.v = S.v.slice(0, -1);
}
// PAS: COMMONFPC.PAS MouseInRect
export function MouseInRect(X: number, Y: number, XSize: number, YSize: number): boolean {
  const w = DriversVars.Event.Where;
  return w.X >= X && w.X < X + XSize && w.Y >= Y && w.Y < Y + YSize;
}
// PAS: COMMONFPC.PAS MouseInRectProc
export function MouseInRectProc(X: number, Y: number, XSize: number, YSize: number): boolean {
  const e = DriversVars.Event;
  if (!DriversVars.IsGraphMode) {
    return e.Where.X >= X - 1 && e.Where.X < X - 1 + XSize && e.Where.Y >= Y - 1 && e.Where.Y < Y - 1 + YSize;
  }
  return e.WhereG.X >= X && e.WhereG.X < X + XSize && e.WhereG.Y >= Y && e.WhereG.Y < Y + YSize;
}
// PAS: COMMONFPC.PAS HexStrToLong
export function HexStrToLong(S: string): number {
  let r = 0;
  for (let i = 0; i < S.length; i++) {
    const ch = S[i];
    let c: number;
    if (ch >= 'a' && ch <= 'f') c = ch.charCodeAt(0) - 0x61 + 10;
    else if (ch >= 'A' && ch <= 'F') c = ch.charCodeAt(0) - 0x41 + 10;
    else if (ch >= '0' && ch <= '9') c = ch.charCodeAt(0) - 0x30;
    else return 0;
    r = int32((r << 4) + c);
  }
  return r;
}

// ---------------------------------------------------------------- time, date

// PAS: COMMONFPC.PAS NoDayInMonth (array[1..12])
const NoDayInMonth = [0, 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
// TS: NoDayInMonth[M] for an out-of-range M (Pascal reads outside the array; R-)
function DaysOf(M: number): number {
  return NoDayInMonth[M] ?? 0;
}
// PAS: COMMONFPC.PAS OlympYear
function OlympYear(y: number): boolean {
  return y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
}
// PAS: COMMONFPC.PAS OlympYears
function OlympYears(y: number): number {
  if (y < 3) return 0;
  y--;
  return Math.trunc(y / 4) - Math.trunc(y / 100) + Math.trunc(y / 400);
}

// PAS: COMMONFPC.PAS SplitDate
export function SplitDate(R: float, d: Ref<number>, m: Ref<number>, y: Ref<number>): void {
  let l = int32(Trunc(R));
  if (l === 0) {
    y.v = 1;
    m.v = 1;
    d.v = 1;
    return;
  }
  let yy = word(Math.trunc(l / 365));
  yy = word(yy + 1);
  l = l % 365;
  while (l <= OlympYears(yy)) {
    yy = word(yy - 1);
    l = l + 365;
  }
  l = l - OlympYears(yy);
  let j = 1;
  for (; j <= 12; j++) {
    let i = NoDayInMonth[j];
    if (j === 2 && OlympYear(yy)) i++;
    if (i >= l) break;
    l = l - i;
  }
  // Pascal: after a full loop without goto, j = 12 (the for variable keeps its last value)
  if (j > 12) j = 12;
  y.v = yy;
  m.v = j;
  d.v = word(l);
}
// PAS: COMMONFPC.PAS RDate
export function RDate(Y: number, M: number, D: number, hh: number, mm: number, ss: number, tt: number): float {
  Y = word(Y);
  M = word(M);
  D = word(D);
  if (D > DaysOf(M) && (M !== 2 || D !== 29 || !OlympYear(Y))) return 0;
  let l: number;
  if (word(Y + M + D) === 0) l = 0;
  else {
    l = (Y - 1) * 365 + OlympYears(Y) + D;
    for (let i = 1; i <= Math.min(M - 1, 12); i++) l = l + NoDayInMonth[i];
    if (M > 2 && OlympYear(Y)) l++;
  }
  // word op shortint constant has the common type longint in BP7: no 16-bit wrap here
  const n = word(tt) + 100 * word(ss) + 6000 * word(mm);
  const r = (n + 360000.0 * word(hh)) / 8640000.0;
  return l + r;
}
// PAS: COMMONFPC.PAS AddMonth
export function AddMonth(R: float, RM: float): float {
  const d = ref(0), m = ref(0), y = ref(0);
  SplitDate(R, d, m, y);
  const l = int32(y.v * 12 + m.v - 1 + Trunc(RM));
  const RTime = Frac(R);
  const yy = word(Math.trunc(l / 12));
  const mm = (l % 12) + 1;
  let dd = d.v;
  if (dd > DaysOf(mm)) {
    dd = DaysOf(mm);
    if (mm === 2 && OlympYear(yy)) dd = 29;
  }
  return RDate(yy, mm, dd, 0, 0, 0, 0) + RTime;
}
// PAS: COMMONFPC.PAS DifMonth
export function DifMonth(R1: float, R2: float): float {
  const d1 = ref(0), m1 = ref(0), y1 = ref(0), d2 = ref(0), m2 = ref(0), y2 = ref(0);
  SplitDate(R1, d1, m1, y1);
  SplitDate(R2, d2, m2, y2);
  // BP7: integer (16-bit) arithmetic
  return int16((int16(y2.v) - int16(y1.v)) * 12 + int16(m2.v) - int16(m1.v));
}
// PAS: COMMONFPC.PAS EncodeMask – YMDhmst become chr(0..6)
function EncodeMask(Mask: Ref<string>, Min: Ref<number>, Max: Ref<number>): void {
  const Code = 'YMDhmst';
  Min.v = 9;
  Max.v = 0;
  let s = '';
  for (let i = 0; i < Mask.v.length; i++) {
    const j = Code.indexOf(Mask.v[i]);
    if (j >= 0) {
      s += String.fromCharCode(j);
      if (Min.v > j) Min.v = j;
      if (Max.v < j) Max.v = j;
    } else s += Mask.v[i];
  }
  Mask.v = s;
}
// PAS: COMMONFPC.PAS AnalDateMask – I is 1-based
function AnalDateMask(Mask: string, I: Ref<number>, IDate: Ref<number>, N: Ref<number>): void {
  N.v = 0;
  if (Mask.charCodeAt(I.v - 1) <= 6) {
    IDate.v = Mask.charCodeAt(I.v - 1);
    do {
      I.v++;
      N.v++;
    } while (!(I.v > Mask.length || Mask.charCodeAt(I.v - 1) !== IDate.v));
  }
}
// PAS: COMMONFPC.PAS ExCode
function ExCode(N: number, Mask: string): boolean {
  for (let i = 0; i < Mask.length; i++) if (Mask.charCodeAt(i) === N) return true;
  return false;
}
// PAS: COMMONFPC.PAS ValDate
export function ValDate(Txt: string, Mask: string): float {
  // z: Y,M,D,hh,mm,ss,tt = Date[0..6]
  const Date = [-1, -1, -1, 0, 0, 0, 0];
  let Ylength = 0;
  let WasYMD = false;
  let WasMinus = false;
  const mk = ref(Mask), min = ref(0), max = ref(0);
  EncodeMask(mk, min, max);
  Mask = mk.v;
  const i = ref(1), iDate = ref(0), n = ref(0);
  let j = 1;
  const txt = (k: number): string => Txt[k - 1] ?? '\0';
  const isDig = (c: string): boolean => c >= '0' && c <= '9';
  let R: number;
  // 1:
  for (;;) {
    if (j > Txt.length) break; // goto 2
    if (i.v > Mask.length) return 0;
    AnalDateMask(Mask, i, iDate, n);
    if (n.v === 0) {
      if (Mask[i.v - 1] !== txt(j)) return 0;
      i.v++;
      j++;
    } else {
      let s = '';
      if (iDate.v < 3) WasYMD = true;
      while (txt(j) === ' ' && n.v > 1) {
        j++;
        n.v--;
      }
      if (txt(j) === '-' && n.v > 1 && iDate.v === min.v && iDate.v > 2) {
        WasMinus = true;
        j++;
        n.v--;
      }
      if (!isDig(txt(j))) return 0;
      while (j <= Txt.length && isDig(txt(j)) && n.v > 0) {
        s = ShortStr(s + txt(j), 4);
        j++;
        n.v--;
      }
      const v = ref(0), k = ref(0);
      ValI(s, v, k);
      Date[iDate.v] = v.v;
      if (iDate.v === 0) Ylength = s.length;
    }
  }
  // 2:
  if (min.v === 2 && max.v >= 3) {
    if (Date[2] < 0) Date[2] = 0;
    R = Date[2] + (Date[6] + 100 * Date[5] + 6000 * Date[4] + 360000.0 * Date[3]) / 8640000.0;
  } else {
    if (WasYMD) {
      const Day = ref(0), Month = ref(0), Year = ref(0);
      SplitDate(Today(), Day, Month, Year);
      if (Date[2] === -1) Date[2] = 1;
      else if (Date[2] === 0 || Date[2] > 31) return 0;
      else if (Date[1] === -1) Date[1] = Month.v;
      if (Date[1] === -1) Date[1] = 1;
      else if (Date[1] === 0 || Date[1] > 12) return 0;
      if (Ylength === 0) Date[0] = Year.v;
      else if (Date[0] > 9999) return 0;
      else if (Ylength <= 2) {
        const off = BaseVars.Spec.OffDefaultYear;
        if (off === 0) Date[0] = Math.trunc(Year.v / 100) * 100 + Date[0];
        else {
          const y = word(Year.v + off) % 100;
          if (Date[0] < y) Date[0] = Date[0] + 2000;
          else Date[0] = Date[0] + 1900;
        }
      }
    } else {
      Date[0] = 0;
      Date[1] = 0;
      Date[2] = 0;
    }
    if (min.v < 3 && Date[3] > 23) return 0;
    if (min.v < 4 && Date[4] > 59) return 0;
    if (min.v < 5 && Date[5] > 59) return 0;
    R = RDate(Date[0], Date[1], Date[2], Date[3], Date[4], Date[5], Date[6]);
  }
  // 3:
  if (!WasYMD && R === 0.0) R = 1e-11;
  return WasMinus ? -R : R;
}
// PAS: COMMONFPC.PAS StrDate
export function StrDate(R: float, Mask: string): string {
  const MultX = [0, 0, 0, 24, 1440, 86400, 8640000]; // [3..6]
  const DivX = [0, 0, 0, 1, 60, 3600, 360000, 1, 60, 6000, 1, 100]; // [3..11]
  const Date = [0, 0, 0]; // d: Y, M, D (words)
  const Time = [0, 0, 0, 0, 0, 0, 0]; // t: [3..6] hh, mm, ss, tt
  let s = '';
  const mk = ref(Mask), min = ref(0), max = ref(0);
  EncodeMask(mk, min, max);
  Mask = mk.v;
  let WasMinus = false;
  if (R === 0 || (R < 0 && min.v < 3)) {
    for (let i = 0; i < Mask.length; i++) s += Mask.charCodeAt(i) <= 6 ? ' ' : Mask[i];
    return ShortStr(s, 80);
  } else if (R < 0) {
    WasMinus = true;
    R = -R;
  }
  if (min.v < 3) {
    if (min.v === 2 && max.v >= 3) Date[2] = word(Trunc(R));
    else {
      const d = ref(0), m = ref(0), y = ref(0);
      SplitDate(R, d, m, y);
      Date[2] = d.v;
      Date[1] = m.v;
      Date[0] = y.v;
    }
    R = Frac(R);
  }
  if (max.v >= 3) {
    let l = int32(Round(R * MultX[max.v]));
    let f: number;
    if (ExCode(3, Mask)) {
      f = DivX[max.v];
      Time[3] = Math.trunc(l / f);
      l = l % f;
    }
    if (ExCode(4, Mask)) {
      f = DivX[max.v + 3];
      Time[4] = Math.trunc(l / f);
      l = l % f;
    }
    if (ExCode(5, Mask)) {
      f = DivX[max.v + 5];
      Time[5] = Math.trunc(l / f);
      l = l % f;
    }
    Time[6] = l;
  }
  const i = ref(1), iDate = ref(0), n = ref(0);
  let First = true;
  while (i.v <= Mask.length) {
    AnalDateMask(Mask, i, iDate, n);
    if (n.v === 0) {
      s = ShortStr(s + Mask[i.v - 1], 80);
      i.v++;
    } else {
      let x: string;
      if (iDate.v < 3) x = StrI(Date[iDate.v]);
      else {
        x = StrI(Time[iDate.v]);
        if (iDate.v === min.v && WasMinus) x = '-' + x;
      }
      const c = First && iDate.v > 2 && iDate.v === min.v ? ' ' : '0';
      First = false;
      while (x.length < n.v) x = c + x;
      x = ShortStr(x, 80);
      if (iDate.v < 3) x = x.substr(Math.max(x.length - n.v, 0), n.v);
      s = ShortStr(s + x, 80);
    }
  }
  return s;
}
// PAS: COMMONFPC.PAS Today – BaseVars.userToday, else host date (pasrt GetDate)
export function Today(): float {
  if (BaseVars.userToday !== 0) return BaseVars.userToday;
  const Year = ref(0), Month = ref(0), Day = ref(0), WeekDay = ref(0);
  GetDate(Year, Month, Day, WeekDay);
  return RDate(Year.v, Month.v, Day.v, 0, 0, 0, 0);
}
// PAS: COMMONFPC.PAS CurrTime – host time (pasrt GetTime)
export function CurrTime(): float {
  const Hour = ref(0), Minute = ref(0), Second = ref(0), Sec100 = ref(0);
  GetTime(Hour, Minute, Second, Sec100);
  return RDate(1, 1, 0, Hour.v, Minute.v, Second.v, Sec100.v);
}

// ---------------------------------------------------------------- debugging

// PAS: COMMONFPC.PAS wait – ReadKey unless FandBatch
export function wait(): void {
  if (!DriversVars.FandBatch) ReadKey();
}
const HexStr = '0123456789ABCDEF';
// PAS: COMMONFPC.PAS HexB
export function HexB(b: number): string2 {
  return HexStr[(b >> 4) & 15] + HexStr[b & 15];
}
// PAS: COMMONFPC.PAS HexW
export function HexW(i: number): string4 {
  return HexB(i >> 8) + HexB(i);
}
// PAS: COMMONFPC.PAS HexD
export function HexD(i: number): string8 {
  return HexW(i >>> 16) + HexW(i);
}
// PAS: COMMONFPC.PAS HexPtr – pointers have no address here: a numeric value is shown, else 0
export function HexPtr(p: unknown): string9 {
  return HexD(typeof p === 'number' ? p : 0);
}
// PAS: COMMONFPC.PAS DispH
export function DispH(ad: Uint8Array, NoBytes: number): void {
  for (let i = 0; i < NoBytes; i++) TxtWrite(Output, HexB(ad[i]), ' ');
}

// ---------------------------------------------------------------- display

// TS: the style control chars [^s,^w,^q,^d,^b,^e,^a]
function IsStyleCtrl(c: string): boolean {
  return c === '\x13' || c === '\x17' || c === '\x11' || c === '\x04' || c === '\x02' || c === '\x05' || c === '\x01';
}
// PAS: COMMONFPC.PAS LenStyleStr
export function LenStyleStr(s: string): number {
  let l = s.length;
  for (let i = 0; i < s.length; i++) if (IsStyleCtrl(s[i])) l--;
  return l;
}
// PAS: COMMONFPC.PAS LogToAbsLenStyleStr
export function LogToAbsLenStyleStr(s: string, l: number): number {
  let i = 1;
  while (i <= s.length && l > 0) {
    if (!IsStyleCtrl(s[i - 1])) l--;
    i++;
  }
  return i - 1;
}
// PAS: COMMONFPC.PAS CStyle: string[10]; CColor: string[11] (private)
let CStyle = '';
let CColor = '';
// PAS: COMMONFPC.PAS WrStyleChar (private)
function WrStyleChar(c: string): void {
  const a = ref(0);
  if (SetStyleAttr(c, a)) {
    const i = CStyle.indexOf(c);
    if (i >= 0) {
      CStyle = CStyle.slice(0, i) + CStyle.slice(i + 1);
      CColor = CColor.slice(0, i) + CColor.slice(i + 1);
    } else {
      CStyle = ShortStr(c + CStyle, 10);
      CColor = ShortStr(String.fromCharCode(a.v & 0xff) + CColor, 11);
    }
    DriversVars.TextAttr = CColor.charCodeAt(0);
  } else if (c === '\r') TxtWrite(Output, '\r\n');
  else if (c !== '\n') TxtWrite(Output, c);
}
// PAS: COMMONFPC.PAS WrStyleStr
export function WrStyleStr(s: string, Attr: number): void {
  DriversVars.TextAttr = Attr & 0xff;
  CStyle = '';
  CColor = String.fromCharCode(Attr & 0xff);
  for (let i = 0; i < s.length; i++) WrStyleChar(s[i]);
  DriversVars.TextAttr = Attr & 0xff;
}
// PAS: COMMONFPC.PAS WrLongStyleStr
export function WrLongStyleStr(S: LongStrPtr, Attr: number): void {
  DriversVars.TextAttr = Attr & 0xff;
  CStyle = '';
  CColor = String.fromCharCode(Attr & 0xff);
  for (let i = 0; i < S.length; i++) WrStyleChar(String.fromCharCode(S[i]));
  DriversVars.TextAttr = Attr & 0xff;
}
// PAS: COMMONFPC.PAS RectToPixel (graphics: empty in the FPC port)
export function RectToPixel(
  c1: number, r1: number, c2: number, r2: number,
  x1: Ref<number>, y1: Ref<number>, x2: Ref<number>, y2: Ref<number>,
): void {}

// ---------------------------------------------------------------- messages

// PAS: COMMONFPC.PAS SetStyleAttr
export function SetStyleAttr(c: string, a: Ref<number>): boolean {
  const k = BaseVars.Colors;
  if (c === '\x13') a.v = k.tUnderline;
  else if (c === '\x17') a.v = k.tItalic;
  else if (c === '\x11') a.v = k.tDWidth;
  else if (c === '\x04') a.v = k.tDStrike;
  else if (c === '\x02') a.v = k.tEmphasized;
  else if (c === '\x05') a.v = k.tCompressed;
  else if (c === '\x01') a.v = k.tElite;
  else return false;
  return true;
}
// PAS: COMMONFPC.PAS SetMsgPar
export function SetMsgPar(s: string): void {
  BaseVars.MsgPar[1] = ShortStr(s, 80);
}
// PAS: COMMONFPC.PAS Set2MsgPar
export function Set2MsgPar(s1: string, s2: string): void {
  BaseVars.MsgPar[1] = ShortStr(s1, 80);
  BaseVars.MsgPar[2] = ShortStr(s2, 80);
}
// PAS: COMMONFPC.PAS Set3MsgPar
export function Set3MsgPar(s1: string, s2: string, s3: string): void {
  Set2MsgPar(s1, s2);
  BaseVars.MsgPar[3] = ShortStr(s3, 80);
}
// PAS: COMMONFPC.PAS Set4MsgPar
export function Set4MsgPar(s1: string, s2: string, s3: string, s4: string): void {
  Set3MsgPar(s1, s2, s3);
  BaseVars.MsgPar[4] = ShortStr(s4, 80);
}
// PAS: COMMONFPC.PAS WriteMsg
export function WriteMsg(N: number): void {
  RdMsg(N);
  TxtWrite(Output, BaseVars.MsgLine);
}
// PAS: COMMONFPC.PAS ClearLL – the attr parameter is ignored (as in Pascal)
export function ClearLL(attr: number): void {
  ScrClr(0, BaseVars.TxtRows - 1, BaseVars.TxtCols, 1, ' ', BaseVars.Colors.uNorm);
}
