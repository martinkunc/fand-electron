// Audit: printing to a print manager (PRINTTXT.PAS CopyToMgr/ExecMgrPgm) and the headless
// EngineDriver answering the engine's host calls.
//
// Bring-up discrepancy: F6 in a report on screen (Přehledy > Účetní výkazy > Výkaz příjmů a výdajů)
// hung our engine under EngineDriver with '►P    ◄' on the bottom line: Účto's print manager UTISK04
// runs as a TS helper that asks the host to print the PDF (hostbridge.ts), and the driver never
// answered, so the worker stayed blocked. The reference cannot EXEC the .EXE and falls back to
// FANDPDF ({tisk}/PRINT1.PRN + PRINT1.pdf); ours deletes the spool file as the original UTISK04 does.
// Unit tests write to work/tmp-audit-driver/, the Účto run to a fresh copy under /tmp (the pristine
// install is never written).

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { FromUnicode, Output, TxtRewrite, getWord } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, FormatCache, OpenH, ReadH, SeekH, PosH, OpenWorkH, InitBase, SizeOfResA, MsgIdxFromBytes, SetExecHelperHook,
  _isoverwritefile, Exclusive,
} from '../src/engine/pas/base.ts';
import { AccessVars, FileD } from '../src/engine/pas/access.ts';
import { PrintArray } from '../src/engine/pas/printtxt.ts';
import { SetDriversCrt, DriversVars, AssignCrt, GotoXY, ScrWrStr, ScrRowStr } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { EngineDriver, headlessHost } from '../src/engine/testing/driver.ts';
import { REF_FAND } from '../src/engine/testing/refdriver.ts';
import { startUcto } from '../src/engine/testing/ucto.ts';
import { settle, normalizeScreen } from '../src/engine/testing/bringup.ts';
import { K, fKey } from '../src/engine/console/keys.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const TMP = join(ROOT, 'work/tmp-audit-driver');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB'));
// the reference's FAND.RES (as bring-up uses it): Účto's own 4.20 FAND.RES shows another main menu
const REF_RES = join(REF_FAND, '..');
const haveRes = existsSync(join(REF_RES, 'FAND.RES'));
const H = (p: string): string => FromUnicode(p);
const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));

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

