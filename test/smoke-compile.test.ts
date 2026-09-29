// Smoke test of the compiler on the whole Účto application: every chapter of UCTO2026.RDB, of each
// .PRO it CALLs and of the separate applications PGM, SESTAVY and TTT is compiled by the ported
// engine in a real FAND session (RUNFAND start-up: FAND.RES, FAND.CFG, work files, help and catalog
// declarations; RUNFAND.SetTopDir opens the task's catalog; PROJMGR.CreateOpenChpt opens each project
// on top of its caller, as CALL does, and CloseChpt closes it).
//
// The copy of Účto is first started once to its main menu (the ported engine in the worker, as the
// app runs it): the first start writes the paths of the .PRO projects into UCTO2026.CAT (they are
// empty in the installation, and CreateOpenChpt finds a sub-project only through its catalog record).
//
// Pass 1 compiles each chapter the way PROJMGR.CompileRdb does with FromCtrlF10 (all chapter types:
// F, D, U, M, R, P, E, L), but keeps going after an error so that every failing chapter is listed.
// Pass 2 runs the ported CompileRdb(Displ=false, Run=true, FromCtrlF10=true) itself on every project
// chain and expects it to succeed wherever pass 1 found no error.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, basename, extname } from 'node:path';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { decode852 } from '../src/engine/console/cp852.ts';
import { GoExitSignal, ref, fref, FSplit, CopyRec, SetParams, FromUnicode } from '../src/engine/pas/pasrt.ts';
import { BaseVars, ExitRecord, NewExit, RestoreExit, RdMsg, LastInChain, InitBase } from '../src/engine/pas/base.ts';
import { SetDriversCrt, InitDriversUnit, DriversVars } from '../src/engine/pas/drivers.ts';
import { AccessVars, RdbPos, ReadRec, ResetCompilePars, _ShortS, _T, type FileD } from '../src/engine/pas/access.ts';
import { SetInpStr, SetInpTTPos } from '../src/engine/pas/compile.ts';
import { RdFileD } from '../src/engine/pas/rdfildcl.ts';
import { ReadMerge } from '../src/engine/pas/rdmerg.ts';
import { ReadReport } from '../src/engine/pas/rdrprt.ts';
import { ReadProcHead, ReadProcBody, ReadDeclChpt } from '../src/engine/pas/rdproc.ts';
import { PushEdit, RdFormOrDesign } from '../src/engine/pas/rdedit.ts';
import { ReadProlog } from '../src/engine/pas/rdprolg.ts';
import { RdRunVars } from '../src/engine/pas/rdrun.ts';
import { TrailChar } from '../src/engine/pas/runfrml.ts';
import { CloseFile } from '../src/engine/pas/oaccess.ts';
import { CreateOpenChpt, CloseChpt, CompileRdb, ExtToTyp } from '../src/engine/pas/runproj.ts';
import { RdUserId } from '../src/engine/pas/projmgr.ts';
import { InitFandSession, SetTopDir } from '../src/engine/pas/runfand.ts';
import { InstallVirtualCwd } from '../src/engine/pas/fand.ts';
import { EngineDriver, K } from '../src/engine/testing/driver.ts';
import { startUcto } from '../src/engine/testing/ucto.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const DIR = join(ROOT, 'work/tmp-smoke-compile/app');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB')) && existsSync(join(APP, 'FAND.RES'));
const startCwd = process.cwd();
Error.stackTraceLimit = 40;

const U = (b: string): string => decode852(Uint8Array.from(b, (c) => c.charCodeAt(0)));

/**
 * The chain of callers each project is compiled under: CALL opens the called project on top of the
 * caller, whose files, functions and procedures its chapters see. From the CALL(name) graph of the
 * sources plus CALLs with computed names (UPG -> MODULnn -> UPGnn, MODUL06 -> SPEC06). UPG04 needs
 * MODUL04 below it (its _DETI.X links PRACOV, declared only in MODUL04; at run time BP7 loads the
 * stored FD segment of the unchanged F chapter instead of recompiling it). The same table as in
 * test/pas-rdproc.test.ts, except that MODUL95 runs under MODUL01 (its catalog record is MODUL01's; the
 * CALLs of MODUL95 in UCTO2026's chapters run with MODUL01 open). A project is found through the
 * catalog records of the projects below it (GetCatIRec MultiLevel). PGM, SESTAVY and TTT are separate
 * applications with their own catalogs.
 */
