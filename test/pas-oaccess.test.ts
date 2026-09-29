// OACCESS package: oaccess.ts (catalog, paths, opening/creating/closing files, duplicate files),
// olongstr.ts (host texts, T-file text copies), printtxt.ts (printing with dot commands),
// fanddos.ts (in-process DOS shell + .BAT interpreter), fandcp.ts (code pages), oldtxx.ts (tool).
// Real Účto files are copied to work/tmp-oaccess/ (the pristine install is never written).

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import {
  cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, statSync, readdirSync, utimesSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  ref, FromUnicode, Output, TxtRewrite, getWord, getLongint, setLongint, BytesToStr, NotImplementedError,
} from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, FormatCache, SaveCache, OpenH, CloseH, ReadH, SeekH, PosH, OpenWorkH, InitBase, SizeOfResA,
  MsgIdxFromBytes, FileSizeH, OSshell, _isoldfile, _isoverwritefile, Exclusive, Shared, RdOnly,
} from '../src/engine/pas/base.ts';
import {
  AccessVars, FileD, FieldDescr, TFile, XFile, RdbD, FrmlElem, f_Stored, LeftJust, GetRecSpace, ReadRec, PutRec,
  NullMode, ExclMode, _const, _gettxt,
} from '../src/engine/pas/access.ts';
import {
  OpenF, OpenCreateF, CloseFile, ClosePassiveFD, CloseFAfter, RewriteF, SetCPathVol, SetTxtPathVol, GetCatIRec,
  RdCatField, WrCatField, RdCatPathVol, Generation, TurnCat, SetCPathForH, TestMountVol, OpenDuplF, SubstDuplF,
  DelDuplF, SaveFiles, CloseFANDFiles, OpenFANDFiles,
} from '../src/engine/pas/oaccess.ts';
import { GetTxt, CopyTFFromGetTxt, CopyTFString, CopyTFStringToH } from '../src/engine/pas/olongstr.ts';
import { PrintArray, PrintTxtFile } from '../src/engine/pas/printtxt.ts';
import {
  FandDosCmd, FandDosVars, FandMaskMatch, FandListFiles, FandTotalSize, FandSearchDown, FandStamp, FandFileTime,
  FandDirPart, FandNamePart, FandWithSlash, FandUpStr, FandIntStr, FandReadWhole, FandWriteWhole, FandDeleteFiles,
  registerHelper, clearHelpers, type TArgs,
} from '../src/engine/pas/fanddos.ts';
import {
  S852ToUtf8, SUtf8To852, S1250ToUtf8, SUtf8To1250, S852To1250, S1250To852, UniToUtf8, NextUtf8, Cp852Uni,
} from '../src/engine/pas/fandcp.ts';
import { OldTxx } from '../src/engine/pas/oldtxx.ts';
import { RunFrmlVars } from '../src/engine/pas/runfrml.ts';
import { SetDriversCrt, DriversVars, AssignCrt } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { decode852, encode852 } from '../src/engine/console/cp852.ts';
import { DataFile } from '../src/engine/fand/datafile.ts';
import { TFile as RawTFile } from '../src/engine/fand/tfile.ts';

// RUNFRML is another package: fall back to minimal versions while it is still stubbed
vi.mock('../src/engine/pas/runfrml.ts', async (orig) => {
  const m = await orig<typeof import('../src/engine/pas/runfrml.ts')>();
  const fb =
    <A extends unknown[], R>(f: (...a: A) => R, alt: (...a: A) => R) =>
    (...a: A): R => {
      try {
        return f(...a);
      } catch (e) {
        if (e instanceof NotImplementedError) return alt(...a);
        throw e;
      }
    };
  return {
    ...m,
    TrailChar: fb(m.TrailChar, (C: string, S: string) => {
      let i = S.length;
      while (i > 0 && S[i - 1] === C) i--;
      return S.slice(0, i);
    }),
    LeadChar: fb(m.LeadChar, (C: string, S: string) => {
      let i = 0;
      while (i < S.length && S[i] === C) i++;
      return S.slice(i);
    }),
    RunInt: fb(m.RunInt, (Z) => Math.trunc(Z!.R)), // constant formulas only
  };
});

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const TMP = join(ROOT, 'work/tmp-oaccess');
const haveApp = existsSync(join(APP, 'UCTO2026.CAT'));
const B = (u: string): string => String.fromCharCode(...encode852(u));
const H = (p: string): string => FromUnicode(p); // host path -> byte string
const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

/** RUNFAND.InitRunFand: the FAND.RES message index (after BASE opened the file). */
function ReadResHeader(): void {
  const h = BaseVars.ResFile.Handle;
  const b = new Uint8Array(SizeOfResA);
  SeekH(h, 0);
  ReadH(h, 2, b);
  ReadH(h, SizeOfResA, b);
  BaseVars.ResFile.SetA(b);
  ReadH(h, 2, b);
  BaseVars.MsgIdxN = getWord(b, 0);
  const mi = new Uint8Array(5 * BaseVars.MsgIdxN);
  ReadH(h, mi.length, mi);
  BaseVars.MsgIdx = MsgIdxFromBytes(mi, BaseVars.MsgIdxN);
  BaseVars.FrstMsgPos = PosH(h);
}
function freshDir(name: string): string {
  const d = join(TMP, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}
/** Deterministic text bytes (CP852 letters, CR LF). */
function makeText(n: number, seed: number): Uint8Array {
  const a = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const r = (s >>> 16) % 40;
    a[i] = r < 26 ? 0x61 + r : r < 30 ? 0xa0 + r : r < 38 ? 0x20 : r === 38 ? 0x0d : 0x0a;
  }
  return a;
}
function aField(name: string, displ: number, l: number, typ = 'A'): FieldDescr {
  const F = new FieldDescr();
  F.Name = name;
  F.Typ = typ;
  F.FrmlTyp = typ === 'N' ? 'S' : 'S';
  F.L = l;
  F.NBytes = typ === 'N' ? (l + 1) >> 1 : l;
  F.M = LeftJust;
  F.Flg = f_Stored;
  F.Displ = displ;
  return F;
}
function constFrml(r: number): FrmlElem {
  const z = new FrmlElem(_const);
  z.R = r;
  return z;
}

let cwd0 = '';
beforeAll(() => {
  cwd0 = process.cwd();
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  if (haveApp) {
    process.env.FANDRES = APP;
    InitBase();
    ReadResHeader();
  }
  FormatCache();
  SetDriversCrt(new Crt(new KeyQueue(), null, 80, 25));
  AssignCrt(Output);
  TxtRewrite(Output);
  DriversVars.FandBatch = true; // messages -> stderr, prompts answer No
  const tw = AccessVars.TWork;
  tw.IsWork = true;
  BaseVars.CPath = H(join(TMP, 'FANDWORK.T$$'));
  BaseVars.FandWorkTName = BaseVars.CPath;
  tw.Create();
  BaseVars.FandWorkName = H(join(TMP, 'FANDWORK.$$$'));
  BaseVars.FandWorkXName = H(join(TMP, 'FANDWORK.X$$'));
  OpenWorkH();
  BaseVars.CPath = BaseVars.FandWorkXName;
  AccessVars.XWork.Handle = OpenH(_isoverwritefile, Exclusive);
});
afterEach(() => {
  process.chdir(cwd0);
});

