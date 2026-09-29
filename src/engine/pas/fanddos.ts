// PAS: FANDDOS.PAS (FPC-only unit) – DOS commands and .BAT files interpreted in-process.
//
// Porting notes:
// * Replaces the COMMAND.COM that FAND's EXEC/OSshell would start: FandDosCmd handles built-ins
//   (VER, SET, MD, RD, DEL, COPY, REN/MOVE, TYPE, ECHO, CLS; CD, PATH, MODE, DIR... are no-ops),
//   'x.BAT' (RunBat: labels, GOTO, IF [NOT] EXIST / a==b, %1..%9, max 400 lines), '>' / '>>'
//   redirection (NUL ignored), otherwise asks FandDosExtra (Účto's .EXE helpers, see RUNBATCH)
//   and finally FandDosShell. Output without redirection is written to stdout (FPC `write`).
// * OS specifics: FandFileTime uses libc localtime_r (UNIX) -> use JS Date in local time.
//   File enumeration uses SysUtils FindFirst with FandMaskMatch (DOS '*'/'?', case-insensitive);
//   FandSlashed maps '\' to the host separator. All strings are byte strings; convert with
//   pasrt ToUnicode/FromUnicode at the node:fs boundary (as HANDLE does).
// * Private state: gText (collected output), gTotal, gNewest, gFound, gCount, gDest (ForEachFile
//   accumulators). Interface state: FandDosShell, FandDosExtra, FandDosNotice -> FandDosVars.
// * Tricky: GOTO restarts the scan at line 1 and skips until the label; IF compares raw tokens
//   ('a==b' must be one token); '$' as the first argument is dropped; FandStamp formats a
//   Unix time stamp as 'dd.mm.yyyy hh:mm'.
//
// Deliberate fixes against the FPC unit (docs/helpers/bat-files.md), each marked `fix:`:
// * the tokenizer honours double quotes (`copy "C:\Moje doklady\f.pdf" "..."`); batch arguments
//   keep their quotes (%1 = "a b", as COMMAND.COM/CMD), built-ins strip them;
// * redirection: the last '>' outside quotes; NUL, NUL:, NULL and /dev/null discard the output;
// * command paths go through HANDLE.UnixPath (drive letters, '\', case-insensitive components)
//   instead of FPC's Slashed; the exported FandSlashed keeps the FPC meaning;
// * `ver` prints `Microsoft Windows [Version 10.0]` (FPC: MS-DOS 6.22, which makes Účto's DosWin
//   believe it runs under pure DOS); `set` lists a virtual environment (FandDosVars.FandDosEnv),
//   never the host one;
// * `IF [NOT] EXIST dir\`, `dir\*.*`, `dir\NUL` are true for an existing (even empty) directory;
//   4DOS `IF [NOT] ISDIR dir`; `IF ERRORLEVEL n`; `IF "a" == "b"` with blanks; `CALL x.bat`;
// * `COPY src dir\*.EX` renames by the DOS wildcard rules (UCTOOL.EXE -> UCTOOL.EX); `COPY a+b c`
//   concatenates; switches (/Y /B /A /V) are ignored; `REN a name` renames inside a's directory;
// * `CMD /C line`, `COMMAND /C line` and a leading '@' run the line itself;
// * more accepted no-ops (KB16, USE, ALIAS, VERIFY, LOADHIGH/LH ...);
// * writes can be confined to writable roots (FandDosVars.FandDosWritable): a refused write
//   fails with exit code 1 and a line in FandDosNotice;
// * output without redirection goes to FandDosVars.FandDosWrite (TS hook; default: dropped,
//   there is no DOS console under the FAND screen).
//
// Helper registry (TS-only): registerHelper(name, fn) dispatches `NAME.EXE args` (in a batch or
// from EXEC) to a TypeScript replacement before FandDosExtra is asked. After both, the built-in
// ports of Účto's DOS utilities (FILESIZE, SUBDIR, DISKSIZE, SETDATE, ISSHARE; see DosToolOf at
// the end) answer; without them EXEC hands these MZ programs to the host shell ('not found').

import * as fs from 'node:fs';
import { ToUnicode, FromUnicode, GetEnv, DirectorySeparator, Clock, ValI, ShortStr, int32, type Ref } from './pasrt.ts';
import { UnixPath } from './base.ts';

// PAS: FANDDOS.PAS TShellRun
export type TShellRun = ((cmd: string) => number) | null;
/** PAS: FANDDOS.PAS TArgs = array[1..16] of ansistring (index 0 unused) */
export type TArgs = string[];
// PAS: FANDDOS.PAS TDosExtra – Av is modified in place
export type TDosExtra =
  | ((Nm: string, Ext: string, Dir: string, Av: TArgs, nAv: number, ExitCode: Ref<number>) => boolean)
  | null;
/** TS-only: a registered helper replacement (same contract as TDosExtra; true = handled). */
export type TDosHelper = (Nm: string, Ext: string, Dir: string, Av: TArgs, nAv: number, ExitCode: Ref<number>) => boolean;

export const FandDosVars = {
  FandDosShell: null as TShellRun,
  FandDosExtra: null as TDosExtra,
  FandDosNotice: '',
  /** TS-only: the environment `set` prints (null = DefaultDosEnv()) */
  FandDosEnv: null as string[] | null,
  /** TS-only: may the shell write/delete this host path? (null = everything is writable) */
  FandDosWritable: null as ((HostPath: string) => boolean) | null,
  /** TS-only: sink for output without redirection (FPC: stdout); null = dropped */
  FandDosWrite: null as ((S: string) => void) | null,
};

// ---------------------------------------------------------------- helper registry (TS-only)

const Helpers = new Map<string, TDosHelper>();

/**
 * TS-only: register (fn) or remove (null) the replacement of a helper program. `name` is a
 * program name with or without an extension ('UCTOOL.EXE', 'subdir'); any directory is ignored,
 * case does not matter. A name without an extension matches every extension.
 */