const CHAINS = [
  'UCTO2026', 'UCTO2026>UCTOINFO', 'UCTO2026>MODUL01', 'UCTO2026>MODUL01>MODUL95',
  ...['02', '03', '04', '05', '06', '07', '08', '09', '99'].map((n) => `UCTO2026>MODUL01>MODUL${n}`),
  ...['02', '03', '04', '05', '06', '07', '08', '09'].map((n) => `UCTO2026>MODUL01>MODUL${n}>SEST${n}`),
  'UCTO2026>MODUL01>MODUL04>MODUL94', 'UCTO2026>MODUL01>MODUL04>MODUL97', 'UCTO2026>MODUL01>MODUL04>MODUL97>SEST97',
  'UCTO2026>MODUL01>SEST01', 'UCTO2026>MODUL01>IMPORT',
  ...['01', '02', '03', '04', '05', '07'].map((n) => `UCTO2026>MODUL01>SPEC${n}`), 'UCTO2026>MODUL01>MODUL06>SPEC06',
  'UCTO2026>MODUL01>UPG', 'UCTO2026>MODUL01>UPG>UPG01', 'UCTO2026>MODUL01>UPG>UPG07', 'UCTO2026>MODUL01>UPG>MODUL98',
  ...['02', '03', '04', '05', '06', '08', '09', '99'].map((n) => `UCTO2026>MODUL01>UPG>MODUL${n}>UPG${n}`),
  'UCTO2026>MODUL01>UPG>MODUL04>MODUL97>UPG97',
  'PGM', 'SESTAVY', 'TTT',
];

/** Compile errors that are expected (none: the first start adds MODUL94's catalog records). */
const KNOWN_ERRORS: string[] = [];

interface ProjectResult {
  chain: string;
  n: Record<string, number>;
  errors: string[];
}

/** PROJMGR.CompileRdb.RdF */
function RdF(FileName: string): void {
  const d = ref(''), name = ref(''), ext = ref('');
  FSplit(FileName, d, name, ext);
  const FDTyp = ExtToTyp(ext.v);
  if (FDTyp === '0') {
    RdMsg(51);
    const s = BaseVars.MsgLine;
    RdMsg(49);
    SetInpStr(ref(s + String(BaseVars.TxtCols - Number(BaseVars.MsgLine.trim()))));
  } else SetInpTTPos(_T(AccessVars.ChptTxt), AccessVars.CRdb!.Encrypted);
  RdFileD(name.v, FDTyp, ext.v);
}

