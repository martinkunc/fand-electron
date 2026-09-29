// report-menu package: WWMENU.PAS (windows, menu boxes and bars, help lines), GENRPRT.PAS
// (automatic reports), RUNRPRT.PAS (the report interpreter) and RUNMERG.PAS (the merge
// interpreter). Menus run on an in-process Crt with queued keys; reports and merges are compiled
// by RDRPRT/RDMERG over data files declared with RDFILDCL in a scratch directory
// (work/tmp-report-menu) and their output (the print view file PRINTER.TXT, output data files)
// is checked. FAND.RES of the pristine Účto install gives the messages.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';

// Routines of other packages that may still be stubs: fall back while they throw NotImplementedError.
const ranInstrs: unknown[] = [];
vi.mock('../src/engine/pas/runproc.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/engine/pas/runproc.ts')>();
  return {
    ...m,
    // the menu tests only record which choice's instructions ran
    RunInstr: (PD: unknown): void => {
      ranInstrs.push(PD);
    },
  };
});
vi.mock('../src/engine/pas/editor.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/engine/pas/editor.ts')>();
  return { ...m, Help: (): void => {} };
});

import { ref, getWord, GoExitSignal, FromUnicode, StrToBytes, TxtRewrite, Output, fmClosed } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, ReadH, PosH, _isoldfile, _isoverwritefile, RdOnly, Exclusive, NewExit, RestoreExit, ExitRecord,
  SaveCache, FormatCache, OpenWorkH, RdMsg, RDate, type TMsgIdxItem,
} from '../src/engine/pas/base.ts';
import { SetDriversCrt, DriversVars, AssignCrt, ScrClr } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { K } from '../src/engine/console/keys.ts';
import { encode852, decode852 } from '../src/engine/console/cp852.ts';
import {
  AccessVars, FileD, RdbD, FrmlElem, ResetCompilePars, GetRecSpace, ReadRec, CreateRec, ZeroAllFlds, NewLMode,
  OldLMode, S_, R_, B_, _ShortS, _R, _B, _const, ExclMode, FieldListEl, KeyFldD,
  type FieldDPtr, type FieldList,
} from '../src/engine/pas/access.ts';
import { SetInpStr } from '../src/engine/pas/compile.ts';
import { RdFileD } from '../src/engine/pas/rdfildcl.ts';
import { ReadReport } from '../src/engine/pas/rdrprt.ts';
import { ReadMerge } from '../src/engine/pas/rdmerg.ts';
import { RdRunVars, Instr, ChoiceD, RprtOpt, _menubox, _menubar, _ALstg, _ARprt, _AErrRecs } from '../src/engine/pas/rdrun.ts';
import {
  TWindow, TMenuBox, TMenuBoxS, TMenuBarS, TMenuBarP, Menu, PrinterMenu, MenuBoxProc, MenuBarProc, GetHlpText, DisplLLHelp, sfFramed,
  sfShadow, TRect,
} from '../src/engine/pas/wwmenu.ts';
import { GenAutoRprt, SubstChar, RunAutoReport, SelForAutoRprt, SelGenRprt } from '../src/engine/pas/genrprt.ts';
import { RunReport } from '../src/engine/pas/runrprt.ts';
import { RunMerge } from '../src/engine/pas/runmerg.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const TMP = join(ROOT, 'work/tmp-report-menu');
const haveApp = existsSync(join(APP, 'FAND.RES'));

/** Byte string of a Unicode text (CP852) and back. */
const B = (u: string): string => String.fromCharCode(...encode852(u));
/** CP852 byte string -> Unicode; control characters stay as they are */
const U = (b: string): string =>
  Array.from(b, (c) => (c.charCodeAt(0) < 0x80 ? c : decode852(Uint8Array.of(c.charCodeAt(0))))).join('');
const H = (p: string): string => FromUnicode(p);

let crt: Crt;
let keys: KeyQueue;
const press = (...codes: number[]): void => {
  for (const c of codes) keys.push(c);
};
const ch = (c: string): number => c.charCodeAt(0); // a plain ASCII key
const row = (y: number): string => crt.screen.rowText(y);
const attr = (x: number, y: number): number => crt.screen.getCell(x, y).attr;

/** Loads the message index of Účto's FAND.RES (as RUNFAND does) so that RdMsg works. */
function loadResMessages(): void {
  BaseVars.CPath = H(join(APP, 'FAND.RES'));
  BaseVars.CVol = '';
  const h = OpenH(_isoldfile, RdOnly);
  expect(BaseVars.HandleError).toBe(0);
  BaseVars.ResFile.Handle = h;
  const b = new Uint8Array(2);
  ReadH(h, 2, b);
  ReadH(h, 17 * 6, new Uint8Array(17 * 6));
  ReadH(h, 2, b);
  const n = getWord(b, 0);
  const it = new Uint8Array(5 * n);
  ReadH(h, it.length, it);
  const idx: TMsgIdxItem[] = [{ Nr: 0, Ofs: 0, Count: 0 }];
  for (let i = 0; i < n; i++) idx.push({ Nr: getWord(it, 5 * i), Ofs: getWord(it, 5 * i + 2), Count: it[5 * i + 4] });
  BaseVars.MsgIdx = idx;
  BaseVars.MsgIdxN = n;
  BaseVars.FrstMsgPos = PosH(h);
}

/** Runs body under a NewExit frame; a GoExit becomes an exception with the message. */
function ok<T>(body: () => T): T {
  const er = new ExitRecord();
  NewExit(null, er);
  try {
    return body();
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
    throw new Error(`GoExit: ${U(BaseVars.MsgLine)}`);
  } finally {
    RestoreExit(er);
  }
}