// ---------------------------------------------------------------- FANDCP

describe('FANDCP: code pages', () => {
  it('CP852 <-> UTF-8 round trip, the table agrees with console/cp852', () => {
    const u = 'Příliš žluťoučký kůň úpěl ďábelské ódy ČŘŽŠĚÚŮ ║╔ ¤';
    const b852 = B(u);
    const utf8 = S852ToUtf8(b852);
    expect(Buffer.from(bytes(utf8)).toString('utf8')).toBe(u);
    expect(SUtf8To852(utf8)).toBe(b852);
    for (let c = 0x80; c <= 0xff; c++) {
      expect(String.fromCharCode(Cp852Uni[c - 0x80])).toBe(decode852(Uint8Array.of(c)));
    }
  });
  it('CP1250 conversions, fallbacks, NextUtf8', () => {
    expect(S852To1250(B('čř'))).toBe('\xe8\xf8');
    expect(S1250To852('\xe8\xf8\x80')).toBe(B('čř') + 'EUR');
    expect(S1250ToUtf8('\x81')).toBe('?'); // undefined in CP1250
    expect(SUtf8To1250(UniToUtf8(0x20ac) + UniToUtf8(0x0161))).toBe('\x80\x9a');
    // fallbacks: quotes, ellipsis, unknown
    expect(SUtf8To852(UniToUtf8(0x201e) + 'a' + UniToUtf8(0x2026) + UniToUtf8(0x4e00))).toBe('"a...?');
    expect(UniToUtf8(0x1f600)).toBe('\xf0\x9f\x98\x80');
    const i = ref(1);
    expect(NextUtf8('\xc3(', i)).toBe(0xfffd); // broken sequence
    expect(i.v).toBe(2);
    i.v = 1;
    expect(NextUtf8('\xf0\x9f\x98\x80', i)).toBe(0x1f600);
    expect(i.v).toBe(5);
  });
});

// ---------------------------------------------------------------- FANDDOS