export function registerHelper(name: string, fn: TDosHelper | null): void {
  const key = UpStr(NamePart(name));
  if (fn === null) Helpers.delete(key);
  else Helpers.set(key, fn);
}
/** TS-only: the registered helper of NM(.EXT), or undefined */
export function helperOf(Nm: string, Ext: string): TDosHelper | undefined {
  const nm = UpStr(Nm);
  const ext = UpStr(Ext);
  return (ext !== '' ? Helpers.get(nm + '.' + ext) : undefined) ?? Helpers.get(nm);
}
/** TS-only: remove all registered helpers (tests) */
export function clearHelpers(): void {
  Helpers.clear();
}
// TS-only: the registry first, then FandDosExtra (the FPC hook), then the built-in ports of Účto's
// DOS utilities (DosToolOf). The FPC unit only has the hook, which nobody sets, so the reference
// hands FILESIZE.EXE & co. to /bin/sh ('not found').
function DosExtra(Nm: string, Ext: string, Dir: string, Av: TArgs, nAv: number, ExitCode: Ref<number>): boolean {
  const h = helperOf(Nm, Ext);
  if (h !== undefined && h(Nm, Ext, Dir, Av, nAv, ExitCode)) return true;
  const x = FandDosVars.FandDosExtra;
  if (x !== null && x(Nm, Ext, Dir, Av, nAv, ExitCode)) return true;
  const t = DosToolOf(Nm, Ext);
  if (t !== undefined) return t(Nm, Ext, Dir, Av, nAv, ExitCode);
  return false;
}

// ---------------------------------------------------------------- time

// PAS: FANDDOS.PAS FandFileTime – Unix time stamp -> local date/time
export function FandFileTime(
  Stamp: number,
  y: Ref<number>, mo: Ref<number>, d: Ref<number>, hh: Ref<number>, mi: Ref<number>, ss: Ref<number>,
): void {
  const t = new Date(Stamp * 1000);
  if (Number.isNaN(t.getTime())) {
    y.v = 1980;
    mo.v = 1;
    d.v = 1;
    hh.v = 0;
    mi.v = 0;
    ss.v = 0;
    return;
  }
  y.v = t.getFullYear();
  mo.v = t.getMonth() + 1;
  d.v = t.getDate();
  hh.v = t.getHours();
  mi.v = t.getMinutes();
  ss.v = t.getSeconds();
}

const CRLF = '\r\n';
const acSize = 1;
const acListPath = 2;
const acListName = 3;
const acDelete = 4;
const acCopy = 5;

let gText = '';
let gTotal = 0;
let gNewest = 0;
let gFound = false;
let gCount = 0;
let gDest = '';

