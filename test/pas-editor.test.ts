// Tests of the EDITOR package: editor.ts (+ edglobal, edtextf, ededit, edscreen, edevent, edevinpt,
// edevproc). The editor runs in-process on a Crt + KeyQueue; the keys are queued before the editor
// reads them. LazyCrt hides queued keys from KeyPressed, so the editor redraws the screen after each
// key (as with a human typist) instead of skipping the redraw because input is pending.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { ref, getWord, FromUnicode, TxtRewrite, Output, GoExitSignal } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, ReadH, PosH, _isoldfile, _isoverwritefile, RdOnly, Exclusive, OpenWorkH, FormatCache,
  NewExit, RestoreExit, ExitRecord, OrigKbd, type TMsgIdxItem,
} from '../src/engine/pas/base.ts';
import { SetDriversCrt, DriversVars, AssignCrt } from '../src/engine/pas/drivers.ts';
import { Crt, UNICODE_KEY } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { K, fKey } from '../src/engine/console/keys.ts';
import { encode852, decode852 } from '../src/engine/console/cp852.ts';
import { AccessVars } from '../src/engine/pas/access.ts';
import {
  EditorVars, EdPriv, EditText, SimpleEditText, FindText, InitTxtEditor, EditTxtFile, SetEditTxt, GetEditTxt,
  SavePar, RestorePar, ClearHelpStkForCRdb, HelpStkEntry, TextM, ViewM, LocalT, MemoT, MsgStr,
} from '../src/engine/pas/editor.ts';
import { FindChar, SetColorOrd, TestOptStr } from '../src/engine/pas/edglobal.ts';
import { EdExitD, EdExKeyD, RdRunVars } from '../src/engine/pas/rdrun.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const SRC = join(ROOT, 'work/source');
const TMP = join(ROOT, 'work/tmp-editor');
const haveApp = existsSync(join(APP, 'FAND.RES'));
const haveSrc = existsSync(SRC);

/** Byte string of a Unicode text (CP852) and back. */
const B = (u: string): string => String.fromCharCode(...bytes(u));
/** CP852 bytes -> Unicode; ASCII (with the control characters) stays as it is */
const dec = (b: Uint8Array): string =>
  Array.from(b, (c) => (c < 0x80 ? String.fromCharCode(c) : decode852(Uint8Array.of(c)))).join('');
const U = (b: string): string => dec(Uint8Array.from(b, (c) => c.charCodeAt(0)));
/** Unicode -> CP852 bytes; ASCII (with the control characters) stays as it is */
const bytes = (u: string): Uint8Array =>
  Uint8Array.from(Array.from(u).flatMap((c) => (c.charCodeAt(0) < 0x80 ? [c.charCodeAt(0)] : [...encode852(c)])));
const H = (p: string): string => FromUnicode(p);

/** A Crt whose KeyPressed does not see the queued keys (only a key already taken and put back). */
class LazyCrt extends Crt {
  override keyPressed(): boolean {
    return (this as unknown as { pushedBack: unknown[] }).pushedBack.length > 0;
  }
}

let crt: Crt;
let keys: KeyQueue;
const press = (...codes: number[]): void => {
  for (const c of codes) keys.push(c);
};
/** printable text as Unicode host keys */
const type = (s: string): void => {
  for (const c of s) keys.push(UNICODE_KEY | c.charCodeAt(0));
};
const ctrl = (c: string): number => c.toUpperCase().charCodeAt(0) - 0x40; // ^A = 1
const row = (y: number): string => crt.screen.rowText(y);

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