describe.skipIf(!haveApp)('FANDDOS: DOS commands and the Účto batch files', () => {
  let C = '';
  let U = '';
  const run = (line: string): number => {
    const rc = ref(-1);
    expect(FandDosCmd(line, rc)).toBe(true);
    return rc.v;
  };
  beforeAll(() => {
    const D = freshDir('dos');
    C = join(D, 'c');
    U = join(C, 'UCTO2026');
    mkdirSync(U, { recursive: true });
    for (const f of ['MAKEDIR.BAT', 'CHKPATH.BAT', 'RENVYP.BAT', 'REN3BKP.BAT', 'DELPRAC.BAT', '{OBNV}.BAT', 'UCTO2026.CAT']) {
      cpSync(join(APP, f), join(U, f));
    }
    // lower-case directories on disk, upper case in the batch files
    mkdirSync(join(U, '{glob}'));
    for (const f of ['MODULY.000', 'SAZDPH.000']) cpSync(join(APP, '{glob}', f), join(U, '{glob}', f));
    mkdirSync(join(U, '{tisk}'));
    writeFileSync(join(U, '{tisk}', 'UCTOOL.EXE'), 'MZ fake');
    mkdirSync(join(U, '{stan}'));
    for (const f of ['DPH.109', 'DPH.209', 'DPH92A.109', 'KEEP.000', 'VYP1.TXT']) writeFileSync(join(U, '{stan}', f), f);
    mkdirSync(join(U, 'BKP'));
    for (const s of ['B', 'T', 'Z']) writeFileSync(join(U, 'BKP', 'FIRMA.262' + s), s);
    mkdirSync(join(U, 'Moje doklady'));
    writeFileSync(join(U, 'Moje doklady', 'f a.pdf'), '%PDF');
    process.env.FAND_DRIVE_C = C;
    clearHelpers();
  });
  afterAll(() => {
    delete process.env.FAND_DRIVE_C;
    FandDosVars.FandDosWritable = null;
    clearHelpers();
  });

  it('ver / set: the Windows identity and a virtual environment', () => {
    expect(run('ver >C:\\UCTO2026\\UCTO.TXT')).toBe(0);
    expect(readFileSync(join(U, 'UCTO.TXT'), 'latin1')).toBe('Microsoft Windows [Version 10.0]\r\n');
    expect(run('set >C:\\UCTO2026\\UCTO.TXT')).toBe(0);
    const set = readFileSync(join(U, 'UCTO.TXT'), 'latin1');
    expect(set).toContain('SystemRoot=C:\\WINDOWS\r\n');
    expect(set).toContain('COMSPEC=C:\\WINDOWS\\SYSTEM32\\CMD.EXE');
    expect(set).not.toContain('HOME=');
    // CMD /C (exec(CMDEXE,'/C '+Parametry)) and '>>' append
    expect(run('C:\\WINDOWS\\SYSTEM32\\CMD.EXE /C ver >>C:\\UCTO2026\\UCTO.TXT')).toBe(0);
    expect(readFileSync(join(U, 'UCTO.TXT'), 'latin1')).toBe(set + 'Microsoft Windows [Version 10.0]\r\n');
    expect(run('echo Ahoj  svete >C:\\UCTO2026\\E.TXT')).toBe(0);
    expect(readFileSync(join(U, 'E.TXT'), 'latin1')).toBe('Ahoj svete\r\n');
    expect(run('rem nothing')).toBe(0);
    expect(run('')).toBe(0);
    expect(FandDosCmd('NEZNAMY a b', ref(0))).toBe(false); // -> host shell
  });
  it('MAKEDIR.BAT creates nested firm directories; the call through OSshell', () => {
    process.chdir(U);
    expect(run('MAKEDIR.BAT $ C:\\UCTO2026\\ADR01 C:\\UCTO2026\\ADR03\\SUB')).toBe(0);
    expect(statSync(join(U, 'ADR01')).isDirectory()).toBe(true);
    expect(statSync(join(U, 'ADR03', 'SUB')).isDirectory()).toBe(true);
    // FAND EXEC('', ...) -> OSshell (maps '\' to '/') -> FandDosCmd; again on existing empty dirs
    BaseVars.LastExitCode = 99;
    OSshell('', 'makedir.bat $ C:\\UCTO2026\\ADR02', true, true, false, false);
    expect(BaseVars.LastExitCode).toBe(0);
    expect(statSync(join(U, 'ADR02')).isDirectory()).toBe(true);
    expect(run('MAKEDIR.BAT $ C:\\UCTO2026\\ADR01')).toBe(0);
    expect(run('MAKEDIR.BAT x C:\\UCTO2026\\ADRXX')).toBe(0); // not "$": nothing
    expect(existsSync(join(U, 'ADRXX'))).toBe(false);
    expect(run('NEEXISTUJE.BAT $')).toBe(9);
  });
  it('CHKPATH.BAT: IF [NOT] EXIST dir\\ is true for an existing empty directory (and 4DOS isdir)', () => {
    process.chdir(U);
    mkdirSync(join(U, 'PRAZDNY'));
    for (const kw of ['exist', 'isdir']) {
      writeFileSync(join(U, 'CHKPATH.TXT'), 'x');
      expect(run(`CHKPATH.BAT $ C:\\UCTO2026\\PRAZDNY\\ CHKPATH.TXT ${kw}`)).toBe(0);
      expect(existsSync(join(U, 'CHKPATH.TXT'))).toBe(true);
      run(`CHKPATH.BAT $ C:\\UCTO2026\\NENI\\ CHKPATH.TXT ${kw}`);
      expect(existsSync(join(U, 'CHKPATH.TXT'))).toBe(false);
    }
  });
  it('RENVYP.BAT and REN3BKP.BAT: copy+delete, rename inside the source directory', () => {
    process.chdir(U);
    run('RENVYP.BAT $ C:\\UCTO2026\\{STAN}\\ VYP1.TXT VYP1.TXT'); // equal names: nothing
    expect(existsSync(join(U, '{stan}', 'VYP1.TXT'))).toBe(true);
    run('RENVYP.BAT $ C:\\UCTO2026\\{STAN}\\ VYP1.TXT VYP2.TXT');
    expect(existsSync(join(U, '{stan}', 'VYP1.TXT'))).toBe(false);
    expect(readFileSync(join(U, '{stan}', 'VYP2.TXT'), 'latin1')).toBe('VYP1.TXT');
    run('REN3BKP.BAT $ C:\\UCTO2026\\BKP\\FIRMA.262 FIRMA.262 2026-03-01_08-30_');
    expect(readdirSync(join(U, 'BKP')).sort()).toEqual([
      '2026-03-01_08-30_FIRMA.262B', '2026-03-01_08-30_FIRMA.262T', '2026-03-01_08-30_FIRMA.262Z',
    ]);
  });
  it('{OBNV}.BAT: md, copy to dir\\*.*, copy to dir\\*.EX renames the extension', () => {
    process.chdir(U);
    expect(run('{OBNV}.BAT $')).toBe(0);
    expect(readdirSync(join(U, '{OBNV}')).sort()).toEqual(['MODULY.000', 'SAZDPH.000', 'UCTO2026.CAT', 'UCTOOL.EX']);
    expect(readFileSync(join(U, '{OBNV}', 'UCTO2026.CAT'))).toEqual(readFileSync(join(APP, 'UCTO2026.CAT')));
    expect(readFileSync(join(U, '{OBNV}', 'UCTOOL.EX'), 'latin1')).toBe('MZ fake');
  });
  it('DELPRAC.BAT: DEL with ? wildcards', () => {
    process.chdir(U);
    run('DELPRAC.BAT');
    expect(readdirSync(join(U, '{stan}')).sort()).toEqual(['KEEP.000', 'VYP2.TXT']);
  });
  it('UCTOBAT2 style: quoted paths with blanks, >null discards; COPY a+b c; REN; TYPE; RD', () => {
    process.chdir(U);
    expect(run('@copy "C:\\UCTO2026\\Moje doklady\\f a.pdf" "C:\\UCTO2026\\out b.pdf" >null')).toBe(0);
    expect(readFileSync(join(U, 'out b.pdf'), 'latin1')).toBe('%PDF');
    expect(existsSync(join(U, 'null'))).toBe(false);
    writeFileSync(join(U, 'P1.TXT'), 'one,');
    writeFileSync(join(U, 'P2.TXT'), 'two');
    expect(run('copy /b P1.TXT + P2.TXT P3.TXT')).toBe(0);
    expect(readFileSync(join(U, 'P3.TXT'), 'latin1')).toBe('one,two');
    expect(run('type p1.txt p2.txt >T.TXT')).toBe(0); // case-insensitive names
    expect(readFileSync(join(U, 'T.TXT'), 'latin1')).toBe('one,two');
    expect(run('copy NENI.TXT X.TXT')).toBe(1);
    expect(run('ren P3.TXT P4.TXT')).toBe(0);
    expect(run('ren P1.TXT P4.TXT')).toBe(1); // duplicate name
    expect(existsSync(join(U, 'P4.TXT'))).toBe(true);
    expect(run('md C:\\UCTO2026\\RDX')).toBe(0);
    expect(run('rd C:\\UCTO2026\\RDX')).toBe(0);
    expect(existsSync(join(U, 'RDX'))).toBe(false);
    for (const c of ['cd \\', 'mode con: cols=80 lines=25', 'kb16 cz,852', 'share', 'path x']) expect(run(c)).toBe(0);
  });
  it('the helper registry dispatches EXE lines of a batch; exit code of the batch = last command', () => {
    process.chdir(U);
    const seen: { nm: string; ext: string; dir: string; av: string[] }[] = [];
    registerHelper('UCTOLNKD.EXE', (Nm, Ext, Dir, Av: TArgs, nAv, ExitCode) => {
      seen.push({ nm: Nm, ext: Ext, dir: Dir, av: Av.slice(1, nAv + 1) });
      ExitCode.v = 3;
      return true;
    });
    writeFileSync(join(U, 'HLP.BAT'), '@echo off\r\nrem x\r\n{TISK}\\UCTOLNKD.EXE $ a "b c"\r\n');
    expect(run('HLP.BAT')).toBe(3);
    expect(seen).toEqual([{ nm: 'UCTOLNKD', ext: 'EXE', dir: '{tisk}/', av: ['a', 'b c'] }]); // relative to the cwd
    // FandDosExtra is asked when no helper is registered
    registerHelper('UCTOLNKD.EXE', null);
    FandDosVars.FandDosExtra = (Nm, Ext, Dir, Av, nAv, ExitCode) => {
      ExitCode.v = 7;
      return Nm === 'UCTOLNKD';
    };
    try {
      expect(run('{TISK}\\UCTOLNKD.EXE x')).toBe(7);
      expect(FandDosCmd('OTHER.EXE', ref(0))).toBe(false);
    } finally {
      FandDosVars.FandDosExtra = null;
    }
    // GOTO, IF "a"=="b", %%, CALL
    writeFileSync(
      join(U, 'G.BAT'),
      'if "%1"=="x" goto :jump\r\necho no>G.TXT\r\ngoto end\r\n:JUMP\r\necho yes %2>G.TXT\r\ncall H2.BAT\r\n:end\r\n',
    );
    writeFileSync(join(U, 'H2.BAT'), 'echo called>>G.TXT\r\n');
    run('G.BAT x y');
    expect(readFileSync(join(U, 'G.TXT'), 'latin1')).toBe('yes y\r\ncalled\r\n');
    run('G.BAT z');
    expect(readFileSync(join(U, 'G.TXT'), 'latin1')).toBe('no\r\n');
  });
  it('writes can be confined (FandDosWritable)', () => {
    FandDosVars.FandDosNotice = '';
    FandDosVars.FandDosWritable = (p) => !p.includes('ZAKAZ');
    try {
      expect(run('md C:\\UCTO2026\\ZAKAZ')).toBe(1);
      expect(existsSync(join(U, 'ZAKAZ'))).toBe(false);
      expect(run('ver >C:\\UCTO2026\\ZAKAZ.TXT')).toBe(1);
      expect(FandDosVars.FandDosNotice).toContain('ZAKAZ');
    } finally {
      FandDosVars.FandDosWritable = null;
    }
  });
  it('the exported file helpers', () => {
    expect(FandMaskMatch('DPH.109', 'dph.?09')).toBe(true);
    expect(FandMaskMatch('abc', '*.*')).toBe(false); // ForEachFile treats '*.*' as "all" itself
    expect(FandMaskMatch('a.b.c', '*.c')).toBe(true);
    expect(FandDirPart('C:\\a/b\\c.txt')).toBe('C:\\a/b\\');
    expect(FandNamePart('C:\\a/b\\c.txt')).toBe('c.txt');
    expect(FandWithSlash('/x')).toBe('/x/');
    expect(FandWithSlash('')).toBe('');
    expect(FandUpStr('abcáz')).toBe('ABCáZ');
    expect(FandIntStr(-12.7)).toBe('-12');
    const d = freshDir('dosfiles');
    const dh = H(d) + '/';
    expect(FandWriteWhole(dh + 'b.txt', 'bb', false)).toBe(true);
    expect(FandWriteWhole(dh + 'b.txt', 'b', true)).toBe(true);
    expect(FandReadWhole(dh + 'b.txt')).toBe('bbb');
    expect(FandReadWhole(dh + 'none')).toBe('');
    FandWriteWhole(dh + 'A.TXT', 'aaaa', false);
    mkdirSync(join(d, 'sub', 'deep'), { recursive: true });
    writeFileSync(join(d, 'sub', 'deep', 'x.dat'), 'x');
    utimesSync(join(d, 'A.TXT'), 1700000000, 1700000000);
    utimesSync(join(d, 'b.txt'), 1700000100, 1700000100);
    expect(FandListFiles(dh + '*.*', false, false)).toBe('A.TXT\r\nb.txt\r\n');
    expect(FandListFiles(dh + '*.TXT', false, true)).toBe(dh + 'A.TXT\r\n' + dh + 'b.txt\r\n');
    expect(FandListFiles(dh + '*', true, false)).toBe('sub\r\n');
    const tot = ref(0), newest = ref(0);
    expect(FandTotalSize(dh + '*.txt', tot, newest)).toBe(true);
    expect(tot.v).toBe(7);
    expect(newest.v).toBe(1700000100);
    expect(FandTotalSize(dh + '*.none', tot, newest)).toBe(false);
    expect(FandSearchDown(dh, '*.dat', 2)).toBe(dh + 'sub/deep/x.dat\r\n');
    expect(FandSearchDown(dh, '*.dat', 1)).toBe('');
    FandDeleteFiles(dh + '*.txt');
    expect(readdirSync(d)).toEqual(['sub']);
    const t = new Date(2024, 1, 29, 7, 5, 9);
    const st = Math.trunc(t.getTime() / 1000);
    expect(FandStamp(st)).toBe('29.02.2024 07:05');
    const y = ref(0), mo = ref(0), dd = ref(0), hh = ref(0), mi = ref(0), ss = ref(0);
    FandFileTime(st, y, mo, dd, hh, mi, ss);
    expect([y.v, mo.v, dd.v, hh.v, mi.v, ss.v]).toEqual([2024, 2, 29, 7, 5, 9]);
  });
});