// PAS: FANDDOS.PAS UpStr (private) – ASCII a..z only
function UpStr(s: string): string {
  return s.replace(/[a-z]+/g, (m) => m.toUpperCase());
}
// PAS: FANDDOS.PAS Trim2 (private) – blanks and tabs
function Trim2(s: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && (s[a] === ' ' || s[a] === '\t')) a++;
  while (b > a && (s[b - 1] === ' ' || s[b - 1] === '\t')) b--;
  return s.slice(a, b);
}
// PAS: FANDDOS.PAS IntStr (private)
function IntStr(v: number): string {
  return String(Math.trunc(v));
}
// PAS: FANDDOS.PAS Pad0 (private)
function Pad0(v: number, w: number): string {
  let s = IntStr(v);
  while (s.length < w) s = '0' + s;
  return s;
}
// PAS: FANDDOS.PAS AddLine (private)
function AddLine(s: string): void {
  gText = gText + s + CRLF;
}
// PAS: FANDDOS.PAS MaskMatch (private) – '*' and '?', case-insensitive (ASCII)
function MaskMatch(nm: string, mk: string): boolean {
  const up = (c: string): string => (c >= 'a' && c <= 'z' ? c.toUpperCase() : c);
  let i = 1;
  let j = 1;
  let si = 0;
  let sj = 0;
  while (i <= nm.length) {
    if (j <= mk.length && (mk[j - 1] === '?' || up(mk[j - 1]) === up(nm[i - 1]))) {
      i++;
      j++;
    } else if (j <= mk.length && mk[j - 1] === '*') {
      si = i;
      sj = j;
      j++;
    } else if (sj > 0) {
      si++;
      i = si;
      j = sj + 1;
    } else return false;
  }
  while (j <= mk.length && mk[j - 1] === '*') j++;
  return j > mk.length;
}
// PAS: FANDDOS.PAS DirPart (private) – up to and including the last '/' or '\'
function DirPart(p: string): string {
  for (let i = p.length; i >= 1; i--) if (p[i - 1] === '/' || p[i - 1] === '\\') return p.slice(0, i);
  return '';
}
// PAS: FANDDOS.PAS NamePart (private)
function NamePart(p: string): string {
  return p.slice(DirPart(p).length);
}
// PAS: FANDDOS.PAS Slashed (private)
function Slashed(p: string): string {
  return p.replace(/[\\/]/g, DirectorySeparator);
}
// PAS: FANDDOS.PAS WithSlash (private)
function WithSlash(p: string): string {
  if (p !== '' && p[p.length - 1] !== DirectorySeparator) return p + DirectorySeparator;
  return p;
}
// TS-only (fix): a DOS path of a command line -> host path (UnixPath keeps a trailing separator)
function HostPath(p: string): string {
  if (p === '') return '';
  return UnixPath(p);
}
// TS-only: is this host path writable for the shell (FandDosWritable)?
function CanWrite(p: string): boolean {
  const w = FandDosVars.FandDosWritable;
  if (w === null || w(p)) return true;
  FandDosVars.FandDosNotice += 'FANDDOS: write refused: ' + p + CRLF;
  return false;
}
// TS-only: host stat helpers (FPC FileExists/DirectoryExists)
function HostStat(p: string): fs.Stats | null {
  try {
    return fs.statSync(ToUnicode(p));
  } catch {
    return null;
  }
}
function FileExists(p: string): boolean {
  const st = HostStat(p);
  return st !== null && !st.isDirectory();
}
function DirectoryExists(p: string): boolean {
  if (p === '') return false;
  const st = HostStat(p);
  return st !== null && st.isDirectory();
}
// PAS: FANDDOS.PAS ReadWhole (private) – '' when missing
function ReadWhole(nm: string): string {
  if (nm === '') return '';
  try {
    const b = fs.readFileSync(ToUnicode(nm));
    let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
    return s;
  } catch {
    return '';
  }
}
// PAS: FANDDOS.PAS WriteWhole (private)
function WriteWhole(nm: string, data: string, append: boolean): boolean {
  if (nm === '') return false;
  if (!CanWrite(nm)) return false;
  const b = Uint8Array.from(data, (c) => c.charCodeAt(0) & 0xff);
  try {
    if (append) fs.appendFileSync(ToUnicode(nm), b);
    else fs.writeFileSync(ToUnicode(nm), b);
    return true;
  } catch {
    return false;
  }
}
// PAS: FANDDOS.PAS CopyOne (private)
function CopyOne(src: string, dst: string): boolean {
  // FPC copies ReadWhole(src) even when src is missing (an empty file); a missing source fails in DOS
  if (!FileExists(src)) return false;
  return WriteWhole(dst, ReadWhole(src), false);
}
// PAS: FANDDOS.PAS IsNul (private); fix: `>null` (UCTOBAT2.BAT) discards too
function IsNul(nm: string): boolean {
  const u = UpStr(nm);
  return u === 'NUL' || u === 'NUL:' || u === '/DEV/NULL' || u === 'NULL';
}
// TS-only: FPC FindFirst(dir+'*', faAnyFile) .. FindNext – entries of a host directory
interface SearchRec {
  Name: string;
  IsDir: boolean;
  Size: number;
  Time: number; // Unix time stamp (FPC on UNIX)
}
function ListDir(dir: string): SearchRec[] | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir === '' ? '.' : ToUnicode(dir));
  } catch {
    return null;
  }
  const res: SearchRec[] = [];
  for (const n of names) {
    const Name = FromUnicode(n);
    const st = HostStat(dir + Name);
    if (st === null) continue;
    res.push({ Name, IsDir: st.isDirectory(), Size: st.size, Time: Math.trunc(st.mtimeMs / 1000) });
  }
  return res;
}
// TS-only (fix): DOS wildcard rename – name/ext templates with '*' and '?' applied to Src
function DosWildName(Src: string, Tmpl: string): string {
  const split = (s: string): [string, string] => {
    const p = s.lastIndexOf('.');
    return p < 0 ? [s, ''] : [s.slice(0, p), s.slice(p + 1)];
  };
  const part = (s: string, t: string): string => {
    let r = '';
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '*') return r + s.slice(i);
      if (t[i] === '?') r += i < s.length ? s[i] : '';
      else r += t[i];
    }
    return r;
  };
  const [sn, se] = split(Src);
  const [tn, te] = split(Tmpl);
  const n = part(sn, tn);
  const e = Tmpl.includes('.') ? part(se, te) : '';
  return e === '' ? n : n + '.' + e;
}
// TS-only: does a name contain DOS wildcards?
function HasWild(s: string): boolean {
  return s.includes('*') || s.includes('?');
}
// PAS: FANDDOS.PAS ForEachFile (private)
function ForEachFile(pattern: string, wantDir: boolean, act: number): void {
  let dir = DirPart(pattern);
  let mk = NamePart(pattern);
  if (mk === '') mk = '*';
  const every = mk === '*.*';
  if (dir === '') dir = '.' + DirectorySeparator;
  const list = ListDir(dir);
  if (list === null) return;
  for (const sr of list) {
    if (sr.Name === '.' || sr.Name === '..') continue;
    if (sr.IsDir !== wantDir) continue;
    if (!(every || MaskMatch(sr.Name, mk))) continue;
    const full = dir + sr.Name;
    switch (act) {
      case acSize:
        if (!gFound) {
          gFound = true;
          gTotal = 0;
        }
        gTotal += sr.Size;
        if (sr.Time > gNewest) gNewest = sr.Time;
        break;
      case acListPath:
        AddLine(full);
        break;
      case acListName:
        AddLine(sr.Name);
        break;
      case acDelete:
        if (CanWrite(full)) {
          try {
            fs.unlinkSync(ToUnicode(full));
          } catch {
            // SysUtils.DeleteFile result ignored
          }
        }
        break;
      case acCopy:
        // fix: a wildcard target name (gDest = 'dir/*.EX') renames by the DOS rules
        if (HasWild(NamePart(gDest))) {
          if (CopyOne(full, DirPart(gDest) + DosWildName(sr.Name, NamePart(gDest)))) gCount++;
        } else if (CopyOne(full, WithSlash(gDest) + sr.Name)) gCount++;
        break;
    }
  }
}
// PAS: FANDDOS.PAS SearchDown (private)
function SearchDown(dir: string, mk: string, depth: number): void {
  if (depth < 0) return;
  const list = ListDir(dir);
  if (list === null) return;
  for (const sr of list) {
    if (sr.Name === '.' || sr.Name === '..') continue;
    if (sr.IsDir) SearchDown(WithSlash(dir + sr.Name), mk, depth - 1);
    else if (MaskMatch(sr.Name, mk)) AddLine(dir + sr.Name);
  }
}
// PAS: FANDDOS.PAS StampOf (private)
function StampOf(t: number): string {
  const y = { v: 0 }, m = { v: 0 }, d = { v: 0 }, hh = { v: 0 }, mm = { v: 0 }, ss = { v: 0 };
  FandFileTime(t, y, m, d, hh, mm, ss);
  return Pad0(d.v, 2) + '.' + Pad0(m.v, 2) + '.' + Pad0(y.v, 4) + ' ' + Pad0(hh.v, 2) + ':' + Pad0(mm.v, 2);
}
// PAS: FANDDOS.PAS SortText (private) – insertion sort of the gText lines (max 512), ASCII upper case
function SortText(): void {
  const l: string[] = [];
  let s = gText;
  while (s !== '' && l.length < 512) {
    const p = s.indexOf(CRLF);
    if (p < 0) {
      l.push(s);
      s = '';
    } else {
      l.push(s.slice(0, p));
      s = s.slice(p + 2);
    }
  }
  for (let i = 1; i < l.length; i++) {
    const t = l[i];
    let j = i - 1;
    while (j >= 0 && UpStr(l[j]) > UpStr(t)) {
      l[j + 1] = l[j];
      j--;
    }
    l[j + 1] = t;
  }
  gText = '';
  for (const x of l) gText = gText + x + CRLF;
}

