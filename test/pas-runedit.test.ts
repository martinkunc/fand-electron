// runedit package: RUNEDI.PAS (EditTxt, Prompt*), RUNEDIT1.PAS (records, display, FieldEdit,
// WriteCRec, delete, journal), RUNEDIT2.PAS (search, checks, switches, navigation, T fields) and
// RUNEDIT3.PAS (RunEdit main loop, exits, EditDataFile). The one-line editor and the field editor
// run on an in-process Crt with queued keys; the data editor runs end to end (EditDataFile with an
// automatic form from RDEDIT.NewEditD) on files declared with RDFILDCL in a scratch directory
// (work/tmp-runedit). FAND.RES of the pristine Účto install gives the messages.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// a hook after RDEDIT.NewEditD (the scratch RDB has no chapter texts for #L sections)
const hooks = vi.hoisted(() => ({ afterNewEditD: null as null | (() => void) }));
vi.mock('../src/engine/pas/rdedit.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/engine/pas/rdedit.ts')>();
  return {
    ...m,
    NewEditD: (...a: Parameters<typeof m.NewEditD>): void => {
      m.NewEditD(...a);
      hooks.afterNewEditD?.();
    },
  };
});
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ref, getWord, GoExitSignal, FromUnicode, TxtRewrite, Output } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, ReadH, PosH, _isoldfile, _isoverwritefile, RdOnly, Exclusive, NewExit, RestoreExit, ExitRecord,
  SaveCache, FormatCache, OpenWorkH, type TMsgIdxItem,
} from '../src/engine/pas/base.ts';
import {
  SetDriversCrt, DriversVars, AssignCrt, ScrClr, GotoXY, Window, _M_, _ESC_, _U_, _CtrlF4_, _F10_,
} from '../src/engine/pas/drivers.ts';
import { Crt, EngineShutdown } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { K, fKey } from '../src/engine/console/keys.ts';
import { encode852, decode852 } from '../src/engine/console/cp852.ts';
import {
  AccessVars, FileD, RdbD, FieldDescr, GetRecSpace, ReadRec, CreateRec, ZeroAllFlds, NewLMode, OldLMode, S_, R_, B_,
  _ShortS, _R, _B, _LongS, ExclMode, ResetCompilePars, XString, f_Stored, f_Mask, f_Comma, LeftJust,
  type FieldDPtr,
} from '../src/engine/pas/access.ts';
import { SetInpStr, GetEditOpt, AllFldsList, RdLex } from '../src/engine/pas/compile.ts';
import { RdChkD } from '../src/engine/pas/rdfildcl.ts';
import { RdFileD } from '../src/engine/pas/rdfildcl.ts';
import { RdRunVars, EditD, EFldD, ERecTxtD, EditDCopiedFields } from '../src/engine/pas/rdrun.ts';
import {
  RunEdiVars, RunEdiPriv, EditTxt, TestIsNewRec, SetSelectFalse, PopEdit, CRec, WrEStatus, RdEStatus, SetNewCRec,
  EditDataFile,
} from '../src/engine/pas/runedi.ts';
import {
  CNRecs, AbsRecNr, TestMask, FieldEdit, DisplSysLine, CheckKeyIn, DuplFld,
} from '../src/engine/pas/runedit1.ts';
import { CompChk, GetChpt } from '../src/engine/pas/runedit2.ts';
import { GetSel2S, EquRoleName, GetFileViewName } from '../src/engine/pas/runedit3.ts';
import { PutSelect } from '../src/engine/pas/wwmix.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const TMP = join(ROOT, 'work/tmp-runedit');
const haveApp = existsSync(join(APP, 'FAND.RES'));

/** Byte string of a Unicode text (CP852) and back. */
const B = (u: string): string => String.fromCharCode(...encode852(u));
const U = (b: string): string =>
  Array.from(b, (c) => (c.charCodeAt(0) < 0x80 ? c : decode852(Uint8Array.of(c.charCodeAt(0))))).join('');
const H = (p: string): string => FromUnicode(p);

/**
 * Test keyboard: keys come in batches. A batch is "typed ahead" (KeyPressed sees it, ClearKeyBuf
 * drops it); the next batch arrives only when the engine waits for a key with the batch used up,
 * like a user who looks at the screen first. After the last batch the engine gets EngineShutdown.
 */
class BatchKeys extends KeyQueue {
  batches: { code: number; shift: number }[][] = [[]];
  done = false;
  override push(code: number, shift = 0): boolean {
    this.batches[this.batches.length - 1].push({ code, shift });
    return true;
  }
  /** WAIT marker: the following keys come after the engine waited */
  cut(): void {
    this.batches.push([]);
  }
  override close(): void {
    this.done = true;
  }
  override get closed(): boolean {
    return this.done;
  }
  override available(): boolean {
    return this.batches[0].length > 0;
  }
  override peek(): { code: number; shift: number } | null {
    return this.batches[0][0] ?? null;
  }
  override read(): { code: number; shift: number } | null {
    while (this.batches[0].length === 0 && this.batches.length > 1) this.batches.shift();
    return this.batches[0].shift() ?? null;
  }
}
/** press() marker: the rest is typed after the engine waited for a key */
const WAIT = -1;