/** Pass 1: the chapter loop of PROJMGR.CompileRdb (FromCtrlF10), one NewExit frame per chapter. */
function compileChapters(chain: string): ProjectResult {
  const a = AccessVars;
  const res: ProjectResult = { chain, n: {}, errors: [] };
  const proj = chain.split('>').pop()!;
  const chpt = a.Chpt!;
  const top = a.CRdb!.ChainBack === null;
  const Encryp = a.CRdb!.Encrypted;
  const RP = new RdbPos();
  RP.R = a.CRdb;
  for (let I = 1; I <= chpt.NRecs; I++) {
    a.CFile = chpt;
    a.CRecPtr = chpt.RecPtr;
    ReadRec(I);
    RP.IRec = I;
    const Typ = _ShortS(a.ChptTyp)[0] ?? '\0';
    const Name = TrailChar(' ', _ShortS(a.ChptName)).slice(0, 12);
    const Txt = _T(a.ChptTxt);
    a.InpRdbPos = CopyRec(RP);
    a.IsCompileErr = false;
    const lstFD = LastInChain(fref(a, 'FileDRoot')) as FileD;
    const ld = a.LinkDRoot;
    const OldE = RdRunVars.EditDRoot;
    const er = new ExitRecord();
    NewExit(null, er);
    try {
      switch (Typ) {
        case 'F':
          RdF(Name);
          if (a.CFile!.IsHlpFile) a.CRdb!.HelpFD = a.CFile;
          break;
        case 'M':
          SetInpTTPos(Txt, Encryp);
          ReadMerge();
          break;
        case 'R':
          SetInpTTPos(Txt, Encryp);
          ReadReport(null);
          break;
        case 'P':
          SetInpTTPos(Txt, Encryp);
          if (a.InpArrLen > 0) {
            ReadProcHead();
            ReadProcBody();
          }
          break;
        case 'E':
          PushEdit();
          RdFormOrDesign(null, null, RP);
          break;
        case 'U':
          if (!top || I > 1) throw new Error('U chapter not first in the top project (error 623)');
          if (Txt !== 0) {
            ResetCompilePars();
            SetInpTTPos(Txt, Encryp);
            RdUserId(!a.IsTestRun || a.ChptTF!.LicenseNr !== 0);
          }
          break;
        case 'D':
          ResetCompilePars();
          SetInpTTPos(Txt, Encryp);
          ReadDeclChpt();
          break;
        case 'L':
          SetInpTTPos(Txt, Encryp);
          ReadProlog(0);
          break;
      }
      res.n[Typ] = (res.n[Typ] ?? 0) + 1;
    } catch (e) {
      const where = `${proj} #${I} ${Typ} ${U(Name)}`;
      if (e instanceof GoExitSignal) res.errors.push(`${where}: ${U(BaseVars.MsgLine)}`);
      else res.errors.push(`${where}: ${(e as Error).stack?.split('\n').slice(0, 6).join(' | ') ?? String(e)}`);
    } finally {
      RestoreExit(er);
    }
    if (Typ === 'P') {
      // a procedure's own files and links are local to it
      lstFD.Chain = null;
      a.LinkDRoot = ld;
    }
    if (Typ === 'E') RdRunVars.EditDRoot = OldE;
    a.CFile = chpt;
    a.CRecPtr = chpt.RecPtr;
  }
  return res;
}

/** RUNFAND.RunRdb up to EditExecRdb: the task's catalog (SetTopDir). */
function openTask(task: string): void {
  const n = ref('');
  expect(SetTopDir(FromUnicode(join(DIR, `${task}.RDB`)), n), `SetTopDir ${task}: ${U(BaseVars.MsgLine)}`).toBe(true);
}
/** RUNFAND.RunRdb after EditExecRdb: close the catalog. */
function closeTask(): void {
  AccessVars.CFile = AccessVars.CatFD;
  CloseFile();
}

/** Runs body under a NewExit frame; a GoExit becomes an Error with the message. */
function ok<T>(what: string, body: () => T): T {
  const er = new ExitRecord();
  NewExit(null, er);
  try {
    return body();
  } catch (e) {
    if (e instanceof GoExitSignal) throw new Error(`${what}: GoExit: ${U(BaseVars.MsgLine)}`);
    throw e;
  } finally {
    RestoreExit(er);
  }
}

/**
 * Walks the chains depth first like nested CALLs: each project is opened (CreateOpenChpt) on top
 * of its caller, `visit` compiles it, and it is closed (CloseChpt) when the walk leaves it.
 */
function walkChains(visit: (chain: string) => void): void {
  let open: string[] = [];
  let task = '';
  const closeTo = (depth: number): void => {
    while (open.length > depth) {
      ok(`CloseChpt ${open[open.length - 1]}`, () => CloseChpt());
      open.pop();
    }
  };
  // sorted, so that the chains below a project follow it and each project is opened once per caller
  for (const chain of [...CHAINS].sort()) {
    const names = chain.split('>');
    let common = 0;
    while (common < open.length && common < names.length && open[common] === names[common]) common++;
    closeTo(common);
    if (open.length === 0 && task !== names[0]) {
      if (task !== '') closeTask();
      task = names[0];
      openTask(task);
    }
    for (let i = open.length; i < names.length; i++) {
      ok(`CreateOpenChpt ${names[i]}`, () => CreateOpenChpt(FromUnicode(names[i]), true));
      open.push(names[i]);
      visit(names.slice(0, i + 1).join('>'));
    }
  }
  closeTo(0);
  closeTask();
  open = [];
}

