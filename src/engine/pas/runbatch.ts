// PAS: RUNBATCH.PAS (FPC only) – non-interactive `fand TASK --source-in DIR | --source-out DIR`:
// import/export the chapters of a task as text files NNN-T-Name.txt (see HOWTO.txt).
//
// Porting notes:
// * No asm. Uses SysUtils (FindFirst/FindNext, ForceDirectories, Format, StringReplace) -> node:fs.
//   Messages go to stderr as 'fand: <utf-8 text>' (Say/Warn); chapter names/texts are converted
//   CP852 <-> UTF-8 (FANDCP S852ToUtf8/SUtf8To852); SourceToFand drops a UTF-8 BOM and turns LF into
//   CR LF, FandToSource turns CR LF (and lone CR) into LF;
//   FANDDOS FandReadWhole/FandWriteWhole read/write whole files.
// * Ansistrings holding UTF-8 are byte strings here too (one char per UTF-8 byte), as in FPC; host
//   file names are converted at the node:fs boundary (Utf8Name/HostName below).
// * Private state: Opened, Aborted, Outcome (0 ok, 1 failure, 2 warnings/usage), Warnings.
// * FandBatchRun: sets ObaseWWVars.BatchMsgCount := 0 and BatchQuiet := true; NewExit around the
//   operation (GoExit -> Aborted, Outcome 1) and again around CloseChpt; any batch message turns
//   Outcome 0 into 2.
// * SourceIn: sorted file names, CreateOpenChpt(Task, true), refuses encrypted chapters, rewrites
//   Chpt (RewriteF), stores each chapter (typ, name <= 12 chars, text <= $FFF0) with StoreChptTxt,
//   SetCompileAll + SaveFiles, then compiles (Compiled: CompileFD := true; CompileRdb(false,true,
//   false); errors are reported as 'chapter N T Name, line L column C: msg' by ReportCompileErr,
//   counting CurrPos over the chapter text with CR = new line, LF ignored).
// * SourceOut: one file per chapter record, '/' and '\' in names replaced by '_'.

import * as fs from 'node:fs';
import { GoExitSignal, ref, StrI, BytesToStr, StrToBytes, ToUnicode, FromUnicode, type Pointer } from './pasrt.ts';
import { BaseVars, ExitRecord, NewExit, RestoreExit, MarkStore, ReleaseStore, type LongStrPtr } from './base.ts';
import { DriversVars } from './drivers.ts';
import {
  AccessVars, GetRecSpace, ReadRec, PutRec, ZeroAllFlds, S_, B_, _ShortS, _LongS, OldLMode, type LockMode,
} from './access.ts';
import { RewriteF, SaveFiles } from './oaccess.ts';
import { ObaseWWVars } from './obaseww.ts';
import { RdRunVars, SetCompileAll } from './rdrun.ts';
import { CreateOpenChpt, CloseChpt, CompileRdb, StoreChptTxt } from './runproj.ts';
import { S852ToUtf8, SUtf8To852 } from './fandcp.ts';
import { FandReadWhole, FandWriteWhole } from './fanddos.ts';

// PAS: RUNBATCH.PAS Ovr
function Ovr(): void {}

let Opened = false;
let Aborted = false;
let Outcome = 0;
let Warnings = 0;

/** TS-only: a UTF-8 byte string (FPC ansistring) as a JS string. */
function Utf8Decode(S: string): string {
  return Buffer.from(S, 'latin1').toString('utf8');
}
/** TS-only: a JS (host) string as a UTF-8 byte string. */
function Utf8Name(S: string): string {
  return Buffer.from(S, 'utf8').toString('latin1');
}
/** TS-only: an FPC file name (UTF-8 bytes) as an engine (CP852 byte string) path. */
function HostName(S: string): string {
  return FromUnicode(Utf8Decode(S));
}

// PAS: RUNBATCH.PAS Say
function Say(Utf8: string): void {
  process.stderr.write('fand: ' + Utf8Decode(Utf8) + '\n');
}
// PAS: RUNBATCH.PAS Warn
function Warn(Utf8: string): void {
  Say(Utf8);
  Warnings++;
}
// PAS: RUNBATCH.PAS U
function U(S: string): string {
  return S852ToUtf8(S);
}
// PAS: RUNBATCH.PAS TrimRightCh
function TrimRightCh(S: string, C: string): string {
  let n = S.length;
  while (n > 0 && S[n - 1] === C) n--;
  return S.slice(0, n);
}
// PAS: RUNBATCH.PAS IStr
function IStr(N: number): string {
  return StrI(N);
}
// PAS: RUNBATCH.PAS LongToAnsi
function LongToAnsi(X: LongStrPtr): string {
  return BytesToStr(X);
}
// PAS: RUNBATCH.PAS AnsiToLong
function AnsiToLong(S: string): LongStrPtr {
  let n = S.length;
  if (n > 0xfff0) n = 0xfff0;
  return StrToBytes(S.slice(0, n));
}
/** TS-only: SysUtils.IncludeTrailingPathDelimiter */
function IncludeTrailingPathDelimiter(S: string): string {
  return S.endsWith('/') ? S : S + '/'; // a host directory (--source-in/--source-out)
}