let crt: Crt;
let keys: BatchKeys;
/** Queues keys: numbers are BIOS words, strings are typed character by character. */
const press = (...ks: (number | string)[]): void => {
  for (const k of ks) {
    if (k === WAIT) keys.cut();
    else if (typeof k === 'number') keys.push(k);
    else for (const c of k) keys.push(c.charCodeAt(0));
  }
};
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

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  keys = new BatchKeys();
  crt = new Crt(keys, null, 80, 25);
  SetDriversCrt(crt);
  AssignCrt(Output);
  TxtRewrite(Output);
  if (haveApp) loadResMessages();
  FormatCache();
  // the TWork/XWork scratch files (windows are saved in TWork by PushW1, work indexes in XWork)
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
  keys = new BatchKeys();
  crt = new Crt(keys, null, 80, 25);
  SetDriversCrt(crt);
  const dv = DriversVars;
  dv.KbdBuffer = '';
  dv.KbdChar = 0;
  dv.Event.What = 0;
  dv.FandBatch = false;
  dv.MausExist = false;
  dv.Crs.Enabled = false;
  dv.TextAttr = 0x07;
  Window(1, 1, 80, 25);
  BaseVars.TxtCols = 80;
  BaseVars.TxtRows = 25;
  BaseVars.Spec.ScreenDelay = 0;
  BaseVars.Spec.F10Enter = false;
  BaseVars.F10SpecKey = 0;
  const c = BaseVars.Colors;
  c.tCtrl = 0x0c;
  c.zNorm = 0x4f;
  c.pTxt = 0x30;
  c.pNorm = 0x3f;
  c.lNorm = 0x70;
  c.lFirst = 0x74;
  c.lSwitch = 0x7e;
  c.fNorm = 0x17;
  c.ShadowAttr = 0x08;
  c.dNorm = 0x1f;
  c.dHili = 0x2f;
  c.dSubset = 0x3f;
  c.dDeleted = 0x4f;
  c.dSelect = 0x5f;
  c.dTxt = 0x1e;
  c.tNorm = 0x07;
  c.uNorm = 0x07;
  c.mNorm = 0x70;
  c.mHili = 0x0f;
  AccessVars.HelpFD = null;
  AccessVars.UserCode = 0;
  BaseVars.ExitP = false;
  BaseVars.BreakP = false;
  RunEdiVars.TxtEdCtrlUBrk = false;
  RunEdiVars.TxtEdCtrlF4Brk = false;
});

/** Closes the key queue: an engine read after the last queued key ends with EngineShutdown. */
function runKeys<T>(body: () => T): T {
  keys.close();
  return body();
}

// ---------------------------------------------------------------- RUNEDI.EditTxt

describe('RUNEDI.EditTxt – the one-line editor', () => {
  it('types into an empty field, Enter returns 0 with KbdChar = Enter, blanks after the cursor dropped', () => {
    GotoXY(11, 6);
    const s = ref('');
    press('abc  ', K.Left, K.Left, K.Enter);
    const r = runKeys(() => EditTxt(s, 1, 10, 10, 'A', false, false, true, false, 0));
    expect(r).toBe(0);
    expect(DriversVars.KbdChar).toBe(_M_);
    expect(s.v).toBe('abc');
    expect(row(5).slice(10, 20)).toBe('abc       ');
  });

  it('insert mode, cursor keys, Home/End, ^S/^D, Backspace, Del, ^G, ^Y-free edits', () => {
    GotoXY(1, 1);
    const s = ref('hello');
    // End, 'X' -> helloX; Home, Right, Del -> hlloX; ^D (right), Backspace -> hloX; ^S ^S, 'Z' -> ZhloX
    press(K.End, 'X', K.Home, K.Right, K.Del, 4, K.Backspace, 19, 19, 'Z', K.Enter);
    runKeys(() => EditTxt(s, 1, 20, 20, 'A', false, false, true, false, 0));
    expect(s.v).toBe('ZhloX');
    // Ins toggles overwrite; ^G deletes under the cursor
    const t = ref('abcd');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    press(K.Ins, 'XY', 7, K.Enter);
    runKeys(() => EditTxt(t, 1, 20, 20, 'A', false, false, true, false, 0));
    expect(t.v).toBe('XYd');
  });

  it('del = true clears the text on the first printable key; not on a cursor key', () => {
    const s = ref('old text');
    press('n', 'ew', K.Enter);
    runKeys(() => EditTxt(s, 1, 20, 20, 'A', true, false, true, false, 0));
    expect(s.v).toBe('new');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const t = ref('old');
    press(K.End, '!', K.Enter);
    runKeys(() => EditTxt(t, 1, 20, 20, 'A', true, false, true, false, 0));
    expect(t.v).toBe('old!');
  });

  it("typ 'N'/'F'/'R' filter the characters; maxlen stops input; upd = false ignores typing", () => {
    const n = ref('');
    press('1a2.3', K.Enter);
    runKeys(() => EditTxt(n, 1, 5, 5, 'N', false, false, true, false, 0));
    expect(n.v).toBe('123');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const f = ref('');
    press('-1,5e3x', K.Enter);
    runKeys(() => EditTxt(f, 1, 10, 10, 'F', false, false, true, false, 0));
    expect(f.v).toBe('-1,53');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const r = ref('');
    press('-1.5e+3x', K.Enter);
    runKeys(() => EditTxt(r, 1, 10, 10, 'R', false, false, true, false, 0));
    expect(r.v).toBe('-1.5e+3');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const m = ref('');
    press('abcdef', K.Enter);
    runKeys(() => EditTxt(m, 1, 4, 4, 'A', false, false, true, false, 0));
    expect(m.v).toBe('abcd');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const v = ref('view');
    press('zz', K.Del, K.Enter);
    runKeys(() => EditTxt(v, 1, 10, 10, 'A', false, false, false, false, 0));
    expect(v.v).toBe('view');
  });

  it('Esc returns 0 with KbdChar = Esc; ^U and Ctrl+F4 only break when enabled (and reset the flags)', () => {
    const s = ref('');
    press('ab', K.Esc);
    expect(runKeys(() => EditTxt(s, 1, 10, 10, 'A', false, false, true, false, 0))).toBe(0);
    expect(DriversVars.KbdChar).toBe(_ESC_);
    expect(s.v).toBe('ab');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    RunEdiVars.TxtEdCtrlUBrk = true;
    RunEdiVars.TxtEdCtrlF4Brk = true;
    const t = ref('');
    press('x', 21);
    expect(runKeys(() => EditTxt(t, 1, 10, 10, 'A', false, false, true, false, 0))).toBe(0);
    expect(DriversVars.KbdChar).toBe(_U_);
    expect(RunEdiVars.TxtEdCtrlUBrk).toBe(false);
    expect(RunEdiVars.TxtEdCtrlF4Brk).toBe(false);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    RunEdiVars.TxtEdCtrlF4Brk = true;
    const u = ref('');
    press(21, 'q', fKey(4, 2));
    expect(runKeys(() => EditTxt(u, 1, 10, 10, 'A', false, false, true, false, 0))).toBe(0);
    expect(DriversVars.KbdChar).toBe(_CtrlF4_);
    expect(u.v).toBe('q');
  });

  it('ret = true returns the cursor position after every key and leaves unknown keys pending', () => {
    const s = ref('');
    press('a');
    expect(runKeys(() => EditTxt(s, 1, 10, 10, 'A', false, false, true, true, 0))).toBe(2);
    expect(s.v).toBe('a');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    press(K.Up);
    expect(runKeys(() => EditTxt(s, 2, 10, 10, 'A', false, false, true, true, 0))).toBe(2);
    expect(DriversVars.Event.What).toBe(0x10); // evKeyDown still pending
    expect(DriversVars.Event.KeyCode).toBe(K.Up);
    DriversVars.Event.What = 0;
  });

  it('star shows asterisks, control chars are shown as letters in tCtrl, the view scrolls', () => {
    GotoXY(1, 3);
    const s = ref('pw');
    press(K.Enter);
    runKeys(() => EditTxt(s, 3, 10, 5, 'A', false, true, true, false, 0));
    expect(row(2).slice(0, 5)).toBe('**   ');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    GotoXY(1, 4);
    const c = ref('a\x01b');
    press(K.Enter);
    runKeys(() => EditTxt(c, 1, 10, 5, 'A', false, false, true, false, 0));
    expect(row(3).slice(0, 3)).toBe('aAb');
    expect(attr(1, 3)).toBe(0x0c);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    GotoXY(1, 5);
    const l = ref('');
    press('0123456789', K.Enter);
    runKeys(() => EditTxt(l, 1, 20, 5, 'A', false, false, true, false, 0));
    expect(l.v).toBe('0123456789');
    expect(row(4).slice(0, 5)).toBe('6789 '); // base = pos - maxcol
  });
});

