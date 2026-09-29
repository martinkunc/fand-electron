// Pascal runtime helpers shared by every ported unit in src/engine/pas/.
// This module is a leaf (no imports of ported units), so its exports may be used at
// module top level. Conventions: docs/PORTING.md.

import { sep } from 'node:path';
import { CP852_TO_UNICODE, charToByte } from '../console/cp852.ts';

// ---------------------------------------------------------------- var parameters

/** A Pascal `var` parameter of a value type (number, string, boolean, pointer). */
export interface Ref<T> {
  v: T;
}

/** A fresh box: `const n = ref(0); ReadNum(n); use(n.v)`. */
export function ref<T>(v: T): Ref<T> {
  return { v };
}

/** Ref bound to an object field: `ChainLast(fref(FD, 'Keys'), K)` for Pascal `ChainLast(FD^.Keys, K)`. */
export function fref<O extends object, K extends keyof O>(o: O, k: K): Ref<O[K]> {
  return {
    get v() {
      return o[k];
    },
    set v(x: O[K]) {
      o[k] = x;
    },
  };
}

/** Ref bound to an array element: Pascal `P(A[i])` with a var parameter. */
export function aref<T>(a: T[], i: number): Ref<T> {
  return {
    get v() {
      return a[i];
    },
    set v(x: T) {
      a[i] = x;
    },
  };
}

/** Untyped Pascal `pointer` whose target varies (heap marks, opaque handles). Cast at use. */
export type Pointer = unknown;

// ---------------------------------------------------------------- non-local exits

/** Thrown by stubs of routines that are not ported yet. */
export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`not implemented: ${what}`);
    this.name = 'NotImplementedError';
  }
}

/** Stub body: `export function Foo(a: number): boolean { return notImpl('UNIT.Foo'); }` */
export function notImpl(what: string): never {
  throw new NotImplementedError(what);
}

/** Stub body for features that are deliberately not ported (BGI graphics, SQL, DML, IPX). */
export function notSupported(what: string): never {
  throw new NotImplementedError(`${what} (not supported in this port)`);
}

/**
 * PAS: BASE.GoExit – the longjmp to the innermost NewExit. BASE.GoExit restores
 * ExitP/BreakP/MyBP from ExitBuf and throws this; the NewExit site catches it.
 * FAND's own RunError(N) (OBASEWW: message N, then GoExit) also ends up here.
 */
export class GoExitSignal extends Error {
  constructor() {
    super('GoExit');
    this.name = 'GoExitSignal';
  }
}

/**
 * Turbo Pascal System.RunError / a runtime error of the Pascal RTL (division by zero = 200,
 * range = 201, heap = 203, invalid FP = 207 ...). Fatal: unwinds the whole task
 * (BASE MyExit reports it). Not to be confused with OBASEWW.RunError(N), see GoExitSignal.
 */
export class FandRunError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`runtime error ${code}`);
    this.code = code;
    this.name = 'FandRunError';
  }
}

/** Pascal Halt(code): unwinds to the engine entry. */
export class HaltSignal extends Error {
  readonly code: number;
  constructor(code: number) {
    super(`halt ${code}`);
    this.code = code;
    this.name = 'HaltSignal';
  }
}

/** System.RunError(code). */
export function SysRunError(code: number): never {
  throw new FandRunError(code);
}

/** System.Halt(code). */
export function Halt(code = 0): never {
  throw new HaltSignal(code);
}

// ---------------------------------------------------------------- integers

/** byte */
export function byte(n: number): number {
  return n & 0xff;
}
/** shortint */
export function shortint(n: number): number {
  return (n << 24) >> 24;
}
/** word */
export function word(n: number): number {
  return n & 0xffff;
}
/** integer (16-bit signed) */
export function int16(n: number): number {
  return (n << 16) >> 16;
}
/** longint (32-bit signed) */
export function int32(n: number): number {
  return n | 0;
}
/** 32-bit unsigned (longint reinterpreted, e.g. for shr) */
export function uint32(n: number): number {
  return n >>> 0;
}
export function Lo(n: number): number {
  return n & 0xff;
}
export function Hi(n: number): number {
  return (n >> 8) & 0xff;
}
/** Swap the bytes of a word. */
export function Swap(n: number): number {
  return ((n & 0xff) << 8) | ((n >> 8) & 0xff);
}
export function Odd(n: number): boolean {
  return (n & 1) !== 0;
}
/** Integer `div` (truncates toward zero). */
export function Div(a: number, b: number): number {
  if (b === 0) SysRunError(200);
  return Math.trunc(a / b);
}
/** Integer `mod` (sign of the dividend, like JS %). */
export function Mod(a: number, b: number): number {
  if (b === 0) SysRunError(200);
  return a % b;
}