// PAS: FANDDOS.PAS FandMaskMatch
export function FandMaskMatch(Nm: string, Mask: string): boolean {
  return MaskMatch(Nm, Mask);
}
// PAS: FANDDOS.PAS FandSlashed – '\' and '/' -> DirectorySeparator
export function FandSlashed(P: string): string {
  return Slashed(P);
}
// PAS: FANDDOS.PAS FandWithSlash – appends DirectorySeparator unless empty or present
export function FandWithSlash(P: string): string {
  return WithSlash(P);
}
// PAS: FANDDOS.PAS FandDirPart – up to and including the last '/' or '\'
export function FandDirPart(P: string): string {
  return DirPart(P);
}
// PAS: FANDDOS.PAS FandNamePart
export function FandNamePart(P: string): string {
  return NamePart(P);
}
// PAS: FANDDOS.PAS FandUpStr – ASCII a..z only
export function FandUpStr(S: string): string {
  return UpStr(S);
}
// PAS: FANDDOS.PAS FandIntStr
export function FandIntStr(V: number): string {
  return IntStr(V);
}
// PAS: FANDDOS.PAS FandReadWhole – '' when missing
export function FandReadWhole(Nm: string): string {
  return ReadWhole(Nm);
}
// PAS: FANDDOS.PAS FandWriteWhole
export function FandWriteWhole(Nm: string, Data: string, Append: boolean): boolean {
  return WriteWhole(Nm, Data, Append);
}
// PAS: FANDDOS.PAS FandListFiles – CR LF separated, sorted
export function FandListFiles(Pattern: string, DirsOnly: boolean, FullPath: boolean): string {
  gText = '';
  const act = FullPath ? acListPath : acListName;
  ForEachFile(Pattern, DirsOnly, act);
  SortText();
  const r = gText;
  gText = '';
  return r;
}
// PAS: FANDDOS.PAS FandTotalSize – false when nothing matched
export function FandTotalSize(Pattern: string, Total: Ref<number>, Newest: Ref<number>): boolean {
  gFound = false;
  gTotal = 0;
  gNewest = 0;
  ForEachFile(Pattern, false, acSize);
  Total.v = gTotal;
  Newest.v = gNewest;
  return gFound;
}
// PAS: FANDDOS.PAS FandDeleteFiles
export function FandDeleteFiles(Pattern: string): void {
  ForEachFile(Pattern, false, acDelete);
}
// PAS: FANDDOS.PAS FandSearchDown – first match of Mask below Dir (Depth levels), '' if none
export function FandSearchDown(Dir: string, Mask: string, Depth: number): string {
  gText = '';
  SearchDown(Dir, Mask, Depth);
  SortText();
  const r = gText;
  gText = '';
  return r;
}
// PAS: FANDDOS.PAS FandStamp – 'dd.mm.yyyy hh:mm' (local time) of a Unix time stamp
export function FandStamp(T: number): string {
  return StampOf(T);
}

// ---------------------------------------------------------------- tokens (TS-only, fix: quotes)

// TS-only: split off the first blank-separated word; blanks inside "..." do not separate
function NextToken(s: Ref<string>): string {
  const t = Trim2(s.v);
  let q = false;
  let i = 0;
  for (; i < t.length; i++) {
    const c = t[i];
    if (c === '"') q = !q;
    else if (!q && (c === ' ' || c === '\t')) break;
  }
  s.v = Trim2(t.slice(i));
  return t.slice(0, i);
}
// TS-only: remove the double quotes of a token
function Unq(s: string): string {
  return s.replace(/"/g, '');
}
// TS-only: the last '>' outside quotes (0 = none), 1-based as Pascal pos
function LastRedir(s: string): number {
  let q = false;
  let p = 0;
  for (let i = 1; i <= s.length; i++) {
    if (s[i - 1] === '"') q = !q;
    else if (!q && s[i - 1] === '>') p = i;
  }
  return p;
}
// TS-only: a DOS switch like /Y /B /A /V /Q
function IsSwitch(s: string): boolean {
  return s.length === 2 && s[0] === '/' && /[A-Za-z?]/.test(s[1]);
}
// TS-only (fix): the virtual environment `set` shows (never the host one)
function DefaultDosEnv(): string[] {
  const env = [
    'COMSPEC=C:\\WINDOWS\\SYSTEM32\\CMD.EXE',
    'PATH=C:\\WINDOWS\\SYSTEM32;C:\\WINDOWS',
    'PROMPT=$P$G',
    'SystemRoot=C:\\WINDOWS',
    'windir=C:\\WINDOWS',
  ];
  for (const n of ['FANDOVRB', 'FANDCFG', 'FANDRES', 'FANDCAT', 'FANDWORK', 'FANDOVR']) {
    const v = GetEnv(n);
    if (v !== '') env.push(n + '=' + v);
  }
  return env;
}

// ---------------------------------------------------------------- batch files

// PAS: FANDDOS.PAS RunBat (private) – exit code of the last command
function RunBat(path: string, av: TArgs, nA: number): number {
  let rc = 0;
  const rcRef = { v: 0 };
  // PAS: RunBat.Word1 (fix: quote-aware)
  const Word1 = (s: Ref<string>): string => NextToken(s);
  // PAS: RunBat.Subst – %1..%9
  const Subst = (s: string): string => {
    let r = '';
    let q = 1;
    while (q <= s.length) {
      if (s[q - 1] === '%' && q < s.length && s[q] >= '1' && s[q] <= '9') {
        const k = s.charCodeAt(q) - 0x30;
        r += k <= nA ? av[k] : '';
        q += 2;
      } else if (s[q - 1] === '%' && q < s.length && s[q] === '%') {
        r += '%'; // fix: %% is a literal percent
        q += 2;
      } else {
        r += s[q - 1];
        q++;
      }
    }
    return r;
  };
  // PAS: RunBat.AnyMatch; fix: 'dir\', 'dir\*.*', 'dir\*', 'dir\NUL' of an existing directory are true
  const AnyMatch = (mask: string): boolean => {
    const dir0 = DirPart(mask);
    let mk = NamePart(mask);
    if (dir0 !== '' && (mk === '' || mk === '*.*' || mk === '*' || UpStr(mk) === 'NUL')) {
      if (DirectoryExists(dir0.length > 1 ? dir0.slice(0, -1) : dir0)) return true;
    }
    if (mk === '') mk = '*';
    const every = mk === '*.*';
    const dir = dir0 === '' ? '.' + DirectorySeparator : dir0;
    const list = ListDir(dir);
    if (list === null) return false;
    for (const sr of list) {
      if (sr.Name === '.' || sr.Name === '..') continue;
      if (every || MaskMatch(sr.Name, mk)) return true;
    }
    return false;
  };
  // PAS: RunBat.Exec
  const Exec = (cmd: string): void => {
    if (cmd === '') return;
    const handled = FandDosCmd(cmd, rcRef);
    rc = rcRef.v;
    if (handled) return;
    const sh = FandDosVars.FandDosShell;
    if (sh !== null) rc = sh(cmd);
  };

  const src = ReadWhole(path);
  if (src === '') return 9;
  const lines: string[] = [];
  let ln = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') {
      if (lines.length < 400) lines.push(ln);
      ln = '';
    } else if (src[i] !== '\r') ln += src[i];
  }
  if (ln !== '' && lines.length < 400) lines.push(ln);
  const n = lines.length;
  let lbl = '';
  let i = 1;
  const Goto = (rest: Ref<string>): void => {
    lbl = UpStr(Word1(rest));
    if (lbl.startsWith(':')) lbl = lbl.slice(1); // fix: GOTO :label
    i = 1;
  };
  while (i <= n) {
    ln = Trim2(lines[i - 1]);
    i++;
    while (ln !== '' && ln[0] === '@') ln = Trim2(ln.slice(1));
    if (ln === '') continue;
    if (ln[0] === ':') {
      if (lbl !== '' && UpStr(Trim2(ln.slice(1))) === lbl) lbl = '';
      continue;
    }
    const skipping = lbl !== '';
    if (skipping) continue;
    ln = Subst(ln);
    const rest = { v: ln };
    let w = UpStr(Word1(rest));
    if (w === 'REM' || w === 'ECHO.' || w === 'PAUSE' || w === 'CLS') continue;
    // FPC skips every ECHO; fix: `echo text >file` still writes the file
    if (w === 'ECHO' && LastRedir(rest.v) === 0) continue;
    if (w === 'GOTO') {
      Goto(rest);
      continue;
    }
    if (w === 'IF') {
      let neg = false;
      let a = Word1(rest);
      if (UpStr(a) === 'NOT') {
        neg = true;
        a = Word1(rest);
      }
      let cond: boolean;
      if (UpStr(a) === 'EXIST') {
        const b = Unq(Word1(rest));
        cond = AnyMatch(HostPath(b)); // fix: engine path mapping
      } else if (UpStr(a) === 'ISDIR' || UpStr(a) === 'DIREXIST') {
        // fix: 4DOS (CHKPATH.BAT under vDos)
        const b = Unq(Word1(rest));
        const hp = HostPath(b);
        cond = DirectoryExists(hp.length > 1 && hp.endsWith(DirectorySeparator) ? hp.slice(0, -1) : hp);
      } else if (UpStr(a) === 'ERRORLEVEL') {
        cond = rc >= (parseInt(Word1(rest), 10) || 0); // fix
      } else {
        let p = a.indexOf('==');
        if (p < 0) {
          // fix: IF "a" == "b" and IF "a" =="b"
          const r2 = { v: rest.v };
          const nx = Word1(r2);
          if (nx.startsWith('==')) {
            a = a + nx;
            rest.v = r2.v;
            if (nx === '==') a = a + Word1(rest);
            p = a.indexOf('==');
          }
        }
        if (p < 0) continue;
        const b = a.slice(p + 2);
        a = a.slice(0, p);
        cond = a === b;
      }
      if (neg) cond = !cond;
      if (!cond) continue;
      const r3 = { v: rest.v };
      w = UpStr(Word1(r3));
      if (w === 'GOTO') {
        Goto(r3);
        continue;
      }
      if (w === '') continue;
      Exec(rest.v); // FPC: Exec(w+' '+rest) with w upper-cased – same command
      continue;
    }
    if (w === 'CALL') {
      Exec(rest.v); // fix: CALL x.bat
      continue;
    }
    Exec(ln);
  }
  return rc;
}