// ---------------------------------------------------------------- RUNEDIT1: masks and the field editor

function field(typ: string, L: number, M = 0, FrmlTyp = 'S', flg = f_Stored, mask = ''): FieldDescr {
  const F = new FieldDescr();
  F.Typ = typ;
  F.FrmlTyp = FrmlTyp;
  F.L = L;
  F.M = M;
  F.Flg = flg;
  F.Name = 'F';
  F.Mask = mask;
  return F;
}

describe.skipIf(!haveApp)('RUNEDIT1.TestMask', () => {
  it('# 9 digits, @ letters, ? any, ! upcase, $ letter+upcase, literals', () => {
    const s = ref('12-ab-x');
    expect(TestMask(s, '99-@@-?', true)).toBe(true);
    const t = ref('ab1');
    expect(TestMask(t, '!$#', true)).toBe(true);
    expect(t.v).toBe('AB1');
  });
  it('[optional] and (alt|ernatives), trailing blanks are allowed', () => {
    expect(TestMask(ref('12  '), '99[99]', true)).toBe(true);
    expect(TestMask(ref('1234'), '99[99]', true)).toBe(true);
    expect(TestMask(ref('AB'), '(AB|CD)', true)).toBe(true);
    expect(TestMask(ref('CD'), '(AB|CD)', true)).toBe(true);
  });
  it('a mismatch shows message 653 with the mask (F10)', () => {
    press(K.F1 + 0x0900); // F10 = $4400
    const s = ref('1x');
    expect(runKeys(() => TestMask(s, '99', true))).toBe(false);
    expect(U(BaseVars.MsgLine)).toContain('99');
    expect(DriversVars.KbdChar).toBe(_F10_);
    expect(TestMask(ref('anything'), null, true)).toBe(true);
  });
});