// ---------------------------------------------------------------- reals

export function Trunc(r: number): number {
  return Math.trunc(r);
}
/** BP7 Round (software Real48, $N-): halves round away from zero. */
export function Round(r: number): number {
  return r < 0 ? -Math.floor(-r + 0.5) : Math.floor(r + 0.5);
}
export function Int(r: number): number {
  return Math.trunc(r);
}
export function Frac(r: number): number {
  return r - Math.trunc(r);
}
export function Sqr(r: number): number {
  return r * r;
}

// ---------------------------------------------------------------- byte strings
// A Pascal string/char is a JS string whose char codes are the raw CP852 bytes.

export function ord(c: string): number {
  return c.charCodeAt(0);
}
export function chr(n: number): string {
  return String.fromCharCode(n & 0xff);
}

/** Assignment to string[max]: truncation. */
export function ShortStr(s: string, max = 255): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** System.Copy (BP7: Index < 1 counts as 1). */
export function Copy(s: string, index: number, count: number): string {
  if (index < 1) index = 1;
  if (count <= 0 || index > s.length) return '';
  return s.substr(index - 1, count);
}

/** System.Pos: 1-based, 0 when not found (also for an empty Substr). */
export function Pos(substr: string, s: string): number {
  if (substr === '') return 0;
  return s.indexOf(substr) + 1;
}

/** Functional System.Delete: returns the new string. */
export function StrDelete(s: string, index: number, count: number): string {
  if (index < 1 || index > s.length || count <= 0) return s;
  return s.slice(0, index - 1) + s.slice(index - 1 + count);
}

/** System.Delete(var S; Index, Count). */
export function Delete(s: Ref<string>, index: number, count: number): void {
  s.v = StrDelete(s.v, index, count);
}

/** Functional System.Insert: returns the new string (truncated to 255). */
export function StrInsert(source: string, s: string, index: number): string {
  if (index < 1) index = 1;
  if (index > s.length) index = s.length + 1;
  return ShortStr(s.slice(0, index - 1) + source + s.slice(index - 1));
}

/** System.Insert(Source; var S; Index). */
export function Insert(source: string, s: Ref<string>, index: number): void {
  s.v = StrInsert(source, s.v, index);
}

/** System.UpCase: only 'a'..'z' (national letters go through BASE UpcCharTab). */
export function UpCase(c: string): string {
  const b = c.charCodeAt(0);
  return b >= 0x61 && b <= 0x7a ? String.fromCharCode(b - 32) : c;
}

/** CP852 upper-case table derived from Unicode (default for BASE UpcCharTab before the config is read). */
export const UPCASE_852: Uint8Array = (() => {
  const t = new Uint8Array(256);
  for (let i = 0; i < 256; i++) {
    t[i] = i;
    if (i < 0x80) {
      if (i >= 0x61 && i <= 0x7a) t[i] = i - 32;
      continue;
    }
    const u = CP852_TO_UNICODE[i];
    const up = u.toUpperCase();
    if (up !== u && up.length === 1) {
      const b = charToByte(up);
      if (b !== 0x3f || up === '?') t[i] = b;
    }
  }
  return t;
})();

/** Upper-case a byte string with a char table (UpcCharTab or UPCASE_852). */
export function UpcaseStr(s: string, tab: Uint8Array = UPCASE_852): string {
  let r = '';
  for (let i = 0; i < s.length; i++) r += String.fromCharCode(tab[s.charCodeAt(i) & 0xff]);
  return r;
}

/** Byte string -> Unicode (screen, host file names, messages to the host). */
export function ToUnicode(s: string): string {
  let r = '';
  for (let i = 0; i < s.length; i++) {
    const b = s.charCodeAt(i) & 0xff;
    r += b < 0x20 ? String.fromCharCode(b) : CP852_TO_UNICODE[b];
  }
  return r;
}

/** Unicode -> byte string (CP852, '?' for unmappable). */
export function FromUnicode(u: string): string {
  let r = '';
  for (const c of u) {
    const code = c.charCodeAt(0);
    r += String.fromCharCode(code < 0x80 ? code : charToByte(c));
  }
  return r;
}