function constS(s: string): FrmlElem {
  const z = new FrmlElem(_const);
  z.S = s;
  return z;
}
function constB(b: boolean): FrmlElem {
  const z = new FrmlElem(_const);
  z.B = b;
  return z;
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  keys = new KeyQueue();
  crt = new Crt(keys, null, 80, 25);
  SetDriversCrt(crt);
  AssignCrt(Output);
  TxtRewrite(Output);
  if (haveApp) loadResMessages();
  FormatCache();
  // the TWork/XWork scratch files (windows are saved in TWork by PushW1)
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
  BaseVars.WrkDir = H(TMP) + '/';
});

beforeEach(() => {
  keys = new KeyQueue();
  crt = new Crt(keys, null, 80, 25);
  SetDriversCrt(crt);
  const dv = DriversVars;
  dv.KbdBuffer = '';
  dv.KbdChar = 0;
  dv.Event.What = 0;
  dv.FandBatch = false;
  dv.MausExist = false;
  dv.Crs.Enabled = false;
  BaseVars.TxtCols = 80;
  BaseVars.TxtRows = 25;
  BaseVars.Spec.ScreenDelay = 0;
  const c = BaseVars.Colors;
  c.mNorm = 0x70;
  c.mHili = 0x0f;
  c.mFirst = 0x74;
  c.mDisabled = 0x78;
  c.ShadowAttr = 0x08;
  c.uNorm = 0x07;
  c.nNorm = 0x30;
  AccessVars.HelpFD = null;
  AccessVars.MenuX = 1;
  AccessVars.MenuY = 1;
  BaseVars.ExitP = false;
  BaseVars.BreakP = false;
  ranInstrs.length = 0;
});

// ---------------------------------------------------------------- WWMENU

describe('WWMENU: windows', () => {
  it('TWindow.Assign centres (C1/R1 = 0) or clamps to the screen, framed adds 2', () => {
    const w = new TWindow();
    w.Assign(0, 0, 20, 5);
    expect([w.Orig.X, w.Orig.Y, w.Size.X, w.Size.Y]).toEqual([30, 10, 20, 5]);
    w.SetState(sfFramed, true);
    w.Assign(0, 0, 20, 5);
    expect([w.Orig.X, w.Orig.Y, w.Size.X, w.Size.Y]).toEqual([29, 9, 22, 7]);
    expect([w.Col1(), w.Row1(), w.Col2(), w.Row2()]).toEqual([30, 10, 51, 16]);
    w.Assign(70, 20, 90, 30); // too far right/down: moved in
    expect([w.Orig.X, w.Orig.Y, w.Size.X, w.Size.Y]).toEqual([59, 14, 21, 11]);
    w.Assign(5, 3, 7, 3); // minimum size m+1
    expect([w.Orig.X, w.Orig.Y, w.Size.X, w.Size.Y]).toEqual([4, 2, 3, 3]);
    const r = new TRect();
    r.A.Assign(4, 2);
    r.Size.Assign(3, 3);
    const p = { X: 6, Y: 4 } as never;
    expect(r.Contains(p)).toBe(true);
    expect(w.Contains({ X: 7, Y: 4 } as never)).toBe(false);
  });

  it('TWindow.Init draws a double frame, centred top/bottom texts, shadow; Done restores', () => {
    ScrClr(0, 0, 80, 25, '.', 0x07);
    const w = new TWindow();
    w.SetState(sfFramed | sfShadow | 0x20 /* sfFrDouble */, true);
    w.InitWindow(10, 5, 29, 8, 0x1e, 'Top', 'Bot', false);
    // top/bottom text at Col1 + (m - l) div 2 = 10 + (18 - 5) div 2
    expect(row(4).slice(9, 32)).toBe('╔══════ Top ═══════╗...');
    expect(row(5).slice(9, 30)).toBe('║                  ║.');
    expect(row(7).slice(9, 30)).toBe('╚══════ Bot ═══════╝.');
    expect(attr(29, 5)).toBe(0x08); // shadow right (2 columns)
    expect(attr(30, 5)).toBe(0x08);
    expect(attr(11, 8)).toBe(0x08); // shadow below from Orig.X+2
    expect(attr(10, 8)).toBe(0x07);
    w.Done();
    expect(row(4).slice(9, 32)).toBe('.'.repeat(23));
    expect(attr(29, 5)).toBe(0x07);
  });
});