describe.skipIf(!haveApp)('RUNEDIT1.FieldEdit', () => {
  it("'A' fields are padded to L; the mask of an A field is checked and uppercases", () => {
    GotoXY(1, 1);
    const F = field('A', 6, LeftJust);
    const Txt = ref('');
    const R = ref(0);
    press('ab', K.Enter);
    expect(runKeys(() => FieldEdit(F, null, 6, 1, Txt, R, true, true, false, 0))).toBe(0);
    expect(Txt.v).toBe('ab    ');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const M = field('A', 3, LeftJust, 'S', f_Stored | f_Mask, '!!9');
    const T2 = ref('');
    press('ab1', K.Enter);
    runKeys(() => FieldEdit(M, null, 3, 1, T2, R, true, true, false, 0));
    expect(T2.v).toBe('AB1');
  });
  it("'N' right-justified fields get leading zeros", () => {
    const F = field('N', 5, 0);
    const Txt = ref('');
    const R = ref(0);
    press('42', K.Enter);
    runKeys(() => FieldEdit(F, null, 5, 1, Txt, R, true, true, false, 0));
    expect(Txt.v).toBe('00042');
  });
  it("'F' fields: decimal comma, Str(r:L:M), f_Comma scales the result; overflow -> message 617, edit again", () => {
    // F,7.2 -> L = 7+2+2 = 11? (RDFILDCL: L = M=0 ? L+1 : L+M+2) -> here L=10, M=2
    const F = field('F', 10, 2, 'R');
    const Txt = ref('');
    const R = ref(0);
    press('12,5', K.Enter);
    runKeys(() => FieldEdit(F, null, 10, 1, Txt, R, true, true, false, 0));
    expect(Txt.v).toBe('     12.50');
    expect(R.v).toBe(12.5);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const C = field('F', 10, 2, 'R', f_Stored | f_Comma);
    const T2 = ref('');
    press('-1,257', K.Enter);
    runKeys(() => FieldEdit(C, null, 10, 1, T2, R, true, true, false, 0));
    expect(T2.v).toBe('     -1.26');
    expect(R.v).toBe(-126); // int(-1.257*100 - 0.5)
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const S = field('F', 5, 0, 'R'); // 4 digits
    const T3 = ref('');
    press('12345', K.Enter, 0x4400, '9', K.Enter);
    runKeys(() => FieldEdit(S, null, 5, 1, T3, R, true, true, false, 0));
    expect(U(BaseVars.MsgPar[1])).toBe('9999.');
    expect(T3.v).toBe('    9');
    expect(R.v).toBe(9);
  });
  it("'D' fields: ValDate/StrDate with the mask; an invalid date -> message 618", () => {
    const F = field('D', 10, 0, 'R', f_Stored, 'DD.MM.YYYY');
    const Txt = ref('');
    const R = ref(0);
    press('1.2.2026', K.Enter);
    runKeys(() => FieldEdit(F, null, 10, 1, Txt, R, true, true, false, 0));
    expect(Txt.v).toBe('01.02.2026');
    expect(R.v).toBeGreaterThan(700000);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const T2 = ref('');
    // error 618, F10, then the field is edited again with del = true
    press('32.13.2026', K.Enter, 0x4400, '3.1.2026', K.Enter);
    runKeys(() => FieldEdit(F, null, 10, 1, T2, R, true, true, false, 0));
    expect(U(BaseVars.MsgPar[1])).toBe('DD.MM.YYYY');
    expect(T2.v).toBe('03.01.2026');
  });
  it("'B' fields accept only Yes/No letters; Enter keeps the value; Esc leaves", () => {
    GotoXY(1, 1);
    const F = field('B', 1, 0, 'B');
    const Txt = ref('');
    const R = ref(0);
    const yes = BaseVars.AbbrYes;
    press('q', yes.toLowerCase());
    runKeys(() => FieldEdit(F, null, 1, 1, Txt, R, true, true, false, 0));
    expect(Txt.v).toBe(yes);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const T2 = ref(yes);
    press(K.Enter);
    runKeys(() => FieldEdit(F, null, 1, 1, T2, R, true, true, false, 0));
    expect(T2.v).toBe(yes);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const T3 = ref('');
    press(K.Esc);
    runKeys(() => FieldEdit(F, null, 1, 1, T3, R, true, true, false, 0));
    expect(DriversVars.KbdChar).toBe(_ESC_);
    expect(T3.v).toBe('');
  });
});

// ---------------------------------------------------------------- the data editor end to end

/** A scratch RDB (chapter file only) whose data files live in dir. */
function newRdb(dir: string): RdbD {
  const a = AccessVars;
  rmSync(dir, { recursive: true, force: true });
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
  RdRunVars.EditDRoot = null;
  return R;
}

/** RDFILDCL: declare a data file of the scratch RDB. */
function declare(name: string, dcl: string, typ = '6'): FileD {
  ResetCompilePars();
  AccessVars.RdFldNameFrml = null;
  AccessVars.FrmlSumEl = null;
  SetInpStr(ref(B(dcl)));
  ok(() => RdFileD(name, typ, ''));
  return AccessVars.CFile!;
}

type Val = string | number | boolean;
function fld(fd: FileD, name: string): FieldDPtr {
  for (let f = fd.FldD; f !== null; f = f.Chain) if (U(f.Name) === name) return f;
  throw new Error(`no field ${name}`);
}
/** Appends records (field name -> value) to a non-indexed fd. */
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
/** Screen dump for failure messages. */
const screen = (): string => Array.from({ length: 25 }, (_, y) => row(y).trimEnd()).join('\n');

/** EditDataFile with an automatic form of all fields; the queued keys must end the editor. */
function editFile(fd: FileD, ...ks: (number | string)[]): void {
  editFileEO(fd, null, ...ks);
}
function editFileEO(fd: FileD, cfg: ((EO: NonNullable<ReturnType<typeof GetEditOpt>>) => void) | null,
  ...ks: (number | string)[]): void {
  const EO = GetEditOpt()!;
  EO.Flds = AllFldsList(fd, false);
  cfg?.(EO);
  press(...ks);
  keys.close();
  try {
    ok(() => EditDataFile(fd, EO));
  } catch (e) {
    if (e instanceof EngineShutdown) throw new Error(`the editor waits for more keys:\n${screen()}`);
    throw e;
  }
  expect(RdRunVars.EditDRoot).toBe(null);
}

