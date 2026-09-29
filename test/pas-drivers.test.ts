// Tests of the DRIVERS package: drivers.ts (+ keybd.ts), obaseww.ts, obase.ts.
// The engine side runs in-process on a Crt + KeyQueue; keys are queued before they are read.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

// TWork (ACCESS) keeps the PushW images; an in-memory stand-in until ACCESS is ported.
vi.mock('../src/engine/pas/access.ts', async (importOriginal) => {
  const m = await importOriginal<typeof import('../src/engine/pas/access.ts')>();
  const store = new Map<number, Uint8Array>();
  let next = 1;
  return {
    ...m,
    StoreInTWork: (s: Uint8Array): number => {
      const p = next;
      next += s.length + 2;
      store.set(p, s.slice());
      return p;
    },
    ReadDelInTWork: (p: number): Uint8Array => {
      const s = store.get(p);
      if (!s) throw new Error('TWork: no item at ' + p);
      store.delete(p);
      return s;
    },
  };
});

import { Crt, UNICODE_KEY } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { encode852 } from '../src/engine/console/cp852.ts';
import {
  Output, TextFile, TxtRewrite, TxtWrite, TxtWriteln, TxtReadln, TxtEof, TxtClose, TxtAppend, GoExitSignal,
  BytesToStr, FromUnicode, ref, getWord,
} from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, ReadH, PosH, _isoldfile, RdOnly, CsKbd, OrigKbd, WHasFrame, WShadow, WDoubleFrame,
  type TMsgIdxItem,
} from '../src/engine/pas/base.ts';
import {
  DriversVars, DriversHost, SetDriversCrt, ScrWrStr, ScrWrChar, ScrClr, ScrRdBuf, ScrWrBuf, ScrPush, ScrPop,
  ScrMove, ScrColor, ScrWrFrameLn, ScrCell, ScrRowStr, Window, GotoXY, WhereX, WhereY, ClrScr, ClrEol, InsLine,
  DelLine, TextColor, TextBackGround, CrsGet, CrsSet, CrsShow, CrsHide, CrsBig, AssignCrt, ReadKbd, ReadKey,
  KeyPressed, KbdPressed, ESCPressed, AddToKbdBuf, ClearKbdBuf, KbdTimer, WaitEvent, TestEvent, ClrEvent,
  AddCtrlAltShift, InitMouseEvents, MouseEvHandler, GetMouseEvent, ConvKamenLatin, ConvKamenToCurr, NoDiakr,
  ConvToNoDiakr, ToggleCS, CurrToKamen, TermSize, evKeyDown, evMouseDown, evMouseUp, mbLeftButton, foLatin2,
  foKamen, _ESC_, _F10_, _F2_, _ShiftF2_, _CtrlF2_, _AltF2_, _CtrlHome_, _Home_, _CtrlPgUp_, _M_, _up_,
} from '../src/engine/pas/drivers.ts';
import {
  PushW, PopW, PopW2, PushWFramed, CenterWw, WrLLMsgTxt, WrLLMsg, WrLLF10Msg, PromptYN, PushWrLLMsg, RunMsgOn,
  RunMsgN, RunMsgOff, RunError,
} from '../src/engine/pas/obaseww.ts';
import { AccessVars } from '../src/engine/pas/access.ts';
import { NewExit, RestoreExit, ExitRecord } from '../src/engine/pas/base.ts';
import {
  IsPrintCtrl, ResetTxt, RewriteTxt, Seek0Txt, SetPrintTxtPath, ResetPrinter, ClosePrinter, PrintStr,
} from '../src/engine/pas/obase.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const hasUcto = existsSync(join(APP, 'FAND.RES'));
const TMP = join(ROOT, 'work/tmp-drivers');

let crt: Crt;
let keys: KeyQueue;

function key(code: number, shift = 0): void {
  keys.push(code, shift);
}
/** a printable host key: Unicode char (+ US scan code) */
function ukey(ch: string, scan = 0, shift = 0): void {
  keys.push(UNICODE_KEY | ch.charCodeAt(0) | (scan << 16), shift);
}
const B = (u: string): string => FromUnicode(u); // Unicode -> CP852 byte string