describe.skipIf(!haveApp)('WWMENU: message menus (FAND.RES)', () => {
  // message 4: 'FM004//Opis vět/Součt.sestava/Totály/Chybné věty'
  it('TMenuBoxS: layout, colours, hot keys, Exec result', () => {
    ScrClr(0, 0, 80, 25, '.', 0x07);
    // what Menu(4, ..) does, but kept open to look at the screen
    const w = ok(() => {
      RdMsg(4);
      return new TMenuBoxS().Init(0, 0, BaseVars.MsgLine);
    });
    expect(w.nTxt).toBe(4);
    expect(U(w.GetText(-1))).toBe('FM004');
    expect(w.GetText(0)).toBe('');
    expect(U(w.GetText(2))).toBe('Součt.sestava');
    // width: 13 + 4 + frame 2 = 19, height 4 + 2, centred
    expect([w.Orig.X, w.Orig.Y, w.Size.X, w.Size.Y]).toEqual([30, 9, 19, 6]);
    expect(row(9).slice(30, 49)).toBe('┌' + '─'.repeat(17) + '┐');
    expect(row(10).slice(30, 51)).toBe('│  Opis vět       │..');
    expect(row(11).slice(30, 49)).toBe('│  Součt.sestava  │');
    expect(row(14).slice(30, 49)).toBe('└' + '─'.repeat(17) + '┘');
    // not current: the first letter in mFirst, the rest mNorm
    expect(attr(33, 11)).toBe(0x74);
    expect(attr(34, 11)).toBe(0x70);
    expect(attr(49, 11)).toBe(0x08); // shadow
    // Exec: Down, Down, Enter -> 3
    press(K.Down, K.Down, K.Enter);
    expect(w.Exec(1)).toBe(3);
    // current item painted in mHili over the whole width
    expect(attr(32, 12)).toBe(0x0f);
    expect(attr(46, 12)).toBe(0x0f);
    expect(w.GetHlpName()).toBe('FM004_3');
    // hot key: 'c' (Chybné věty) -> 4; Esc -> 0; End/Home wrap
    press(ch('c'));
    expect(w.Exec(1)).toBe(4);
    press(K.Esc);
    expect(w.Exec(2)).toBe(0);
    press(K.End, K.Enter);
    expect(w.Exec(1)).toBe(4);
    press(K.Up, K.Enter); // from 1 up wraps to 4
    expect(w.Exec(1)).toBe(4);
    AccessVars.MenuX = 7;
    AccessVars.MenuY = 8;
    w.Done();
    expect([AccessVars.MenuX, AccessVars.MenuY]).toEqual([1, 1]); // restored from Init
    expect(row(10).slice(28, 52)).toBe('.'.repeat(24));
  });

  it('TMenuBarS: texts and pull-down message numbers from one message; (item shl 8) + subitem', () => {
    // message 284 'FM0284/(cm)/0/1/2/3/4/5/6/7/8/9' read as a bar: 5 items '(cm)','0'..'3',
    // their pull-down messages 4..8 (item 1 -> message 4, the auto report menu)
    ScrClr(0, 0, 80, 25, '.', 0x07);
    const bar = ok(() => new TMenuBarS().Init(284));
    expect(bar.nTxt).toBe(5);
    expect([1, 2, 5, 6].map((i) => bar.GetText(i))).toEqual(['(cm)', '0', '3', '4']);
    press(K.Enter, K.Down, K.Enter);
    expect(ok(() => bar.Exec())).toBe((1 << 8) + 2);
    expect(bar.DownI[1]).toBe(2);
    expect(bar.GetHlpName()).toBe('FM0284_1');
    press(K.Enter, K.Esc, K.Esc); // Esc in the pull-down: back in the bar; Esc: 0
    expect(ok(() => bar.Exec())).toBe(0);
    bar.Done();
    expect(row(0)).toBe('.'.repeat(80));
  });

  it('Menu(4): Down, Enter chooses the 2nd item; MenuX/Y point below it while it runs', () => {
    press(K.Down, K.Enter);
    expect(ok(() => Menu(4, 1))).toBe(2);
    press(K.Esc);
    expect(ok(() => Menu(4, 3))).toBe(0);
  });

  it('PrinterMenu: the printers are appended to the message, the choice becomes prCurr', () => {
    const bv = BaseVars;
    const strg = (name: string): Uint8Array => Uint8Array.of(name.length, ...StrToBytes(name), 0);
    bv.prMax = 2;
    bv.printer[0] = { ...bv.printer[0], Strg: strg('LaserJet'), Lpti: 1, ToMgr: false, TmOut: 0 };
    bv.printer[1] = { ...bv.printer[1], Strg: strg('Epson/FX'), Lpti: 2, ToMgr: true, TmOut: 0 };
    bv.prCurr = 0;
    let texts: string[] = [];
    press(K.Down, K.Enter);
    expect(ok(() => PrinterMenu(46))).toBe(true);
    expect(bv.prCurr).toBe(1);
    texts = bv.MsgLine.split('/').slice(-2);
    expect(texts).toEqual(['LaserJet (LPT1)', 'Epson-FX ']);
    press(K.Esc);
    expect(ok(() => PrinterMenu(46))).toBe(false);
    expect(bv.prCurr).toBe(1);
    bv.prMax = 0;
    bv.prCurr = -1;
  });
});