/** Byte string -> Uint8Array (LongStr, record buffers). */
export function StrToBytes(s: string): Uint8Array {
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
  return b;
}

/** Uint8Array (slice) -> byte string. */
export function BytesToStr(b: Uint8Array, ofs = 0, len = b.length - ofs): string {
  let r = '';
  const end = Math.min(b.length, ofs + len);
  for (let i = ofs; i < end; i += 4096) {
    r += String.fromCharCode(...b.subarray(i, Math.min(end, i + 4096)));
  }
  return r;
}

/** Read a length-prefixed Pascal string stored in a buffer (record field, resource, inline data). */
export function GetPStr(b: Uint8Array, ofs = 0): string {
  return BytesToStr(b, ofs + 1, b[ofs]);
}

/** Store a Pascal string at ofs (length byte + chars), truncated to max. */
export function SetPStr(b: Uint8Array, ofs: number, s: string, max = 255): void {
  s = ShortStr(s, max);
  b[ofs] = s.length;
  for (let i = 0; i < s.length; i++) b[ofs + 1 + i] = s.charCodeAt(i);
}

// ---------------------------------------------------------------- memory blocks

/** System.FillChar(X, Count, Value) on a buffer (optionally from ofs). */
export function FillChar(buf: Uint8Array, count: number, value: number | string, ofs = 0): void {
  const v = typeof value === 'string' ? value.charCodeAt(0) : value;
  buf.fill(v & 0xff, ofs, ofs + count);
}

/** System.Move(Source, Dest, Count); overlap-safe. Use subarray()s or the offsets for `A[i]` arguments. */
export function Move(src: Uint8Array, dst: Uint8Array, count: number, srcOfs = 0, dstOfs = 0): void {
  if (count <= 0) return;
  if (src.buffer === dst.buffer) dst.set(src.slice(srcOfs, srcOfs + count), dstOfs);
  else dst.set(src.subarray(srcOfs, srcOfs + count), dstOfs);
}

/** Little-endian accessors for record buffers (Pascal typecasts like WordPtr(p)^). */
export function getWord(b: Uint8Array, ofs: number): number {
  return b[ofs] | (b[ofs + 1] << 8);
}
export function setWord(b: Uint8Array, ofs: number, v: number): void {
  b[ofs] = v & 0xff;
  b[ofs + 1] = (v >> 8) & 0xff;
}
export function getInteger(b: Uint8Array, ofs: number): number {
  return int16(getWord(b, ofs));
}
export function setInteger(b: Uint8Array, ofs: number, v: number): void {
  setWord(b, ofs, v);
}
export function getLongint(b: Uint8Array, ofs: number): number {
  return (b[ofs] | (b[ofs + 1] << 8) | (b[ofs + 2] << 16) | (b[ofs + 3] << 24)) | 0;
}
export function setLongint(b: Uint8Array, ofs: number, v: number): void {
  b[ofs] = v & 0xff;
  b[ofs + 1] = (v >> 8) & 0xff;
  b[ofs + 2] = (v >> 16) & 0xff;
  b[ofs + 3] = (v >> 24) & 0xff;
}

// ---------------------------------------------------------------- Str / Val

/** Decimal digits of |r| at `sig` significant digits: value = 0.digits * 10^exp. */
function decDigits(r: number, sig = 15): { digits: string; exp: number } {
  if (r === 0) return { digits: '', exp: 0 };
  const [m, e] = Math.abs(r).toExponential(sig - 1).split('e');
  return { digits: m.replace('.', '').replace(/0+$/, ''), exp: Number(e) + 1 };
}

/** Round a digit string to n digits (half away from zero); returns digits and exp carry. */
function roundDigits(digits: string, n: number): { digits: string; carry: boolean } {
  if (n < 0) return { digits: '', carry: false };
  if (digits.length <= n) return { digits, carry: false };
  const up = digits.charCodeAt(n) >= 0x35;
  let d = digits.slice(0, n);
  if (!up) return { digits: d, carry: false };
  const a = d.split('').map(Number);
  let i = a.length - 1;
  while (i >= 0 && a[i] === 9) a[i--] = 0;
  if (i < 0) return { digits: '1' + a.join(''), carry: true };
  a[i]++;
  d = a.join('');
  return { digits: d, carry: false };
}