// ---------------------------------------------------------------- OACCESS

describe.skipIf(!haveApp)('OACCESS: catalog, paths, opening and closing Účto files', () => {
  let A = ''; // the task directory (a copy)
  let Chpt: FileD;
  let tipy: FileD;
  let rdb: RdbD;
  const TIPY_RECLEN = 115;
  const TIPY_TEXT = 66; // Text:T displacement (after the deleted flag)
  function catalogFD(): FileD {
    const fd = new FileD();
    fd.Typ = 'C';
    fd.Name = 'Catalog';
    fd.RecLen = 107;
    fd.FrstDispl = 6;
    // FAND.RES message 52: NazUlohy:A,8;NazSouboru:A,8;Ar:N,2;Cesta:A,79;Navesti:A,11
    const f = [aField('NazUlohy', 0, 8), aField('NazSouboru', 8, 8), aField('Ar', 16, 2, 'N'), aField('Cesta', 17, 79), aField('Navesti', 96, 11)];
    for (let i = 0; i < f.length - 1; i++) f[i].Chain = f[i + 1];
    fd.FldD = f[0];
    const av = AccessVars;
    [av.CatRdbName, av.CatFileName, av.CatArchiv, av.CatPathName, av.CatVolume] = f;
    return fd;
  }
  function tipyFD(): FileD {
    const fd = new FileD();
    fd.Typ = 'X';
    fd.Name = 'TIPY';
    fd.RecLen = TIPY_RECLEN;
    fd.FrstDispl = 6;
    fd.XF = new XFile();
    fd.TF = new TFile();
    return fd;
  }
  beforeAll(() => {
    A = freshDir('app');
    for (const f of ['UCTO2026.CAT', 'TIPY.000', 'TIPY.T00']) cpSync(join(APP, f), join(A, f));
    mkdirSync(join(A, '{info}'));
    cpSync(join(APP, '{info}', 'PGMKOD.000'), join(A, '{info}', 'PGMKOD.000'));
    const av = AccessVars;
    av.TopRdbDir = H(A);
    av.TopDataDir = '';
    av.CatFDName = 'UCTO2026';
    av.CatFD = catalogFD();
    Chpt = new FileD();
    Chpt.Typ = '0';
    Chpt.Name = 'UCTO2026';
    Chpt.RecLen = 10;
    tipy = tipyFD();
    Chpt.Chain = tipy;
    rdb = new RdbD();
    rdb.FD = Chpt;
    rdb.RdbDir = H(A);
    rdb.DataDir = H(A);
    av.CRdb = rdb;
    av.Chpt = Chpt;
    av.HelpFD = null;
    BaseVars.FandDir = H(APP) + '/';
    av.CFile = av.CatFD;
    expect(OpenF(Exclusive)).toBe(true);
  });
  afterAll(() => {
    const av = AccessVars;
    av.CFile = av.CatFD;
    CloseFile();
    av.CRdb = null;
    av.CatFD = null;
    av.Chpt = null;
  });

  it('the catalog: path, records, fields, GetCatIRec (single and multi level)', () => {
    const av = AccessVars;
    const cat = av.CatFD!;
    av.CFile = cat;
    SetCPathVol();
    expect(BaseVars.CPath).toBe(H(join(A, 'UCTO2026.CAT')));
    expect(cat.NRecs).toBe(608);
    expect(cat.Handle).not.toBe(0xff);
    expect(RdCatField(104, av.CatFileName)).toBe('TIPY');
    expect(RdCatField(5, av.CatVolume)).toBe('{PRIK}');
    expect(GetCatIRec('TIPY', false)).toBe(104);
    expect(GetCatIRec('tipy', false)).toBe(104); // SEquUpcase
    expect(GetCatIRec('PGMKOD', true)).toBe(0); // belongs to UCTOINFO
    const info = new RdbD();
    info.FD = new FileD();
    info.FD.Typ = '0';
    info.FD.Name = 'UCTOINFO';
    info.ChainBack = rdb;
    info.RdbDir = H(A);
    info.DataDir = H(A);
    av.CRdb = info;
    try {
      expect(GetCatIRec('PGMKOD', false)).toBe(547);
      expect(GetCatIRec('TIPY', false)).toBe(0);
      expect(GetCatIRec('TIPY', true)).toBe(104);
      // a relative catalog path: the data directory of the RDB, '{INFO}' found case-insensitively on open
      const pk = new FileD();
      pk.Typ = '6';
      pk.Name = 'PGMKOD';
      pk.CatIRec = 547;
      const hd = readFileSync(join(APP, '{info}', 'PGMKOD.000'));
      pk.RecLen = hd.readUInt16LE(4);
      pk.FrstDispl = 6;
      if (hd.readInt32LE(0) < 0) {
        pk.Typ = 'X';
        pk.XF = new XFile();
      }
      info.FD.Chain = pk;
      av.CFile = pk;
      SetCPathVol();
      expect(BaseVars.CPath).toBe(H(A) + '/{INFO}/PGMKOD.000');
      expect(OpenF(RdOnly)).toBe(true);
      expect(pk.NRecs).toBe(Math.abs(hd.readInt32LE(0)));
      expect(pk.UMode).toBe(RdOnly);
      CloseFile();
      expect(pk.Handle).toBe(0xff);
      expect(existsSync(join(A, '{info}', 'PGMKOD.000'))).toBe(true);
    } finally {
      av.CRdb = rdb;
    }
  });
  it('SetCPathVol: catalog path, RDB/data/help directories, absolute DOS paths, SetTxtPathVol', () => {
    const av = AccessVars;
    tipy.CatIRec = 104;
    av.CFile = tipy;
    SetCPathVol();
    expect(BaseVars.CPath).toBe(H(join(A, 'TIPY.000')));
    expect([BaseVars.CDir, BaseVars.CName, BaseVars.CExt, BaseVars.CVol]).toEqual([H(A) + '/', 'TIPY', '.000', '']);
    av.CFile = Chpt;
    SetCPathVol();
    expect(BaseVars.CPath).toBe(H(join(A, 'UCTO2026.RDB')));
    const loose = new FileD();
    loose.Typ = '6';
    loose.Name = 'VOLNY';
    av.CFile = loose;
    SetCPathVol();
    expect(BaseVars.CPath).toBe(H(join(A, 'VOLNY.100'))); // not declared in an RDB of the chain
    tipy.Chain = loose;
    SetCPathVol();
    expect(BaseVars.CPath).toBe(H(join(A, 'VOLNY.000')));
    tipy.Chain = null;
    av.HelpFD = loose;
    SetCPathVol();
    expect(BaseVars.CPath).toBe(H(APP) + '/FANDHLP.000');
    av.HelpFD = null;
    // C:\AUTOEXEC.BAT (record 71) through FAND_DRIVE_C
    const drv = freshDir('cdrive');
    process.env.FAND_DRIVE_C = drv;
    try {
      const ab = new FileD();
      ab.Typ = '6';
      ab.Name = 'AUTOEXEC';
      ab.CatIRec = 71;
      Chpt.Chain = ab;
      av.CFile = ab;
      SetCPathVol();
      expect(BaseVars.CPath).toBe(H(drv) + '/AUTOEXEC.BAT');
      RdCatPathVol(71);
      expect(BaseVars.CPath).toBe(H(drv) + '/AUTOEXEC.BAT');
      SetTxtPathVol('C:\\X\\A.TXT', 0);
      expect(BaseVars.CPath).toBe(H(drv) + '/X/A.TXT');
      // a text file by catalog record: relative to the current directory
      process.chdir(A);
      SetTxtPathVol(null, 65);
      expect(BaseVars.CPath).toBe(H(join(A, 'UCTOTXT.UUU')));
    } finally {
      delete process.env.FAND_DRIVE_C;
      Chpt.Chain = tipy;
    }
    // TestMountVol: host paths never ask for a floppy
    BaseVars.CVol = 'DISK1';
    BaseVars.CDir = H(A);
    expect(TestMountVol('/')).toBe(0);
    BaseVars.CVol = '#';
    expect(TestMountVol('A')).toBe(0);
    BaseVars.CVol = '';
  });
  it('WrCatField stores verbatim (BP7), Generation, TurnCat, SetCPathForH', () => {
    const av = AccessVars;
    WrCatField(104, av.CatPathName, 'TIPY.012');
    av.CFile = tipy;
    tipy.CatIRec = 104;
    expect(Generation()).toBe(12);
    WrCatField(104, av.CatPathName, 'C:\\DATA\\TIPY.000');
    SaveCache(0);
    const raw = readFileSync(join(A, 'UCTO2026.CAT'));
    expect(raw.subarray(6 + 103 * 107 + 17, 6 + 103 * 107 + 17 + 16).toString('latin1')).toBe('C:\\DATA\\TIPY.000');
    expect(Generation()).toBe(0);
    WrCatField(104, av.CatPathName, 'TIPY.000');
    // rotate 65..69 by one and back
    const names = (): string[] => [65, 66, 67, 68, 69].map((i) => RdCatField(i, av.CatFileName));
    const before = names();
    av.CFile = null;
    TurnCat(65, 5, 1);
    expect(names()).toEqual([...before.slice(1), before[0]]);
    av.CFile = null;
    TurnCat(65, 5, -1);
    expect(names()).toEqual(before);
    // the owner of a handle (error messages)
    av.CFile = tipy;
    expect(OpenF(Exclusive)).toBe(true);
    const keep = av.CFile;
    SetCPathForH(tipy.TF!.Handle);
    expect(BaseVars.CPath).toBe(H(join(A, 'TIPY.T00')));
    SetCPathForH(tipy.XF!.Handle);
    expect(BaseVars.CPath).toBe(H(join(A, 'TIPY.X00')));
    SetCPathForH(250);
    expect(BaseVars.CPath).toBe(BaseVars.MsgLine);
    expect(av.CFile).toBe(keep);
    CloseFile();
  });
  it('OpenF/CloseFile of an X file with a T file: missing .X is created invalid and dropped on close', () => {
    const av = AccessVars;
    av.CFile = tipy;
    tipy.CatIRec = 104;
    expect(OpenF(Exclusive)).toBe(true);
    const df = new DataFile(join(A, 'TIPY.000'));
    expect(tipy.NRecs).toBe(df.nRecs);
    expect(tipy.NRecs).toBe(2222);
    expect(tipy.LMode).toBe(NullMode);
    expect(tipy.XF!.NotValid).toBe(true);
    expect(existsSync(join(A, 'TIPY.X00'))).toBe(true);
    expect(OpenF(Exclusive)).toBe(true); // already open: no-op
    av.CRecPtr = GetRecSpace();
    ReadRec(7);
    expect(Buffer.from(av.CRecPtr.subarray(0, TIPY_RECLEN)).equals(Buffer.from(df.readRecord(7)))).toBe(true);
    df.close();
    ClosePassiveFD();
    expect(tipy.Handle).toBe(0xff);
    expect(tipy.TF!.Handle).toBe(0xff);
    expect(existsSync(join(A, 'TIPY.X00'))).toBe(false);
    expect(statSync(join(A, 'TIPY.000')).size).toBe(statSync(join(APP, 'TIPY.000')).size);
    expect(readFileSync(join(A, 'TIPY.T00'))).toEqual(readFileSync(join(APP, 'TIPY.T00')));
    // SaveFiles / CloseFANDFiles / OpenFANDFiles over the RDB chain
    av.CFile = tipy;
    OpenF(Exclusive);
    SaveFiles();
    tipy.LMode = ExclMode;
    CloseFANDFiles(false);
    expect(tipy.ExLMode).toBe(ExclMode);
    expect(tipy.Handle).toBe(0xff);
    expect(av.CatFD!.Handle).toBe(0xff);
    Chpt.Handle = 0xff;
    const rdbFile = join(A, 'UCTO2026.RDB');
    writeFileSync(rdbFile, Buffer.from([0, 0, 0, 0, 10, 0])); // an empty chapter file
    Chpt.TF = null;
    OpenFANDFiles(false);
    expect(av.CatFD!.Handle).not.toBe(0xff);
    expect(tipy.Handle).not.toBe(0xff);
    expect(tipy.UMode).toBe(Exclusive); // Shared on a local volume
    CloseFAfter(Chpt.Chain);
    expect(tipy.Handle).toBe(0xff);
    av.CFile = Chpt;
    CloseFile(); // NRecs=0: the file is deleted
    expect(existsSync(rdbFile)).toBe(false);
  });
  it('OpenCreateF creates a new file with its T file; CloseFile deletes them when empty', () => {
    const av = AccessVars;
    const nf = new FileD();
    nf.Typ = '6';
    nf.Name = 'NOVY';
    nf.RecLen = 20;
    nf.FrstDispl = 6;
    nf.TF = new TFile();
    tipy.Chain = nf;
    try {
      av.CFile = nf;
      OpenCreateF(Shared);
      expect(existsSync(join(A, 'NOVY.000'))).toBe(true);
      expect(existsSync(join(A, 'NOVY.T00'))).toBe(true);
      expect(nf.NRecs).toBe(0);
      av.CRecPtr = GetRecSpace();
      av.CRecPtr.set(bytes('abc'));
      PutRec();
      CloseFile();
      expect(statSync(join(A, 'NOVY.000')).size).toBe(26);
      expect(new DataFile(join(A, 'NOVY.000')).nRecs).toBe(1);
      expect(OpenF(Exclusive)).toBe(true);
      expect(RewriteF(false)).toBe(NullMode);
      expect(nf.NRecs).toBe(0);
      CloseFile();
      expect(existsSync(join(A, 'NOVY.000'))).toBe(false);
      expect(existsSync(join(A, 'NOVY.T00'))).toBe(false);
      nf.TF = null;
      av.CFile = nf;
      expect(OpenF(Exclusive)).toBe(false); // missing
    } finally {
      tipy.Chain = null;
    }
  });
  it('OpenDuplF + CopyTFString + SubstDuplF replace the files; DelDuplF drops a copy', () => {
    const av = AccessVars;
    av.CFile = tipy;
    tipy.CatIRec = 104;
    expect(OpenF(Exclusive)).toBe(true);
    const dup = OpenDuplF(true)!;
    expect(av.CFile).toBe(dup);
    expect(dup.TF).not.toBe(tipy.TF);
    expect(existsSync(join(A, 'TIPY.100'))).toBe(true);
    expect(existsSync(join(A, 'TIPY.200'))).toBe(true);
    const picks = [1, 2, 100, 2222];
    const rec = GetRecSpace();
    for (const i of picks) {
      av.CFile = tipy;
      av.CRecPtr = rec;
      ReadRec(i);
      const pos = getLongint(rec, TIPY_TEXT);
      av.CFile = dup; // CFile = the destination (TF.NotCached depends on it)
      const np = CopyTFString(dup.TF, tipy, tipy.TF, pos);
      setLongint(rec, TIPY_TEXT, np);
      PutRec();
    }
    expect(dup.NRecs).toBe(4);
    av.CFile = tipy;
    SubstDuplF(dup, true);
    expect(av.CFile).toBe(tipy);
    expect(tipy.Name).toBe('TIPY');
    expect(tipy.NRecs).toBe(4);
    expect(existsSync(join(A, 'TIPY.100'))).toBe(false);
    expect(existsSync(join(A, 'TIPY.200'))).toBe(false);
    // DelDuplF
    const dup2 = OpenDuplF(false)!;
    expect(dup2.TF).toBe(tipy.TF);
    expect(existsSync(join(A, 'TIPY.100'))).toBe(true);
    av.CFile = tipy;
    DelDuplF(dup2);
    expect(existsSync(join(A, 'TIPY.100'))).toBe(false);
    CloseFile();
    // the new files hold the 4 records and their texts
    const orig = new DataFile(join(APP, 'TIPY.000'));
    const origT = new RawTFile(join(APP, 'TIPY.T00'));
    const df = new DataFile(join(A, 'TIPY.000'));
    const tf = new RawTFile(join(A, 'TIPY.T00'));
    expect(df.nRecs).toBe(4);
    picks.forEach((i, k) => {
      const o = orig.readRecord(i);
      const n = df.readRecord(k + 1);
      expect(Buffer.from(n.subarray(0, TIPY_TEXT)).equals(Buffer.from(o.subarray(0, TIPY_TEXT)))).toBe(true);
      const op = new DataView(o.buffer, o.byteOffset).getInt32(TIPY_TEXT, true);
      const np = new DataView(n.buffer, n.byteOffset).getInt32(TIPY_TEXT, true);
      expect(tf.read(np)).toEqual(origT.read(op));
    });
    expect(statSync(join(A, 'TIPY.T00')).size).toBeLessThan(statSync(join(APP, 'TIPY.T00')).size);
    for (const x of [orig, df]) x.close();
    for (const x of [origT, tf]) x.close();
  });
  it('a network volume (#): shared open, temporary files in WrkDir, SubstDuplF copies back', () => {
    const av = AccessVars;
    for (const f of ['TIPY.000', 'TIPY.T00']) cpSync(join(APP, f), join(A, f));
    const wrk = freshDir('wrk');
    BaseVars.WrkDir = H(wrk) + '/';
    WrCatField(104, av.CatVolume, '#');
    try {
      av.CFile = tipy;
      tipy.CatIRec = 104;
      expect(OpenF(Shared)).toBe(true);
      expect(tipy.UMode).toBe(Shared);
      expect(tipy.NotCached()).toBe(true);
      const dup = OpenDuplF(true)!;
      expect(existsSync(join(wrk, 'TIPY.100'))).toBe(true);
      expect(existsSync(join(wrk, 'TIPY.200'))).toBe(true);
      const rec = GetRecSpace();
      for (const i of [5, 6]) {
        av.CFile = tipy;
        av.CRecPtr = rec;
        ReadRec(i);
        av.CFile = dup;
        setLongint(rec, TIPY_TEXT, CopyTFString(dup.TF, tipy, tipy.TF, getLongint(rec, TIPY_TEXT)));
        PutRec();
      }
      av.CFile = tipy;
      SubstDuplF(dup, true);
      expect(tipy.NRecs).toBe(2);
      expect(readdirSync(wrk)).toEqual([]); // the temporary files were copied and deleted
      CloseFile();
      const df = new DataFile(join(A, 'TIPY.000'));
      expect(df.nRecs).toBe(2);
      expect(df.fileSize).toBe(6 + 2 * TIPY_RECLEN);
      const orig = new DataFile(join(APP, 'TIPY.000'));
      const tf = new RawTFile(join(A, 'TIPY.T00'));
      const origT = new RawTFile(join(APP, 'TIPY.T00'));
      const tp = (r: Uint8Array): number => new DataView(r.buffer, r.byteOffset).getInt32(TIPY_TEXT, true);
      expect(tf.read(tp(df.readRecord(2)))).toEqual(origT.read(tp(orig.readRecord(6))));
      for (const x of [orig, df]) x.close();
      for (const x of [origT, tf]) x.close();
    } finally {
      WrCatField(104, av.CatVolume, '');
    }
  });
});