describe('WWMENU: MENUBOX / MENUBAR instructions', () => {
  function choice(txt: string, opts: Partial<ChoiceD> = {}): ChoiceD {
    const c = new ChoiceD();
    c.TxtFrml = constS(B(txt));
    c.Instr = new Instr(_menubar); // any instruction: the mocked RunInstr records it
    Object.assign(c, opts);
    return c;
  }
  function chain<T extends { Chain: T | null }>(...a: T[]): T {
    for (let i = 0; i < a.length - 1; i++) a[i].Chain = a[i + 1];
    return a[0];
  }
  function menuBox(head: string, cs: ChoiceD[], pullDown: boolean, loop = false): Instr {
    const PD = new Instr(_menubox);
    PD.HdLine = constS(B(head));
    PD.Choices = chain(...cs);
    PD.PullDown = pullDown;
    PD.Loop = loop;
    PD.Shdw = true;
    return PD;
  }

  it('MENUBOX: texts get ^W marks, hidden and disabled choices, the chosen instructions run', () => {
    const cs = [
      choice('Alfa'),
      choice('Skrytá', { Bool: constB(false) }), // not displayed
      choice('Beta', { Bool: constB(false), DisplEver: true }), // displayed, disabled
      choice('Gama'),
    ];
    const PD = menuBox('Hlava', cs, false);
    ScrClr(0, 0, 80, 25, '.', 0x07);
    // Down skips the disabled Beta: Gama; Enter
    press(K.Down, K.Enter);
    ok(() => MenuBoxProc(PD));
    expect(ranInstrs).toEqual([cs[3].Instr]);
    expect(cs.map((c) => [c.Displ, c.Enabled])).toEqual([[true, true], [false, false], [true, false], [true, true]]);
    expect(cs[0].Txt).toBe('\x17A\x17lfa');
    expect(row(10).slice(0, 5)).toBe('.....'); // closed again
    // Loop: runs again until Esc (no ESC branch: leaves)
    ranInstrs.length = 0;
    PD.Loop = true;
    press(K.Enter, ch('g'), K.Esc);
    ok(() => MenuBoxProc(PD));
    expect(ranInstrs).toEqual([cs[0].Instr, cs[3].Instr]);
    // ESC branch
    ranInstrs.length = 0;
    PD.Loop = false;
    PD.WasESCBranch = true;
    PD.ESCInstr = new Instr(_menubar);
    press(K.Esc);
    ok(() => MenuBoxProc(PD));
    expect(ranInstrs).toEqual([PD.ESCInstr]);
  });

  it('MENUBAR: layout, Right + Enter runs a choice, a pull-down MENUBOX opens below its item', () => {
    const sub = [choice('Jedna'), choice('Dvě')];
    const down = menuBox('', sub, true);
    const cs = [choice('Soubor', { Instr: down }), choice('Úpravy'), choice('Konec')];
    const PD = new Instr(_menubar);
    PD.Choices = chain(...cs);
    ScrClr(0, 0, 80, 25, '.', 0x07);
    // nBlks: (80 - 23) div 3 = 19, reduced while 57 - 3n < n: 14
    const bar = ok(() => new TMenuBarP().Init(PD));
    expect(bar.nBlks).toBe(14);
    const r = new TRect();
    bar.GetItemRect(2, r);
    expect([r.A.X, r.A.Y, r.Size.X]).toEqual([36, 0, 8]);
    press(K.Esc);
    expect(bar.Exec()).toBe(0);
    expect(row(0)).toBe(' '.repeat(14) + ' Soubor ' + ' '.repeat(14) + ' Úpravy ' + ' '.repeat(14) + ' Konec ' + ' '.repeat(15));
    expect(attr(15, 0)).toBe(0x0f); // current
    expect(attr(37, 0)).toBe(0x74); // hot letter
    bar.Done();
    expect(row(0)).toBe('.'.repeat(80));

    // Right, Enter: Úpravy runs and the bar stays (ExecItem true); Esc leaves
    press(K.Right, K.Enter, K.Esc);
    ok(() => MenuBarProc(PD));
    expect(ranInstrs).toEqual([cs[1].Instr]);

    // Enter on Soubor opens the pull-down at MenuX/MenuY (below the item); Down, Enter runs 'Dvě'
    ranInstrs.length = 0;
    let seen = '';
    const origExec = TMenuBox.prototype.Exec; // TMenuBoxP inherits TMenuBox.Exec
    const spy = vi.spyOn(TMenuBox.prototype, 'Exec').mockImplementation(function (this: TMenuBox, i: number) {
      seen = row(1).slice(14, 26) + '|' + row(2).slice(14, 26);
      return origExec.call(this, i);
    });
    press(K.Enter, K.Down, K.Enter, K.Esc);
    ok(() => MenuBarProc(PD));
    spy.mockRestore();
    expect(ranInstrs).toEqual([sub[1].Instr]);
    // MenuX/MenuY = item rect + (1, 2): the box (width 5 + 4 + 2) at column 15, row 2
    expect(seen).toBe('┌─────────┐.|│  Jedna  │.');
  });
});

// ---------------------------------------------------------------- data files for reports and merges

/** A scratch RDB (chapter file only) whose data files live in dir. */
function newRdb(dir: string): RdbD {
  const a = AccessVars;
  mkdirSync(dir, { recursive: true });
  const chpt = new FileD();
  chpt.Typ = '0';
  chpt.Name = 'TEST';
  const R = new RdbD();
  R.FD = chpt;
  R.RdbDir = H(dir);
  R.DataDir = H(dir);
  a.FileDRoot = chpt;
  a.CRdb = R;
  a.CatFD = null;
  a.LinkDRoot = null;
  a.FuncDRoot = null;
  return R;
}

/** RDFILDCL: declare a data file of the scratch RDB. */
function declare(name: string, dcl: string): FileD {
  ResetCompilePars();
  AccessVars.RdFldNameFrml = null;
  AccessVars.FrmlSumEl = null;
  SetInpStr(ref(B(dcl)));
  ok(() => RdFileD(name, '6', ''));
  return AccessVars.CFile!;
}

type Val = string | number | boolean;
function fld(fd: FileD, name: string): FieldDPtr {
  for (let f = fd.FldD; f !== null; f = f.Chain) if (U(f.Name) === name) return f;
  throw new Error(`no field ${name}`);
}
/** Appends records (field name -> value) to fd. */
function addRecs(fd: FileD, recs: Record<string, Val>[]): void {
  const a = AccessVars;
  a.CFile = fd;
  const md = NewLMode(ExclMode);
  a.CRecPtr = GetRecSpace();
  for (const r of recs) {
    ZeroAllFlds();
    for (const [k, v] of Object.entries(r)) {
      const f = fld(fd, k);
      if (typeof v === 'string') S_(f, B(v));
      else if (typeof v === 'number') R_(f, v);
      else B_(f, v);
    }
    CreateRec(fd.NRecs + 1);
  }
  OldLMode(md);
  SaveCache(0);
}
function readRecs(fd: FileD, names: string[]): Val[][] {
  const a = AccessVars;
  a.CFile = fd;
  const md = NewLMode(ExclMode);
  a.CRecPtr = GetRecSpace();
  const res: Val[][] = [];
  for (let i = 1; i <= fd.NRecs; i++) {
    ReadRec(i);
    res.push(
      names.map((n) => {
        const f = fld(fd, n)!;
        return f.FrmlTyp === 'S' ? U(_ShortS(f)).trimEnd() : f.FrmlTyp === 'R' ? _R(f) : _B(f);
      }),
    );
  }
  OldLMode(md);
  return res;
}