/** SimpleEditText on a Unicode text; returns the edited text (Unicode) and the flags. */
function simpleEdit(text: string, mode = TextM, maxLen = 0x7fff): { txt: string; upd: boolean; ind: number } {
  const b = bytes(text);
  const Len = ref(b.length);
  const Ind = ref(1);
  const Upd = ref(false);
  ok(() => SimpleEditText(mode, '', '', b, maxLen, Len, Ind, Upd));
  const t = EditorVars.EdTxt!.subarray(0, Len.v);
  return { txt: dec(t), upd: Upd.v, ind: Ind.v };
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  keys = new KeyQueue();
  crt = new LazyCrt(keys, null, 80, 25);
  SetDriversCrt(crt);
  AssignCrt(Output);
  TxtRewrite(Output);
  if (haveApp) loadResMessages();
  FormatCache();
  // the TWork scratch file (windows are saved in TWork by PushW1, the clipboard lives there)
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

beforeEach(() => {
  keys = new KeyQueue();
  crt = new LazyCrt(keys, null, 80, 25);
  SetDriversCrt(crt);
  const dv = DriversVars;
  dv.KbdBuffer = '';
  dv.KbdChar = 0;
  dv.KbdFlgs = 0;
  dv.Event.What = 0;
  dv.FandBatch = false;
  dv.MausExist = false;
  dv.LLKeyFlags = 0;
  dv.Crs.Enabled = false;
  dv.WindMin.X = 0;
  dv.WindMin.Y = 0;
  dv.WindMax.X = 79;
  dv.WindMax.Y = 24;
  dv.TextAttr = 0x07;
  BaseVars.TxtCols = 80;
  BaseVars.TxtRows = 25;
  BaseVars.Spec.ScreenDelay = 0;
  BaseVars.Spec.KbdTyp = OrigKbd;
  BaseVars.Spec.CtrlDelay = 0;
  BaseVars.Spec.TxtCharPg = '\xfa';
  BaseVars.Spec.TxtInsPg = true;
  BaseVars.F10SpecKey = 0;
  const c = BaseVars.Colors;
  c.tNorm = 0x17;
  c.tCtrl = 0x1c;
  c.tBlock = 0x71;
  c.tUnderline = 0x1a;
  c.tItalic = 0x1b;
  c.tDWidth = 0x1d;
  c.tDStrike = 0x1e;
  c.tEmphasized = 0x1f;
  c.tCompressed = 0x13;
  c.tElite = 0x12;
  c.fNorm = 0x70;
  c.lNorm = 0x70;
  c.lFirst = 0x74;
  c.zNorm = 0x4f;
  c.pNorm = 0x1e;
  c.pTxt = 0x1f;
  c.hNorm = 0x30;
  c.ShadowAttr = 0x08;
  AccessVars.EdBreak = 0;
  BaseVars.ExitP = false;
  BaseVars.BreakP = false;
  InitTxtEditor();
});

// ---------------------------------------------------------------- search helpers

describe('EDGLOBAL: FindChar, FindString (FindText), SetColorOrd', () => {
  it('FindChar finds the Num-th occurrence and returns Len when missing (BP7: Num unchanged)', () => {
    const t = bytes('ab\r\ncd\r\nef\r\n');
    const tt = EdPriv.T;
    EdPriv.T = t;
    try {
      const n = ref(2);
      expect(FindChar(n, '\r', 1, t.length)).toBe(7);
      expect(n.v).toBe(2);
      const m = ref(1);
      expect(FindChar(m, 'x', 1, t.length)).toBe(t.length);
      expect(m.v).toBe(1);
      expect(FindChar(ref(1), 'c', 6, t.length)).toBe(t.length);
    } finally {
      EdPriv.T = tt;
    }
  });
  it('FindText with the options: exact, u (upper case), ~ (CharOrdTab), w (whole words)', () => {
    const t = bytes('Účetní deník; ÚČETNÍ DENÍK a účetnictví.');
    // result = index after the match (1-based)
    expect(FindText(B('deník'), '', t, t.length)).toBe(13);
    expect(FindText(B('DENÍK'), '', t, t.length)).toBe(27);
    expect(FindText(B('deník'), 'u', t, t.length)).toBe(13);
    expect(FindText(B('xyz'), 'U', t, t.length)).toBe(0);
    // whole words: 'účet' is only a prefix
    expect(FindText(B('účet'), 'w', t, t.length)).toBe(0);
    expect(FindText(B('účetnictví'), 'W', t, t.length)).toBe(40);
    // ~: CharOrdTab (identity until FAND.CFG is read) behaves like the exact search
    expect(FindText(B('DENÍK'), '~', t, t.length)).toBe(27);
    // the editor globals are restored
    expect(EdPriv.FindStr).toBe('');
  });
  it('TestOptStr ignores the case of the option letter', () => {
    const o = EdPriv.OptionStr;
    EdPriv.OptionStr = 'GW';
    try {
      expect(TestOptStr('g')).toBe(true);
      expect(TestOptStr('w')).toBe(true);
      expect(TestOptStr('u')).toBe(false);
    } finally {
      EdPriv.OptionStr = o;
    }
  });
  it('SetColorOrd toggles the colour control chars of T[First..Last)', () => {
    const tt = EdPriv.T;
    EdPriv.T = bytes('a\x13b\x02c\x13d\x02');
    try {
      const co = ref('');
      SetColorOrd(co, 1, 8);
      expect(co.v).toBe('\x02'); // ^S on and off again, ^B still on
      const co2 = ref('');
      SetColorOrd(co2, 1, 2); // Last is exclusive
      expect(co2.v).toBe('');
    } finally {
      EdPriv.T = tt;
    }
  });
});

// ---------------------------------------------------------------- editor state

describe('EDITOR: SavePar/RestorePar, SetEditTxt/GetEditTxt, help stack', () => {
  it('SavePar/RestorePar restore the switches and the editor block', () => {
    EditorVars.Insert = true;
    EdPriv.Mode = 'T';
    EdPriv.LenT = 17;
    EdPriv.Part.PosP = 5;
    EdPriv.ColKey[3] = 0x42;
    const l = SavePar();
    EditorVars.Insert = false;
    EdPriv.Mode = 'H';
    EdPriv.LenT = 1;
    EdPriv.Part.PosP = 99;
    EdPriv.ColKey[3] = 0;
    RestorePar(l);
    expect(EditorVars.Insert).toBe(true);
    expect(EdPriv.Mode).toBe('T');
    expect(EdPriv.LenT).toBe(17);
    expect(EdPriv.Part.PosP).toBe(5);
    expect(EdPriv.ColKey[3]).toBe(0x42);
  });
  it('GetEditTxt reports the defaults of InitTxtEditor', () => {
    const r = { i: ref(false), n: ref(false), w: ref(true), j: ref(true), c: ref(true), l: ref(0), rr: ref(0) };
    GetEditTxt(r.i, r.n, r.w, r.j, r.c, r.l, r.rr);
    expect([r.i.v, r.n.v, r.w.v, r.j.v, r.c.v, r.l.v, r.rr.v]).toEqual([true, true, false, false, false, 1, 78]);
    // SetEditTxt with no formulas changes nothing
    SetEditTxt({ Insert: null, Indent: null, Wrap: null, Just: null, ColBlk: null, Left: null, Right: null } as never);
    expect(EditorVars.Insert).toBe(true);
  });
  it('ClearHelpStkForCRdb drops the entries of CRdb', () => {
    const r1 = {} as never;
    const r2 = {} as never;
    const P = EdPriv;
    P.iStk = 3;
    for (let i = 1; i <= 3; i++) P.Stk[i] = Object.assign(new HelpStkEntry(), { Rdb: i === 2 ? r2 : r1, iR: i });
    const cr = AccessVars.CRdb;
    AccessVars.CRdb = r1;
    try {
      ClearHelpStkForCRdb();
    } finally {
      AccessVars.CRdb = cr;
    }
    expect(P.iStk).toBe(1);
    expect(P.Stk[1].iR).toBe(2);
    P.iStk = 0;
  });
});

// ---------------------------------------------------------------- editing

describe.skipIf(!haveApp)('EDITOR: editing a local text (SimpleEditText)', () => {
  it('types into an empty text; Enter splits lines (Indent keeps the indentation)', () => {
    type('Příliš žluťoučký');
    press(K.Enter);
    type('kůň');
    press(K.Esc);
    const r = simpleEdit('');
    expect(r.txt).toBe('Příliš žluťoučký\r\nkůň');
    expect(r.upd).toBe(true);
    expect(DriversVars.KbdChar).toBe(0x1b);
  });
  it('Indent: a new line starts under the first word of the previous line', () => {
    press(K.End, K.Enter);
    type('b');
    press(K.Esc);
    expect(simpleEdit('   a').txt).toBe('   a\r\n   b');
  });
  it('overwrite mode (Ins), Del, Backspace joining lines, ^Y deleting a line', () => {
    // line 1: 'abc', line 2: 'def', line 3: 'ghi'
    press(K.Ins); // overwrite
    type('X'); // Xbc
    press(K.Ins, K.Del); // Xc
    press(K.Down, K.Home, K.Backspace); // join: Xcdef
    press(K.Down, ctrl('y')); // delete 'ghi'
    press(K.Esc);
    expect(simpleEdit('abc\r\ndef\r\nghi\r\n').txt).toBe('Xcdef\r\n');
  });
  it('WordStar cursor keys (^D ^S ^X ^E) and ^T deletes a word', () => {
    press(ctrl('x'), ctrl('d'), ctrl('d'), ctrl('d'), ctrl('d'));
    type('!');
    press(ctrl('e'), K.Home, ctrl('t'));
    press(K.Esc);
    expect(simpleEdit('jedna dva\r\ntri ctyri\r\n').txt).toBe('dva\r\ntri !ctyri\r\n');
  });
  it('the cursor position comes back in Ind (after the text part)', () => {
    press(K.Down, K.Right, K.Right, K.Esc);
    const r = simpleEdit('abc\r\ndefgh\r\n');
    expect(r.ind).toBe(8); // 'd' is at 6
    expect(r.upd).toBe(false);
  });
  it('view mode does not change the text', () => {
    type('xyz');
    press(K.Esc);
    const r = simpleEdit('abc\r\n', ViewM);
    expect(r.txt).toBe('abc\r\n');
    expect(r.upd).toBe(false);
  });
});

describe.skipIf(!haveApp)('EDITOR: blocks, clipboard, formatting, find', () => {
  it('^KB ^KK marks a text block, ^KC copies it, ^KY deletes it', () => {
    // mark 'bb' on line 1, copy to the start of line 2
    press(K.Right, K.Right, fKey(7), K.Right, K.Right, fKey(8)); // F7 / F8 = begin / end of block
    press(K.Down, K.Home, ctrl('k'), 'c'.charCodeAt(0));
    press(K.Esc);
    expect(simpleEdit('aabbcc\r\ndd\r\n').txt).toBe('aabbcc\r\nbbdd\r\n');
  });
  it('^KY deletes the marked block', () => {
    press(ctrl('k'), 'b'.charCodeAt(0), K.Down, K.Right, ctrl('k'), 'k'.charCodeAt(0));
    press(ctrl('k'), 'y'.charCodeAt(0), K.Esc);
    expect(simpleEdit('one\r\ntwo\r\nthree\r\n').txt).toBe('wo\r\nthree\r\n');
  });
  it('^KU / ^KL change the case of the block (national letters through UpcCharTab)', () => {
    press(fKey(7), K.End, fKey(8), ctrl('k'), 'u'.charCodeAt(0), K.Esc);
    expect(simpleEdit('žluťoučký kůň\r\n').txt).toBe('ŽLUŤOUČKÝ KŮŇ\r\n');
    press(fKey(7), K.End, fKey(8), ctrl('k'), 'l'.charCodeAt(0), K.Esc);
    expect(simpleEdit('ŽLUŤOUČKÝ KŮŇ\r\n').txt).toBe('žluťoučký kůň\r\n');
  });
  it('Ctrl+F7 grasps the block into the clipboard (TWork), Shift+F7 drops it', () => {
    press(fKey(7), K.Right, K.Right, K.Right, fKey(8), fKey(7, 2)); // Ctrl+F7
    press(K.Down, K.End, fKey(7, 1)); // Shift+F7
    press(K.Esc);
    expect(simpleEdit('abc\r\nxy\r\n').txt).toBe('abc\r\nxyabc\r\n');
  });
  it('column block: ^KN, mark, ^KC copies the columns', () => {
    press(ctrl('k'), 'n'.charCodeAt(0));
    press(K.Right, fKey(7), K.Down, K.Right, K.Right, fKey(8)); // columns 2..3 of lines 1..2
    press(K.Down, K.End, ctrl('k'), 'c'.charCodeAt(0));
    press(ctrl('k'), 'n'.charCodeAt(0)); // back to text blocks for the next tests
    press(K.Esc);
    expect(simpleEdit('abcd\r\nefgh\r\nij\r\nkl\r\n').txt).toBe('abcd\r\nefgh\r\nijbc\r\nklfg\r\n');
  });
  it('^B formats a paragraph to the margins (^OR sets the right margin)', () => {
    press(ctrl('o'), 'r'.charCodeAt(0));
    // the prompt offers the current column; typing replaces it
    type('12');
    press(K.Enter);
    press(ctrl('b'), K.Esc);
    // the paragraph ends at a hard return (CR LF); the new line breaks are soft (CR only)
    const r = simpleEdit('aaa bbb ccc ddd\reee fff\r\nggg\r\n\r\nzzz\r\n');
    expect(r.txt).toBe('aaa bbb ccc\rddd eee fff\r\nggg\r\n\r\nzzz\r\n');
    EdPriv.RightMarg = 78;
  });
  it('^QF finds text, ^L repeats; ^QA replaces with option n', () => {
    press(ctrl('q'), 'f'.charCodeAt(0));
    type('xx');
    press(K.Enter, K.Enter); // no options
    type('1');
    press(ctrl('l'));
    type('2');
    press(K.Esc);
    expect(simpleEdit('a xx b xx c\r\n').txt).toBe('a xx1 b xx2 c\r\n');
    press(ctrl('q'), 'a'.charCodeAt(0));
    type('xx');
    press(K.Enter);
    type('Y');
    press(K.Enter);
    type('gn');
    press(K.Enter, K.Esc);
    expect(simpleEdit('a xx b xx c\r\nxx\r\n').txt).toBe('a Y b Y c\r\nY\r\n');
  });
});

describe.skipIf(!haveApp)('EDITOR: help mode, exit keys, calculator, block files', () => {
  it('help text: the ^S..^S words are links; Right selects the next one, Enter returns it in LexWord', () => {
    const t = bytes('Viz \x13první\x13 a \x13druhé\x13 heslo.\r\n');
    const orig = t.slice();
    const Len = ref(t.length);
    const Ind = ref(1);
    press(K.Right, K.Enter);
    ok(() =>
      EditText('H', MemoT, '', '', t, 0xfff0, Len, Ind, ref(0), '', null, ref(false), ref(false), 0, 0, null));
    expect(DriversVars.KbdChar).toBe(0x0d);
    expect(U(AccessVars.LexWord)).toBe('druhé');
    // ClrWord put the ^S marks back
    expect(EditorVars.EdTxt!.subarray(0, Len.v)).toEqual(orig);
  });
  it('an exit key of type Q ends the editor (EditText = false, EdBreak from the key)', () => {
    const X = new EdExitD();
    X.Typ = 'Q';
    X.Keys = Object.assign(new EdExKeyD(), { KeyCode: fKey(2), Break: 5 });
    press(K.Down, fKey(2));
    const b = bytes('a\r\nb\r\n');
    const Len = ref(b.length);
    const Ind = ref(1);
    const r = ok(() =>
      EditText(TextM, LocalT, '', '', b, 0x7fff, Len, Ind, ref(0), '', X, ref(false), ref(false), 0, 0, null));
    expect(r).toBe(false);
    expect(DriversVars.KbdChar).toBe(fKey(2));
    expect(AccessVars.EdBreak).toBe(5);
    expect(AccessVars.LastTxtPos).toBe(4);
  });
  it('Ctrl+F5 calculates a formula, Ctrl+F4 inserts the result at the cursor', () => {
    RdRunVars.CalcTxt = '';
    press(fKey(5, 2));
    type('(1+2)*7');
    press(K.Enter, fKey(4, 2), K.Esc);
    expect(simpleEdit('x\r\n').txt).toBe('21x\r\n');
    expect(RdRunVars.CalcTxt).toBe('21');
  });
  it('^KW writes the block to a file, ^KR reads a file in', () => {
    const f = 'work/tmp-editor/BLOK.TXT';
    rmSync(join(ROOT, f), { force: true });
    press(fKey(7), K.Down, fKey(8)); // the first line
    press(ctrl('k'), 'w'.charCodeAt(0));
    type(f);
    press(K.Enter, K.Esc);
    simpleEdit('prvni\r\ndruhy\r\n');
    expect(readFileSync(join(ROOT, f), 'latin1')).toBe('prvni\r\n');
    press(K.Down, K.Down, ctrl('k'), 'r'.charCodeAt(0));
    type(f);
    press(K.Enter, K.Esc);
    expect(simpleEdit('prvni\r\ndruhy\r\n').txt).toBe('prvni\r\ndruhy\r\nprvni\r\n');
  });
});

// ---------------------------------------------------------------- screen

describe.skipIf(!haveApp)('EDITOR: screen', () => {
  it('shows the text, the status line with Row:Col and the Insert/Indent flags', () => {
    let seen: string[] = [];
    // look at the screen while the editor waits for the next key: use a Help-less exit via Esc
    const b = bytes('první řádek\r\ndruhý\r\n');
    const Len = ref(b.length);
    const Ind = ref(1);
    const Scr = ref(0);
    const Srch = ref(false);
    const Upd = ref(false);
    press(K.Down, K.Right);
    // Esc arrives after the redraw of the second key
    press(K.Esc);
    const origRead = crt.readKey.bind(crt);
    crt.readKey = (ms?: number) => {
      const k = origRead(ms);
      if (k && (k.code & 0xff) === 0x1b) seen = [row(0), row(1), row(2)];
      return k;
    };
    const ms = new MsgStr();
    ms.Head = B('Hlavička _____');
    ok(() => EditText(TextM, LocalT, '', '', b, 0x7fff, Len, Ind, Scr, '', null, Srch, Upd, 0, 0, ms));
    expect(seen[1].trimEnd()).toBe('první řádek');
    expect(seen[2].trimEnd()).toBe('druhý');
    expect(seen[0]).toContain('Hlavička');
    expect(seen[0]).toMatch(/2:2/);
    // pScr = ScrT + Posi shl 16: row 2 of the window, column 2
    expect(Scr.v >>> 16).toBe(2);
    expect((Scr.v >> 8) & 0xff).toBe(2);
  });
  it('colour control chars: ^B shows as B in the tEmphasized colour', () => {
    let cells: { ch: string; attr: number }[] = [];
    const origRead = crt.readKey.bind(crt);
    crt.readKey = (ms?: number) => {
      const k = origRead(ms);
      if (k && (k.code & 0xff) === 0x1b) cells = [0, 1, 2].map((x) => crt.screen.getCell(x, 1));
      return k;
    };
    press(K.Esc);
    simpleEdit('a\x02b\r\n');
    expect(cells.map((c) => c.ch).join('')).toBe('aBb');
    expect(cells[1].attr).toBe(0x1f);
    expect(cells[0].attr).toBe(0x07); // TxtColor = TextAttr at the start
  });
});

// ---------------------------------------------------------------- text files

describe.skipIf(!haveApp)('EDITOR: EditTxtFile on Účto text files', () => {
  it('views CONFIG.TXT read-only and shows its first lines', () => {
    const f = join(TMP, 'CONFIG.TXT');
    writeFileSync(f, readFileSync(join(APP, 'CONFIG.TXT')));
    const orig = readFileSync(f);
    let seen: string[] = [];
    const origRead = crt.readKey.bind(crt);
    crt.readKey = (ms?: number) => {
      const k = origRead(ms);
      if (k && (k.code & 0xff) === 0x1b) seen = [1, 2, 3, 4].map(row);
      return k;
    };
    press(K.Esc);
    BaseVars.CPath = H(f);
    BaseVars.CVol = '';
    ok(() => EditTxtFile(null, ViewM, '', null, 1, 0, null, 0, '', 0, null));
    const lines = U(String.fromCharCode(...orig)).split('\r\n');
    expect(seen.map((s) => s.trimEnd())).toEqual(lines.slice(0, 4));
    expect(readFileSync(f)).toEqual(orig);
    expect(AccessVars.EdUpdated).toBe(false);
  });
  it('edits a text file: inserts a line at the top and writes it back', () => {
    const f = join(TMP, 'CONFIG2.TXT');
    const orig = readFileSync(join(APP, 'CONFIG.TXT'));
    writeFileSync(f, orig);
    type('rem nový');
    press(K.Enter, K.Esc);
    BaseVars.CPath = H(f);
    ok(() => EditTxtFile(null, TextM, '', null, 1, 0, null, 0, '', 0, null));
    const now = readFileSync(f);
    expect(Buffer.from(now)).toEqual(Buffer.concat([Buffer.from(encode852('rem nový\r\n')), orig]));
    expect(AccessVars.EdUpdated).toBe(true);
    expect(AccessVars.LastTxtPos).toBe(11);
  });
  it('a local text in TWork (LP): edits it and stores the new text; ^U restores the original', () => {
    const tw = AccessVars.TWork;
    const LP = ref(tw.Store(bytes('lokální text\r\n')));
    type('A');
    press(K.Esc);
    ok(() => EditTxtFile(LP, TextM, '', null, 1, 0, null, 0, '', 0, null));
    expect(dec(tw.Read(1, LP.v))).toBe('Alokální text\r\n');
    // ^U asks (108) and starts again from the text as it was
    type('xyz');
    press(ctrl('u'), 'Y'.charCodeAt(0));
    type('B');
    press(K.Esc);
    BaseVars.AbbrYes = 'Y';
    ok(() => EditTxtFile(LP, TextM, '', null, 1, 0, null, 0, '', 0, null));
    expect(dec(tw.Read(1, LP.v))).toBe('BAlokální text\r\n');
  });
  it.skipIf(!haveSrc)('a file larger than the buffer is edited in parts (RdNextPart/UpdateFile)', () => {
    // realistic content: decoded Účto sources, CP852, CR LF, > 100 kB
    const parts: Buffer[] = [];
    let total = 0;
    for (const d of readdirSync(SRC).sort()) {
      const dir = join(SRC, d);
      for (const n of readdirSync(dir).sort()) {
        if (!n.endsWith('.txt')) continue;
        const u = readFileSync(join(dir, n), 'utf8').replace(/\r?\n/g, '\r\n');
        if (u.split('\r\n').some((l) => l.length > 200)) continue; // a line > 255 asks to split it (402)
        const b = Buffer.from(encode852(u.endsWith('\r\n') ? u : u + '\r\n'));
        parts.push(b);
        total += b.length;
        if (total > 150000) break;
      }
      if (total > 150000) break;
    }
    const orig = Buffer.concat(parts);
    expect(orig.length).toBeGreaterThan(0x10000);
    const f = join(TMP, 'BIG.TXT');
    writeFileSync(f, orig);
    // go to the end (Ctrl+PgDn reads the last part), type there, back to the top, type there
    press(K.CtrlPgDn);
    type('KONEC');
    press(K.CtrlPgUp);
    type('ZAČÁTEK');
    press(K.Esc);
    BaseVars.CPath = H(f);
    ok(() => EditTxtFile(null, TextM, '', null, 1, 0, null, 0, '', 0, null));
    const now = readFileSync(f);
    const expected = Buffer.concat([Buffer.from(encode852('ZAČÁTEK')), orig, Buffer.from('KONEC')]);
    expect(now.length).toBe(expected.length);
    expect(now.equals(expected)).toBe(true);
  });
});