function reset(): void {
  keys = new KeyQueue();
  crt = new Crt(keys, null, 80, 25);
  BaseVars.TxtCols = 80;
  BaseVars.TxtRows = 25;
  SetDriversCrt(crt);
  const dv = DriversVars;
  dv.WindMin.X = 0;
  dv.WindMin.Y = 0;
  dv.WindMax.X = 79;
  dv.WindMax.Y = 24;
  dv.TextAttr = 0x07;
  dv.Crs.X = dv.Crs.Y = 0;
  dv.Crs.Enabled = false;
  dv.Crs.Big = false;
  dv.KbdBuffer = '';
  dv.KbdChar = 0;
  dv.KbdFlgs = 0;
  dv.Event.What = 0;
  dv.FandBatch = false;
  dv.MausExist = false;
  dv.LLKeyFlags = 0;
  BaseVars.Spec.KbdTyp = OrigKbd;
  BaseVars.Spec.Beep = false;
  BaseVars.Spec.ScreenDelay = 0;
  BaseVars.Spec.F10Enter = false;
  BaseVars.Fonts.VFont = foLatin2;
  BaseVars.Fonts.NoDiakrSupported = false;
  BaseVars.F10SpecKey = 0;
  const c = BaseVars.Colors;
  c.lNorm = 0x70;
  c.lFirst = 0x74;
  c.zNorm = 0x4f;
  c.pNorm = 0x1e;
  c.pTxt = 0x1f;
  c.ShadowAttr = 0x08;
  AssignCrt(Output);
  TxtRewrite(Output);
}

beforeEach(reset);

describe('DRIVERS: video memory', () => {
  it('writes CP852 bytes as Unicode cells and reads the bytes back', () => {
    const s = B('Účto: Příliš žluťoučký kůň §');
    ScrWrStr(2, 3, s, 0x1e);
    expect(crt.screen.rowText(3).slice(2, 2 + s.length)).toBe('Účto: Příliš žluťoučký kůň §');
    expect(crt.screen.getCell(2, 3).attr).toBe(0x1e);
    const buf = new Uint16Array(s.length);
    ScrRdBuf(2, 3, buf, s.length);
    expect(BytesToStr(Uint8Array.from(buf, (w) => w & 0xff))).toBe(s);
    expect(buf[0] >> 8).toBe(0x1e);
    // control bytes survive too (0x15 and 0xF5 are both '§' on screen)
    ScrWrChar(0, 0, '\x15', 7);
    ScrWrChar(1, 0, '\xf5', 7);
    expect(ScrCell(0, 0) & 0xff).toBe(0x15);
    expect(ScrCell(1, 0) & 0xff).toBe(0xf5);
  });
  it('ScrClr, ScrColor, ScrMove, frames', () => {
    ScrClr(10, 5, 4, 2, '*', 0x20);
    expect(crt.screen.rowText(5).slice(9, 15)).toBe(' **** ');
    expect(crt.screen.rowText(6).slice(10, 14)).toBe('****');
    ScrColor(11, 5, 2, 0x4e);
    expect(ScrCell(11, 5)).toBe(0x4e2a);
    expect(ScrCell(13, 5)).toBe(0x202a);
    ScrWrStr(0, 0, 'abcdef', 7);
    ScrMove(0, 0, 0, 1, 3);
    expect(ScrRowStr(1).slice(0, 3)).toBe('abc');
    ScrWrFrameLn(0, 10, 0, 5, 7);
    ScrWrFrameLn(0, 11, 9, 5, 7);
    expect(crt.screen.rowText(10).slice(0, 5)).toBe('┌───┐');
    expect(crt.screen.rowText(11).slice(0, 5)).toBe('╔═══╗');
  });
  it('linear addressing: a write past the row end continues on the next row (BP7)', () => {
    ScrWrStr(78, 0, 'wxyz', 7);
    expect(crt.screen.rowText(0).slice(78)).toBe('wx');
    expect(crt.screen.rowText(1).slice(0, 2)).toBe('yz');
  });
  it('ScrPush / ScrPop restore an area', () => {
    ScrWrStr(0, 0, 'hello', 0x17);
    ScrWrStr(0, 1, 'world', 0x17);
    const p = ScrPush(0, 0, 5, 2);
    expect(p[0]).toBe(5);
    expect(p[1]).toBe(2);
    ScrClr(0, 0, 80, 25, ' ', 7);
    ScrPop(3, 4, p);
    expect(crt.screen.rowText(4).slice(3, 8)).toBe('hello');
    expect(crt.screen.rowText(5).slice(3, 8)).toBe('world');
    const w = new Uint16Array(2);
    ScrRdBuf(3, 5, w, 2);
    ScrWrBuf(0, 24, w, 2);
    expect(ScrCell(1, 24)).toBe(0x1700 | 0x6f);
  });
  it('TermSize reports the Crt screen', () => {
    const c = ref(80);
    const r = ref(20);
    expect(TermSize(c, r)).toBe(true);
    expect([c.v, r.v]).toEqual([80, 25]);
  });
});