// ---------------------------------------------------------------- OLONGSTR

describe.skipIf(!haveApp)('OLONGSTR: host texts and T-file text copies', () => {
  let D = '';
  const fdOf = (tf: TFile): FileD => {
    const fd = new FileD();
    fd.Typ = '6';
    fd.Name = 'T';
    fd.UMode = Exclusive;
    fd.LMode = ExclMode;
    fd.TF = tf;
    return fd;
  };
  const newTF = (name: string): [FileD, TFile] => {
    const tf = new TFile();
    const fd = fdOf(tf);
    AccessVars.CFile = fd;
    BaseVars.CPath = H(join(D, name));
    tf.Create();
    fd.Handle = tf.Handle; // an open data file for NewLMode (TryLMode opens a closed one)
    return [fd, tf];
  };
  /** the whole text at Pos through CopyTFStringToH */
  const textAt = (fd: FileD, tf: TFile, pos: number): Buffer => {
    RunFrmlVars.TFD02 = fd;
    RunFrmlVars.TF02 = tf;
    RunFrmlVars.TF02Pos = pos;
    BaseVars.CPath = H(join(D, 'out.bin'));
    const h = OpenH(_isoverwritefile, Exclusive);
    CopyTFStringToH(h);
    CloseH(h);
    return readFileSync(join(D, 'out.bin'));
  };
  beforeAll(() => {
    D = freshDir('longstr');
    AccessVars.CatFD = null;
  });

  it('GetTxt: offset/length arguments, LastTxtPos, a missing file, truncation at 65000', () => {
    writeFileSync(join(D, 'a.txt'), 'Hello world');
    const Z = new FrmlElem(_gettxt);
    Z.TxtPath = H(join(D, 'a.txt'));
    expect(BytesToStr(GetTxt(Z))).toBe('Hello world');
    expect(AccessVars.LastTxtPos).toBe(11);
    Z.P1 = constFrml(7);
    Z.P2 = constFrml(3);
    expect(BytesToStr(GetTxt(Z))).toBe('wor');
    expect(AccessVars.LastTxtPos).toBe(9);
    Z.P1 = constFrml(100);
    expect(GetTxt(Z).length).toBe(0);
    Z.TxtPath = H(join(D, 'none.txt'));
    expect(GetTxt(Z).length).toBe(0);
    const big = makeText(70000, 1);
    writeFileSync(join(D, 'big.txt'), big);
    const Z2 = new FrmlElem(_gettxt);
    Z2.TxtPath = H(join(D, 'big.txt'));
    const s = GetTxt(Z2);
    expect(s.length).toBe(65000);
    expect(BaseVars.LastExitCode).toBe(1);
    expect(Buffer.from(s).equals(Buffer.from(big.subarray(0, 65000)))).toBe(true);
  });
  it('CopyTFFromGetTxt / CopyTFString / CopyTFStringToH: short, multi-page and continued (> 65000) texts', () => {
    const [fd1, tf1] = newTF('SRC.T00');
    const texts = [makeText(100, 2), makeText(509, 3), makeText(3000, 4), makeText(65000, 5), makeText(140000, 6)];
    const pos1: number[] = [];
    texts.forEach((t, i) => {
      writeFileSync(join(D, `t${i}.txt`), t);
      const Z = new FrmlElem(_gettxt);
      Z.TxtPath = H(join(D, `t${i}.txt`));
      AccessVars.CFile = fd1;
      pos1.push(CopyTFFromGetTxt(tf1, Z));
    });
    expect(pos1[0]).toBe(512); // a short text at FreePart of the new file
    texts.forEach((t, i) => expect(textAt(fd1, tf1, pos1[i]).equals(Buffer.from(t))).toBe(true));
    AccessVars.CFile = fd1;
    tf1.WrPrefix();
    SaveCache(0);
    const raw = new RawTFile(join(D, 'SRC.T00'));
    for (let i = 0; i < 4; i++) expect(Buffer.from(raw.read(pos1[i])).equals(Buffer.from(texts[i]))).toBe(true);
    raw.close();
    // copy into another T file
    const [fd2, tf2] = newTF('DST.T00');
    AccessVars.CFile = fd2;
    expect(CopyTFString(tf2, fd1, tf1, 0)).toBe(0);
    const pos2 = pos1.map((p) => {
      AccessVars.CFile = fd2;
      return CopyTFString(tf2, fd1, tf1, p);
    });
    expect(AccessVars.CFile).toBe(fd2);
    texts.forEach((t, i) => expect(textAt(fd2, tf2, pos2[i]).equals(Buffer.from(t))).toBe(true));
    // an empty host file stores nothing
    writeFileSync(join(D, 'empty.txt'), '');
    const Z = new FrmlElem(_gettxt);
    Z.TxtPath = H(join(D, 'empty.txt'));
    expect(CopyTFFromGetTxt(tf2, Z)).toBe(0);
    RunFrmlVars.TF02Pos = 0;
    CopyTFStringToH(0xff); // nothing to write
    for (const [fd, tf] of [[fd1, tf1], [fd2, tf2]] as const) {
      AccessVars.CFile = fd;
      tf.WrPrefix();
      SaveCache(0);
      CloseH(tf.Handle);
    }
  });
});