describe.skipIf(!haveApp)('smoke: every chapter of Účto compiles', () => {
  const results = new Map<string, ProjectResult>();

  beforeAll(() => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    cpSync(APP, DIR, { recursive: true });
  }, 60_000);

  beforeAll(async () => {
    // the first start of the copy (see the file comment)
    const d = new EngineDriver({ appDir: DIR, project: 'UCTO2026' });
    try {
      await startUcto(d, 90_000);
      d.press(K.Esc);
      await d.waitFor(/^(?![\s\S]*Peněžní deník)/);
      d.press(K.Esc);
      await d.waitFor('Ukončit program účto');
      d.press(K.Enter);
      expect(await d.exited).toBe(0);
    } finally {
      await d.close();
    }
  }, 120_000);

  beforeAll(() => {
    InstallVirtualCwd();
    process.chdir(DIR);
    // FAND.PAS main: `cd <appDir>; ufand` without a task, then InitRunFand up to the command line
    const q = new KeyQueue();
    q.close(); // a wait for a key ends the session (EngineShutdown) instead of hanging
    SetDriversCrt(new Crt(q, null, 80, 25));
    SetParams([]);
    BaseVars.OldDir = FromUnicode(DIR);
    BaseVars.FandDir = FromUnicode(DIR);
    InitDriversUnit();
    InitBase();
    DriversVars.FandBatch = true; // messages go to stderr, prompts answer No
    ok('InitFandSession', () => InitFandSession());
  }, 120_000);

  afterAll(() => {
    process.chdir(startCwd);
    rmSync(join(ROOT, 'work/tmp-smoke-compile'), { recursive: true, force: true });
  });

  it('pass 1: each chapter of each project on top of its callers', () => {
    const projects = readdirSync(APP).filter((f) => /\.(RDB|PRO)$/i.test(f)).map((f) => basename(f, extname(f)).toUpperCase());
    walkChains((chain) => {
      results.set(chain, compileChapters(chain));
    });
    const done = new Set([...results.keys()].map((c) => c.split('>').pop()!));
    expect(projects.filter((p) => !done.has(p))).toEqual([]);
    const n: Record<string, number> = {};
    const seen = new Set<string>();
    for (const [chain, r] of results) {
      const p = chain.split('>').pop()!;
      if (seen.has(p)) continue;
      seen.add(p);
      for (const [k, v] of Object.entries(r.n)) n[k] = (n[k] ?? 0) + v;
    }
    const errors = [...new Set([...results.values()].flatMap((r) => r.errors))];
    console.log(`compiled chapters: ${JSON.stringify(n)}; errors: ${errors.length}\n${errors.join('\n')}`);
    expect(errors.filter((e) => !KNOWN_ERRORS.some((k) => e.startsWith(k)))).toEqual([]);
    expect(n.P).toBeGreaterThan(2600);
    expect(n.F).toBeGreaterThan(100);
    expect(n.R).toBeGreaterThan(100);
    expect(n.E).toBeGreaterThan(10);
  }, 600_000);

  it('pass 2: PROJMGR.CompileRdb compiles every project without an error in pass 1', () => {
    const failed: string[] = [];
    walkChains((chain) => {
      const r = results.get(chain);
      if (r === undefined || r.errors.length > 0) return;
      const okc = ok(`CompileRdb ${chain}`, () => CompileRdb(false, true, true));
      if (!okc) {
        const p = AccessVars.InpRdbPos;
        failed.push(`${chain}: chapter ${p.IRec}: ${U(BaseVars.MsgLine)}`);
      }
    });
    expect(failed).toEqual([]);
  }, 600_000);
});