describe.skipIf(!haveApp)('RUNEDIT: EditDataFile on a scratch RDB', () => {
  const dir = join(TMP, 'rdb1');
  beforeEach(() => {
    newRdb(dir);
    BaseVars.AbbrYes = 'A';
    BaseVars.AbbrNo = 'N';
  });

  it('appends records into an empty file: Enter walks the fields, the last Enter writes, Esc leaves', () => {
    const fd = declare('OSOBY', 'Jmeno:A,10;Vek:F,3.0;Pozn:A,12');
    editFile(fd, 'Novak', K.Enter, '42', K.Enter, 'abc', K.Enter, 'Svoboda', K.Enter, '7', K.Enter, K.Enter, K.Esc);
    expect(readRecs(fd, ['Jmeno', 'Vek', 'Pozn'])).toEqual([
      ['Novak', 42, 'abc'],
      ['Svoboda', 7, ''],
    ]);
    expect(AccessVars.EdUpdated).toBe(true);
    expect(AccessVars.EdRecNo).toBe(0); // left on the (deleted) new record
  });

  it('Esc on a changed existing record saves it; Esc on a changed new record drops it', () => {
    const fd = declare('OSOBY', 'Jmeno:A,10;Vek:F,3.0');
    addRecs(fd, [{ Jmeno: 'A1', Vek: 1 }, { Jmeno: 'B2', Vek: 2 }]);
    // record 1: overwrite the name, Esc
    editFile(fd, 'Z9', K.Enter, K.Esc); // (Esc inside the field would only cancel the field edit)
    expect(readRecs(fd, ['Jmeno', 'Vek'])).toEqual([
      ['Z9', 1],
      ['B2', 2],
    ]);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    // F2 = append mode, type a name, Esc -> the new record is not written
    editFile(fd, fKey(2), 'NEW', K.Enter, K.Esc);
    expect(fd.NRecs).toBe(2);
  });

  it('Down/Up move between records, Ctrl+Y deletes, Alt+= undoes and leaves', () => {
    const fd = declare('OSOBY', 'Jmeno:A,10;Vek:F,3.0');
    addRecs(fd, [{ Jmeno: 'A1', Vek: 1 }, { Jmeno: 'B2', Vek: 2 }, { Jmeno: 'C3', Vek: 3 }]);
    // Down to B2, Ctrl+Y deletes it (no verify), then on C3 (now 2nd) type and Alt+= (undo, exit)
    editFile(fd, K.Down, 25, WAIT, 'XX', K.Enter, 0x8300); // Ctrl+Y drops the type-ahead (ClearKeyBuf)
    expect(readRecs(fd, ['Jmeno', 'Vek'])).toEqual([
      ['A1', 1],
      ['C3', 3],
    ]);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    // Ctrl+End = last record, Up, change Vek via Right + typing, Esc saves
    editFile(fd, K.CtrlEnd, K.Up, K.Right, '55', K.Enter, K.Esc);
    expect(readRecs(fd, ['Jmeno', 'Vek'])).toEqual([
      ['A1', 55],
      ['C3', 3],
    ]);
  });

  it('Ctrl+N inserts before the current record, Ctrl+Right swaps records, Ctrl+F3 goes to a record number', () => {
    const fd = declare('OSOBY', 'Jmeno:A,10;Vek:F,3.0');
    addRecs(fd, [{ Jmeno: 'A1', Vek: 1 }, { Jmeno: 'B2', Vek: 2 }, { Jmeno: 'C3', Vek: 3 }]);
    editFile(fd, K.CtrlPgDn, 14, 'NN', K.Enter, '9', K.Enter, K.Esc);
    expect(readRecs(fd, ['Jmeno'])).toEqual([['A1'], ['B2'], ['NN'], ['C3']]);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    editFile(fd, K.CtrlRight, K.Esc);
    expect(readRecs(fd, ['Jmeno'])).toEqual([['B2'], ['A1'], ['NN'], ['C3']]);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    editFile(fd, fKey(3, 2), '4', K.Enter, 'ZZ', K.Enter, K.Esc);
    expect(readRecs(fd, ['Jmeno', 'Vek'])).toEqual([['B2', 2], ['A1', 1], ['NN', 9], ['ZZ', 3]]);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    // PgDn moves by the window height (clamped to the last record), Ctrl+PgUp to the first; Home/End fields
    editFile(fd, K.PgDn, K.End, '8', K.Enter, WAIT, K.CtrlPgUp, K.End, '7', K.Enter, WAIT, K.Esc);
    expect(readRecs(fd, ['Vek'])).toEqual([[7], [1], [9], [8]]);
  });

  it('F6 menu -> filter (PromptSelect): Down skips the records the condition rejects', () => {
    const fd = declare('OSOBY', 'Jmeno:A,10;Vek:F,3.0');
    addRecs(fd, [{ Jmeno: 'A1', Vek: 1 }, { Jmeno: 'B2', Vek: 0 }, { Jmeno: 'C3', Vek: 3 }]);
    // (a key typed ahead while Down searches would ask 'přerušit hledání A/N?' - message 23)
    editFile(fd, fKey(6), WAIT, K.Down, K.Down, K.Enter, WAIT, 'Vek>0', K.Enter, WAIT, K.Down, WAIT, 'X', K.Enter, K.Esc);
    expect(readRecs(fd, ['Jmeno'])).toEqual([['A1'], ['B2'], ['X']]);
  });

  it('a journal file gets +, O and N records with the record number, user code and the record copy', () => {
    const fd = declare('OSOBY', 'Jmeno:A,10;Vek:F,3.0');
    addRecs(fd, [{ Jmeno: 'A1', Vek: 1 }]);
    const jrn = declare('JRN', "Upd:A,1;RecNr:F,8.0;User:F,4.0;TimeStamp:D,'DD.MM.YYYY hh:mm:ss';Jmeno:A,10;Vek:F,3.0");
    AccessVars.UserCode = 3;
    editFileEO(fd, (EO) => (EO.Journal = jrn), K.Right, '5', K.Enter, fKey(2), 'B2', K.Enter, '2', K.Enter, K.Esc);
    AccessVars.UserCode = 0;
    expect(readRecs(fd, ['Jmeno', 'Vek'])).toEqual([['A1', 5], ['B2', 2]]);
    expect(readRecs(jrn, ['Upd', 'RecNr', 'User', 'Jmeno', 'Vek'])).toEqual([
      ['O', 1, 3, 'A1', 1],
      ['N', 1, 3, 'A1', 5],
      ['+', 2, 3, 'B2', 2],
    ]);
    const ts = readRecs(jrn, ['TimeStamp'])[0][0] as number;
    expect(Math.abs(ts - (Date.now() / 86400000 + 719163 + 1))).toBeLessThan(40);
  });

  it('F4 duplicates the field of the previous record into a new record', () => {
    const fd = declare('OSOBY', 'Jmeno:A,10;Vek:F,3.0');
    addRecs(fd, [{ Jmeno: 'A1', Vek: 7 }]);
    // F2 (append), type a name, Enter -> Vek; F4 copies Vek=7 and goes on (writes the record)
    editFile(fd, fKey(2), 'B2', K.Enter, fKey(4), K.Esc);
    expect(readRecs(fd, ['Jmeno', 'Vek'])).toEqual([
      ['A1', 7],
      ['B2', 7],
    ]);
  });

  it('an indexed file keeps its key order; a duplicate primary key is refused (message 820)', () => {
    const fd = declare('ADR', 'Cislo:F,4.0;Jmeno:A,10;#K @ Cislo', 'X');
    editFile(fd, '5', K.Enter, 'E', K.Enter, '3', K.Enter, 'C', K.Enter, '9', K.Enter, 'I', K.Enter, K.Esc);
    expect(readRecs(fd, ['Cislo', 'Jmeno'])).toEqual([
      [5, 'E'],
      [3, 'C'],
      [9, 'I'],
    ]);
    const a = AccessVars;
    a.CFile = fd;
    const md = NewLMode(ExclMode);
    const K1 = fd.Keys!;
    expect(fd.XF!.NRecs).toBe(3);
    expect([1, 2, 3].map((i) => K1.NrToRecNr(i))).toEqual([2, 1, 3]);
    OldLMode(md);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    // F2 append, key 3 again -> 820 (F10), Esc drops the new record
    editFile(fd, fKey(2), '3', K.Enter, 'X', K.Enter, 0x4400, K.Esc);
    expect(U(BaseVars.MsgLine)).toMatch(/[Kk]l/);
    expect(fd.XF!.NRecs).toBe(3);
  });
  it('F3 searches by the primary key (index): found -> goes there; not found -> message 118', () => {
    const fd = declare('ADR', 'Cislo:F,4.0;Jmeno:A,10;#K @ Cislo', 'X');
    editFile(fd, '20', K.Enter, 'B', K.Enter, '10', K.Enter, 'A', K.Enter, '30', K.Enter, 'C', K.Enter, K.Esc);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    // F3, 20 Enter -> record with Cislo 20 (2nd in key order); Right, rename, Enter writes, Esc
    editFile(fd, fKey(3), '20', K.Enter, K.Right, 'BB', K.Enter, K.Esc);
    expect(readRecs(fd, ['Cislo', 'Jmeno'])).toEqual([
      [20, 'BB'],
      [10, 'A'],
      [30, 'C'],
    ]);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    // F3, 25 (missing) -> 'věta neexistuje' (F10), the cursor stays on the next key (30)
    editFile(fd, fKey(3), '25', K.Enter, 0x4400, K.Right, 'CC', K.Enter, K.Esc);
    expect(U(BaseVars.MsgLine)).toBe('věta neexistuje');
    expect(readRecs(fd, ['Cislo', 'Jmeno'])).toEqual([
      [20, 'BB'],
      [10, 'A'],
      [30, 'CC'],
    ]);
  });

  it('Ctrl+F5 calculator: Ctrl+F4 assigns the result to the current field', () => {
    const fd = declare('OSOBY', 'Jmeno:A,10;Vek:F,3.0');
    addRecs(fd, [{ Jmeno: 'A1', Vek: 1 }]);
    editFile(fd, K.Right, fKey(5, 2), '6*7', fKey(4, 2), K.Esc);
    expect(RdRunVars.CalcTxt).toBe('6*7');
    expect(readRecs(fd, ['Jmeno', 'Vek'])).toEqual([['A1', 42]]);
  });

  it('^U asks (message 108) and undoes the record', () => {
    const fd = declare('OSOBY', 'Jmeno:A,10;Vek:F,3.0');
    addRecs(fd, [{ Jmeno: 'A1', Vek: 1 }]);
    editFile(fd, 'QQ', K.Enter, '9', K.Enter, WAIT, K.Up, K.Esc);
    expect(readRecs(fd, ['Jmeno', 'Vek'])).toEqual([['QQ', 9]]);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    editFile(fd, 'ZZ', K.Enter, 21, BaseVars.AbbrYes, K.Esc);
    expect(readRecs(fd, ['Jmeno', 'Vek'])).toEqual([['QQ', 9]]);
  });

  it('a T field: typing opens the text editor, the text is stored in the .T00 file', () => {
    const fd = declare('POZN', 'Nazev:A,10;Pozn:T');
    editFile(fd, 'X', K.Enter, 'hello', K.Esc, WAIT, K.Esc);
    expect(fd.NRecs).toBe(1);
    const a = AccessVars;
    a.CFile = fd;
    const md = NewLMode(ExclMode);
    a.CRecPtr = GetRecSpace();
    ReadRec(1);
    const t = _LongS(fld(fd, 'Pozn'));
    OldLMode(md);
    expect(String.fromCharCode(...t)).toBe('hello');
  });
  it('a failed link check (#L X.exist): F10 message 110 with Shift+F7 picks the value from the linked file', () => {
    const druhy = declare('DRUHY', 'Kod:A,2;Nazev:A,10;#K @ Kod', 'X');
    editFile(druhy, 'AA', K.Enter, 'first', K.Enter, 'BB', K.Enter, 'second', K.Enter, K.Esc);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    const poloz = declare('POLOZ', 'Druh:A,2;Castka:F,5.0;#K DRUHY Druh');
    expect(AccessVars.LinkDRoot).not.toBe(null);
    // the #L check DRUHY.exist:'Neznamy druh' hung on the Druh field of the POLOZ form
    hooks.afterNewEditD = (): void => {
      const E = RdRunVars.EditDRoot!;
      if (E.FD !== poloz) return;
      AccessVars.CFile = poloz;
      ResetCompilePars();
      SetInpStr(ref(B("DRUHY.exist:'Neznamy druh'")));
      RdLex();
      E.FirstFld!.Chk = RdChkD(1);
    };
    // ZZ fails the check -> Shift+F7 -> DRUHY editor on the nearest key; Up to AA, Enter copies it
    // back (^M into the key buffer = Enter in POLOZ), then Castka 5, Enter writes, Esc
    try {
      editFile(poloz, 'ZZ', K.Enter, WAIT, fKey(7, 1), WAIT, K.Up, K.Enter, WAIT, '5', K.Enter, K.Esc);
    } finally {
      hooks.afterNewEditD = null;
    }
    expect(readRecs(poloz, ['Druh', 'Castka'])).toEqual([['AA', 5]]);
  });
});