/** RDRPRT + RUNRPRT: runs the report text into the print view file and returns its lines. */
function runReport(text: string): string[] {
  ResetCompilePars();
  AccessVars.RdFldNameFrml = null;
  AccessVars.FrmlSumEl = null;
  SetInpStr(ref(B(text)));
  ok(() => ReadReport(null));
  ok(() => RunReport(null));
  expect(RdRunVars.PrintView).toBe(true);
  return printView();
}
function printView(): string[] {
  const t = readFileSync(join(TMP, 'PRINTER.TXT'), 'latin1');
  return U(t).split('\r\n');
}

const GOODS = [
  { Skupina: 'A', Nazev: 'Jablka', Mnozstvi: 10, Cena: 25.5, Datum: 0 },
  { Skupina: 'A', Nazev: 'Hrušky', Mnozstvi: 3, Cena: 12, Datum: 0 },
  { Skupina: 'B', Nazev: 'Mrkev', Mnozstvi: 7, Cena: 8.25, Datum: 0 },
  { Skupina: 'C', Nazev: 'Chléb dlouhý', Mnozstvi: 1, Cena: 30, Datum: 0 },
];

describe.skipIf(!haveApp)('RUNRPRT: reports over a scratch data file', () => {
  let zbozi: FileD;
  beforeAll(() => {
    BaseVars.Spec.AutoRprtLimit = 60; // FAND.CFG of Účto
    BaseVars.Spec.CpLines = 12;
    const dir = join(TMP, 'rprt');
    rmSync(dir, { recursive: true, force: true });
    newRdb(dir);
    zbozi = declare('ZBOZI', 'Skupina:A,2;Nazev:A,12;Mnozstvi:F,4.0;Cena:F,7.2;Datum:D;Pozn:A,40');
    addRecs(zbozi, GOODS.map((g) => ({ ...g })));
  });

  it('page head, detail lines with number formats, group footings with sums, report footing', () => {
    const lines = runReport(
      [
        '#I1_ZBOZI Skupina',
        '#PH page;',
        'Seznam zboží                          strana ___',
        '#CH_Skupina Skupina;',
        'Skupina _',
        '#DE Nazev,Mnozstvi,Cena;',
        '  ____________ ____ ____.__',
        '#CF_Skupina Skupina,sum(Mnozstvi),sum(Cena);',
        '  celkem _     ____ ____.__',
        '#RF sum(Cena),sum(1);',
        'Celkem  ______.__  vět ___',
      ].join('\r\n'),
    );
    expect(lines).toEqual([
      'Seznam zboží                          strana   1',
      'Skupina A',
      '  Jablka         10   25.50',
      '  Hrušky          3   12.00',
      '  celkem A       13   37.50',
      'Skupina B',
      '  Mrkev           7    8.25',
      '  celkem B        7    8.25',
      'Skupina C',
      '  Chléb dlouhý    1   30.00',
      '  celkem C        1   30.00',
      'Celkem      75.75  vět   4',
      '',
    ]);
  });
});

describe.skipIf(!haveApp)('RUNRPRT: several inputs, output file, empty report', () => {
  let dir = '';
  beforeAll(() => {
    BaseVars.Spec.AutoRprtLimit = 60;
    BaseVars.Spec.CpLines = 12;
    dir = join(TMP, 'rprt3');
    rmSync(dir, { recursive: true, force: true });
    newRdb(dir);
    const skupiny = declare('SKUPINY', 'Skupina:A,2;Popis:A,9');
    addRecs(skupiny, [
      { Skupina: 'A', Popis: 'Ovoce' },
      { Skupina: 'B', Popis: 'Zelenina' },
      { Skupina: 'D', Popis: 'Pečivo' },
    ]);
    const zbozi = declare('ZBOZI', 'Skupina:A,2;Nazev:A,12;Mnozstvi:F,4.0;Cena:F,7.2');
    addRecs(zbozi, GOODS.map(({ Datum: _, ...g }) => g));
  });

  it('two inputs matched by Skupina: a group missing in one input gets its match fields', () => {
    const lines = runReport(
      [
        '#I1_SKUPINY Skupina',
        '#I2_ZBOZI Skupina',
        '#CH_Skupina Skupina;',
        'Skupina _',
        '#DE1 Popis,count;',
        ' skupina _________ (__)',
        '#DE2 Nazev,Cena;',
        '  ____________ ____.__',
        '#CF_Skupina I1.count,I2.count;',
        ' počty __ __',
      ].join('\r\n'),
    );
    expect(lines).toEqual([
      'Skupina A',
      ' skupina Ovoce     ( 1)',
      '  Jablka         25.50',
      '  Hrušky         12.00',
      ' počty  1  2',
      'Skupina B',
      ' skupina Zelenina  ( 1)',
      '  Mrkev           8.25',
      ' počty  1  1',
      'Skupina C',
      '  Chléb dlouhý   30.00',
      ' počty  0  1',
      'Skupina D',
      ' skupina Pečivo    ( 1)',
      ' počty  1  0',
      '',
    ]);
  });

  it('a RunError inside (607: input 2 not sorted) closes the report and the inputs, then GoExit', () => {
    const neser = declare('NESER', 'Skupina:A,2;Nazev:A,12');
    addRecs(neser, [
      { Skupina: 'B', Nazev: 'x' },
      { Skupina: 'A', Nazev: 'y' },
    ]);
    ResetCompilePars();
    SetInpStr(ref(B(['#I1_SKUPINY Skupina', '#I2_NESER Skupina', '#DE2 Nazev;', '____'].join('\r\n'))));
    ok(() => ReadReport(null));
    const bp = BaseVars.MyBP;
    DriversVars.FandBatch = true; // the message does not wait for a key
    expect(() => ok(() => RunReport(null))).toThrow(/GoExit/);
    expect(AccessVars.EdBreak).toBe(3);
    expect(RdRunVars.Rprt.Mode).toBe(fmClosed);
    expect(BaseVars.MyBP).toBe(bp); // PopProcStk
    expect(printView()).toEqual(['x   ']); // B.x printed (no line end yet), then A.y comes after B
    expect(RdRunVars.IDA[2]!.Scan!.FD!.LMode).toBe(0); // CloseInp: OldLMode(NullMode)
  });

  it('an empty print view gets message 159; a file path with .ti copies', () => {
    const lines = runReport(['#I1_ZBOZI (Cena>1000)', '#DE Nazev;', '____________'].join('\r\n'));
    RdMsg(159);
    expect(lines).toEqual(['', U(BaseVars.MsgLine)]);

    ResetCompilePars();
    SetInpStr(ref(B(['#I1_ZBOZI (Cena>20)', '#DE Nazev;', '____________'].join('\r\n'))));
    const RO = new RprtOpt();
    RO.Path = H(join(dir, 'OUT.TXT'));
    RO.Times = (() => {
      const z = new FrmlElem(_const);
      z.R = 2;
      return z;
    })();
    ok(() => ReadReport(RO));
    ok(() => RunReport(RO));
    expect(RdRunVars.PrintView).toBe(false);
    expect(U(readFileSync(join(dir, 'OUT.TXT'), 'latin1')).split('\r\n')).toEqual([
      '.ti 2',
      'Jablka      ',
      'Chléb dlouhý',
      '',
    ]);
  });
});