describe('DRIVERS: window, cursor and the CRT text driver', () => {
  it('Window/GotoXY/WhereX/ClrScr', () => {
    Window(11, 6, 30, 10);
    expect(DriversVars.WindMin).toEqual({ X: 10, Y: 5 });
    expect(DriversVars.WindMax).toEqual({ X: 29, Y: 9 });
    GotoXY(3, 2);
    expect([WhereX(), WhereY()]).toEqual([3, 2]);
    expect([DriversVars.Crs.X, DriversVars.Crs.Y]).toEqual([12, 6]);
    expect([crt.screen.cx, crt.screen.cy]).toEqual([12, 6]);
    GotoXY(25, 2); // outside: the window origin
    expect([WhereX(), WhereY()]).toEqual([1, 1]);
    Window(0, 1, 5, 5); // invalid: ignored
    expect(DriversVars.WindMin).toEqual({ X: 10, Y: 5 });
    Window(1, 1, 81, 5); // wider than the screen: ignored
    expect(DriversVars.WindMax).toEqual({ X: 29, Y: 9 });
    TextColor(14);
    TextBackGround(1);
    expect(DriversVars.TextAttr).toBe(0x1e);
    ClrScr();
    expect(ScrCell(10, 5)).toBe(0x1e20);
    expect(ScrCell(29, 9)).toBe(0x1e20);
    expect(ScrCell(30, 9)).toBe(0x0720);
  });
  it('write() goes through the CRT driver: CR, LF, wrap and scroll inside the window', () => {
    Window(1, 1, 10, 3);
    TxtWrite(Output, 'abc');
    expect(WhereX()).toBe(4);
    TxtWriteln(Output, 'def');
    TxtWrite(Output, '1234567890XY'); // wraps after 10 chars
    expect(ScrRowStr(1).slice(0, 10)).toBe('1234567890');
    expect(ScrRowStr(2).slice(0, 2)).toBe('XY');
    TxtWrite(Output, '\r\nlast'); // scrolls the window up
    expect(ScrRowStr(0).slice(0, 10)).toBe('1234567890');
    expect(ScrRowStr(1).slice(0, 2)).toBe('XY');
    expect(ScrRowStr(2).slice(0, 4)).toBe('last');
    expect(ScrRowStr(0).slice(10, 12)).toBe('  '); // outside the window untouched
    TxtWrite(Output, '\x08\x08Z');
    expect(ScrRowStr(2).slice(0, 4)).toBe('laZt');
    expect([crt.screen.cx, crt.screen.cy]).toEqual([3, 2]);
  });
  it('InsLine/DelLine move the lines below the cursor (BP7 Scroll)', () => {
    for (let y = 0; y < 4; y++) ScrWrStr(0, y, 'line' + y, 7);
    Window(1, 1, 80, 4);
    GotoXY(1, 2);
    InsLine();
    expect([0, 1, 2, 3].map((y) => ScrRowStr(y).trimEnd())).toEqual(['line0', '', 'line1', 'line2']);
    DelLine();
    expect([0, 1, 2, 3].map((y) => ScrRowStr(y).trimEnd())).toEqual(['line0', 'line1', 'line2', '']);
    GotoXY(3, 1);
    ClrEol();
    expect(ScrRowStr(0).trimEnd()).toBe('li');
  });
  it('CrsGet/CrsSet keep position, size and visibility (BP7)', () => {
    GotoXY(5, 7);
    CrsBig();
    const s = CrsGet();
    expect(s).toBe((6 << 24) | (4 << 16) | (1 << 8) | 1);
    CrsHide();
    GotoXY(1, 1);
    DriversVars.Crs.Big = false;
    expect(crt.screen.cursorVisible).toBe(false);
    CrsSet(s);
    expect(DriversVars.Crs).toMatchObject({ X: 4, Y: 6, Big: true, Enabled: true });
    expect(crt.screen.cursorVisible).toBe(true);
    CrsHide();
    const h = CrsGet();
    CrsShow();
    CrsSet(h);
    expect(DriversVars.Crs.Enabled).toBe(false);
  });
});

