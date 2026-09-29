// Package "proj-main": WWMIX, RUNPROJ (PROJMGR1/PROJMGR), RUNFAND, RUNBATCH and FAND (main).
// Unit tests of the helpers, then whole sessions of the ported engine on copies of the installed
// Účto (work/tmp-proj-main/): main() runs in-process on a Crt whose key queue is closed; whenever
// the engine would wait for a key, the test looks at the screen and types the answer (like
// src/engine/testing/ucto.ts does for the reference FAND). A screen without an answer ends the
// session with EngineShutdown and the screen in the error message.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Crt, UNICODE_KEY } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { K, fKey } from '../src/engine/console/keys.ts';
import { decode852 } from '../src/engine/console/cp852.ts';
import { UCTO_START_ANSWERS, UCTO_MAIN_MENU } from '../src/engine/testing/ucto.ts';
import { FromUnicode } from '../src/engine/pas/pasrt.ts';
import { BaseVars } from '../src/engine/pas/base.ts';
import { AccessVars, TFile, FileD, RdbD, Code } from '../src/engine/pas/access.ts';
import { WwMixVars, PutSelect, GetSelect, SetPassword, HasPassword, HasPasswordAuth, SelMark } from '../src/engine/pas/wwmix.ts';
import { ExtToTyp, IsCurrChpt, RdFDSegment } from '../src/engine/pas/runproj.ts';
import { main, type FandMainOptions } from '../src/engine/pas/fand.ts';
import { Rdb } from '../src/engine/fand/rdb.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const WORK = join(ROOT, 'work/tmp-proj-main');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB')) && existsSync(join(APP, 'FAND.RES'));
const startCwd = process.cwd();
Error.stackTraceLimit = 50;

/** Byte string of a Unicode text (CP852) and back. */
const B = (u: string): string => FromUnicode(u);
const U = (b: string): string => decode852(Uint8Array.from(b, (c) => c.charCodeAt(0)));

/** A fresh copy of the installed application. */
function copyApp(label: string): string {
  const dir = join(WORK, label);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(APP, dir, { recursive: true });
  return dir;
}

interface Answer {
  name: string;
  when: RegExp;
  keys: (number | string)[];
  /** how often it may answer (default: always) */
  times?: number;
  /** runs when it answers (e.g. to record engine state) */
  probe?: () => void;
}
interface Session {
  code: number;
  seen: string[];
  screens: string[];
  stderr: string;
}