function padLeft(s: string, w: number): string {
  return s.length < w ? ' '.repeat(w - s.length) + s : s;
}

/** Str(i:w) for integer types. */
export function StrI(i: number, w = 0): string {
  return padLeft(String(Math.trunc(i)), w);
}

/**
 * Str(r:w:d) for reals with BP7 Real48 layout (w/d = -1 when omitted):
 * no d -> scientific ' 1.2345000000E+02' (width 17 by default, clamp(w-7,1,10) decimals);
 * d >= 0 -> fixed point, rounded half away from zero on 15 significant digits.
 */
export function StrR(r: number, w = -1, d = -1): string {
  const neg = r < 0 || Object.is(r, -0);
  if (d < 0) {
    const dec = w < 0 ? 10 : Math.max(1, Math.min(10, w - 7));
    let { digits, exp } = decDigits(r);
    if (digits === '') {
      return padLeft(' 0.' + '0'.repeat(dec) + 'E+00', w);
    }
    const rd = roundDigits(digits, dec + 1);
    digits = rd.digits.padEnd(dec + 1, '0');
    if (rd.carry) {
      exp++;
      digits = digits.slice(0, dec + 1);
    }
    const e = exp - 1;
    const es = (e < 0 ? '-' : '+') + String(Math.abs(e)).padStart(2, '0');
    return padLeft((neg && r !== 0 ? '-' : ' ') + digits[0] + '.' + digits.slice(1) + 'E' + es, w);
  }
  let { digits, exp } = decDigits(r);
  let intPart: string;
  let fracPart: string;
  if (digits === '') {
    intPart = '0';
    fracPart = '0'.repeat(d);
  } else {
    // number of digits kept = digits before the point (exp) + d
    const keep = exp + d;
    if (keep < 0) {
      digits = '';
    } else {
      const rd = roundDigits(digits, keep);
      digits = rd.digits;
      if (rd.carry) exp++;
    }
    const all = digits.padEnd(Math.max(exp + d, 0), '0');
    if (exp > 0) {
      intPart = all.slice(0, exp).padEnd(exp, '0');
      fracPart = all.slice(exp, exp + d).padEnd(d, '0');
    } else {
      intPart = '0';
      fracPart = ('0'.repeat(-exp) + all).slice(0, d).padEnd(d, '0');
    }
  }
  const s = (neg ? '-' : '') + intPart + (d > 0 ? '.' + fracPart : '');
  return padLeft(s, w);
}

function skipBlanks(s: string): number {
  let i = 0;
  while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
  return i;
}

/**
 * Val(S, V, Code) into a longint: leading blanks, sign, decimal or '$' hex.
 * Code = 1-based position of the first bad char, 0 on success.
 */
export function ValI(s: string, v: Ref<number>, code: Ref<number>): void {
  let i = skipBlanks(s);
  let neg = false;
  if (s[i] === '+' || s[i] === '-') neg = s[i++] === '-';
  let n = 0;
  let hex = false;
  if (s[i] === '$') {
    hex = true;
    i++;
  }
  const start = i;
  for (; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let dv: number;
    if (c >= 0x30 && c <= 0x39) dv = c - 0x30;
    else if (hex && c >= 0x41 && c <= 0x46) dv = c - 0x37;
    else if (hex && c >= 0x61 && c <= 0x66) dv = c - 0x57;
    else break;
    n = n * (hex ? 16 : 10) + dv;
    if (!hex && n > 2147483648) {
      v.v = 0;
      code.v = i + 1;
      return;
    }
  }
  if (i === start || i < s.length) {
    v.v = 0;
    code.v = i + 1;
    return;
  }
  if (hex) n = n | 0;
  else if (!neg && n > 2147483647) {
    v.v = 0;
    code.v = i;
    return;
  }
  v.v = neg ? -n : n;
  code.v = 0;
}

/** Val(S, V, Code) into a real: [blanks][sign]digits[.digits][E[sign]digits]. */
export function ValR(s: string, v: Ref<number>, code: Ref<number>): void {
  let i = skipBlanks(s);
  const b = i;
  if (s[i] === '+' || s[i] === '-') i++;
  let nd = 0;
  while (i < s.length && s[i] >= '0' && s[i] <= '9') i++, nd++;
  if (s[i] === '.') {
    i++;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') i++, nd++;
  }
  if (nd === 0) {
    v.v = 0;
    code.v = i + 1;
    return;
  }
  if (s[i] === 'e' || s[i] === 'E') {
    i++;
    if (s[i] === '+' || s[i] === '-') i++;
    const e0 = i;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') i++;
    if (i === e0) {
      v.v = 0;
      code.v = i + 1;
      return;
    }
  }
  if (i < s.length) {
    v.v = 0;
    code.v = i + 1;
    return;
  }
  v.v = Number(s.slice(b, i));
  code.v = 0;
}