describe('DRIVERS: keyboard', () => {
  it('ReadKbd: ASCII keys lose the scan code, extended keys keep it, Ctrl+PgUp = $0300', () => {
    key(0x1c0d); // Enter
    key(0x4400); // F10
    key(0x8400); // host Ctrl+PgUp
    key(0x011b); // Esc
    ukey('ř');
    expect(ReadKbd()).toBe(_M_);
    expect(ReadKbd()).toBe(_F10_);
    expect(DriversVars.KbdChar).toBe(_F10_);
    expect(ReadKbd()).toBe(_CtrlPgUp_);
    expect(ReadKbd()).toBe(_ESC_);
    expect(ReadKbd()).toBe(0xfd); // ř in CP852
    expect(KeyPressed()).toBe(false);
  });
  it('KbdBuffer comes first; 0 and $0300 are stored escaped', () => {
    key(0x1e61); // 'a' from the Bios
    AddToKbdBuf(0x0300);
    AddToKbdBuf(0);
    AddToKbdBuf(0x3b00);
    AddToKbdBuf(0x78);
    expect(DriversVars.KbdBuffer).toBe('\x00\x84\x00\x03\x00\x3bx');
    expect(KbdPressed()).toBe(true);
    expect(ReadKbd()).toBe(0x0300);
    expect(ReadKbd()).toBe(0);
    expect(ReadKbd()).toBe(0x3b00);
    expect(ReadKbd()).toBe(0x78);
    expect(ReadKbd()).toBe(0x61);
    ClearKbdBuf();
  });
  it('ReadKey (Bios) and ESCPressed', () => {
    key(0x3c00);
    key(0x011b);
    key(0x1e61);
    expect(ReadKey()).toBe(_F2_);
    expect(ESCPressed()).toBe(true);
    expect(ESCPressed()).toBe(false); // 'a' is read and lost
    expect(KeyPressed()).toBe(false);
    ukey('x');
    ClearKbdBuf();
    expect(KeyPressed()).toBe(false);
  });
  it('FandBatch: ReadKey and WaitEvent answer Esc without blocking', () => {
    DriversVars.FandBatch = true;
    expect(ReadKey()).toBe(_ESC_);
    expect(WaitEvent(0)).toBe(0);
    expect(DriversVars.Event.KeyCode).toBe(_ESC_);
    ClrEvent();
  });
  it('KbdTimer: runs out, or Esc aborts', () => {
    expect(KbdTimer(1, 0)).toBe(true);
    key(0x011b);
    expect(KbdTimer(100, 1)).toBe(false);
    key(0x1e61);
    expect(KbdTimer(100, 2)).toBe(false);
    expect(KeyPressed()).toBe(false);
  });
  it('WaitEvent: 2 after Delta ticks, 1 when the shift state changes, 0 with an event', () => {
    const t0 = Date.now();
    expect(WaitEvent(1)).toBe(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    key(0x4d00, 2); // Shift+Right: KbdFlgs while it is processed
    expect(WaitEvent(0)).toBe(0);
    expect(DriversVars.Event.KeyCode).toBe(0x4d00);
    expect(DriversVars.KbdFlgs).toBe(2);
    ClrEvent();
    expect(WaitEvent(0)).toBe(1); // no key waiting: the modifier counts as released
    expect(DriversVars.KbdFlgs).toBe(0);
  });
  it('AddCtrlAltShift: only F1..F10 get the modifier (BP7), Ctrl+Home', () => {
    const E = DriversVars.Event;
    E.What = evKeyDown;
    E.KeyCode = _F2_;
    AddCtrlAltShift(0x03);
    expect(E.KeyCode).toBe(_ShiftF2_);
    E.KeyCode = _F2_;
    AddCtrlAltShift(0x04);
    expect(E.KeyCode).toBe(_CtrlF2_);
    E.KeyCode = _F2_;
    AddCtrlAltShift(0x08);
    expect(E.KeyCode).toBe(_AltF2_);
    E.KeyCode = 0x8500; // F11: unchanged
    AddCtrlAltShift(0x04);
    expect(E.KeyCode).toBe(0x8500);
    E.KeyCode = _Home_;
    AddCtrlAltShift(0x04);
    expect(E.KeyCode).toBe(_CtrlHome_);
    ClrEvent();
  });
  it('Czech keyboard layout (spec.KbdTyp = CsKbd) with dead keys', () => {
    BaseVars.Spec.KbdTyp = CsKbd;
    ukey('2', 0x03);
    ukey('=', 0x0d); // dead key carka
    ukey('e', 0x12);
    ukey('+', 0x0d); // dead key hacek
    ukey('r', 0x13);
    ukey('+', 0x0d);
    ukey('+', 0x0d); // doubly pressed: the char itself
    expect(ReadKbd()).toBe(B('ě').charCodeAt(0));
    expect(ReadKbd()).toBe(B('é').charCodeAt(0));
    expect(ReadKbd()).toBe(B('ř').charCodeAt(0));
    expect(ReadKbd()).toBe(0x2b);
  });
});

describe('DRIVERS: code pages', () => {
  it('Kamenický <-> Latin-2 and without diacritics', () => {
    const kam = Uint8Array.of(0x80, 0x87, 0x88, 0xa9, 0x41); // Č č ě ř A in Kamenický
    const b = kam.slice();
    ConvKamenLatin(b, b.length, true);
    expect(BytesToStr(b)).toBe(B('Ččěř') + 'A');
    ConvKamenLatin(b, b.length, false);
    expect([...b]).toEqual([...kam]);
    const c = kam.slice();
    ConvKamenToCurr(c, c.length);
    expect(BytesToStr(c)).toBe(B('ČčěřA'));
    expect(NoDiakr(B('ř'))).toBe('r');
    expect(NoDiakr(B('Ž'))).toBe('Z');
    const d = encode852('Účto žluťoučký');
    ConvToNoDiakr(d, d.length, foLatin2);
    expect(BytesToStr(d)).toBe('Ucto zlutoucky');
    const e = kam.slice();
    ConvToNoDiakr(e, e.length, foKamen);
    expect(BytesToStr(e)).toBe('CcerA');
    expect(CurrToKamen(B('ř'))).toBe('\xa9');
    expect(ToggleCS('2')).toBe('2');
    expect(ToggleCS('A')).toBe(B('Á'));
  });
});

describe('DRIVERS: mouse', () => {
  it('left click on a red last-line key gives that key; right click is Esc', () => {
    DriversHost.MouseDriverPresent = true;
    try {
      InitMouseEvents();
      expect(DriversVars.MausExist).toBe(true);
      // last line: " F10 Uložit  Esc Konec" with the key names in lFirst
      ScrClr(0, 24, 80, 1, ' ', BaseVars.Colors.lNorm);
      ScrWrStr(1, 24, 'F10', BaseVars.Colors.lFirst);
      ScrWrStr(5, 24, B('Uložit'), BaseVars.Colors.lNorm);
      ScrWrStr(13, 24, 'Esc', BaseVars.Colors.lFirst);
      ScrWrStr(17, 24, '\x18', BaseVars.Colors.lFirst);
      MouseEvHandler(2, mbLeftButton, 2 * 8, 24 * 8);
      MouseEvHandler(4, 0, 2 * 8, 24 * 8);
      expect(TestEvent()).toBe(true);
      expect(DriversVars.Event.What).toBe(evKeyDown);
      expect(DriversVars.Event.KeyCode).toBe(_F10_);
      ClrEvent();
      GetMouseEvent(); // the release
      expect(DriversVars.Event.What).toBe(evMouseUp);
      MouseEvHandler(2, mbLeftButton, 14 * 8, 24 * 8);
      MouseEvHandler(4, 0, 14 * 8, 24 * 8);
      expect(ReadKbd()).toBe(_ESC_);
      MouseEvHandler(2, mbLeftButton, 17 * 8, 24 * 8);
      MouseEvHandler(4, 0, 17 * 8, 24 * 8);
      expect(ReadKbd()).toBe(_up_);
      MouseEvHandler(2, 2, 40 * 8, 3 * 8); // right button
      MouseEvHandler(4, 0, 40 * 8, 3 * 8);
      expect(ReadKbd()).toBe(_ESC_);
      MouseEvHandler(2, mbLeftButton, 40 * 8, 3 * 8);
      GetMouseEvent(); // the right button's release
      expect(DriversVars.Event.What).toBe(evMouseUp);
      GetMouseEvent();
      expect(DriversVars.Event.What).toBe(evMouseDown);
      expect(DriversVars.Event.Where).toMatchObject({ X: 40, Y: 3 });
    } finally {
      DriversHost.MouseDriverPresent = false;
      DriversVars.MausExist = false;
    }
  });
});

describe('OBASEWW: windows and messages', () => {
  it('PushW/PopW restore the screen, window, colour and cursor', () => {
    ScrWrStr(0, 2, 'background', 0x17);
    Window(5, 4, 20, 8);
    DriversVars.TextAttr = 0x1f;
    GotoXY(2, 2);
    CrsShow();
    const cur = CrsGet();
    const w = PushW(1, 2, 30, 6);
    expect(DriversVars.WindMin).toEqual({ X: 0, Y: 1 });
    DriversVars.TextAttr = 0x4e;
    ClrScr();
    CrsHide();
    expect(ScrRowStr(2).trimEnd()).toBe('');
    PopW(w);
    expect(ScrRowStr(2).slice(0, 10)).toBe('background');
    expect(ScrCell(0, 2) >> 8).toBe(0x17);
    expect(DriversVars.WindMin).toEqual({ X: 4, Y: 3 });
    expect(DriversVars.WindMax).toEqual({ X: 19, Y: 7 });
    expect(DriversVars.TextAttr).toBe(0x1f);
    expect(CrsGet()).toBe(cur);
    const w2 = PushW(1, 1, 80, 25);
    ClrScr();
    PopW2(w2, false); // parameters only
    expect(ScrRowStr(2).trimEnd()).toBe('');
  });
  it('CenterWw and PushWFramed draw a centred framed, shadowed window', () => {
    const c1 = ref(0);
    const r1 = ref(0);
    const c2 = ref(20);
    const r2 = ref(3);
    CenterWw(c1, r1, c2, r2, WHasFrame);
    expect([c1.v, r1.v, c2.v, r2.v]).toEqual([30, 11, 51, 15]);
    ScrClr(0, 0, 80, 25, '.', 0x07);
    const w = PushWFramed(0, 0, 20, 3, 0x1e, 'Title', '', WHasFrame | WDoubleFrame | WShadow);
    expect(crt.screen.rowText(10).slice(29, 51)).toBe('╔' + '═'.repeat(6) + ' Title ' + '═'.repeat(7) + '╗');
    expect(crt.screen.rowText(12).slice(29, 51)).toBe('║' + ' '.repeat(20) + '║');
    expect(crt.screen.rowText(14).slice(29, 51)).toBe('╚' + '═'.repeat(20) + '╝');
    expect(ScrCell(52, 12) >> 8).toBe(0x08); // shadow
    expect(DriversVars.WindMin).toEqual({ X: 30, Y: 11 });
    TxtWrite(Output, 'in');
    expect(crt.screen.rowText(11).slice(30, 32)).toBe('in');
    PopW(w);
    expect(crt.screen.rowText(10).slice(29, 52)).toBe('.'.repeat(23));
  });
  it('WrLLMsgTxt: ^W toggles the lFirst colour on the last line', () => {
    BaseVars.MsgLine = ' \x17F10\x17 ' + B('Uložit') + ' \x17Esc\x17 Konec';
    GotoXY(10, 10);
    WrLLMsgTxt();
    expect(crt.screen.rowText(24).trimEnd()).toBe(' F10 Uložit Esc Konec');
    expect(ScrCell(1, 24) >> 8).toBe(BaseVars.Colors.lFirst);
    expect(ScrCell(5, 24) >> 8).toBe(BaseVars.Colors.lNorm);
    expect(ScrCell(79, 24) >> 8).toBe(BaseVars.Colors.lNorm);
    expect([WhereX(), WhereY()]).toEqual([10, 10]);
  });
  it('RunMsgOn/N/Off: progress in the last line, restored afterwards', () => {
    ScrWrStr(0, 24, 'status line', 7);
    RunMsgOn('R', 200);
    expect(ScrRowStr(24).slice(0, 7)).toBe('\x10R  0%\x11');
    RunMsgN(100);
    expect(ScrRowStr(24).slice(0, 7)).toBe('\x10R 50%\x11');
    RunMsgOff();
    expect(ScrRowStr(24).slice(0, 11)).toBe('status line');
  });
});

/** Loads the message index of Účto's FAND.RES (as RUNFAND does) so that RdMsg works. */
function loadResMessages(): void {
  BaseVars.CPath = join(APP, 'FAND.RES');
  BaseVars.CVol = '';
  const h = OpenH(_isoldfile, RdOnly);
  expect(BaseVars.HandleError).toBe(0);
  BaseVars.ResFile.Handle = h;
  const b = new Uint8Array(2);
  ReadH(h, 2, b);
  expect(getWord(b, 0)).toBe(0x0420);
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

describe.skipIf(!hasUcto)('OBASEWW: FAND.RES messages (Účto)', () => {
  it('WrLLMsg, WrLLF10Msg, PromptYN, RunError', () => {
    loadResMessages();
    BaseVars.AbbrYes = 'A';
    BaseVars.AbbrNo = 'N';
    // WrLLF10Msg: 'F10!' + message; waits for F10; the last line comes back
    ScrWrStr(0, 24, 'previous', 7);
    key(0x1e61); // ignored
    key(0x4400);
    WrLLF10Msg(10);
    expect(DriversVars.KbdChar).toBe(_F10_);
    expect(ScrRowStr(24).slice(0, 8)).toBe('previous');
    WrLLMsg(10);
    expect(BaseVars.MsgLine.length).toBeGreaterThan(3);
    const ll = ScrRowStr(24);
    expect(ll.trimEnd()).toBe(BaseVars.MsgLine.replace(/\x17/g, '').slice(0, 80).trimEnd());
    // PromptYN: waits for A/N
    ukey('x');
    ukey('a');
    expect(PromptYN(22)).toBe(true);
    key(0x314e); // 'N'
    expect(PromptYN(22)).toBe(false);
    expect(ScrRowStr(24)).toBe(ll); // PopW restored the last line
    // PushWrLLMsg with (ESC)
    const w = PushWrLLMsg(10, true);
    expect(ScrRowStr(24).slice(0, 8)).toBe('  (ESC) ');
    expect(ScrCell(0, 24) >> 8).toBe(BaseVars.Colors.zNorm | 0x80);
    PopW(w);
    // RunError: message + GoExit, EdBreak = 3 (batch mode: the message goes to stderr)
    DriversVars.FandBatch = true;
    const er = new ExitRecord();
    NewExit(null, er);
    let fired = false;
    try {
      RunError(10);
    } catch (e) {
      if (!(e instanceof GoExitSignal)) throw e;
      fired = true;
    } finally {
      RestoreExit(er);
    }
    expect(fired).toBe(true);
    expect(AccessVars.EdBreak).toBe(3);
  });
});

describe('OBASE: text files and the printer', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(TMP, { recursive: true });
  });
  it('RewriteTxt/ResetTxt: CR LF lines through the HANDLE layer, append, rewind', () => {
    BaseVars.CPath = join(TMP, 'T1.TXT');
    BaseVars.CVol = '';
    const F = new TextFile();
    expect(RewriteTxt(F, false)).toBe(true);
    TxtWriteln(F, B('první řádek'));
    TxtWrite(F, 'x'.repeat(300));
    TxtWriteln(F);
    TxtClose(F);
    const raw = readFileSync(join(TMP, 'T1.TXT'));
    expect(raw.length).toBe(11 + 2 + 300 + 2);
    expect(raw.subarray(0, 13)).toEqual(Buffer.from([...encode852('první řádek'), 13, 10]));
    expect(ResetTxt(F)).toBe(true);
    expect(TxtReadln(F)).toBe(B('první řádek'));
    expect(TxtReadln(F).length).toBe(255); // string[255]
    expect(TxtEof(F)).toBe(true);
    Seek0Txt(F);
    expect(TxtReadln(F)).toBe(B('první řádek'));
    TxtClose(F);
    // append (fmInOut: OpenTxt seeks to the end)
    BaseVars.CPath = join(TMP, 'T1.TXT');
    const G = new TextFile();
    expect(ResetTxt(G)).toBe(true);
    TxtClose(G);
    G.Handle = OpenH(3 /* _isoldnewfile */, 4 /* Exclusive */);
    TxtAppend(G);
    TxtWriteln(G, 'end');
    TxtClose(G);
    expect(readFileSync(join(TMP, 'T1.TXT')).subarray(-5).toString('latin1')).toBe('end\r\n');
    BaseVars.CPath = join(TMP, 'MISSING.TXT');
    expect(ResetTxt(new TextFile())).toBe(false);
    expect(BaseVars.HandleError).toBe(2);
  });
  it('PrintCtrl: style controls become printer codes, ^P blocks pass untranslated, Kod K', () => {
    // printer 0: strings prName, prUl1, prUl2, ... from FAND.CFG layout (length-prefixed)
    const strs = ['EPSON', '\x1b-1', '\x1b-0', '\x1b4', '\x1b5'];
    const bytes: number[] = [];
    for (const s of strs) bytes.push(s.length, ...[...s].map((c) => c.charCodeAt(0)));
    const pr = BaseVars.printer[0];
    Object.assign(pr, { Strg: Uint8Array.from(bytes), Typ: 'E', Kod: 'L', Lpti: 1, Handle: 0xff });
    BaseVars.prCurr = 0;
    BaseVars.prMax = 1;
    expect(IsPrintCtrl('\x13')).toBe(true);
    expect(IsPrintCtrl('a')).toBe(false);
    BaseVars.CPath = join(TMP, 'P.TXT');
    const F = new TextFile();
    expect(RewriteTxt(F, true)).toBe(true);
    // ^S underline on/off, ^W italic on, č (Latin-2 -> Kamenický by Kod 'L'), ^P 2 bytes binary
    TxtWrite(F, 'a\x13b\x13\x17' + B('č') + '\x10\x02\x00' + B('č') + '\x13');
    TxtClose(F);
    // the 2 bytes after ^P <2> <0> (č, ^S) pass untranslated
    expect(readFileSync(join(TMP, 'P.TXT')).toString('latin1')).toBe('a\x1b-1b\x1b-0\x1b4\x87\x9f\x13');
  });
  it('ResetPrinter/ClosePrinter write LPT1.PRN in the work directory; SetPrintTxtPath', () => {
    const pr = BaseVars.printer[0];
    const strs: string[] = [];
    strs[0] = 'P';
    for (let i = 1; i <= 32; i++) strs[i] = '';
    strs[15] = '\x1b@'; // prReset
    strs[16] = '\x1bC'; // prPageSizeNN
    strs[32] = '\x0c'; // prClose
    const bytes: number[] = [];
    for (const s of strs) bytes.push(s.length, ...[...s].map((c) => c.charCodeAt(0)));
    Object.assign(pr, { Strg: Uint8Array.from(bytes), Typ: 'E', Kod: '\0', Lpti: 1, Handle: 0xff, ToHandle: true });
    BaseVars.prCurr = 0;
    const cwd = process.cwd();
    process.chdir(TMP);
    try {
      expect(ResetPrinter(72, 0, false, true)).toBe(true);
      PrintStr('Hi\r');
      ClosePrinter(0);
      expect(pr.Handle).toBe(0xff);
      expect(readFileSync(join(TMP, 'LPT1.PRN')).toString('latin1')).toBe('\x1b@\x1bC\x48Hi\r\n\x0c');
    } finally {
      process.chdir(cwd);
    }
    BaseVars.WrkDir = TMP + '/';
    SetPrintTxtPath();
    expect(BaseVars.CPath).toBe(TMP + '/PRINTER.TXT');
  });
});