// PAS: RUNBATCH.PAS ReportCompileErr
function ReportCompileErr(): void {
  const av = AccessVars;
  const s = BaseVars.MsgLine;
  if (av.InpRdbPos.R === av.CRdb && av.InpRdbPos.IRec > 0 && !av.CRdb!.Encrypted) {
    const cf = av.CFile, cr = av.CRecPtr;
    const p = ref<Pointer>(null);
    MarkStore(p);
    av.CFile = av.Chpt;
    av.CRecPtr = GetRecSpace();
    ReadRec(av.InpRdbPos.IRec);
    const x = _LongS(av.ChptTxt);
    const t = LongToAnsi(x);
    let line = 1, col = 1;
    for (let i = 1; i <= av.CurrPos - 1; i++) {
      if (i > t.length) break;
      else if (t[i - 1] === '\r') {
        line++;
        col = 1;
      } else if (t[i - 1] !== '\n') col++;
    }
    const r = av.CRdb!.ChainBack !== null ? U(av.CRdb!.FD!.Name) + ': ' : '';
    Warn(r + 'chapter ' + IStr(av.InpRdbPos.IRec) + ' ' + TrimRightCh(_ShortS(av.ChptTyp), ' ') + ' ' +
      U(TrimRightCh(_ShortS(av.ChptName), ' ')) + ', line ' + IStr(line) + ' column ' + IStr(col) + ': ' + U(s));
    ReleaseStore(p.v);
    av.CFile = cf;
    av.CRecPtr = cr;
  } else Warn(U(s));
}
// PAS: RUNBATCH.PAS Compiled
function Compiled(): boolean {
  RdRunVars.CompileFD = true;
  if (CompileRdb(false, true, false)) return true;
  ReportCompileErr();
  return false;
}
// PAS: RUNBATCH.PAS SplitSourceName
function SplitSourceName(F: string, Typ: { v: string }, Name: { v: string }): boolean {
  // ExtractFileExt / ChangeFileExt(ExtractFileName(F), '')
  const fn = F.slice(F.lastIndexOf('/') + 1);
  const dot = fn.lastIndexOf('.');
  const ext = dot >= 0 ? fn.slice(dot) : '';
  if (ext.toLowerCase() !== '.txt') return false;
  const b = dot >= 0 ? fn.slice(0, dot) : fn;
  let i = 1;
  while (i <= b.length && b[i - 1] >= '0' && b[i - 1] <= '9') i++;
  if (i === 1 || i + 2 > b.length || b[i - 1] !== '-' || b[i + 1] !== '-') return false;
  Typ.v = b[i];
  Name.v = b.slice(i + 2);
  return true;
}
// PAS: RUNBATCH.PAS SourceToFand
function SourceToFand(S: string): string {
  let t = S;
  if (t.slice(0, 3) === '\xef\xbb\xbf') t = t.slice(3);
  t = SUtf8To852(t);
  let r = '';
  for (let i = 1; i <= t.length; i++) {
    if (t[i - 1] === '\n') {
      if (i === 1 || t[i - 2] !== '\r') r += '\r';
      r += '\n';
    } else r += t[i - 1];
  }
  return r;
}
// PAS: RUNBATCH.PAS FandToSource
function FandToSource(S: string): string {
  let r = '';
  for (let i = 1; i <= S.length; i++) {
    if (S[i - 1] === '\r' && i < S.length && S[i] === '\n') {
      // CR of CR LF dropped
    } else if (S[i - 1] === '\r') r += '\n';
    else r += S[i - 1];
  }
  return U(r);
}
// PAS: RUNBATCH.PAS SourceIn
function SourceIn(Task: string, Dir: string): void {
  const av = AccessVars;
  const names: string[] = [];
  const typ = ref(''), nm = ref('');
  let list: string[] = [];
  try {
    list = fs.readdirSync(ToUnicode(IncludeTrailingPathDelimiter(Dir)));
  } catch {
    list = [];
  }
  for (const u of list) {
    const n = Utf8Name(u);
    if (SplitSourceName(n, typ, nm)) names.push(n);
  }
  if (names.length === 0) {
    Say('no chapter files (NNN-T-Name.txt) in ' + U(Dir));
    return;
  }
  for (let i = 0; i < names.length - 1; i++)
    for (let j = i + 1; j < names.length; j++)
      if (names[j] < names[i]) {
        const t = names[i];
        names[i] = names[j];
        names[j] = t;
      }
  av.IsTestRun = true;
  CreateOpenChpt(Task, true);
  Opened = true;
  if (av.CRdb!.Encrypted) {
    Say(U(Task) + ': the chapters are password-protected; not replaced');
    return;
  }
  av.CFile = av.Chpt;
  av.CRecPtr = av.Chpt!.RecPtr;
  const md: LockMode = RewriteF(false);
  for (let i = 0; i < names.length; i++) {
    SplitSourceName(names[i], typ, nm);
    if (nm.v.length > 12) Warn(names[i] + ': the name is longer than 12 characters');
    const t = SourceToFand(FandReadWhole(IncludeTrailingPathDelimiter(Dir) + HostName(names[i])));
    if (t.length > 0xfff0) Warn(names[i] + ': longer than a chapter can be, cut');
    const p = ref<Pointer>(null);
    MarkStore(p);
    ZeroAllFlds();
    S_(av.ChptTyp, typ.v);
    S_(av.ChptName, SUtf8To852(nm.v));
    B_(av.ChptVerif, false);
    const x = AnsiToLong(t);
    StoreChptTxt(av.ChptTxt, x, false);
    PutRec();
    ReleaseStore(p.v);
  }
  OldLMode(md);
  SetCompileAll();
  SaveFiles();
  Say(U(Task) + ': ' + IStr(names.length) + ' chapters from ' + U(Dir));
  if (Compiled()) Outcome = 0;
  else Say('the task does not compile (the chapters are stored)');
}
// PAS: RUNBATCH.PAS SourceOut
function SourceOut(Task: string, Dir: string): void {
  const av = AccessVars;
  CreateOpenChpt(Task, false);
  Opened = true;
  if (av.CRdb!.Encrypted) {
    Say(U(Task) + ': the chapters are password-protected; not written');
    return;
  }
  try {
    fs.mkdirSync(ToUnicode(Dir), { recursive: true }); // ForceDirectories
  } catch {
    Say('cannot create ' + U(Dir));
    return;
  }
  av.CFile = av.Chpt;
  av.CRecPtr = av.Chpt!.RecPtr;
  let c = 0;
  for (let i = 1; i <= av.Chpt!.NRecs; i++) {
    const p = ref<Pointer>(null);
    MarkStore(p);
    ReadRec(i);
    let typ = TrimRightCh(_ShortS(av.ChptTyp), ' ');
    if (typ === '') typ = '_';
    // TS: the name stays CP852 here; FandWriteWhole converts it to the host name (FPC: U(name))
    const nm = TrimRightCh(_ShortS(av.ChptName), ' ');
    let f = StrI(i).padStart(3, '0') + '-' + typ + '-' + nm + '.txt'; // Format('%.3d-%s-%s.txt')
    f = f.replace(/\//g, '_').replace(/\\/g, '_');
    const x = _LongS(av.ChptTxt);
    if (!FandWriteWhole(IncludeTrailingPathDelimiter(Dir) + f, FandToSource(LongToAnsi(x)), false)) Warn('cannot write ' + U(f));
    else c++;
    ReleaseStore(p.v);
  }
  Say(U(Task) + ': ' + IStr(c) + ' chapters to ' + U(Dir));
  if (Warnings === 0) Outcome = 0;
  else Outcome = 2;
}
// PAS: RUNBATCH.PAS Usage
function Usage(): void {
  Say('usage: fand TASK --source-in DIR | --source-out DIR');
}

// PAS: RUNBATCH.PAS FandBatchRun – returns the process exit code
export function FandBatchRun(Task: string, Op: string, Arg: string): number {
  Outcome = 1;
  Warnings = 0;
  Opened = false;
  Aborted = false;
  ObaseWWVars.BatchMsgCount = 0;
  DriversVars.BatchQuiet = true;
  if (Task === '--help' || Arg === '') {
    Usage();
    return 2;
  }
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    if (Op === '--source-in') SourceIn(Task, Arg);
    else if (Op === '--source-out') SourceOut(Task, Arg);
    else {
      Usage();
      Outcome = 2;
    }
  } catch (e) {
    if (!(e instanceof GoExitSignal)) {
      RestoreExit(er);
      throw e;
    }
    Aborted = true;
  }
  // 9:
  RestoreExit(er);
  if (Aborted) Outcome = 1;
  if (Opened) {
    Opened = false;
    NewExit(Ovr, er);
    try {
      CloseChpt();
    } catch (e) {
      if (!(e instanceof GoExitSignal)) {
        RestoreExit(er);
        throw e;
      }
      Outcome = 1;
    }
    RestoreExit(er);
  }
  if (Outcome === 0 && ObaseWWVars.BatchMsgCount > 0) Outcome = 2;
  return Outcome;
}