// ---------------------------------------------------------------- PRINTTXT

describe.skipIf(!haveApp)('PRINTTXT: dot commands, header/footer, print manager', () => {
  let D = '';
  const setPrinter = (toMgr: boolean, strings: string[]): void => {
    const s: number[] = [];
    for (const x of strings) s.push(x.length, ...bytes(x));
    BaseVars.printer[0] = {
      Strg: Uint8Array.from(s), Typ: 'P', Kod: '\0', Lpti: 1, TmOut: 0, OpCls: false, ToHandle: true, ToMgr: toMgr,
      Handle: 0xff,
    };
    BaseVars.prCurr = 0;
    BaseVars.prMax = 1;
  };
  beforeAll(() => {
    D = freshDir('print');
    BaseVars.Spec.CpLines = 0;
    BaseVars.Spec.AutoRprtLimit = 60;
    BaseVars.Spec.ChoosePrMsg = false;
  });
  afterAll(() => {
    BaseVars.prCurr = -1;
  });

  it('PrintArray: .pl/.he/.fo with page numbers, automatic form feeds', () => {
    process.chdir(D);
    setPrinter(false, []);
    const txt = '.pl 8\r\n.he H__\r\n.fo F__\r\na\r\nb\r\nc\r\nd\r\ne\r\n';
    PrintArray(bytes(txt), txt.length, true);
    const out = readFileSync(join(D, 'LPT1.PRN'), 'latin1');
    expect(out).toBe(' H 1\r\n\r\na\r\nb\r\nc\r\nd\r\n\r\n F 1\r\n\x0c H 2\r\n\r\ne\r\n\r\n\r\n\r\n\r\n F 2\r\n\x0c');
    expect(AccessVars.RprtPage).toBe(2);
    // .ff: no final form feed; a leading ^L of a line is a page break
    const t2 = '.ff\r\nx\r\n\x0cy\r\n\r\nz';
    PrintArray(bytes(t2), t2.length, true);
    expect(readFileSync(join(D, 'LPT1.PRN'), 'latin1')).toBe('x\r\n\x0cy\r\n\r\nz\r\n');
  });
  it('PrintTxtFile starts the output at BegPos; the print manager gets a spool copy', () => {
    process.chdir(D);
    setPrinter(false, []);
    writeFileSync(join(D, 'r.txt'), 'x1\r\nx2\r\nx3\r\n');
    BaseVars.CPath = H(join(D, 'r.txt'));
    PrintTxtFile(5);
    expect(readFileSync(join(D, 'LPT1.PRN'), 'latin1')).toBe('x2\r\nx3\r\n\x0c');
    // printer with a manager: prMgrFileNm (15) '#' = 1, 2, ...; no manager program
    const strs = Array.from({ length: 18 }, () => '');
    strs[15] = H(join(D, 'SPOOL#.TXT'));
    setPrinter(true, strs);
    const t = '.pl 20\r\nabc\r\n';
    PrintArray(bytes(t), t.length, true);
    const spool = readdirSync(D).filter((f) => f.startsWith('SPOOL'));
    expect(spool.length).toBe(1);
    expect(readFileSync(join(D, spool[0]), 'latin1')).toBe(t);
    BaseVars.CPath = H(join(D, 'r.txt'));
    PrintTxtFile(0);
    const spool2 = readdirSync(D).filter((f) => f.startsWith('SPOOL')).sort();
    expect(spool2.length).toBe(2);
    expect(readFileSync(join(D, spool2.find((f) => f !== spool[0])!), 'latin1')).toBe('x1\r\nx2\r\nx3\r\n');
    // a missing file: message, nothing printed
    BaseVars.CPath = H(join(D, 'none.txt'));
    PrintTxtFile(0);
  });
});