// ---------------------------------------------------------------- DOS unit

/** FPC's DirectorySeparator: the host separator, or '\\' in the DOS view (HANDLE DosView, fand.ts
 *  main); a live binding, set with SetDirectorySeparator. */
export let DirectorySeparator: string = sep;
/** TS-only: switch DirectorySeparator (fand.ts main turns the DOS view on or off). */
export function SetDirectorySeparator(s: string): void {
  DirectorySeparator = s;
}

/** Clock used by GetDate/GetTime; tests replace `Clock.now`. */
export const Clock = { now: (): Date => new Date() };

/** DOS.GetDate(var Year, Month, Day, DayOfWeek). */
export function GetDate(year: Ref<number>, month: Ref<number>, day: Ref<number>, dayOfWeek: Ref<number>): void {
  const d = Clock.now();
  year.v = d.getFullYear();
  month.v = d.getMonth() + 1;
  day.v = d.getDate();
  dayOfWeek.v = d.getDay();
}

/** DOS.GetTime(var Hour, Minute, Second, Sec100). */
export function GetTime(hour: Ref<number>, minute: Ref<number>, second: Ref<number>, sec100: Ref<number>): void {
  const d = Clock.now();
  hour.v = d.getHours();
  minute.v = d.getMinutes();
  second.v = d.getSeconds();
  sec100.v = Math.floor(d.getMilliseconds() / 10);
}

/** DOS.GetEnv as a byte string ('' when unset). */
export function GetEnv(name: string): string {
  return FromUnicode(process.env[ToUnicode(name)] ?? '');
}

// TS-only: the command line of the FAND program (ParamStr(1..ParamCount)), set by fand.ts FandMain.
let ProgramArgs: string[] = [];

/** TS-only: set the program arguments (byte strings, without the program name). */
export function SetParams(args: string[]): void {
  ProgramArgs = [...args];
}

/** System.ParamStr – '' beyond ParamCount; ParamStr(0) is the program name. */
export function ParamStr(i: number): string {
  if (i === 0) return 'FAND';
  return ProgramArgs[i - 1] ?? '';
}

/** System.ParamCount */
export function ParamCount(): number {
  return ProgramArgs.length;
}

/** DOS.FSplit(Path, var Dir, Name, Ext) – accepts both '\' and the host separator. */
export function FSplit(path: string, dir: Ref<string>, name: Ref<string>, ext: Ref<string>): void {
  let i = path.length;
  while (i > 0 && path[i - 1] !== '\\' && path[i - 1] !== '/' && path[i - 1] !== ':') i--;
  dir.v = path.slice(0, i);
  const rest = path.slice(i);
  const dot = rest.lastIndexOf('.');
  if (dot >= 0) {
    name.v = rest.slice(0, dot);
    ext.v = rest.slice(dot);
  } else {
    name.v = rest;
    ext.v = '';
  }
}

/** DOS path string types (byte strings). */
export type PathStr = string;
export type DirStr = string;
export type NameStr = string;
export type ExtStr = string;

// ---------------------------------------------------------------- text files

export const fmClosed = 0xd7b0;
export const fmInput = 0xd7b1;
export const fmOutput = 0xd7b2;
export const fmInOut = 0xd7b3;

/** TextRec driver function (OpenFunc/InOutFunc/FlushFunc/CloseFunc): returns 0 or an IO error code. */
export type TextFunc = (F: TextFile) => number;

/**
 * Pascal `text` variable (TextRec). The unit that owns the file installs the TextRec drivers
 * (DRIVERS AssignCrt for the screen, OBASE ResetTxt/RewriteTxt for files and LPT1); the
 * System routines TxtReset/TxtRewrite/TxtWrite/TxtReadln/TxtClose... below call them as TP does.
 */