// ---------------------------------------------------------------- state, helpers, prompts

describe('RUNEDI state: CRec, CNRecs, AbsRecNr, WrEStatus/RdEStatus, SetNewCRec', () => {
  it('copies the EditD fields FirstEmptyFld..SelMode both ways and derives HasIndex/HasTF/CPage', () => {
    const fd = new FileD();
    fd.NRecs = 7;
    const E = new EditD();
    E.FD = fd;
    E.NewRecPtr = new Uint8Array(4);
    E.NRecs = 3;
    const D = new EFldD();
    D.Page = 1;
    E.CFld = D;
    const rt = new ERecTxtD();
    rt.N = 2;
    E.RecTxt = rt;
    E.BaseRec = 4;
    E.IRec = 2;
    E.Select = true;
    E.SelMode = true;
    E.OnlySearch = true; // VK = nil -> OnlySearch off
    RdRunVars.EditDRoot = E;
    RdEStatus();
    const P = RunEdiPriv;
    expect(AccessVars.CFile).toBe(fd);
    expect(AccessVars.CRecPtr).toBe(E.NewRecPtr);
    expect(RunEdiVars.CFld).toBe(D);
    expect([P.BaseRec, P.IRec, P.Select, P.SelMode, P.OnlySearch, P.HasIndex, P.HasTF]).toEqual([
      4, 2, true, true, false, false, false,
    ]);
    expect(P.CPage).toBe(1);
    expect(P.RT).toBe(rt);
    expect(CRec()).toBe(5);
    expect(CNRecs()).toBe(7);
    expect(AbsRecNr(5)).toBe(5);
    P.IsNewRec = true;
    expect(CNRecs()).toBe(8);
    expect(AbsRecNr(3)).toBe(3);
    expect(AbsRecNr(6)).toBe(5); // after the new record
    expect(TestIsNewRec()).toBe(true);
    P.IsNewRec = false;
    SetNewCRec(9, false); // below the window: base moves
    expect([P.BaseRec, P.IRec]).toEqual([7, 3]);
    SetNewCRec(2, false);
    expect([P.BaseRec, P.IRec]).toEqual([2, 1]);
    SetSelectFalse();
    P.WarnSwitch = true;
    WrEStatus();
    expect(E.Select).toBe(false);
    expect(E.WarnSwitch).toBe(true);
    expect(E.BaseRec).toBe(2);
    for (const f of EditDCopiedFields) expect((E as unknown as Record<string, unknown>)[f]).toBe(
      (P as unknown as Record<string, unknown>)[f]);
    const prev = new EditD();
    E.PrevE = prev;
    PopEdit();
    expect(RdRunVars.EditDRoot).toBe(prev);
    RdRunVars.EditDRoot = null;
  });

  it('CheckKeyIn: KEYIN intervals over the packed view key', () => {
    const E = new EditD();
    expect(CheckKeyIn(E)).toBe(true);
    // a view key of one A,3 field; the record holds 'KLM'
    const fd = new FileD();
    const F = field('A', 3, LeftJust);
    F.NBytes = 3;
    fd.FldD = F;
    fd.RecLen = 3;
    const kf = new (class { Chain = null; FldD = F; CompLex = false; Descend = false })();
    const key = new (class { KFlds = kf })() as never;
    E.VK = key;
    AccessVars.CFile = fd;
    AccessVars.CRecPtr = Uint8Array.from([0x4b, 0x4c, 0x4d, 0, 0]);
    const x = new XString();
    x.PackKF(kf as never);
    const lo = x.S;
    const k1 = new (class { Chain = null; X1: string | null = null; X2: string | null = null })();
    E.KIRoot = k1 as never;
    k1.X1 = lo.slice(0, 1); // prefix 'K..' up to 'K'#$FF
    expect(CheckKeyIn(E)).toBe(true);
    k1.X1 = lo + 'Z';
    k1.X2 = lo + 'Z';
    expect(CheckKeyIn(E)).toBe(false);
  });

  it('DuplFld copies S/R/B values between records (and files)', () => {
    const fd = new FileD();
    const A = field('A', 3, LeftJust);
    A.NBytes = 3;
    const N = field('F', 5, 0, 'R');
    N.NBytes = 2;
    N.Displ = 3;
    A.Chain = N;
    fd.FldD = A;
    fd.RecLen = 5;
    fd.Typ = '6';
    const r1 = new Uint8Array(7);
    const r2 = new Uint8Array(7);
    AccessVars.CFile = fd;
    AccessVars.CRecPtr = r1;
    S_(A, 'abc');
    R_(N, 123);
    DuplFld(fd, fd, r1, r2, null, A, A);
    DuplFld(fd, fd, r1, r2, null, N, N);
    expect(AccessVars.CRecPtr).toBe(r1);
    AccessVars.CRecPtr = r2;
    expect(_ShortS(A)).toBe('abc');
    expect(_R(N)).toBe(123);
  });
});