// ---------------------------------------------------------------- OLDTXX

describe('OLDTXX: the .TTT prefix repair tool', () => {
  it('old format with a negative FreePart: negated, FreePage := ML, truncated', () => {
    const D = freshDir('oldtxx');
    const T = new Uint8Array(2048);
    T[2] = 2; // OldMaxPage = 2
    setLongint(T, 4, -700);
    writeFileSync(join(D, 'A.TTT'), T);
    OldTxx(H(join(D, 'A')));
    const r = readFileSync(join(D, 'A.TTT'));
    expect(r.length).toBe(1536);
    expect(r.readInt32LE(0)).toBe(1536);
    expect(r.readInt32LE(4)).toBe(700);
    // FreePart >= 0: left alone
    OldTxx(H(join(D, 'A.TTT')));
    expect(readFileSync(join(D, 'A.TTT'))).toEqual(r);
  });
  it('new format with an empty password: converted to the old one, texts still readable', () => {
    const D = join(TMP, 'oldtxx');
    mkdirSync(D, { recursive: true });
    const tf = new TFile();
    const fd = new FileD();
    fd.Typ = '6';
    fd.UMode = Exclusive;
    fd.TF = tf;
    AccessVars.CFile = fd;
    BaseVars.CPath = H(join(D, 'B.T00'));
    tf.Create();
    const text = makeText(2000, 9);
    const pos = tf.Store(text);
    tf.WrPrefix();
    SaveCache(0);
    const pw = tf.PwCode;
    CloseH(tf.Handle);
    const before = readFileSync(join(D, 'B.T00'));
    expect(before.readUInt32LE(0)).toBe(0xffff0001);
    OldTxx(H(join(D, 'B.T00')));
    const after = readFileSync(join(D, 'B.T00'));
    const ML = (before.readInt32LE(17) + 1) * 512; // MaxPage is not coded
    expect(after.readInt32LE(0)).toBe(ML);
    expect(after.readUInt16LE(11)).toBe((before.readUInt16LE(11) - 0x4000) & 0xffff);
    const tf2 = new TFile();
    fd.TF = tf2;
    BaseVars.CPath = H(join(D, 'B.T00'));
    tf2.Handle = OpenH(_isoldfile, Exclusive);
    tf2.RdPrefix(false);
    expect(tf2.PwCode).toBe(pw);
    expect(Buffer.from(tf2.Read(1, pos)).equals(Buffer.from(text))).toBe(true);
    CloseH(tf2.Handle);
  });
});