describe.skipIf(!haveApp)('RUNRPRT: text columns, number/date formats, pages', () => {
  let fd: FileD;
  beforeAll(() => {
    BaseVars.Spec.AutoRprtLimit = 60;
    BaseVars.Spec.CpLines = 12;
    const dir = join(TMP, 'rprt2');
    rmSync(dir, { recursive: true, force: true });
    newRdb(dir);
    fd = declare('POLOZKY', 'Nazev:A,12;Cena:F,7.2;Datum:D;Pozn:A,40');
    addRecs(fd, [
      { Nazev: 'Jablka', Cena: 25.5, Datum: RDate(2026, 9, 28, 0, 0, 0, 0), Pozn: 'červená sladká jablka z Moravy' },
      { Nazev: 'Hrušky', Cena: 0, Datum: 0, Pozn: 'bez poznámky' },
      { Nazev: 'Mrkev', Cena: -8.25, Datum: RDate(2025, 1, 2, 0, 0, 0, 0), Pozn: '' },
    ]);
  });

  it("'@' text column wraps and justifies, '@' numbers are blank when zero, dates", () => {
    const lines = runReport(
      ['#I1_POLOZKY', '#DE Nazev,Cena,Datum,Pozn;', '____________ @@@@.@@ __.__.____ @@@@@@@@@@'].join('\r\n'),
    );
    expect(lines).toEqual([
      'Jablka         25.50 28.09.2026 červená   ',
      '                                sladká    ',
      '                                jablka   z',
      '                                Moravy    ',
      'Hrušky           .     .  .     bez       ', // zero: blank number, blank date
      '                                poznámky  ',
      'Mrkev          -8.25 02.01.2025           ', // empty text: Width blanks
      '',
    ]);
  });

  it('.pagesize/.pagelimit: page foot and head around the page break, page numbers', () => {
    const lines = runReport(
      [
        '.pagesize:=6; .pagelimit:=3;',
        '#I1_POLOZKY',
        '#PH page;',
        'strana __',
        '#PF ;',
        '----',
        '#DE Nazev;',
        '_______',
        '#RF sum(1);',
        'konec __',
      ].join('\r\n'),
    );
    // Mrkev would end on line 4 > pagelimit: page foot, form feed, page head
    expect(lines).toEqual([
      '.pl 6',
      'strana  1',
      'Jablka ',
      'Hrušky ',
      '----',
      '\x0cstrana  2',
      'Mrkev  ',
      'konec  3',
      '----',
      '',
    ]);
  });
});