describe('RUNEDIT3 helpers', () => {
  it('EquRoleName: empty role = the file name; GetFileViewName skips views without access rights', () => {
    const ld = new (class {
      ToFD = { Name: 'FIRMY' };
      RoleName = 'FIRMY';
    })() as never;
    expect(EquRoleName('', ld)).toBe(true);
    expect(EquRoleName('X', ld)).toBe(false);
    const fd = new FileD();
    fd.Name = 'FIRMY';
    const SL = ref(null);
    expect(GetFileViewName(fd, SL)).toBe('FIRMY');
    const v1 = { Chain: null as unknown, S: 'Admin', After: '\x05' };
    const v2 = { Chain: null as unknown, S: 'All', After: '\x01\x02' };
    const v3 = { Chain: null as unknown, S: 'Other', After: '\x02' };
    v1.Chain = v2;
    v2.Chain = v3;
    AccessVars.UserCode = 7;
    AccessVars.AccRight = '\x02';
    const r = ref(v1 as never);
    expect(GetFileViewName(fd, r)).toBe('\x01All');
    expect(r.v).toBe(v3);
    expect(GetFileViewName(fd, r)).toBe('\x01Other');
    expect(r.v).toBe(null);
    AccessVars.UserCode = 0;
  });
});

describe.skipIf(!haveApp)('RUNEDI prompts, CompChk, DisplSysLine', () => {
  it('PromptS/PromptR/PromptB edit a value at the cursor; Esc gives the implicit value', async () => {
    const { PromptS, PromptR, PromptB } = await import('../src/engine/pas/runedi.ts');
    const { FrmlElem, _const } = await import('../src/engine/pas/access.ts');
    GotoXY(1, 10);
    const A = field('A', 8, LeftJust);
    press('jmeno', K.Enter);
    expect(runKeys(() => PromptS('Name: ', null, A))).toBe('jmeno   ');
    expect(AccessVars.EscPrompt).toBe(false);
    expect(row(9).slice(0, 14)).toBe('Name: jmeno   ');
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    GotoXY(1, 11);
    const F = field('F', 6, 2, 'R');
    press('3,25', K.Enter);
    expect(runKeys(() => PromptR('Kc ', null, F))).toBe(3.25);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    GotoXY(1, 12);
    const Bf = field('B', 1, 0, 'B');
    const impl = new FrmlElem(_const);
    impl.B = true;
    press(K.Esc);
    expect(runKeys(() => PromptB('Ok? ', impl, Bf))).toBe(true);
    expect(AccessVars.EscPrompt).toBe(true);
  });

  it('GetSel2S splits the SelectStr choice at C (wh=1: the tail is s, wh=2: the head is s)', async () => {
    const { SelectStr } = await import('../src/engine/pas/wwmix.ts');
    PutSelect('RDB.FILE');
    PutSelect('OTHER');
    press(K.Enter);
    runKeys(() => SelectStr(0, 0, 35, ''));
    const s = ref('');
    const s2 = ref('');
    GetSel2S(s, s2, '.', 1);
    expect([s.v, s2.v]).toEqual(['FILE', 'RDB']);
    keys = new BatchKeys();
    crt = new Crt(keys, null, 80, 25);
    SetDriversCrt(crt);
    PutSelect('\x01view.ROLE');
    press(K.Enter);
    runKeys(() => SelectStr(0, 0, 35, ''));
    GetSel2S(s, s2, '.', 2);
    expect([s.v, s2.v]).toEqual(['\x01view', 'ROLE']);
  });

  it('CompChk: failed errors always, warnings only with WarnSwitch', async () => {
    const { FrmlElem, _const, ChkD } = await import('../src/engine/pas/access.ts');
    const no = new FrmlElem(_const);
    no.B = false;
    const w = new ChkD();
    w.Bool = no;
    w.Warning = true;
    const e = new ChkD();
    e.Bool = no;
    const D = new EFldD();
    D.Chk = w;
    RunEdiPriv.WarnSwitch = false;
    expect(CompChk(D, '?')).toBe(null);
    RunEdiPriv.WarnSwitch = true;
    expect(CompChk(D, '?')).toBe(w);
    expect(CompChk(D, 'F')).toBe(null);
    w.Chain = e;
    expect(CompChk(D, 'F')).toBe(e);
  });

  it('DisplSysLine: __.__.____ = today, a run of underscores = the record number field', () => {
    const E = new EditD();
    E.Head = '  FILE  ____     __.__.____';
    const fd = new FileD();
    fd.NRecs = 0;
    E.FD = fd;
    RdRunVars.EditDRoot = E;
    RunEdiPriv.BaseRec = 1;
    RunEdiPriv.IRec = 3;
    DisplSysLine();
    expect([E.RecNrPos, E.RecNrLen]).toEqual([9, 4]);
    expect(row(0).slice(0, 17)).toBe('  FILE     3     ');
    expect(row(0).slice(17, 27)).toMatch(/^\d\d\.\d\d\.\d{4}$/);
    RdRunVars.EditDRoot = null;
  });
});