export class TextFile {
  Name = '';
  Mode = fmClosed;
  /** host fd, or -1; -2 = the CRT (AssignCrt); a FAND handle for OBASE text files */
  Handle = -1;
  /** the TextRec buffer (byte string): pending output, or the input InOutFunc read */
  Buf = '';
  /** output: Buf.length (chars pending); input: index of the next char of Buf (0-based) */
  BufPos = 0;
  /** input: number of valid chars in Buf */
  BufEnd = 0;
  BufSize = 128;
  LineEnd = '\r\n';
  OpenFunc: TextFunc | null = null;
  InOutFunc: TextFunc | null = null;
  FlushFunc: TextFunc | null = null;
  CloseFunc: TextFunc | null = null;
}

/** System.Output (DRIVERS AssignCrt(Output) + TxtRewrite(Output) route it to the screen). */
export const Output = new TextFile();

function TxtIOCheck(res: number): void {
  if (res !== 0) SysRunError(res); // {$I+}: an IO error is a runtime error
}

/** System.Assign(F, Name) for a text file: closed, no drivers yet (the owner sets OpenFunc). */
export function TxtAssign(F: TextFile, Name: string): void {
  F.Name = Name;
  F.Mode = fmClosed;
  F.Buf = '';
  F.BufPos = 0;
  F.BufEnd = 0;
  F.BufSize = 128;
  F.LineEnd = '\r\n';
  F.OpenFunc = null;
  F.InOutFunc = null;
  F.FlushFunc = null;
  F.CloseFunc = null;
}

function TxtOpen(F: TextFile, Mode: number): void {
  if (F.Mode === fmInput || F.Mode === fmOutput) TxtClose(F);
  else if (F.Mode !== fmClosed) SysRunError(102); // file not assigned
  F.Mode = Mode;
  F.Buf = '';
  F.BufPos = 0;
  F.BufEnd = 0;
  if (!F.OpenFunc) {
    F.Mode = fmClosed;
    SysRunError(2);
  }
  const res = F.OpenFunc(F);
  if (res !== 0) {
    F.Mode = fmClosed;
    SysRunError(res);
  }
  if (Mode === fmInOut) F.Mode = fmOutput; // Append
}

/** System.Reset(F) */
export function TxtReset(F: TextFile): void {
  TxtOpen(F, fmInput);
}
/** System.Rewrite(F) */
export function TxtRewrite(F: TextFile): void {
  TxtOpen(F, fmOutput);
}
/** System.Append(F) (the driver's OpenFunc sees Mode = fmInOut) */
export function TxtAppend(F: TextFile): void {
  TxtOpen(F, fmInOut);
}

/** System.Write(F, s1, s2, ...) with byte strings (format numbers with StrI/StrR first). */
export function TxtWrite(F: TextFile, ...S: string[]): void {
  if (F.Mode !== fmOutput) SysRunError(F.Mode === fmInput ? 105 : 103);
  for (const s of S) {
    for (let i = 0; i < s.length; ) {
      const n = Math.min(s.length - i, F.BufSize - F.Buf.length);
      F.Buf += s.substr(i, n);
      F.BufPos = F.Buf.length;
      i += n;
      if (F.Buf.length >= F.BufSize) TxtIOCheck(F.InOutFunc ? F.InOutFunc(F) : 0);
    }
  }
  if (F.FlushFunc) TxtIOCheck(F.FlushFunc(F));
}
/** System.Writeln(F, s1, ...) */
export function TxtWriteln(F: TextFile, ...S: string[]): void {
  TxtWrite(F, ...S, F.LineEnd);
}

function TxtFill(F: TextFile): boolean {
  if (F.BufPos < F.BufEnd) return true;
  TxtIOCheck(F.InOutFunc ? F.InOutFunc(F) : 0);
  return F.BufPos < F.BufEnd;
}