// ---------------------------------------------------------------- commands

// PAS: FANDDOS.PAS FandDosCmd – true when the command was handled here
export function FandDosCmd(Line: string, ExitCode: Ref<number>): boolean {
  const av: TArgs = [''];
  let nArg = 0;
  const Arg = (n: number): string => (n >= 1 && n <= nArg ? Unq(av[n]) : '');
  ExitCode.v = 0;
  gText = '';
  let s = Trim2(Line);
  // fix: '@' prefix, CMD /C and COMMAND /C run the rest of the line
  for (;;) {
    while (s !== '' && s[0] === '@') s = Trim2(s.slice(1));
    const r = { v: s };
    const c0 = UpStr(NamePart(Unq(NextToken(r))));
    const r2 = { v: r.v };
    const sw = UpStr(NextToken(r2));
    if (
      (c0 === 'CMD' || c0 === 'CMD.EXE' || c0 === 'COMMAND' || c0 === 'COMMAND.COM') &&
      (sw === '/C' || sw === '/K')
    ) {
      s = r2.v;
      continue;
    }
    break;
  }
  if (s === '') return true;
  let redir = '';
  let app = false;
  let p = LastRedir(s);
  if (p > 0) {
    app = p > 1 && s[p - 2] === '>';
    redir = Unq(Trim2(s.slice(p)));
    const q = app ? p - 1 : p; // the first '>'
    // `2>nul`, `1>>x`: a stream number right before '>' is not an argument (`echo 1 >x` keeps its 1)
    const sn = q >= 2 && (s[q - 2] === '1' || s[q - 2] === '2') && (q === 2 || s[q - 3] === ' ' || s[q - 3] === '\t');
    const stderr = sn && s[q - 2] === '2';
    s = Trim2(s.slice(0, sn ? q - 2 : q - 1));
    if (stderr) {
      // `2>x` redirects the error output, which the built-ins do not write: stdout stays, x is created
      if (!app && !IsNul(redir)) WriteWhole(HostPath(redir), '', false);
      redir = '';
      app = false;
    }
  }
  let cmd = '';
  const r = { v: s };
  while (r.v !== '') {
    const tok = NextToken(r);
    if (tok === '') continue;
    if (cmd === '') cmd = Unq(tok);
    else if (nArg < 16) {
      nArg++;
      av[nArg] = tok;
    }
  }
  if (cmd === '') return true;
  let nm = UpStr(NamePart(cmd));
  let ext = '';
  p = nm.lastIndexOf('.') + 1;
  if (p > 0) {
    ext = nm.slice(p);
    nm = nm.slice(0, p - 1);
  }
  if (ext === 'BAT' || ext === 'CMD') {
    let bs = HostPath(cmd); // fix: UnixPath finds the file case-insensitively
    if (!FileExists(bs)) {
      gText = '';
      ForEachFile(WithSlash(DirPart(bs)) + NamePart(bs), false, acListPath);
      if (gText !== '') {
        const q = gText.indexOf(CRLF);
        if (q >= 0) bs = gText.slice(0, q);
      }
      gText = '';
    }
    if (!FileExists(bs)) {
      ExitCode.v = 9;
      return true;
    }
    ExitCode.v = RunBat(bs, av, nArg);
    return true;
  }
  if (Arg(1) === '$') {
    for (let i = 1; i <= nArg - 1; i++) av[i] = av[i + 1];
    nArg--;
  }
  const extraArgs = (): TArgs => {
    const x: TArgs = [''];
    for (let i = 1; i <= nArg; i++) x[i] = Unq(av[i]);
    return x;
  };
  const cmdDir = DirPart(cmd) === '' ? '' : HostPath(DirPart(cmd));
  if (ext !== '') {
    const x = extraArgs();
    return DosExtra(nm, ext, cmdDir, x, nArg, ExitCode);
  }
  if (nm === 'VER') {
    AddLine('Microsoft Windows [Version 10.0]'); // fix: FPC 'MS-DOS Version 6.22'
  } else if (nm === 'SET' || nm === 'SETCFG') {
    if (nArg === 0) for (const e of FandDosVars.FandDosEnv ?? DefaultDosEnv()) AddLine(e); // fix: virtual env
  } else if (nm === 'MD' || nm === 'MKDIR' || nm === 'MAKEDIR') {
    for (let i = 1; i <= nArg; i++) {
      const d = HostPath(Arg(i));
      if (!CanWrite(d)) {
        ExitCode.v = 1;
        continue;
      }
      try {
        fs.mkdirSync(ToUnicode(d), { recursive: true });
      } catch {
        ExitCode.v = 1;
      }
    }
  } else if (nm === 'RD' || nm === 'RMDIR') {
    for (let i = 1; i <= nArg; i++) {
      if (IsSwitch(Arg(i))) continue;
      const d = HostPath(Arg(i));
      if (!CanWrite(d)) continue;
      try {
        fs.rmdirSync(ToUnicode(d));
      } catch {
        // RemoveDir result ignored
      }
    }
  } else if (nm === 'DEL' || nm === 'ERASE') {
    for (let i = 1; i <= nArg; i++) if (!IsSwitch(Arg(i))) ForEachFile(HostPath(Arg(i)), false, acDelete);
  } else if (nm === 'COPY' || nm === 'XCOPY') {
    // fix: switches ignored, a+b concatenation, wildcard target names
    const toks: string[] = [];
    for (let i = 1; i <= nArg; i++) if (!IsSwitch(Arg(i))) toks.push(Arg(i));
    const srcs: string[] = [];
    let k = 0;
    const addSrc = (t: string): void => {
      for (const x of t.split('+')) if (x !== '') srcs.push(x);
    };
    if (k < toks.length) addSrc(toks[k++]);
    while (k < toks.length && (toks[k].startsWith('+') || toks[k - 1].endsWith('+'))) addSrc(toks[k++]);
    const dstArg = k < toks.length ? toks[k] : '';
    if (srcs.length > 1) {
      let data = '';
      for (const x of srcs) data += ReadWhole(HostPath(x));
      const dst = HostPath(dstArg !== '' ? dstArg : srcs[0]);
      if (!WriteWhole(dst, data, false)) ExitCode.v = 1;
    } else {
      let dst = HostPath(dstArg !== '' ? dstArg : '.' + DirectorySeparator);
      const src = HostPath(srcs[0] ?? '');
      const nmD = NamePart(dst);
      if (nmD === '*.*' || nmD === '*') dst = DirPart(dst);
      if (dst.length > 1 && dst.endsWith(DirectorySeparator) && DirectoryExists(dst.slice(0, -1))) dst = dst.slice(0, -1);
      if (HasWild(NamePart(dst))) {
        gCount = 0;
        gDest = dst;
        ForEachFile(src, false, acCopy);
        if (gCount === 0) ExitCode.v = 1;
      } else if (DirectoryExists(dst)) {
        gCount = 0;
        gDest = dst;
        ForEachFile(src, false, acCopy);
        if (gCount === 0) ExitCode.v = 1;
      } else if (HasWild(NamePart(src))) {
        // many sources into one file: DOS concatenates them
        gText = '';
        ForEachFile(src, false, acListPath);
        let data = '';
        for (const f of gText.split(CRLF)) if (f !== '') data += ReadWhole(f);
        const any = gText !== '';
        gText = '';
        if (!any || !WriteWhole(dst, data, false)) ExitCode.v = 1;
      } else if (!CopyOne(src, dst)) ExitCode.v = 1;
    }
  } else if (nm === 'REN' || nm === 'RENAME' || nm === 'MOVE') {
    const src = HostPath(Arg(1));
    let dst: string;
    // fix: REN takes a new name, not a path: the file stays in its directory
    if (nm !== 'MOVE' && DirPart(Arg(2)) === '') dst = DirPart(src) + Arg(2);
    else dst = HostPath(Arg(2));
    if (nm === 'MOVE' && DirectoryExists(dst)) dst = WithSlash(dst) + NamePart(src);
    const RenOne = (a: string, b: string): boolean => {
      if (!CanWrite(a) || !CanWrite(b)) return false;
      if (nm !== 'MOVE' && HostStat(b) !== null) return false; // DOS: a duplicate file name
      try {
        fs.renameSync(ToUnicode(a), ToUnicode(b));
        return true;
      } catch {
        return false;
      }
    };
    if (HasWild(NamePart(src))) {
      gText = '';
      ForEachFile(src, false, acListName);
      const names = gText.split(CRLF).filter((x) => x !== '');
      gText = '';
      if (names.length === 0) ExitCode.v = 1;
      for (const f of names) if (!RenOne(DirPart(src) + f, DirPart(dst) + DosWildName(f, NamePart(dst)))) ExitCode.v = 1;
    } else if (!RenOne(src, dst)) ExitCode.v = 1;
  } else if (nm === 'TYPE') {
    for (let i = 1; i <= nArg; i++) gText = gText + ReadWhole(HostPath(Arg(i)));
  } else if (nm === 'ECHO') {
    let es = '';
    for (let i = 1; i <= nArg; i++) {
      if (es !== '') es = es + ' ';
      es = es + av[i];
    }
    if (nArg === 1 && (UpStr(av[1]) === 'OFF' || UpStr(av[1]) === 'ON')) {
      // `echo off` prints nothing
    } else AddLine(es);
  } else if (nm === 'CLS') {
    gText = '\x1b[2J\x1b[H';
  } else if (
    nm === 'CD' || nm === 'CHDIR' || nm === 'EXIT' || nm === 'PAUSE' || nm === 'REM' || nm === 'PATH' ||
    nm === 'PROMPT' || nm === 'MODE' || nm === 'KEYB' || nm === 'SHARE' || nm === 'MOUNT' || nm === 'DIR' ||
    // fix: more no-ops
    nm === 'KB16' || nm === 'USE' || nm === 'ALIAS' || nm === 'VERIFY' || nm === 'LH' || nm === 'LOADHIGH' ||
    nm === 'CHCP' || nm === 'TITLE' || nm === 'COLOR' || nm === 'SETLOCAL' || nm === 'ENDLOCAL'
  ) {
    // accepted, nothing to do
  } else {
    const x = extraArgs();
    return DosExtra(nm, ext, cmdDir, x, nArg, ExitCode);
  }
  if (redir !== '') {
    if (!IsNul(redir)) if (!WriteWhole(HostPath(redir), gText, app)) ExitCode.v = 1;
  } else if (gText !== '') FandDosVars.FandDosWrite?.(gText);
  gText = '';
  return true;
}

