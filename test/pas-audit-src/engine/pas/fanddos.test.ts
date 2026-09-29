// Audit of FANDDOS (FandDosCmd / DosExtra / registerHelper) driven by a bring-up discrepancy:
//
// EXEC of Účto's DOS utilities (FILESIZE.EXE, SUBDIR.EXE, DISKSIZE.EXE, SETDATE.EXE, ISSHARE.EXE)
// reached the host shell in both engines ('/bin/sh: FILESIZE.EXE: not found'): the FPC unit only
// has the FandDosExtra hook, which nothing sets. FileSize then left PARAM3.FFF at -2 and Firma1
// skipped copying the {NOVA} templates into a new company. The utilities are now ported in
// fanddos.ts (behaviour read from the disassembled BP7 originals) and answer after the registry
// and FandDosExtra. The tests run them through MEMORY.OSshell, as RUNPROC's exec does.

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, utimesSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Clock, FromUnicode, ref } from '../../../../src/engine/pas/pasrt.ts';
import { BaseVars, OSshell, FormatCache, SetExecHelperHook } from '../../../../src/engine/pas/base.ts';
import {
  FandDosCmd, FandDosVars, FandStamp, DosMaskMatch, DosToolOf, registerHelper, clearHelpers,
} from '../../../../src/engine/pas/fanddos.ts';

const ROOT = join(import.meta.dirname, '../../../..');
const TMP = join(ROOT, 'work/tmp-audit-fanddos');
const C = join(TMP, 'c'); // drive C:

const saveEnv: Record<string, string | undefined> = {};
function setEnv(k: string, v: string | undefined): void {
  if (!(k in saveEnv)) saveEnv[k] = process.env[k];
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(C, { recursive: true });
  FormatCache();
  SetExecHelperHook(null);
});
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});
beforeEach(() => {
  setEnv('FAND_DRIVE_C', FromUnicode(C));
  for (const l of 'ABDEFGHIJK') setEnv('FAND_DRIVE_' + l, undefined);
  setEnv('FAND_DOSTOOLS', undefined);
});
afterEach(() => {
  for (const [k, v] of Object.entries(saveEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  clearHelpers();
});

/** EXEC as RUNPROC does it: OSshell(Path, CmdLine); returns LastExitCode */
function exec(prog: string, params: string): number {
  BaseVars.LastExitCode = 255;
  expect(OSshell(prog, params, true, true, false, false)).toBe(true);
  return BaseVars.LastExitCode;
}
const read = (p: string): string => readFileSync(join(C, p), 'latin1');
function file(p: string, data: string | number, mtime?: Date): void {
  mkdirSync(join(C, p, '..'), { recursive: true });
  writeFileSync(join(C, p), typeof data === 'number' ? Buffer.alloc(data) : data);
  if (mtime) utimesSync(join(C, p), mtime, mtime);
}

describe('FANDDOS: DOS name matching of the utilities (FindFirst, FCB style)', () => {
  it('matches name and extension separately; a trailing ? may match nothing', () => {
    expect(DosMaskMatch('PARAM2.000', '*.*')).toBe(true);
    expect(DosMaskMatch('README', '*.*')).toBe(true);
    expect(DosMaskMatch('README', '*')).toBe(true);
    expect(DosMaskMatch('PARAM2.000', '*')).toBe(false); // '*' = '????????.   '
    expect(DosMaskMatch('DENIK.001', '*.0??')).toBe(true);
    expect(DosMaskMatch('DENIK.0', '*.0??')).toBe(true);
    expect(DosMaskMatch('DENIK.01', '*.0??')).toBe(true);
    expect(DosMaskMatch('DENIK.TXT', '*.0??')).toBe(false);
    expect(DosMaskMatch('DENIK.0001', '*.0??')).toBe(false);
    expect(DosMaskMatch('denik.dbf', 'DENIK.DBF')).toBe(true);
    expect(DosMaskMatch('A.BAT', '?.BAT')).toBe(true);
    expect(DosMaskMatch('AB.BAT', '?.BAT')).toBe(false);
    expect(DosMaskMatch('.', '*.*')).toBe(false);
    expect(DosMaskMatch('..', '*.*')).toBe(false);
  });
});

describe('FANDDOS: FILESIZE.EXE (FileSize, Firma1 new company)', () => {
  it('writes the total size and the newest stamp of the matching files; exit 0', () => {
    const t1 = new Date(2026, 2, 15, 8, 30, 12);
    const t2 = new Date(2026, 4, 1, 17, 5, 0);
    file('UCTO/{DATA}/PARAM2.000', 1200, t1);
    file('UCTO/{DATA}/DENIK.DBF', 34, t2);
    file('UCTO/{DATA}/X', 5, t1);
    mkdirSync(join(C, 'UCTO/{DATA}/SUB'), { recursive: true }); // a directory counts 0
    expect(exec('FILESIZE.EXE', '$ C:\\UCTO\\UCTOTXT.UUU C:\\UCTO\\{DATA}\\*.*')).toBe(0);
    expect(read('UCTO/UCTOTXT.UUU')).toBe('1239\r\n' + FandStamp(Math.trunc(t2.getTime() / 1000)) + '\r\n');
    expect(FandStamp(Math.trunc(t2.getTime() / 1000))).toBe('01.05.2026 17:05');
    // several masks add up; a DOS mask
    expect(exec('FILESIZE.EXE', '$ C:\\UCTO\\UCTOTXT.UUU C:\\UCTO\\{DATA}\\*.0?? C:\\UCTO\\{DATA}\\*')).toBe(0);
    expect(read('UCTO/UCTOTXT.UUU')).toBe('1205\r\n15.03.2026 08:30\r\n');
  });

  it('an empty company directory gives -1 and no stamp (Firma1 then copies {NOVA})', () => {
    mkdirSync(join(C, 'UCTO/{NEW}'), { recursive: true });
    expect(exec('FILESIZE.EXE', '$ C:\\UCTO\\UCTOTXT.UUU C:\\UCTO\\{NEW}\\*.*')).toBe(0);
    expect(read('UCTO/UCTOTXT.UUU')).toBe('-1\r\n\r\n');
    // only empty files: the total is 0, which the original also writes as -1 (with a stamp)
    file('UCTO/{NEW}/E.TXT', 0, new Date(2026, 0, 2, 3, 4));
    expect(exec('FILESIZE.EXE', '$ C:\\UCTO\\UCTOTXT.UUU C:\\UCTO\\{NEW}\\*.*')).toBe(0);
    expect(read('UCTO/UCTOTXT.UUU')).toBe('-1\r\n02.01.2026 03:04\r\n');
  });

  it('exit 1 when the result file cannot be written; a full program path works', () => {
    expect(exec('C:\\UCTO\\FILESIZE.EXE', '$ C:\\NODIR\\OUT.TXT C:\\UCTO\\*.*')).toBe(1);
    expect(exec('filesize', '$ C:\\UCTO\\OUT.TXT C:\\UCTO\\NIC.*')).toBe(0);
    expect(read('UCTO/OUT.TXT')).toBe('-1\r\n\r\n');
  });

  it('the result file is truncated before the scan, as the original Rewrite does', () => {
    file('R/OUT.TXT', 'x'.repeat(500));
    file('R/A.DAT', 7, new Date(2026, 5, 6, 7, 8));
    expect(exec('FILESIZE.EXE', '$ C:\\R\\OUT.TXT C:\\R\\*.*')).toBe(0);
    expect(read('R/OUT.TXT').split('\r\n')[0]).toBe('7'); // not 507
  });
});

describe('FANDDOS: SUBDIR.EXE (VyberDir, SubDir)', () => {
  it('lists the subdirectories (names only, not hidden), sorted; exit 0', () => {
    for (const d of ['{DATA}', 'FIRMA1', 'FIRMA1.BAK', '.git', '{ZAL3}']) mkdirSync(join(C, 'S', d), { recursive: true });
    file('S/SOUBOR.TXT', 'x');
    expect(exec('C:\\S\\SUBDIR.EXE', '$ C:\\S\\ C:\\S\\UCTOTXT.UUU')).toBe(0);
    expect(read('S/UCTOTXT.UUU')).toBe('FIRMA1\r\nFIRMA1.BAK\r\n{DATA}\r\n{ZAL3}\r\n');
  });
  it('the directory is used as given (no \\ added), exit 2 for an unwritable result', () => {
    expect(exec('SUBDIR.EXE', '$ C:\\S C:\\UCTOTXT.UUU')).toBe(0);
    expect(read('UCTOTXT.UUU')).toBe('S\r\n'); // C:\S*.* matches the directory S itself
    expect(exec('SUBDIR.EXE', '$ C:\\S\\ C:\\NODIR\\X.TXT')).toBe(2);
  });
});

describe('FANDDOS: DISKSIZE.EXE (DiskSize)', () => {
  it('writes capacity, free and used bytes and an empty label', () => {
    expect(exec('DISKSIZE.EXE', '$ C:\\DS.TXT C')).toBe(0);
    const l = read('DS.TXT').split('\r\n');
    expect(l).toHaveLength(5);
    const [size, free, used] = l.slice(0, 3).map(Number);
    expect(size).toBeGreaterThan(0);
    expect(size).toBeLessThanOrEqual(65535 * 64 * 512);
    expect(free).toBeGreaterThanOrEqual(0);
    expect(used).toBe(size - free);
    expect(l[3]).toBe('');
    expect(l[4]).toBe('');
  });
  it('a drive that does not exist gives -1, 0, 0 with exit 0; an unwritable result exit 2', () => {
    if (process.platform !== 'win32') {
      expect(exec('DISKSIZE.EXE', '$ C:\\DS.TXT A')).toBe(0);
      expect(read('DS.TXT')).toBe('-1\r\n0\r\n0\r\n\r\n');
    }
    expect(exec('DISKSIZE.EXE', '$ C:\\DS.TXT 1')).toBe(0);
    expect(read('DS.TXT')).toBe('-1\r\n0\r\n0\r\n\r\n');
    expect(exec('DISKSIZE.EXE', '$ C:\\NODIR\\DS.TXT C')).toBe(2);
  });
});

describe('FANDDOS: SETDATE.EXE (SetDate)', () => {
  const now0 = Clock.now;
  afterEach(() => {
    Clock.now = now0;
  });
  it('moves the engine clock, not the host one; an invalid date keeps the date', () => {
    Clock.now = () => new Date(2026, 8, 28, 10, 0, 30);
    expect(exec('SETDATE.EXE', '2030 03 15 08 30')).toBe(0);
    const d = Clock.now();
    expect([d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()]).toEqual([2030, 3, 15, 8, 30, 0]);
    expect(exec('SETDATE.EXE', '2030 02 30 07 15')).toBe(0); // 30 Feb: DOS refuses the date
    const e = Clock.now();
    expect([e.getFullYear(), e.getMonth() + 1, e.getDate(), e.getHours(), e.getMinutes()]).toEqual([2030, 3, 15, 7, 15]);
    expect(exec('SETDATE.EXE', 'x y z 25 00')).toBe(0); // nothing valid: no change
    expect(Clock.now().getHours()).toBe(7);
  });
});

describe('FANDDOS: ISSHARE.EXE (Config1 "SHARE.EXE v *.BAT")', () => {
  it('lists the .BAT files containing the word on C:, exit 0 (SHARE never resident)', () => {
    file('I/A.BAT', '@echo off\r\nc:\\dos\\share.exe /l:500\r\n');
    file('I/B.BAT', 'echo nic\r\n');
    file('I/SUB/C.BAT', 'SHARE\r\n');
    file('I/SUB/D.TXT', 'SHARE\r\n');
    file('I/.hid/E.BAT', 'SHARE\r\n');
    file('I/F.BAT', 'x'.repeat(300) + 'SHARE\r\n'); // beyond a string[255] line
    file('I/G.BAT', 'rem\x1aSHARE\r\n'); // after ^Z
    setEnv('FAND_DRIVE_C', FromUnicode(join(C, 'I')));
    expect(exec('ISSHARE.EXE', '$ *.BAT SHARE C:\\OUT.TXT')).toBe(0);
    expect(readFileSync(join(C, 'I/OUT.TXT'), 'latin1')).toBe('C:\\A.BAT\r\nC:\\SUB\\C.BAT\r\n');
  });
});

describe('FANDDOS: dispatch (registry, FandDosExtra, built-ins, FAND_DOSTOOLS)', () => {
  it('a registered helper and FandDosExtra come first; FAND_DOSTOOLS=0 switches the ports off', () => {
    expect(DosToolOf('FILESIZE', 'EXE')).toBeDefined();
    expect(DosToolOf('filesize', '')).toBeDefined();
    expect(DosToolOf('FILESIZE', 'COM')).toBeUndefined();
    let got: string[] = [];
    registerHelper('FILESIZE.EXE', (_n, _e, _d, Av, nAv, rc) => {
      got = Av.slice(1, nAv + 1);
      rc.v = 7;
      return true;
    });
    const rc = ref(0);
    expect(FandDosCmd('FILESIZE.EXE $ "a b" c', rc)).toBe(true);
    expect([rc.v, got]).toEqual([7, ['a b', 'c']]);
    clearHelpers();
    setEnv('FAND_DOSTOOLS', '0');
    expect(FandDosCmd('FILESIZE.EXE $ C:\\OUT.TXT C:\\*.*', rc)).toBe(false);
    expect(existsSync(join(C, 'OUT.TXT'))).toBe(false);
  });
  it('a stream number is taken off only right before ">" (`echo 1 >x` keeps its 1)', () => {
    const rc = ref(0);
    expect(FandDosCmd('echo 1 >C:\\E1.TXT', rc)).toBe(true);
    expect(read('E1.TXT')).toBe('1\r\n');
    expect(FandDosCmd('echo ahoj 1>C:\\E2.TXT', rc)).toBe(true);
    expect(read('E2.TXT')).toBe('ahoj\r\n');
    expect(FandDosCmd('echo dva 2 1>>C:\\E2.TXT', rc)).toBe(true);
    expect(read('E2.TXT')).toBe('ahoj\r\ndva 2\r\n');
    const w: string[] = [];
    FandDosVars.FandDosWrite = (s) => void w.push(s);
    try {
      expect(FandDosCmd('echo tri 2>nul', rc)).toBe(true);
    } finally {
      FandDosVars.FandDosWrite = null;
    }
    expect(w).toEqual(['tri\r\n']);
  });
});