/** Runs main() and answers every screen the engine waits on (see the file comment). */
function session(opts: FandMainOptions, answers: Answer[], maxAnswers = 200): Session {
  const q = new KeyQueue();
  q.close();
  const crt = new Crt(q, null, 80, 25);
  const seen: string[] = [];
  const screens: string[] = [];
  const used = new Map<Answer, number>();
  const text = (): string => {
    const rows: string[] = [];
    for (let y = 0; y < 25; y++) rows.push(crt.screen.rowText(y).trimEnd());
    return rows.join('\n');
  };
  const orig = crt.readKey.bind(crt);
  crt.readKey = (t?: number) => {
    if (!crt.keyPressed() && seen.length < maxAnswers) {
      const t0 = text();
      const a = answers.find((x) => x.when.test(t0) && (used.get(x) ?? 0) < (x.times ?? Infinity));
      if (a) {
        used.set(a, (used.get(a) ?? 0) + 1);
        seen.push(a.name);
        screens.push(t0);
        a.probe?.();
        for (const k of a.keys) q.push(typeof k === 'number' ? k : UNICODE_KEY | k.charCodeAt(0));
      }
    }
    return orig(t);
  };
  const errs: string[] = [];
  const w = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((s: string) => {
    errs.push(String(s));
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = main(crt, opts);
    return { code, seen, screens, stderr: errs.join('') };
  } catch (e) {
    throw new Error(`${(e as Error).stack}\nanswered: ${seen.join(', ')}\nstderr: ${errs.join('')}\n--- screen ---\n${text()}`);
  } finally {
    process.stderr.write = w;
    process.chdir(startCwd);
  }
}

/** Účto from its start to the main menu, then quit (Esc closes the pull-down, Esc, Enter = "A"). */
const UCTO_RUN: Answer[] = [
  { name: 'quit?', when: /Ukončit program účto \?/, keys: [K.Enter] },
  { name: 'main menu', when: UCTO_MAIN_MENU, keys: [K.Esc] },
  ...UCTO_START_ANSWERS.map((a) => ({ name: a.name, when: a.when, keys: a.keys })),
];

afterAll(() => {
  process.chdir(startCwd);
});

// ---------------------------------------------------------------- WWMIX (no screen)

describe('WWMIX: selection list', () => {
  it('PutSelect on an empty list resets ss; GetSelect (single) returns the current item', () => {
    const ss = WwMixVars.ss;
    ss.Empty = true;
    ss.Subset = true; // reset by the first PutSelect (FillChar(ss.Abcd, sizeof(ss)-5, 0))
    ss.Abcd = true;
    PutSelect(B('první'));
    expect(ss.Empty).toBe(false);
    expect(ss.Subset).toBe(false);
    expect(ss.Abcd).toBe(false);
    PutSelect('DRUHA');
    PutSelect('x'.repeat(60)); // cut to 46
    // without SelectStr sv.iItem is 0 and GetItem(0) is the first item (for i:=2 to 0)
    expect(U(GetSelect())).toBe('první');
  });
  it('GetSelect in subset mode returns only tagged items', () => {
    const ss = WwMixVars.ss;
    ss.Empty = true;
    PutSelect('A');
    PutSelect(SelMark + 'B');
    ss.Subset = true;
    expect(GetSelect()).toBe('');
    expect(ss.Tag).toBe(' ');
  });
});

describe('WWMIX: passwords in the T-file header (BP7 layout)', () => {
  function fd(): FileD {
    const f = new FileD();
    f.TF = new TFile();
    const e = new Uint8Array(20).fill(0x40);
    Code(e, 20);
    f.TF.PwCode = String.fromCharCode(...e);
    f.TF.Pw2Code = String.fromCharCode(...e);
    return f;
  }
  it('an empty password is 20 x "@" XOR $AA', () => {
    const f = fd();
    expect(HasPassword(f, 1, '')).toBe(true);
    expect(HasPassword(f, 2, '')).toBe(true);
    expect(HasPassword(f, 1, 'x')).toBe(false);
  });
  it('SetPassword pads with "@" and codes with $AA; HasPassword compares', () => {
    const f = fd();
    SetPassword(f, 1, 'heslo');
    const raw = Array.from(f.TF!.PwCode, (c) => c.charCodeAt(0) ^ 0xaa);
    expect(String.fromCharCode(...raw)).toBe('heslo' + '@'.repeat(15));
    expect(HasPassword(f, 1, 'heslo')).toBe(true);
    expect(HasPassword(f, 1, 'HESLO')).toBe(false);
    expect(HasPassword(f, 2, '')).toBe(true);
    SetPassword(f, 2, 'x'.repeat(25)); // string20
    expect(HasPassword(f, 2, 'x'.repeat(20))).toBe(true);
    // BP7: no empty-password shortcut (FPC HasPasswordAuth accepted '')
    expect(HasPasswordAuth(f, 1, '')).toBe(false);
  });
});

// ---------------------------------------------------------------- RUNPROJ helpers

describe('RUNPROJ: chapter helpers', () => {
  it('ExtToTyp', () => {
    expect(ExtToTyp('')).toBe('6');
    expect(ExtToTyp('.hlp')).toBe('6');
    expect(ExtToTyp('.X')).toBe('X');
    expect(ExtToTyp('.dta')).toBe('8');
    expect(ExtToTyp('.DBF')).toBe('D');
    expect(ExtToTyp('.Rdb')).toBe('0');
    expect(ExtToTyp('.000')).toBe('?');
    expect(ExtToTyp('.SQL')).toBe('?'); // FandSQL off
  });
  it('RdFDSegment is the FPC no-op (always recompile)', () => {
    expect(RdFDSegment(1, 1234)).toBe(false);
  });
  it('IsCurrChpt compares CRdb^.FD with CFile', () => {
    const r = new RdbD();
    const f = new FileD();
    r.FD = f;
    AccessVars.CRdb = r;
    AccessVars.CFile = f;
    expect(IsCurrChpt()).toBe(true);
    AccessVars.CFile = new FileD();
    expect(IsCurrChpt()).toBe(false);
    AccessVars.CRdb = null;
  });
});

// ---------------------------------------------------------------- sessions

describe.skipIf(!haveApp)('FAND main: `ufand ucto2026` (U.BAT)', () => {
  let dir: string;
  let s: Session;
  let atMenu: { rdbs: string[]; top: string; enc: boolean; cwd: string; files: string[] } | null = null;
  beforeAll(() => {
    dir = copyApp('ucto');
    const probe = (): void => {
      if (atMenu) return;
      const rdbs: string[] = [];
      for (let r = AccessVars.CRdb; r !== null; r = r.ChainBack) rdbs.push(r.FD!.Name);
      let top = AccessVars.CRdb!;
      while (top.ChainBack !== null) top = top.ChainBack;
      const files: string[] = [];
      for (let f = top.FD; f !== null; f = f.Chain) files.push(f.Name);
      atMenu = { rdbs, top: top.RdbDir, enc: top.Encrypted, cwd: process.cwd(), files };
    };
    const answers = UCTO_RUN.map((a) => (a.name === 'main menu' ? { ...a, probe } : a));
    s = session({ appDir: dir, task: 'ucto2026', env: { FANDOVRB: '80' } }, answers);
  }, 120000);

  it('starts Účto like the reference FAND and quits with 0', () => {
    expect(s.code).toBe(0);
    // no 'Přemístění programu': the task sees DOS paths (HANDLE DosView), so the server directory
    // (SERVER.Path + '\\') equals the one stored at the last start, as on DOS/Windows. With host
    // paths it was '/…/ucto/\\' and never matched.
    expect(s.seen).not.toContain('Přemístění programu');
    expect(s.seen).toContain('VYBERTE VERZI');
    expect(s.seen).toContain('main menu');
    expect(s.seen[s.seen.length - 1]).toBe('quit?');
    expect(s.stderr).toBe('');
  });
  it('the task runs with its compiled chapter file (FileDRoot = UCTO2026 + the F chapters)', () => {
    expect(atMenu).not.toBeNull();
    const m = atMenu!;
    expect(m.rdbs[m.rdbs.length - 1]).toBe('ucto2026');
    expect(U(m.top)).toBe('C:\\ucto'); // DOS view: C: is the parent of the application directory
    expect(m.enc).toBe(true); // licensed chapters (LicenseNr <> 0)
    const rdb = new Rdb(join(dir, 'UCTO2026.RDB'));
    const fNames = rdb.chapters.filter((ch) => ch.typ === 'F').map((ch) => ch.name.replace(/\..*$/, ''));
    expect(m.files[0]).toBe('ucto2026');
    expect(m.files.slice(1, 1 + fNames.length).map((x) => U(x))).toEqual(fNames);
  });
  it('closes everything and deletes the work files (MyExit)', () => {
    expect(AccessVars.CRdb).toBeNull();
    expect(existsSync(join(dir, 'FANDWORK.$$$'))).toBe(false);
    expect(BaseVars.WasInitPgm).toBe(true);
    expect(BaseVars.AbbrYes).toBe('A'); // RdMsg(50)
    expect(BaseVars.AbbrNo).toBe('N');
  });
});

describe.skipIf(!haveApp)('FAND desktop: `ufand` -> Provést úlohu -> select UCTO2026.RDB', () => {
  let s: Session;
  beforeAll(() => {
    const dir = copyApp('desktop');
    s = session({ appDir: dir }, [
      // the desktop menu: first 'Provést úlohu', after the task 'Konec'
      { name: 'desktop run', when: /Provést úlohu/, keys: [K.Down, K.Enter], times: 1 },
      { name: 'mask', when: /vyberte úlohu ─/, keys: [K.Enter], times: 1 },
      { name: 'list', when: /vyberte úlohu ═/, keys: [K.Down, K.Enter], times: 1 },
      ...UCTO_RUN,
      { name: 'desktop quit', when: /Provést úlohu/, keys: [K.Down, K.Down, K.Down, K.Down, K.Enter], times: 1 },
    ]);
  }, 120000);

  it('shows the FAND desktop with the version line', () => {
    const t = s.screens[0];
    expect(t).toMatch(/Ladit úlohu/);
    expect(t).toMatch(/Konec/);
    expect(t).toMatch(/verze\s+4\.2x \(LAN,~GRAPH\)\s+licenční číslo 999001/);
    expect(t.split('\n')[0]).toMatch(/^╔═+╗$/);
  });
  it('SelectDiskFile: mask *.RDB, then the sorted list of tasks and directories', () => {
    expect(s.screens[1]).toMatch(/\*\.RDB/);
    const list = s.screens[2];
    // the task sees DOS paths (HANDLE DosView): directories are '\name' and sort after the
    // files ('\' after the letters, as on DOS), 3 columns x 5 rows per page
    expect(list).toMatch(/║ PGM\.RDB\s+SESTAVY\.RDB\s+TTT\.RDB/);
    expect(list).toMatch(/║ UCTO2026\.RDB\s+\\\.\.\s+\\\{ap02\}/);
    expect(list).toContain('\\{glob}');
    expect(list).toMatch(/ C:\\desktop\\\*\.RDB /);
    expect(list).toMatch(/↓║/); // more items below
    expect(list).toMatch(/Enter-vyber/);
  });
  it('runs the selected task and returns to the desktop; Konec ends with 0', () => {
    expect(s.seen).toContain('main menu');
    expect(s.seen[s.seen.length - 1]).toBe('desktop quit');
    expect(s.code).toBe(0);
    expect(AccessVars.CRdb).toBeNull();
  });
});

describe.skipIf(!haveApp)('RUNBATCH: ufand TASK --source-in DIR / --source-out DIR', () => {
  let dir: string;
  beforeAll(() => {
    dir = copyApp('batch');
  });

  it('--help prints the usage, exit 2', () => {
    const s = session({ appDir: dir, task: '--help' }, []);
    expect(s.code).toBe(2);
    expect(s.stderr).toMatch(/usage: fand TASK --source-in DIR \| --source-out DIR/);
  });
  it('refuses the licensed (encrypted) chapters of UCTO2026, exit 1', () => {
    const s = session({ appDir: dir, task: 'UCTO2026', args: ['--source-out', join(dir, 'out')] }, []);
    expect(s.stderr).toMatch(/UCTO2026: the chapters are password-protected; not written/);
    expect(s.code).toBe(1);
    expect(existsSync(join(dir, 'out'))).toBe(false);
  });
  it('--source-in creates a task from chapter files, --source-out writes them back', () => {
    const src = join(dir, 'src-in');
    mkdirSync(src, { recursive: true });
    const chapters: [string, string][] = [
      ['010-F-Adresy.txt', 'Jmeno:A,20;\nMesto:A,15;\nPocet:F,5.0;\n'],
      ['020-P-main.txt', "{ hlavní procedura - Účto }\nbegin\n  writeln('Ahoj z procedury');\n  wait;\nend;\n"],
      ['030-I-Poznámka.txt', 'Poznámka: příliš žluťoučký kůň\n'],
    ];
    for (const [f, t] of chapters) writeFileSync(join(src, f), (f.startsWith('030') ? '﻿' : '') + t);
    writeFileSync(join(src, 'README.md'), 'not a chapter');
    const tdir = join(dir, 'NOVA');
    mkdirSync(tdir);
    const env = { FANDRES: dir, FANDCFG: dir };
    const s = session({ appDir: tdir, task: 'NOVA', args: ['--source-in', src], env }, []);
    expect(s.stderr).toMatch(/NOVA: 3 chapters from /);
    expect(s.code).toBe(0);
    const rdb = new Rdb(join(tdir, 'NOVA.RDB'));
    expect(rdb.encrypted).toBe(false);
    expect(rdb.chapters.map((c) => `${c.typ}:${c.name}`)).toEqual(['F:Adresy', 'P:main', 'I:Poznámka']);
    expect(rdb.text(rdb.chapters[1])).toBe(chapters[1][1]);
    expect(Buffer.from(rdb.textBytes(rdb.chapters[0])).toString('latin1')).toBe('Jmeno:A,20;\r\nMesto:A,15;\r\nPocet:F,5.0;\r\n');

    const out = join(dir, 'src-out');
    const s2 = session({ appDir: tdir, task: 'NOVA', args: ['--source-out', out], env }, []);
    expect(s2.stderr).toMatch(/NOVA: 3 chapters to /);
    expect(s2.code).toBe(0);
    expect(readdirSync(out).sort()).toEqual(['001-F-Adresy.txt', '002-P-main.txt', '003-I-Poznámka.txt']);
    expect(readFileSync(join(out, '002-P-main.txt'), 'utf8')).toBe(chapters[1][1]);
    expect(readFileSync(join(out, '003-I-Poznámka.txt'), 'utf8')).toBe(chapters[2][1]); // BOM dropped
  });
  it('`ufand NOVA D`: the chapter editor; Ctrl+F9 runs procedure main (CompRunChptRec)', () => {
    const tdir = join(dir, 'NOVA');
    const s = session({ appDir: tdir, task: 'NOVA', args: ['D'], env: { FANDRES: dir, FANDCFG: dir } }, [
      { name: 'editor', when: /F2-nová/, keys: [K.Down, fKey(9, 2)], times: 1 },
      { name: 'user screen', when: /Ahoj z procedury/, keys: [K.Enter], times: 1 },
      { name: 'editor again', when: /F2-nová/, keys: [K.Esc], times: 1 },
      { name: 'desktop', when: /Provést úlohu/, keys: [K.Esc], times: 1 },
    ]);
    expect(s.seen).toEqual(['editor', 'user screen', 'editor again', 'desktop']);
    const ed = s.screens[0].split('\n');
    expect(ed[0]).toMatch(/NOVA\.RDB/);
    expect(ed[2]).toMatch(/^ F\s+Adresy\s+\* Jmeno:A,20;/);
    expect(ed[3]).toMatch(/^ P\s+main\s+\* \{ hlavní procedura - Účto \}/);
    expect(ed[4]).toMatch(/^ I\s+Poznámka/);
    expect(s.code).toBe(0);
  });
  it('Instalace úlohy: the install menu sets the second password (PassWord twice, SetPassword)', () => {
    const tdir = join(dir, 'NOVA');
    const s = session({ appDir: tdir, env: { FANDRES: dir, FANDCFG: dir } }, [
      { name: 'desktop install', when: /Provést úlohu/, keys: [K.Down, K.Down, K.Enter], times: 1 },
      { name: 'mask', when: /vyberte soubor ─/, keys: [K.Enter], times: 1 },
      { name: 'list', when: /vyberte soubor ═/, keys: [K.Home, K.Enter], times: 1 }, // NOVA.RDB, then '\..' (DOS order)
      { name: 'password', when: /zadejte heslo/, keys: ['a', 'b', K.Enter], times: 1 },
      { name: 'again', when: /ke kontrole znovu/, keys: ['a', 'b', K.Enter], times: 1 },
      { name: 'install menu', when: /Nové heslo/, keys: [K.Down, K.Down, K.Enter], times: 1 },
      { name: 'install menu end', when: /Nové heslo/, keys: [K.Esc], times: 1 },
      { name: 'desktop', when: /Provést úlohu/, keys: [K.Esc], times: 1 },
    ]);
    expect(s.seen).toEqual(['desktop install', 'mask', 'list', 'install menu', 'password', 'again', 'install menu end', 'desktop']);
    expect(s.code).toBe(0);
    const rdb = new Rdb(join(tdir, 'NOVA.RDB'));
    expect(rdb.tfile.header.password1).toBe('');
    expect(rdb.tfile.header.password2).toBe('ab');
  });
  it('a compile error is reported with chapter, line and column; the chapters stay stored', () => {
    const src = join(dir, 'src-bad');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, '1-P-main.txt'), 'begin\n  x:=;\nend;\n');
    const tdir = join(dir, 'CHYBA');
    mkdirSync(tdir);
    const env = { FANDRES: dir, FANDCFG: dir };
    const s = session({ appDir: tdir, task: 'CHYBA', args: ['--source-in', src], env }, []);
    expect(s.stderr).toMatch(/chapter 1 P main, line 2 column \d+: /);
    expect(s.stderr).toMatch(/the task does not compile \(the chapters are stored\)/);
    expect(s.code).toBe(1);
    expect(new Rdb(join(tdir, 'CHYBA.RDB')).chapters.length).toBe(1);
  });
});