// ---------------------------------------------------------------- Účto's DOS utilities (TS-only)
//
// Ports of the small Borland Pascal 7 programs in Účto's directory (docs/helpers/filesize.md,
// disksize.md, subdir.md, setdate.md, isshare.md). What they do is read from the disassembled
// originals. They get what FandDosCmd passes to FandDosExtra: the arguments unquoted and without
// the leading '$' (the originals halt with exit code 1 without it; that case cannot be seen here).
// The result files are written as the originals write them with `writeln`: ASCII lines ending CR LF.
// Deliberate differences from DOS, where the host has no equivalent:
// * directory order is the host's, so listings are sorted (upper case, as SortText) and FILESIZE
//   gives the stamp of the NEWEST file instead of the last one in DOS directory order;
// * host names starting with '.' count as hidden (SUBDIR/ISSHARE skip hidden directories);
// * DISKSIZE: no volume labels; A: and B: are "no drive" unless FAND_DRIVE_A/B maps them;
//   sizes are capped as DOS reports them (65535 clusters of 32 kB);
// * SETDATE moves the engine clock (pasrt.Clock), never the host's, as the DOS session clock
//   of NTVDM/vDos did.
// FAND_DOSTOOLS=0 in the environment switches them off (the reference FAND has none).

// TS-only: the ported utilities by program name (extension .EXE or none)
const DosTools = new Map<string, TDosHelper>([
  ['FILESIZE', DosFileSize],
  ['SUBDIR', DosSubDir],
  ['DISKSIZE', DosDiskSize],
  ['SETDATE', DosSetDate],
  ['ISSHARE', DosIsShare],
]);