/** System.Eof(F) for text: end of the data or a ^Z. */
export function TxtEof(F: TextFile): boolean {
  if (F.Mode !== fmInput) SysRunError(F.Mode === fmOutput ? 104 : 103);
  if (!TxtFill(F)) return true;
  return F.Buf.charCodeAt(F.BufPos) === 0x1a;
}
/** System.Eoln(F) */
export function TxtEoln(F: TextFile): boolean {
  if (TxtEof(F)) return true;
  const c = F.Buf.charCodeAt(F.BufPos);
  return c === 0x0d || c === 0x0a;
}
/** System.Read(F, C: char) – #26 at the end of the file. */
export function TxtReadChar(F: TextFile): string {
  if (F.Mode !== fmInput) SysRunError(F.Mode === fmOutput ? 104 : 103);
  if (!TxtFill(F)) return '\x1a';
  return F.Buf[F.BufPos++];
}
/** System.Readln(F, S) into a string[Max]: the line up to CR/^Z (truncated), then skips past the LF. */
export function TxtReadln(F: TextFile, Max = 255): string {
  if (F.Mode !== fmInput) SysRunError(F.Mode === fmOutput ? 104 : 103);
  let s = '';
  for (;;) {
    if (!TxtFill(F)) return s;
    const c = F.Buf.charCodeAt(F.BufPos);
    if (c === 0x1a) return s;
    if (c === 0x0d) break;
    if (c === 0x0a) break; // a bare LF also ends a line (as FPC; Unix text files)
    if (s.length < Max) s += F.Buf[F.BufPos];
    F.BufPos++;
  }
  // skip the rest of the line: CR, then LF
  if (F.Buf.charCodeAt(F.BufPos) === 0x0d) {
    F.BufPos++;
    if (TxtFill(F) && F.Buf.charCodeAt(F.BufPos) === 0x0a) F.BufPos++;
  } else F.BufPos++;
  return s;
}
/** System.Flush(F) */
export function TxtFlush(F: TextFile): void {
  if (F.Mode !== fmOutput) SysRunError(F.Mode === fmInput ? 105 : 103);
  if (F.InOutFunc) TxtIOCheck(F.InOutFunc(F));
}
/** System.Close(F): flushes output, then the driver's CloseFunc. */
export function TxtClose(F: TextFile): void {
  if (F.Mode !== fmInput && F.Mode !== fmOutput) SysRunError(103);
  if (F.Mode === fmOutput && F.Buf.length > 0 && F.InOutFunc) TxtIOCheck(F.InOutFunc(F));
  const res = F.CloseFunc ? F.CloseFunc(F) : 0;
  F.Mode = fmClosed;
  F.Buf = '';
  F.BufPos = 0;
  F.BufEnd = 0;
  TxtIOCheck(res);
}

// ---------------------------------------------------------------- variant records

/**
 * Zero-initialise a class through its prototype, the way GetZStore did: every field of every
 * variant reads as its zero value until assigned, but instances only store assigned fields.
 * A function value is a per-instance lazy initialiser (embedded records and arrays).
 */
export function defineDefaults(cls: { prototype: object }, defaults: Record<string, unknown>): void {
  for (const [k, v] of Object.entries(defaults)) {
    if (typeof v === 'function') {
      const init = v as () => unknown;
      Object.defineProperty(cls.prototype, k, {
        configurable: true,
        get(this: object) {
          const val = init();
          Object.defineProperty(this, k, { value: val, writable: true, enumerable: true, configurable: true });
          return val;
        },
        set(this: object, val: unknown) {
          Object.defineProperty(this, k, { value: val, writable: true, enumerable: true, configurable: true });
        },
      });
    } else {
      Object.defineProperty(cls.prototype, k, { value: v, writable: true, enumerable: false, configurable: true });
    }
  }
}

/** Variant fields of the same type at the same offset: `alias` reads/writes `target`. */
export function defineAliases(cls: { prototype: object }, aliases: Record<string, string>): void {
  for (const [alias, target] of Object.entries(aliases)) {
    Object.defineProperty(cls.prototype, alias, {
      configurable: true,
      get(this: Record<string, unknown>) {
        return this[target];
      },
      set(this: Record<string, unknown>, val: unknown) {
        this[target] = val;
      },
    });
  }
}

// ---------------------------------------------------------------- record assignment

/**
 * Pascal record assignment `A := B` copies the value; objects are references. CopyRec makes a
 * shallow copy with the same class (prototype defaults stay shared); embedded records that must
 * not be shared are copied by the caller.
 */
export function CopyRec<T extends object>(src: T): T {
  return Object.assign(Object.create(Object.getPrototypeOf(src)) as T, src);
}

/** `Dst := Src` into an existing record object (e.g. an embedded record or a var parameter). */
export function AssignRec<T extends object>(dst: T, src: T): void {
  // fields left at their prototype default in src must read as default in dst too
  for (const k of Object.keys(dst)) if (!Object.prototype.hasOwnProperty.call(src, k)) delete (dst as Record<string, unknown>)[k];
  Object.assign(dst, src);
}