describe.skipIf(!haveApp)('GENRPRT: automatic reports', () => {
  let fd: FileD;
  function fieldList(...names: string[]): FieldList {
    let root: FieldList = null;
    for (const n of names.reverse()) {
      const e = new FieldListEl();
      e.FldD = fld(fd, n);
      e.Chain = root;
      root = e;
    }
    return root;
  }
  beforeAll(() => {
    BaseVars.Spec.AutoRprtLimit = 60;
    BaseVars.Spec.CpLines = 12;
    const dir = join(TMP, 'genrprt');
    rmSync(dir, { recursive: true, force: true });
    newRdb(dir);
    fd = declare('ZBOZI', "Skupina:A,2;Nazev:A,12;Mnozstvi:F,4.0;Cena:F,7.2;Datum:D,'DD.MM.YY'");
    addRecs(fd, GOODS.map((g) => ({ ...g, Datum: RDate(2026, 1, g.Mnozstvi, 0, 0, 0, 0) })));
  });

  it('SelForAutoRprt: the mode from menu 4, spec.AutoRprtPrint prints to LPT1, Esc cancels', () => {
    const RO = new RprtOpt();
    RO.FDL.FD = fd;
    RO.Flds = fieldList('Nazev', 'Cena');
    RO.SK = new KeyFldD(); // sort keys given: no PromptSortKeys
    RO.SK.FldD = fld(fd, 'Nazev');
    BaseVars.Spec.AutoRprtPrint = true;
    press(K.Enter);
    expect(ok(() => SelForAutoRprt(RO))).toBe(true);
    expect(RO.Mode).toBe(_ALstg);
    expect(RO.Path).toBe('LPT1');
    BaseVars.Spec.AutoRprtPrint = false;
    press(K.Down, K.Down, K.Down, K.Enter);
    RO.Path = null;
    expect(ok(() => SelForAutoRprt(RO))).toBe(true);
    expect(RO.Mode).toBe(_AErrRecs);
    expect(RO.Path).toBe(null);
    press(K.Esc);
    expect(ok(() => SelForAutoRprt(RO))).toBe(false);
  });

  it('SelGenRprt: file and field lists chosen interactively, Esc gives nil', () => {
    press(K.Esc);
    expect(ok(() => SelGenRprt(B('Sestava')))).toBe(null);
    // the only file; all fields (ImplAll); no control, no sum fields
    BaseVars.Spec.AutoRprtWidth = 80; // GetRprtOpt: Width
    press(K.Enter, K.Enter, K.Enter, K.Enter);
    const txt = ok(() => SelGenRprt(B('Sestava')));
    const t = U(String.fromCharCode(...txt!)).split('\r\n');
    expect(t[0]).toBe('#I1_ZBOZI  ');
    expect(t.slice(3)).toEqual([
      'Skupina Nazev        Mnozstvi        Cena    Datum',
      '#DH .notsolo;',
      '',
      "#DE Skupina,Nazev,Mnozstvi,Cena,strdate(Datum,'DD.MM.YY');",
      '   __   ____________   _____  ________.__ ________',
    ]);
  });

  it('SubstChar changes the string in place (BP7)', () => {
    const s = ref("a_b_'c'");
    SubstChar(s, '_', '-');
    SubstChar(s, "'", '"');
    expect(s.v).toBe('a-b-"c"');
  });

  it('GenAutoRprt: control and sum fields, the generated text compiles and runs', () => {
    const RO = new RprtOpt();
    RO.FDL.FD = fd;
    RO.Width = 80;
    RO.Style = '?';
    RO.Mode = _ARprt;
    RO.Flds = fieldList('Skupina', 'Nazev', 'Mnozstvi', 'Cena', 'Datum');
    RO.Ctrl = fieldList('Skupina');
    RO.Sum = fieldList('Cena');
    const txt = ok(() => GenAutoRprt(RO, true));
    const t = U(String.fromCharCode(...txt));
    const msg = (n: number): string => {
      RdMsg(n);
      return U(BaseVars.MsgLine);
    };
    expect(t.split('\r\n')).toEqual([
      '#I1_ZBOZI  ~Skupina',
      '#PH today,page;',
      ' '.repeat(19) + '\x11' + '   ZBOZI' + '\x11' + ' '.repeat(14) + '__.__.____' + ' '.repeat(12 - msg(17).length) + msg(17) + '___',
      // Style '?': one line fits into Width, so no compressed print (^E, #PF)
      'Skupina Nazev        Mnozstvi          Cena    Datum',
      '#DH .notsolo;',
      '',
      "#DE Skupina,Nazev,Mnozstvi,Cena,strdate(Datum,'DD.MM.YY');",
      // F,4.0 has L = 5, F,7.2 L = 11; items centred under the headings, sums 2 wider
      '   __   ____________   _____    ________.__ ________',
      '#CF_Skupina Skupina,sum(Cena);',
      '   __' + ' '.repeat(25) + '__________.__' + ' '.repeat(11) + '*',
      '#RF (sum(1)>0) sum(Cena);',
      ' '.repeat(30) + '__________.__' + ' '.repeat(11) + '**',
      '#RF sum(1);',
      '',
      msg(20) + '_______',
    ]);
    // RunAutoReport = GenAutoRprt + ReadReport + RunReport
    ok(() => RunAutoReport(RO));
    const lines = printView();
    expect(lines[0]).toMatch(/^ {19}\x11 {3}ZBOZI\x11 {14}\d\d\.\d\d\.\d{4} {5}strana: {2}1$/);
    expect(lines.slice(1)).toEqual([
      'Skupina Nazev        Mnozstvi          Cena    Datum',
      '', // #DH .notsolo: before the first detail of each group
      '   A    Jablka            10          25.50 10.01.26',
      '   A    Hrušky             3          12.00 03.01.26',
      '   A                                  37.50           *',
      '',
      '   B    Mrkev              7           8.25 07.01.26',
      '   B                                   8.25           *',
      '',
      '   C    Chléb dlouhý       1          30.00 01.01.26',
      '   C                                  30.00           *',
      '                                      75.75           **',
      '',
      msg(20) + '      4',
      '',
    ]);
  });
});