/** TS-only: the built-in port of the DOS utility NM(.EXT), or undefined */
export function DosToolOf(Nm: string, Ext: string): TDosHelper | undefined {
  const ext = UpStr(Ext);
  if (ext !== '' && ext !== 'EXE') return undefined;
  if (GetEnv('FAND_DOSTOOLS') === '0') return undefined;
  return DosTools.get(UpStr(Nm));
}

/**
 * TS-only: DOS FindFirst name matching (FCB style): name and extension are matched separately,
 * '*' matches the rest of the part, '?' one character or none at the end of the part. So '*'
 * matches only names without an extension, '*.*' everything, '*.0??' also 'X.0' and 'X.01'.
 */
export function DosMaskMatch(Nm: string, Mask: string): boolean {
  const split = (s: string): [string, string] => {
    const p = s.lastIndexOf('.');
    return p < 0 ? [s, ''] : [s.slice(0, p), s.slice(p + 1)];
  };
  const up = (c: string): string => (c >= 'a' && c <= 'z' ? c.toUpperCase() : c);
  const part = (s: string, t: string): boolean => {
    let j = 0;
    for (let i = 0; i < t.length; i++) {
      if (t[i] === '*') return true;
      if (t[i] === '?') {
        if (j < s.length) j++;
      } else {
        if (j >= s.length || up(s[j]) !== up(t[i])) return false;
        j++;
      }
    }
    return j === s.length;
  };
  if (Nm === '.' || Nm === '..') return false;
  const [n, e] = split(Nm);
  const [mn, me] = split(Mask);
  return part(n, mn) && part(e, me);
}

// TS-only: the entries of a host directory matching a DOS mask, sorted as SortText sorts
function DosFind(Pattern: string): { Dir: string; List: SearchRec[] } {
  let Dir = DirPart(Pattern);
  const mk = NamePart(Pattern);
  if (Dir === '') Dir = '.' + DirectorySeparator;
  const list = (ListDir(Dir) ?? []).filter((sr) => DosMaskMatch(sr.Name, mk));
  list.sort((a, b) => (UpStr(a.Name) < UpStr(b.Name) ? -1 : UpStr(a.Name) > UpStr(b.Name) ? 1 : 0));
  return { Dir, List: list };
}
// TS-only: Assign + Rewrite of a utility's result file ('' = standard output, as in TP)
function OpenResult(Nm: string): boolean {
  return Nm === '' || WriteWhole(HostPath(Nm), '', false);
}
function WriteResult(Nm: string, Data: string): boolean {
  if (Nm !== '') return WriteWhole(HostPath(Nm), Data, false);
  if (Data !== '') FandDosVars.FandDosWrite?.(Data);
  return true;
}

/**
 * TS-only: FILESIZE.EXE $ <result> <mask> [<mask> ...]. Line 1: the total size of the matching
 * files (a longint, it wraps), '-1' when it is 0; line 2: 'DD.MM.YYYY hh:mm' of the newest one,
 * empty when none matched. Exit 1 when the result file cannot be written.
 */
function DosFileSize(Nm: string, Ext: string, Dir: string, Av: TArgs, nAv: number, ExitCode: Ref<number>): boolean {
  const out = nAv >= 1 ? Av[1] : '';
  if (!OpenResult(out)) {
    ExitCode.v = 1;
    return true;
  }
  let total = 0;
  let newest = -1;
  for (let i = 2; i <= nAv; i++) {
    for (const sr of DosFind(HostPath(Av[i])).List) {
      if (sr.IsDir) continue; // a directory entry has size 0 in DOS
      total = int32(total + sr.Size);
      if (sr.Time > newest) newest = sr.Time;
    }
  }
  const s = (total === 0 ? '-1' : IntStr(total)) + CRLF + (newest >= 0 ? StampOf(newest) : '') + CRLF;
  ExitCode.v = WriteResult(out, s) ? 0 : 1;
  return true;
}

/**
 * TS-only: SUBDIR.EXE $ <dir> <result>. One line per subdirectory of <dir>+'*.*' (the name only;
 * <dir> must end with '\', it is not added). Exit 2 when the result file cannot be written.
 */