describe.skipIf(!haveApp)('PRINTTXT CopyToMgr/ExecMgrPgm', () => {
  const D = join(TMP, 'mgr');
  let crt: Crt;
  let cwd0 = '';
  const env0 = process.env.FAND_PRINT;
  const setMgrPrinter = (): void => {
    const strs = Array.from({ length: 18 }, () => '');
    strs[15] = H(join(D, 'PRINT#.PRN')); // prMgrFileNm
    strs[16] = 'UTISK04.EXE'; // prMgrProg
    strs[17] = '/P #'; // prMgrParam
    const s: number[] = [];
    for (const x of strs) s.push(x.length, ...bytes(x));
    BaseVars.printer[0] = {
      Strg: Uint8Array.from(s), Typ: 'P', Kod: '\0', Lpti: 1, TmOut: 0, OpCls: false, ToHandle: true, ToMgr: true, Handle: 0xff,
    };
    BaseVars.prCurr = 0;
    BaseVars.prMax = 1;
  };
  beforeAll(() => {
    cwd0 = process.cwd();
    rmSync(D, { recursive: true, force: true });
    mkdirSync(D, { recursive: true });
    process.env.FANDRES = APP;
    process.env.FAND_PRINT = 'none'; // FandDeliverPdf: do not open the PDF
    InitBase();
    ReadResHeader();
    FormatCache();
    crt = new Crt(new KeyQueue(), null, 80, 25);
    SetDriversCrt(crt);
    AssignCrt(Output);
    TxtRewrite(Output);
    DriversVars.FandBatch = true;
    const tw = AccessVars.TWork;
    tw.IsWork = true;
    BaseVars.CPath = H(join(D, 'FANDWORK.T$$'));
    BaseVars.FandWorkTName = BaseVars.CPath;
    tw.Create();
    BaseVars.FandWorkName = H(join(D, 'FANDWORK.$$$'));
    BaseVars.FandWorkXName = H(join(D, 'FANDWORK.X$$'));
    OpenWorkH();
    BaseVars.CPath = BaseVars.FandWorkXName;
    AccessVars.XWork.Handle = OpenH(_isoverwritefile, Exclusive);
    BaseVars.Spec.CpLines = 0;
    BaseVars.Spec.AutoRprtLimit = 60;
    BaseVars.Spec.ChoosePrMsg = false;
  });
  afterAll(() => {
    SetExecHelperHook(null);
    BaseVars.prCurr = -1;
    process.chdir(cwd0);
    if (env0 === undefined) delete process.env.FAND_PRINT;
    else process.env.FAND_PRINT = env0;
  });

  it('spools the text, EXECs the manager with # = the spool path, restores the top line and the window', () => {
    process.chdir(D);
    setMgrPrinter();
    ScrWrStr(0, 0, 'TOP LINE', 7);
    GotoXY(10, 5);
    const calls: { path: string; cmd: string; spool: string; winMin: number[]; winMax: number[]; top: string }[] = [];
    SetExecHelperHook((Path, CmdLine) => {
      const spool = CmdLine.slice(3);
      calls.push({
        path: Path, cmd: CmdLine, spool: readFileSync(spool, 'latin1'),
        winMin: [DriversVars.WindMin.X, DriversVars.WindMin.Y], winMax: [DriversVars.WindMax.X, DriversVars.WindMax.Y],
        top: ScrRowStr(0).trimEnd(),
      });
      ScrWrStr(0, 0, 'the manager scribbled over the top line', 7);
      return 0;
    });
    const cf = new FileD();
    AccessVars.CFile = cf;
    const t = '.pl 20\r\nabc\r\ndef\r\n';
    PrintArray(bytes(t), t.length, true);
    expect(calls.length).toBe(1);
    const spoolPath = H(join(D, 'PRINT1.PRN'));
    expect(calls[0].path).toBe('UTISK04.EXE');
    expect(calls[0].cmd).toBe('/P ' + spoolPath);
    expect(calls[0].spool).toBe(t); // the whole text, dot commands included
    // the manager runs in RunMsgOn's window (the bottom line), not in PushW's top line
    expect(calls[0].winMin).toEqual([0, 24]);
    expect(calls[0].winMax).toEqual([7, 24]);
    expect(ScrRowStr(0).trimEnd()).toBe('TOP LINE');
    expect(calls[0].top).toBe('TOP LINE');
    expect([DriversVars.WindMin.X, DriversVars.WindMin.Y, DriversVars.WindMax.X, DriversVars.WindMax.Y]).toEqual([0, 0, 79, 24]);
    expect([DriversVars.Crs.X, DriversVars.Crs.Y]).toEqual([9, 4]);
    expect(AccessVars.CFile).toBe(cf);
    expect(BaseVars.LastExitCode).toBe(0);
    expect(readdirSync(D).filter((f) => /\.pdf$/i.test(f))).toEqual([]); // the manager succeeded: no FANDPDF
    expect(ScrRowStr(24)).not.toContain('\x10P'); // RunMsgOff removed the '►P' indicator
  });

  it('FPC: a failing manager program leaves the spool file converted to a PDF next to it', () => {
    process.chdir(D);
    setMgrPrinter();
    let cmd = '';
    SetExecHelperHook((_Path, CmdLine) => {
      cmd = CmdLine;
      return 3;
    });
    const t = 'Výkaz\r\nřádek 2\r\n';
    const b = Uint8Array.from(Buffer.from(t, 'latin1'));
    PrintArray(b, b.length, true);
    expect(cmd).toBe('/P ' + H(join(D, 'PRINT2.PRN'))); // prFileNr counts on
    expect(BaseVars.LastExitCode).toBe(3);
    expect(existsSync(join(D, 'PRINT2.PRN'))).toBe(true);
    expect(readFileSync(join(D, 'PRINT2.pdf')).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

describe('EngineDriver host answers', () => {
  it('the headless host prints nothing, has an empty clipboard, chooses no file', async () => {
    expect(await headlessHost('print', ['/x.pdf', { dialog: false, copies: 1 }])).toBe(true);
    expect(await headlessHost('clipboardRead', [])).toBe('');
    expect(await headlessHost('chooseFile', [{}])).toBe(null);
    expect(await headlessHost('open', ['/x.pdf'])).toBe(null);
  });
});

describe.skipIf(!haveApp || !haveRes)('Účto: F6 in a report prints through UTISK04 without hanging the headless driver', () => {
  it('Výkaz příjmů a výdajů: F6 sends one PDF to the host, returns to the report, leaves no spool file', async () => {
    // a short path as in bring-up: under a longer one (e.g. work/tmp-audit-driver/ucto/task) Účto
    // itself shows another main menu (no Nápověda), in the reference FAND as well
    const base = mkdtempSync('/tmp/fandaud-');
    const dir = join(base, 'task');
    cpSync(APP, dir, { recursive: true });
    const d = new EngineDriver({ appDir: dir, project: 'UCTO2026', env: { FANDRES: REF_RES } });
    try {
      await startUcto(d, 120_000);
      await settle(d);
      d.press(K.Right, K.Right);
      await d.waitFor('Účetní výkazy');
      d.press(K.Enter);
      await d.waitFor('Výkaz příjmů a výdajů');
      await settle(d, 300);
      d.press(K.Down, K.Down, K.Down, K.Down, K.Down, K.Enter);
      await d.waitFor('Součty sloupců');
      await settle(d, 300);
      d.press(K.Enter);
      await d.waitFor('Základ daně', 60_000);
      await settle(d, 1000);
      const report = d.text();
      d.press(fKey(6));
      for (let i = 0; i < 300 && d.hostCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      const after = await settle(d, 1500, 60_000);
      expect(d.errors).toEqual([]);
      expect(d.hostCalls.map((c) => c.op)).toEqual(['print']);
      expect(String(d.hostCalls[0].args[0])).toMatch(/\.pdf$/i);
      expect(after).not.toContain('►P'); // the '►P    ◄' print indicator is gone
      expect(normalizeScreen(after)).toEqual(normalizeScreen(report));
      expect(readdirSync(join(dir, '{tisk}')).filter((f) => /^print/i.test(f))).toEqual([]);
      d.press(K.Esc);
      await d.waitFor('Součty sloupců');
    } finally {
      await d.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 300_000);
});