describe.skipIf(!haveApp)('RUNMERG: merges into output files', () => {
  let zbozi: FileD;
  let soucty: FileD;
  let kopie: FileD;
  function runMerge(text: string): void {
    ResetCompilePars();
    AccessVars.RdFldNameFrml = null;
    AccessVars.FrmlSumEl = null;
    SetInpStr(ref(B(text)));
    ok(() => ReadMerge());
    ok(() => RunMerge());
  }
  beforeAll(() => {
    const dir = join(TMP, 'merge');
    rmSync(dir, { recursive: true, force: true });
    newRdb(dir);
    zbozi = declare('ZBOZI', 'Skupina:A,2;Nazev:A,12;Mnozstvi:F,4.0;Cena:F,7.2');
    addRecs(zbozi, GOODS.map(({ Datum: _, ...g }) => g));
    soucty = declare('SOUCTY', 'Skupina:A,2;Pocet:F,3.0;Cena:F,8.2;Skup:F,3.0');
    kopie = declare('KOPIE', 'Skupina:A,2;Nazev:A,12;Cena:F,7.2;Poradi:F,3.0');
  });

  it('#O_ per group with sums and count, #O1_ per record with a condition and implicit fields', () => {
    runMerge(
      [
        '#I1_ZBOZI Skupina',
        '#O_SOUCTY Skupina:=Skupina; Pocet:=I1.count; Cena:=sum(Cena); Skup:=group;',
        '#O1_KOPIE (Cena>10) Poradi:=I1.count;',
      ].join('\r\n'),
    );
    expect(readRecs(soucty, ['Skupina', 'Pocet', 'Cena', 'Skup'])).toEqual([
      ['A', 2, 37.5, 1],
      ['B', 1, 8.25, 2],
      ['C', 1, 30, 3],
    ]);
    expect(readRecs(kopie, ['Skupina', 'Nazev', 'Cena', 'Poradi'])).toEqual([
      ['A', 'Jablka', 25.5, 1],
      ['A', 'Hrušky', 12, 2],
      ['C', 'Chléb dlouhý', 30, 1],
    ]);
  });

  it('#O*_ joins the inputs of a group (cartesian product), groups missing an input are left out', () => {
    const skupiny = declare('SKUPINY', 'Skupina:A,2;Popis:A,9');
    addRecs(skupiny, [
      { Skupina: 'A', Popis: 'Ovoce' },
      { Skupina: 'A', Popis: 'Plody' },
      { Skupina: 'B', Popis: 'Zelenina' },
      { Skupina: 'D', Popis: 'Pečivo' },
    ]);
    const spoj = declare('SPOJ', 'Skupina:A,2;Nazev:A,12;Popis:A,9;Skup:F,3.0');
    runMerge(
      ['#I1_ZBOZI Skupina', '#I2_SKUPINY Skupina', '#O*_SPOJ Skupina:=I1.Skupina; Nazev:=I1.Nazev; Popis:=I2.Popis; Skup:=group;'].join(
        '\r\n',
      ),
    );
    expect(readRecs(spoj, ['Skupina', 'Nazev', 'Popis', 'Skup'])).toEqual([
      ['A', 'Jablka', 'Ovoce', 1],
      ['A', 'Jablka', 'Plody', 1],
      ['A', 'Hrušky', 'Ovoce', 1],
      ['A', 'Hrušky', 'Plody', 1],
      ['B', 'Mrkev', 'Zelenina', 2],
    ]);
  });
});

describe.skipIf(!haveApp)('WWMENU: help texts (HELP02 of Účto)', () => {
  let R: RdbD;
  beforeAll(() => {
    const dir = join(TMP, 'help');
    rmSync(dir, { recursive: true, force: true });
    R = newRdb(dir);
    for (const f of ['HELP02.000', 'HELP02.T00']) cpSync(join(APP, f), join(dir, f));
    ResetCompilePars();
    SetInpStr(ref(B(' Heslo:A,30; Text:T,40;')));
    ok(() => RdFileD('HELP02', '6', '.HLP'));
    R.HelpFD = AccessVars.CFile;
    expect(R.HelpFD!.IsHlpFile).toBe(true);
  });
  const txt = (t: Uint8Array | null): string => U(String.fromCharCode(...(t ?? [])));

  it('GetHlpText: by name without diacritics, masks in the names, empty texts continue, by number', () => {
    const iRec = ref(0);
    let t = ok(() => GetHlpText(R, B('Posta'), true, iRec)); // name 'Pošta'
    expect(iRec.v).toBe(4);
    expect(txt(t).split('\r\n')[0]).toBe('{ F1 = Pošta - podprogram (modul)}');
    expect(ok(() => GetHlpText(R, B('POSTA'), true, iRec))).toBe(null); // case matters
    t = ok(() => GetHlpText(R, B('TEXTY.Cislo'), true, iRec)); // record '*.Cislo'
    expect(iRec.v).toBe(40);
    expect(txt(t)).toContain('Číslo: číslo firmy (F7-adresář)');
    t = ok(() => GetHlpText(R, B('SESTADR.Adresat'), true, iRec)); // empty text: the next record's
    expect(iRec.v).toBe(39);
    expect(txt(t)).toContain('Adresát, Odesílat: číslo firmy');
    AccessVars.CFile = R.HelpFD;
    iRec.v = 9;
    t = ok(() => GetHlpText(R, '', false, iRec));
    expect(iRec.v).toBe(9);
    expect(txt(t)).toContain('E-MAIL - ODESLÁNÍ DOPISU');
  });

  it("DisplLLHelp: the first help line without '{' '}' in the last line, '' when there is none", () => {
    ScrClr(0, 0, 80, 25, '.', 0x07);
    AccessVars.CFile = null;
    ok(() => DisplLLHelp(R, B('Pošta'), false));
    expect(row(24)).toBe(' F1 = Pošta - podprogram (modul)'.padEnd(80));
    expect(attr(0, 24)).toBe(0x30);
    expect(AccessVars.CFile).toBe(null); // restored
    ok(() => DisplLLHelp(R, B('nic'), true));
    expect(row(23)).toBe(' '.repeat(80));
    const R2 = new RdbD(); // no help file: nothing drawn
    ok(() => DisplLLHelp(R2, B('Pošta'), true));
    expect(row(22)).toBe('.'.repeat(80));
  });
});