function DosSubDir(Nm: string, Ext: string, Dir: string, Av: TArgs, nAv: number, ExitCode: Ref<number>): boolean {
  const out = nAv >= 2 ? Av[2] : '';
  if (!OpenResult(out)) {
    ExitCode.v = 2;
    return true;
  }
  let s = '';
  // DOS: attributes $10/$11/$30/$31 only, i.e. not hidden or system
  for (const sr of DosFind(HostPath((nAv >= 1 ? Av[1] : '') + '*.*')).List) if (sr.IsDir && sr.Name[0] !== '.') s = s + sr.Name + CRLF;
  ExitCode.v = WriteResult(out, s) ? 0 : 2;
  return true;
}

// TS-only: the host directory of DOS drive L ('@' = the current one), null when there is no such drive
function DosDriveRoot(L: string): string | null {
  const u = UpStr(L);
  if (u === '@') return HostPath('.');
  if (!(u >= 'A' && u <= 'Z')) return null;
  const env = GetEnv('FAND_DRIVE_' + u);
  if (env !== '') return env;
  if ((u === 'A' || u === 'B') && process.platform !== 'win32') return null; // no floppies here
  return HostPath(u + ':\\');
}
// DOS INT 21h/36h reports at most 65535 clusters of 64 sectors of 512 bytes
const DosMaxDisk = 65535 * 64 * 512;

/**
 * TS-only: DISKSIZE.EXE $ <result> <drive letter>. Lines: capacity, free and used bytes, volume
 * label. An invalid drive gives -1, 0, 0 and '' with exit code 0, as the original. Exit 2 when
 * the result file cannot be written.
 */
function DosDiskSize(Nm: string, Ext: string, Dir: string, Av: TArgs, nAv: number, ExitCode: Ref<number>): boolean {
  const out = nAv >= 1 ? Av[1] : '';
  if (!OpenResult(out)) {
    ExitCode.v = 2;
    return true;
  }
  const d = nAv >= 2 ? Av[2] : '';
  const root = d === '' ? null : DosDriveRoot(d[0]);
  let size = -1;
  let free = 0;
  let used = 0;
  if (root !== null) {
    try {
      const st = fs.statfsSync(ToUnicode(root));
      size = Math.min(st.bsize * st.blocks, DosMaxDisk);
      free = Math.min(st.bsize * st.bavail, DosMaxDisk);
      used = size - free;
    } catch {
      size = -1;
    }
  }
  const s = IntStr(size) + CRLF + IntStr(free) + CRLF + IntStr(used) + CRLF + '' + CRLF;
  ExitCode.v = WriteResult(out, s) ? 0 : 2;
  return true;
}

/**
 * TS-only: SETDATE.EXE <year> <month> <day> <hour> <minute>: DOS SetDate and SetTime (each
 * ignored when invalid, as INT 21h/2Bh and 2Dh do). Moves the engine clock. Always exit 0.
 */
function DosSetDate(Nm: string, Ext: string, Dir: string, Av: TArgs, nAv: number, ExitCode: Ref<number>): boolean {
  const V = (i: number): number => {
    const v = { v: 0 };
    const code = { v: 0 };
    ValI(i <= nAv ? Av[i] : '', v, code);
    return code.v !== 0 ? 0 : v.v & 0xffff; // a word; BP7 Val leaves 0 on an error
  };
  const y = V(1);
  const m = V(2) & 0xff;
  const d = V(3) & 0xff;
  const h = V(4) & 0xff;
  const mi = V(5) & 0xff;
  const now = Clock.now();
  const t = new Date(now.getTime());
  if (y >= 1980 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(y, m, 0).getDate()) t.setFullYear(y, m - 1, d);
  if (h < 24 && mi < 60) t.setHours(h, mi, 0, 0);
  const off = t.getTime() - now.getTime();
  if (off !== 0) {
    const prev = Clock.now;
    Clock.now = (): Date => new Date(prev().getTime() + off);
  }
  ExitCode.v = 0;
  return true;
}

/**
 * TS-only: ISSHARE.EXE $ <mask> <word> <result>: the full DOS paths of the files matching <mask>
 * on drives C: to K: (whole trees) that contain <word> (case-insensitive, in the first 255
 * characters of a line). Exit code: 4 when SHARE is resident (never: the engine locks itself),
 * + 8 when a directory path exceeded 67 characters; 2 when the result cannot be written.
 * Only drives mapped by FAND_DRIVE_x are searched, and C: (the application's drive).
 */
function DosIsShare(Nm: string, Ext: string, Dir: string, Av: TArgs, nAv: number, ExitCode: Ref<number>): boolean {
  const mask = ShortStr(nAv >= 1 ? Av[1] : '', 12);
  const word = UpStr(nAv >= 2 ? Av[2] : '');
  const out = nAv >= 3 ? Av[3] : '';
  if (!OpenResult(out)) {
    ExitCode.v = 2;
    return true;
  }
  let s = '';
  let err = false;
  const Contains = (f: string): boolean => {
    if (word === '') return false; // Pos('',s) = 0
    let t = ReadWhole(f);
    const z = t.indexOf('\x1a');
    if (z >= 0) t = t.slice(0, z);
    for (const ln of t.split(/\r\n|\r|\n/)) if (UpStr(ln.slice(0, 255)).includes(word)) return true;
    return false;
  };
  const Walk = (host: string, dos: string): void => {
    for (const sr of DosFind(host + mask).List) if (!sr.IsDir && Contains(host + sr.Name)) s = s + UpStr(dos + sr.Name) + CRLF;
    for (const sr of DosFind(host + '*.*').List) {
      if (!sr.IsDir || sr.Name[0] === '.') continue;
      const sub = dos + UpStr(sr.Name);
      if (sub.length > 67) err = true;
      else Walk(WithSlash(host + sr.Name), sub + '\\');
    }
  };
  const seen = new Set<string>();
  for (let d = 0; d <= 8; d++) {
    const L = String.fromCharCode(0x43 + d);
    let root = GetEnv('FAND_DRIVE_' + L);
    if (root === '' && L === 'C') root = HostPath('C:\\');
    if (root === '' || !DirectoryExists(root.length > 1 && root.endsWith(DirectorySeparator) ? root.slice(0, -1) : root)) continue;
    root = WithSlash(root);
    if (seen.has(root)) continue;
    seen.add(root);
    Walk(root, L + ':\\');
  }
  if (!WriteResult(out, s)) {
    ExitCode.v = 2;
    return true;
  }
  ExitCode.v = err ? 8 : 0;
  return true;
}
