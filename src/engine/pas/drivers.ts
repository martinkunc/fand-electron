// PAS: DRIVERS.PAS – keyboard, mouse events, the text screen and the cursor.
// The screen/keyboard hardware is the existing Crt (src/engine/console/crt.ts):
// byte strings are converted to Unicode cells here and nowhere else.
// Screen cell buffers (ScrWrBuf/ScrRdBuf/ScrPush) are Uint16Array words: lo = CP852 char, hi = attr.
//
// Porting notes:
// * Sources: the FPC branch of DRIVERS.PAS drives a terminal (TermEmit, ANSI key decoding,
//   EnsureRawTty/RestoreTty, PollStdin, TermSize/SIGWINCH, TermEncoding); all of that is replaced
//   by the Crt binding below. The BP7 branch (DRIVERS.PAS non-FPC + KEYBD.PAS) is followed where it
//   is observable: linear video-memory addressing of the Scr* routines, the real Scroll (InsLine/
//   DelLine move lines), CrsGet/CrsSet carry Big/Enabled, GotoXY/Window byte checks, the keyboard
//   event path (KbdBuffer, spec.KbdTyp layouts with dead keys, scan code stripping), the mouse event
//   queue and red last-line "keys", WaitEvent's KbdFlgs change result and the 'PC FAND' screen saver,
//   AddCtrlAltShift only for F1..F10. FPC additions kept: FandBatch (ReadKey/WaitEvent answer Esc,
//   CRT output to stderr).
// * Video memory = `Shadow` (like the FPC port): a Uint16Array of MaxTxtCols*MaxTxtRows words
//   addressed Y*TxtCols+X. Writes also go to the bound Crt screen (byteToChar); reads come from the
//   Shadow, so CP852 bytes round-trip exactly. Without a Crt only the Shadow is kept.
// * Keyboard: the Crt's KeyEvent.code is the BIOS int 16h word. KbdFlgs (BIOS 0:$417) is taken from
//   KeyEvent.shift when a key is read and cleared when WaitEvent finds the queue empty (the host
//   sends no key-up events): TS approximation of "modifier held".
// * Mouse: int 33h does not exist; the host may call MouseEvHandler (TS entry of the BP7 driver
//   callback) after setting MouseDriverPresent. HideMaus/ShowMaus calls around screen writes are
//   omitted (they only hide the int 33h pointer).
// * Timer (BIOS 0:$46C) is a getter over the host clock (55 ms ticks); Delay waits N ticks.
// * AssignCrt installs the TextRec drivers (OpenCrt/WrOutput/DummyCrt) on a pasrt.TextFile.

import type { Crt } from '../console/crt.ts';
import { byteToChar } from '../console/cp852.ts';
import {
  fmOutput, Output, TxtWrite, ToUnicode, ValI, Copy, ParamStr, ref, type Ref, type Pointer, type TextFile,
} from './pasrt.ts';
import { BaseVars, StoreAvail } from './base.ts';
import { PushW1, PopW } from './obaseww.ts';
import { Menu, PrinterMenu } from './wwmenu.ts';
import { GetKeyEvent, BreakCheck, AddToKbdBuf, KeyPressed, ReadKey } from './keybd.ts';

export * from './keybd.ts';

// ---------------------------------------------------------------- Crt binding (TS-only)

let ActiveCrt: Crt | null = null;

/** TS-only: bind the Crt (screen + key queue) the engine runs on; called once at start-up. */
export function SetDriversCrt(crt: Crt | null): void {
  ActiveCrt = crt;
  ShadowInit();
}

/** TS-only: the bound Crt (throws when the engine was not started with one). */
export function GetDriversCrt(): Crt {
  if (!ActiveCrt) throw new Error('DRIVERS: no Crt bound (SetDriversCrt)');
  return ActiveCrt;
}

/** TS-only: the bound Crt or null (headless). */
export function CurrCrt(): Crt | null {
  return ActiveCrt;
}

/** TS-only: host hooks – `sound(hz)` starts a tone (0 = NoSound). */
export const DriversHost = {
  sound: null as ((hz: number) => void) | null,
  /** the host has a mouse and calls MouseEvHandler (int 33h driver present) */
  MouseDriverPresent: false,
  /** source of the BIOS tick counter in ms (tests replace it) */
  now: (): number => performance.now(),
};

/** TS-only: BIOS tick count (18.2/s; FPC: GetTickCount64 div 55). */
function TimerTicks(): number {
  return Math.floor(DriversHost.now() / 55);
}

/** TS-only: int 16h ah=1 – a key waiting in the host queue. */
export function BiosKeyPressed(): boolean {
  return ActiveCrt !== null && ActiveCrt.keyPressed();
}

/** TS-only: int 16h ah=0 – blocking read of a BIOS key word; sets KbdFlgs from its shift state. */
export function BiosReadKey(): number {
  const k = GetDriversCrt().readKey();
  if (!k) return 0;
  DriversVars.KbdFlgs = k.shift & 0x0f;
  return k.code & 0xffff;
}

/** TS-only: wait up to ms (Infinity = until a key) for a key without taking it; true = key waiting. */
export function BiosWaitKey(ms: number): boolean {
  if (BiosKeyPressed()) return true;
  if (ActiveCrt === null) {
    if (ms === Infinity) GetDriversCrt(); // throws: would block forever
    HostSleep(ms);
    return false;
  }
  const k = ActiveCrt.readKey(ms);
  if (!k) return false;
  ActiveCrt.unreadKey(k);
  return true;
}

/** TS-only: sleep ms (flushes the Crt screen first). */
export function HostSleep(ms: number): void {
  if (ms <= 0) return;
  if (ActiveCrt) {
    ActiveCrt.delay(ms);
    return;
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// ---------------------------------------------------------------- objects

// PAS: DRIVERS.PAS TPoint
export class TPoint {
  X = 0;
  Y = 0;
  // PAS: DRIVERS.PAS TPoint.Assign
  Assign(XX: number, YY: number): void {
    this.X = XX;
    this.Y = YY;
  }
}

// PAS: DRIVERS.PAS TObject (Turbo Vision style base; constructor Init / destructor Done)
export class TObject {
  Init(): void {}
  Done(): void {}
}
export type PObject = TObject | null;

// ---------------------------------------------------------------- events

export const evMouseDown = 0x0001;
export const evMouseUp = 0x0002;
export const evMouseMove = 0x0004;
export const evMouseAuto = 0x0008;
export const evNothing = 0x0000;
export const evMouse = 0x000f;
export const evKeyDown = 0x0010;

export const mbLeftButton = 0x01;
export const mbRightButton = 0x02;
export const mbDoubleClick = 0x100;

// PAS: DRIVERS.PAS TEvent – case What of evMouse: (Buttons, Where, WhereG, From);
// evKeyDown: (KeyCode) | (CharCode, ScanCode) overlaying KeyCode. Buttons and KeyCode are the
// same word (first field of both variants): Buttons is an alias of KeyCode.
export class TEvent {
  What = 0;
  Where = new TPoint();
  WhereG = new TPoint();
  From = new TPoint();
  KeyCode = 0;
  get Buttons(): number {
    return this.KeyCode;
  }
  set Buttons(b: number) {
    this.KeyCode = b & 0xffff;
  }
  get CharCode(): string {
    return String.fromCharCode(this.KeyCode & 0xff);
  }
  set CharCode(c: string) {
    this.KeyCode = (this.KeyCode & 0xff00) | (c.charCodeAt(0) & 0xff);
  }
  get ScanCode(): number {
    return (this.KeyCode >> 8) & 0xff;
  }
  set ScanCode(b: number) {
    this.KeyCode = ((b & 0xff) << 8) | (this.KeyCode & 0xff);
  }
}
export type PEvent = TEvent | null;

// ---------------------------------------------------------------- keys

export const _F1 = '\x3b';
export const _F6 = '\x40';
export const _F9 = '\x43';
export const _F10 = '\x44';
export const _CtrlF1 = '\x5e';
export const _CtrlF2 = '\x5f';
export const _CtrlF3 = '\x60';
export const _CtrlF4 = '\x61';
export const _CtrlF5 = '\x62';
export const _CtrlF6 = '\x63';
export const _CtrlF7 = '\x64';
export const _CtrlF8 = '\x65';
export const _CtrlF9 = '\x66';
export const _CtrlF10 = '\x67';
export const _AltF1 = '\x68';
export const _AltF2 = '\x69';
export const _AltF3 = '\x6a';
export const _AltF4 = '\x6b';
export const _AltF5 = '\x6c';
export const _AltF6 = '\x6d';
export const _AltF7 = '\x6e';
export const _AltF8 = '\x6f';
export const _AltF9 = '\x70';
export const _AltF10 = '\x71';
export const _ShiftF1 = '\x54';
export const _CtrlHome = '\x77';
export const _CtrlEnd = '\x75';
export const _EOF = '\x1a';
export const _CR = '\x0d';
export const _LF = '\x0a';
export const _ESC = '\x1b';

export const _F1_ = 0x3b00;
export const _F2_ = 0x3c00;
export const _F3_ = 0x3d00;
export const _F4_ = 0x3e00;
export const _F5_ = 0x3f00;
export const _F6_ = 0x4000;
export const _F7_ = 0x4100;
export const _F8_ = 0x4200;
export const _F9_ = 0x4300;
export const _F10_ = 0x4400;
export const _ShiftF1_ = 0x5400;
export const _ShiftF2_ = 0x5500;
export const _ShiftF3_ = 0x5600;
export const _ShiftF4_ = 0x5700;
export const _ShiftF5_ = 0x5800;
export const _ShiftF6_ = 0x5900;
export const _ShiftF7_ = 0x5a00;
export const _ShiftF8_ = 0x5b00;
export const _ShiftF9_ = 0x5c00;
export const _ShiftF10_ = 0x5d00;
export const _CtrlF1_ = 0x5e00;
export const _CtrlF2_ = 0x5f00;
export const _CtrlF3_ = 0x6000;
export const _CtrlF4_ = 0x6100;
export const _CtrlF5_ = 0x6200;
export const _CtrlF6_ = 0x6300;
export const _CtrlF7_ = 0x6400;
export const _CtrlF8_ = 0x6500;
export const _CtrlF9_ = 0x6600;
export const _CtrlF10_ = 0x6700;
export const _AltF1_ = 0x6800;
export const _AltF2_ = 0x6900;
export const _AltF3_ = 0x6a00;
export const _AltF4_ = 0x6b00;
export const _AltF5_ = 0x6c00;
export const _AltF6_ = 0x6d00;
export const _AltF7_ = 0x6e00;
export const _AltF8_ = 0x6f00;
export const _AltF9_ = 0x7000;
export const _AltF10_ = 0x7100;

export const _left_ = 0x4b00;
export const _right_ = 0x4d00;
export const _up_ = 0x4800;
export const _down_ = 0x5000;
export const _Home_ = 0x4700;
export const _End_ = 0x4f00;
export const _PgUp_ = 0x4900;
export const _PgDn_ = 0x5100;
export const _CtrlLeft_ = 0x7300;
export const _CtrlRight_ = 0x7400;
export const _CtrlPgUp_ = 0x0300; // !differs from BIOS $8400 (FAND remaps it in ReadKbd)
export const _CtrlPgDn_ = 0x7600;
export const _CtrlHome_ = 0x7700;
export const _CtrlEnd_ = 0x7500;
export const _Ins_ = 0x5200;
export const _Del_ = 0x5300;
export const _Tab_ = 0x9;
export const _ShiftTab_ = 0x0f00;
export const _AltEqual_ = 0x8300;

export const _ESC_ = 0x1b;
export const _A_ = 1;
export const _B_ = 2;
export const _C_ = 3;
export const _D_ = 4;
export const _E_ = 5;
export const _F_ = 6;
export const _G_ = 7;
export const _H_ = 8;
export const _I_ = 9;
export const _J_ = 10;
export const _K_ = 11;
export const _L_ = 12;
export const _M_ = 13;
export const _N_ = 14;
export const _O_ = 15;
export const _P_ = 16;
export const _Q_ = 17;
export const _R_ = 18;
export const _S_ = 19;
export const _T_ = 20;
export const _U_ = 21;
export const _V_ = 22;
export const _W_ = 23;
export const _X_ = 24;
export const _Y_ = 25;
export const _Z_ = 26;

// TVideoFont = (foAscii, foLatin2, foKamen)
export type TVideoFont = number;
export const foAscii = 0;
export const foLatin2 = 1;
export const foKamen = 2;

// VideoCard: (viCga, viHercules, viEga, viVga)
export const viCga = 0;
export const viHercules = 1;
export const viEga = 2;
export const viVga = 3;

export const MaxTxtCols = 132; // the best adapter
export const MaxTxtRows = 100;
export const EventQSize = 16;
export const ofsTicks = 0x6c;

/** Frame characters (CP852 box drawing), index 0..20: single 0..8, double 9..17, tee 18..20. */
export const FrameChars = '\xda\xc4\xbf\xc0\xc4\xd9\xb3 \xb3\xc9\xcd\xbb\xc8\xcd\xbc\xba \xba\xc3\xc4\xb4';

export interface EventQItem {
  Time: number;
  Buttons: number;
  X: number;
  Y: number;
  GX: number; // pixel
  GY: number;
}

// ---------------------------------------------------------------- unit state

export const DriversVars = {
  Event: new TEvent(),
  trialStartFand: 0,
  trialInterval: 0,

  KbdChar: 0,
  KbdFlgs: 0, // BIOS 0:$417 shift flags
  DemoAutoRd: false,
  KbdBuffer: '',
  LLKeyFlags: 0,

  VideoCard: viVga,
  GraphDriver: 0,
  GraphMode: 0,
  ScrSeg: 0,
  ScrGrSeg: 0,
  NrVFont: 0,
  BytesPerChar: 0,
  ChkSnow: false,
  IsGraphMode: false,
  GrBytesPerChar: 0,
  GrBytesPerLine: 0, // bytesperchar * 80 when switching to graphics

  BGIReload: true,
  LastWhere: new TPoint(),
  LastWhereG: new TPoint(),
  DownWhere: new TPoint(),
  WindMin: { X: 0, Y: 0 },
  WindMax: { X: 79, Y: 24 },
  /** Current text attribute (the drivers keep the Crt screen in sync). */
  TextAttr: 0x07,
  StartAttr: 0x07,
  StartMode: 3,
  LastMode: 3,
  OldIntr08: null as Pointer,
  FontArr: null as Pointer,
  BGIDriver: null as Pointer,
  BGILittFont: null as Pointer,
  BGITripFont: null as Pointer,
  ButtonCount: 0,
  MouseButtons: 0,
  LastButtons: 0,
  DownButtons: 0,
  LastDouble: 0,
  EventCount: 0,
  EventQHead: 0,
  EventQTail: 0,
  EventQueue: Array.from({ length: EventQSize }, (): EventQItem => ({ Time: 0, Buttons: 0, X: 0, Y: 0, GX: 0, GY: 0 })),
  Crs: { X: 0, Y: 0, Big: false, On: false, Enabled: false, Ticks: 0 },
  MausExist: false,

  /** BIOS tick counter 0:$46C (18.2/s): always the current host tick (writes are ignored). */
  get Timer(): number {
    return TimerTicks();
  },
  set Timer(_v: number) {},
  MouseWhere: new TPoint(),
  MouseWhereG: new TPoint(), // pixel
  MausVisible: true,

  FandBatch: false,
  BatchQuiet: false,
};


// PAS: DRIVERS.PAS unit initialization (FPC): batch mode = 'TASK --…' or '--help'.
// (Not named InitDrivers: that is RUNFAND's private start-up routine.) Call after SetParams.
export function InitDriversUnit(): void {
  DriversVars.FandBatch = Copy(ParamStr(2), 1, 2) === '--' || ParamStr(1) === '--help';
}

// PAS: DRIVERS.PAS Free (private)
function Free(P: PObject): void {
  if (P !== null) P.Done();
}
void Free;

// ---------------------------------------------------------------- video memory (TS: Shadow)

const ShadowSize = MaxTxtCols * MaxTxtRows;
/** PAS: DRIVERS.PAS Shadow (FPC) – the text video memory, linear Y*TxtCols+X. */
const Shadow = new Uint16Array(ShadowSize);

// PAS: DRIVERS.PAS ShadowInit (FPC)
function ShadowInit(): void {
  Shadow.fill(0x0720);
}
ShadowInit();

/** TS-only: store one cell (linear index) into video memory and the Crt screen. */
function ScrPut(i: number, w: number): void {
  if (i < 0 || i >= ShadowSize) return;
  Shadow[i] = w;
  if (ActiveCrt === null) return;
  const cols = BaseVars.TxtCols;
  const y = Math.floor(i / cols);
  if (y >= BaseVars.TxtRows) return;
  ActiveCrt.screen.setCell(i - y * cols, y, byteToChar(w & 0xff), (w >> 8) & 0xff);
}

/** TS-only: read one cell (linear index) of video memory. */
function ScrGet(i: number): number {
  return i >= 0 && i < ShadowSize ? Shadow[i] : 0x0720;
}

/** PAS: DRIVERS.PAS ScrGetPtr – the video memory offset (in cells) of (X,Y). */
function ScrGetPtr(X: number, Y: number): number {
  return Y * BaseVars.TxtCols + X;
}

// ---------------------------------------------------------------- screen

// PAS: DRIVERS.PAS LoadVideoFont – BP7 loads FAND.RES font NrVFont with int 10h; no fonts on the host
export function LoadVideoFont(): void {
  if (DriversVars.IsGraphMode || DriversVars.NrVFont === 0) return;
  // the host renders Unicode glyphs: nothing to load
}
// PAS: DRIVERS.PAS ScrClr
export function ScrClr(X: number, Y: number, SizeX: number, SizeY: number, C: string, Color: number): void {
  const w = ((Color & 0xff) << 8) | (C.charCodeAt(0) & 0xff);
  let p = ScrGetPtr(X, Y);
  for (let j = 0; j < SizeY; j++) {
    for (let i = 0; i < SizeX; i++) ScrPut(p + i, w);
    p += BaseVars.TxtCols;
  }
}
// PAS: DRIVERS.PAS ScrWrChar
export function ScrWrChar(X: number, Y: number, C: string, Color: number): void {
  ScrPut(ScrGetPtr(X, Y), ((Color & 0xff) << 8) | (C.charCodeAt(0) & 0xff));
}
// PAS: DRIVERS.PAS ScrWrStr
export function ScrWrStr(X: number, Y: number, S: string, Color: number): void {
  const p = ScrGetPtr(X, Y);
  const a = (Color & 0xff) << 8;
  for (let i = 0; i < S.length; i++) ScrPut(p + i, a | (S.charCodeAt(i) & 0xff));
}
// PAS: DRIVERS.PAS ScrWrFrameLn
export function ScrWrFrameLn(X: number, Y: number, Typ: number, Width: number, Color: number): void {
  if (Width <= 0) return;
  let s: string;
  if (Width === 1) s = FrameChars[Typ + 2];
  else s = FrameChars[Typ] + FrameChars[Typ + 1].repeat(Width - 2) + FrameChars[Typ + 2];
  ScrWrStr(X, Y, s, Color);
}
// PAS: DRIVERS.PAS ScrWrBuf – Buf: L cell words
export function ScrWrBuf(X: number, Y: number, Buf: Uint16Array, L: number): void {
  const p = ScrGetPtr(X, Y);
  for (let i = 0; i < L; i++) ScrPut(p + i, Buf[i]);
}
// PAS: DRIVERS.PAS TermSize – FPC: the terminal size; here the Crt screen (never smaller than given)
export function TermSize(Cols: Ref<number>, Rows: Ref<number>): boolean {
  if (ActiveCrt === null) return false;
  const scr = ActiveCrt.screen;
  if (scr.cols === 0 || scr.rows === 0) return false;
  if (scr.cols > Cols.v) Cols.v = scr.cols;
  if (scr.rows > Rows.v) Rows.v = scr.rows;
  return true;
}
// PAS: DRIVERS.PAS ScrRepaintAll – repaint the Crt screen from video memory
export function ScrRepaintAll(): void {
  if (ActiveCrt === null) return;
  const n = BaseVars.TxtCols * BaseVars.TxtRows;
  for (let i = 0; i < n; i++) ScrPut(i, Shadow[i]);
}
// PAS: DRIVERS.PAS InstallWinch – FPC: SIGWINCH handler; the host window has a fixed text mode
export function InstallWinch(): void {}
// PAS: DRIVERS.PAS ScrRdBuf – Buf receives L cell words
export function ScrRdBuf(X: number, Y: number, Buf: Uint16Array, L: number): void {
  const p = ScrGetPtr(X, Y);
  for (let i = 0; i < L; i++) Buf[i] = ScrGet(p + i);
}
// PAS: DRIVERS.PAS ScrPush1 (private)
function ScrPush1(X: number, Y: number, SizeX: number, SizeY: number, P: Uint16Array): void {
  P[0] = SizeX;
  P[1] = SizeY;
  let src = ScrGetPtr(X, Y);
  let d = 2;
  for (let j = 0; j < SizeY; j++) {
    for (let i = 0; i < SizeX; i++) P[d++] = ScrGet(src + i);
    src += BaseVars.TxtCols;
  }
}
// PAS: DRIVERS.PAS ScrPush – saved area: [SizeX, SizeY, cells...]
export function ScrPush(X: number, Y: number, SizeX: number, SizeY: number): Uint16Array {
  const p = new Uint16Array(SizeX * SizeY + 2); // GetStore(SizeX*SizeY*2+4)
  ScrPush1(X, Y, SizeX, SizeY, p);
  return p;
}
// PAS: DRIVERS.PAS ScrPop
export function ScrPop(X: number, Y: number, P: Uint16Array): void {
  const SizeX = P[0];
  const SizeY = P[1];
  let dst = ScrGetPtr(X, Y);
  let s = 2;
  for (let j = 0; j < SizeY; j++) {
    for (let i = 0; i < SizeX; i++) ScrPut(dst + i, P[s++]);
    dst += BaseVars.TxtCols;
  }
}
// PAS: DRIVERS.PAS ScrPopToGraph (graphics: no-op in the FPC port)
export function ScrPopToGraph(X: number, Y: number, SizeX: number, SizeY: number, P: Uint16Array, DOfs: number): void {}
// PAS: DRIVERS.PAS ScrMove – BP7 rep movsw: a forward copy of L cells
export function ScrMove(X: number, Y: number, ToX: number, ToY: number, L: number): void {
  const s = ScrGetPtr(X, Y);
  const d = ScrGetPtr(ToX, ToY);
  for (let i = 0; i < L; i++) ScrPut(d + i, ScrGet(s + i));
}
// PAS: DRIVERS.PAS ScrColor
export function ScrColor(X: number, Y: number, L: number, Color: number): void {
  const p = ScrGetPtr(X, Y);
  for (let i = 0; i < L; i++) ScrPut(p + i, ((Color & 0xff) << 8) | (ScrGet(p + i) & 0xff));
}

// ---------------------------------------------------------------- cursor, CRT-like window

/** TS-only: show the cursor state on the Crt screen. */
function CrsToScreen(): void {
  if (ActiveCrt === null || DriversVars.FandBatch) return;
  const scr = ActiveCrt.screen;
  scr.cx = DriversVars.Crs.X;
  scr.cy = DriversVars.Crs.Y;
  scr.cursorVisible = DriversVars.Crs.Enabled;
}

// PAS: DRIVERS.PAS CrsShow
export function CrsShow(): void {
  const Crs = DriversVars.Crs;
  if (Crs.Enabled) return;
  if (DriversVars.IsGraphMode) {
    Crs.On = false;
    Crs.Ticks = CrsTimeOff;
  } // else int 10h: cursor shape video.CursOn / CursBig (Crs.Big)
  Crs.Enabled = true;
  CrsToScreen();
}
// PAS: DRIVERS.PAS CrsHide
export function CrsHide(): void {
  const Crs = DriversVars.Crs;
  if (!Crs.Enabled) return;
  Crs.Enabled = false;
  CrsToScreen(); // int 10h: video.CursOff
}
// PAS: DRIVERS.PAS CrsBig
export function CrsBig(): void {
  const Crs = DriversVars.Crs;
  if (!Crs.Big) {
    CrsHide();
    Crs.Big = true;
  }
  CrsShow();
}
// PAS: DRIVERS.PAS CrsNorm
export function CrsNorm(): void {
  const Crs = DriversVars.Crs;
  if (Crs.Big) {
    CrsHide();
    Crs.Big = false;
  }
  CrsShow();
}
const CrsTimeOff = 0x0005;
// PAS: DRIVERS.PAS CrsGotoXY (private)
function CrsGotoXY(aX: number, aY: number): void {
  const Crs = DriversVars.Crs;
  if (DriversVars.IsGraphMode && Crs.Enabled) {
    Crs.Enabled = false;
    Crs.X = aX;
    Crs.Y = aY;
    Crs.On = false;
    Crs.Ticks = CrsTimeOff;
    Crs.Enabled = true;
  } else {
    Crs.X = aX;
    Crs.Y = aY;
    if (!DriversVars.IsGraphMode) CrsToScreen(); // int 10h ah=2
  }
}
// PAS: DRIVERS.PAS CrsGet – BP7: lo word = Big | Enabled shl 8, hi word = X | Y shl 8
export function CrsGet(): number {
  const Crs = DriversVars.Crs;
  return ((Crs.Y & 0xff) << 24) | ((Crs.X & 0xff) << 16) | ((Crs.Enabled ? 1 : 0) << 8) | (Crs.Big ? 1 : 0);
}
// PAS: DRIVERS.PAS CrsSet
export function CrsSet(S: number): void {
  CrsHide();
  DriversVars.Crs.Big = (S & 0xff) !== 0;
  CrsGotoXY((S >>> 16) & 0xff, (S >>> 24) & 0xff);
  if (((S >>> 8) & 0xff) !== 0) CrsShow();
}
// PAS: DRIVERS.PAS CrsIntrInit (graphics cursor blinking on int 8: no-op)
export function CrsIntrInit(): void {}
// PAS: DRIVERS.PAS CrsIntrDone (no-op)
export function CrsIntrDone(): void {}
// PAS: DRIVERS.PAS GotoXY – outside the window: the window origin
export function GotoXY(X: number, Y: number): void {
  const { WindMin, WindMax } = DriversVars;
  let dl = ((X - 1) & 0xff) + WindMin.X;
  let dh = ((Y - 1) & 0xff) + WindMin.Y;
  if (dl > 0xff || dl > WindMax.X || dh > 0xff || dh > WindMax.Y) {
    dl = WindMin.X;
    dh = WindMin.Y;
  }
  CrsGotoXY(dl, dh);
}
// PAS: DRIVERS.PAS WhereX
export function WhereX(): number {
  return (DriversVars.Crs.X - DriversVars.WindMin.X + 1) & 0xff;
}
// PAS: DRIVERS.PAS WhereY
export function WhereY(): number {
  return (DriversVars.Crs.Y - DriversVars.WindMin.Y + 1) & 0xff;
}
// PAS: DRIVERS.PAS Window – 1-based; invalid coordinates are ignored; the cursor goes to the origin
export function Window(X1: number, Y1: number, X2: number, Y2: number): void {
  X1 &= 0xff;
  Y1 &= 0xff;
  X2 &= 0xff;
  Y2 &= 0xff;
  if (X1 > X2 || Y1 > Y2) return;
  if (X1 - 1 < 0 || X1 - 1 >= 0x80 || Y1 - 1 < 0 || Y1 - 1 >= 0x80) return; // dec; js
  if (X2 > (BaseVars.TxtCols & 0xff) || Y2 > (BaseVars.TxtRows & 0xff)) return;
  const dv = DriversVars;
  dv.WindMin.X = X1 - 1;
  dv.WindMin.Y = Y1 - 1;
  dv.WindMax.X = X2 - 1;
  dv.WindMax.Y = Y2 - 1;
  CrsGotoXY(dv.WindMin.X, dv.WindMin.Y);
}
// PAS: DRIVERS.PAS ClrScr
export function ClrScr(): void {
  const { WindMin, WindMax } = DriversVars;
  ScrClr(WindMin.X, WindMin.Y, WindMax.X - WindMin.X + 1, WindMax.Y - WindMin.Y + 1, ' ', DriversVars.TextAttr);
  CrsGotoXY(WindMin.X, WindMin.Y);
}
// PAS: DRIVERS.PAS ClrEol
export function ClrEol(): void {
  const { Crs, WindMax } = DriversVars;
  ScrClr(Crs.X, Crs.Y, WindMax.X - Crs.X + 1, 1, ' ', DriversVars.TextAttr);
}
// PAS: DRIVERS.PAS Scroll (private) – BP7: moves SizeY-1 lines up/down and blanks the freed line
function Scroll(X: number, Y: number, SizeX: number, SizeY: number, Up: boolean): void {
  if (SizeY <= 0 || SizeX <= 0) return;
  if (Up) {
    for (let r = Y; r < Y + SizeY - 1; r++) ScrMove(X, r + 1, X, r, SizeX);
    ScrClr(X, Y + SizeY - 1, SizeX, 1, ' ', DriversVars.TextAttr);
  } else {
    for (let r = Y + SizeY - 1; r > Y; r--) ScrMove(X, r - 1, X, r, SizeX);
    ScrClr(X, Y, SizeX, 1, ' ', DriversVars.TextAttr);
  }
}
// PAS: DRIVERS.PAS TextBackGround
export function TextBackGround(Color: number): void {
  DriversVars.TextAttr = (DriversVars.TextAttr & 0x0f) | ((Color & 0x07) << 4);
}
// PAS: DRIVERS.PAS TextColor
export function TextColor(Color: number): void {
  DriversVars.TextAttr = (DriversVars.TextAttr & 0xf0) | (Color & 0x0f);
}
// PAS: DRIVERS.PAS InsLine
export function InsLine(): void {
  const { Crs, WindMin, WindMax } = DriversVars;
  Scroll(WindMin.X, Crs.Y, WindMax.X - WindMin.X + 1, WindMax.Y - Crs.Y + 1, false);
}
// PAS: DRIVERS.PAS DelLine
export function DelLine(): void {
  const { Crs, WindMin, WindMax } = DriversVars;
  Scroll(WindMin.X, Crs.Y, WindMax.X - WindMin.X + 1, WindMax.Y - Crs.Y + 1, true);
}
// PAS: DRIVERS.PAS Beep – write(^g) through the CRT driver (ScrBeep)
export function beep(): void {
  if (Output.Mode === fmOutput) TxtWrite(Output, '\x07');
  else ScrBeep(); // TS: Output not yet assigned to the CRT
}
// PAS: DRIVERS.PAS LockBeep
export function LockBeep(): void {
  if (BaseVars.Spec.LockBeepAllowed) beep();
}
// PAS: DRIVERS.PAS ScrBeep – 880 Hz for 6 ticks when spec.Beep
export function ScrBeep(): void {
  if (!BaseVars.Spec.Beep) return;
  Sound(880);
  Delay(6);
  NoSound();
}

// ---------------------------------------------------------------- mouse and events

let MausRefresh = false;
let AutoTicks = 0;
let DownTicks = 0;
let AutoDelay = 0;

// PAS: KEYBD.PAS InitMouseEvents (BP7) – MausVisible, MouseWhere set before
export function InitMouseEvents(): void {
  const dv = DriversVars;
  dv.MausExist = false;
  dv.Event.What = 0;
  if (BaseVars.Spec.NoMouseSupport || dv.VideoCard < viEga || !DriversHost.MouseDriverPresent) {
    dv.MausVisible = false;
    return;
  }
  dv.ButtonCount = 2;
  dv.MausExist = true;
  dv.MouseButtons = 0;
  dv.LastButtons = 0;
  dv.DownButtons = 0;
  dv.LastDouble = 0;
  dv.EventCount = 0;
  dv.EventQHead = 0;
  dv.EventQTail = 0;
  dv.LastWhere.X = dv.MouseWhere.X;
  dv.LastWhere.Y = dv.MouseWhere.Y;
  const gx = dv.MouseWhere.X * 8;
  const gy = dv.MouseWhere.Y * (dv.IsGraphMode ? dv.GrBytesPerChar : 8);
  dv.MouseWhereG.X = gx;
  dv.LastWhereG.X = gx;
  dv.MouseWhereG.Y = gy;
  dv.LastWhereG.Y = gy;
  // int 33h fn 4 (position), fn 12 (event handler = MouseEvHandler), fn 1/2 show/hide
}
// PAS: KEYBD.PAS DoneMouseEvents (BP7) – removes the handler, hides the pointer
export function DoneMouseEvents(): void {}
// PAS: KEYBD.PAS ShowMouse (BP7)
export function ShowMouse(): void {
  if (DriversVars.MausExist && !DriversVars.MausVisible) DriversVars.MausVisible = true;
}
// PAS: KEYBD.PAS HideMouse (BP7)
export function HideMouse(): void {
  if (DriversVars.MausExist && DriversVars.MausVisible) DriversVars.MausVisible = false;
}
// PAS: KEYBD.PAS ShowMaus (BP7) – shows the pointer again after HideMaus
export function ShowMaus(): void {
  if (MausRefresh) MausRefresh = false;
}
// PAS: KEYBD.PAS HideMaus (BP7) – hides the pointer during a screen write
export function HideMaus(): void {
  if (DriversVars.MausVisible) MausRefresh = true;
}
// PAS: DRIVERS.PAS SetMouse (FPC: empty; BP7 KEYBD int 33h moves the pointer, sets MausVisible)
export function SetMouse(X: number, Y: number, Visible: boolean): void {}

/**
 * PAS: KEYBD.PAS MouseEvHandler (BP7 int 33h event handler) – TS entry for the host:
 * Condition = int 33h event mask (bits 1..4: a button pressed/released), pixel coordinates GX, GY.
 */
export function MouseEvHandler(Condition: number, Buttons: number, GX: number, GY: number): void {
  const dv = DriversVars;
  dv.MouseWhereG.X = GX;
  dv.MouseWhereG.Y = GY;
  const X = GX >> 3;
  let Y: number;
  if (!dv.IsGraphMode) Y = GY >> 3;
  else {
    Y = dv.GrBytesPerChar ? Math.floor(GY / dv.GrBytesPerChar) & 0xff : 0;
    if (Y >= BaseVars.TxtRows) Y = BaseVars.TxtRows - 1;
  }
  dv.MouseButtons = Buttons & 0xff;
  dv.MouseWhere.X = X;
  dv.MouseWhere.Y = Y;
  if ((Condition & 0b11110) === 0 || dv.EventCount >= EventQSize) return;
  const q = dv.EventQueue[dv.EventQTail];
  q.Time = dv.Timer & 0xffff;
  q.Buttons = Buttons & 0xffff;
  q.X = X;
  q.Y = Y;
  q.GX = GX;
  q.GY = GY;
  dv.EventQTail = (dv.EventQTail + 1) % EventQSize;
  dv.EventCount++;
}

// PAS: KEYBD.PAS GetMouseEvent (BP7)
export function GetMouseEvent(): void {
  const dv = DriversVars;
  const E = dv.Event;
  const spec = BaseVars.Spec;
  let What = evNothing;
  let bl = 0;
  let bh = 0;
  let cx = 0;
  let dx = 0;
  let GX = 0;
  let GY = 0;
  let di = 0;
  let nothing = !dv.MausExist;
  if (!nothing) {
    E.From.X = 0;
    E.From.Y = 0;
    if (dv.EventCount === 0) {
      bl = dv.MouseButtons;
      GX = dv.MouseWhereG.X;
      GY = dv.MouseWhereG.Y;
      cx = dv.MouseWhere.X;
      dx = dv.MouseWhere.Y;
      di = dv.Timer & 0xffff;
    } else {
      const q = dv.EventQueue[dv.EventQHead];
      di = q.Time;
      bl = q.Buttons & 0xff;
      cx = q.X;
      dx = q.Y;
      GX = q.GX;
      GY = q.GY;
      dv.EventQHead = (dv.EventQHead + 1) % EventQSize;
      dv.EventCount--;
    }
    if (spec.MouseReverse) {
      const b = bl & 3;
      if (b !== 0 && b !== 3) bl ^= 3;
    }
    bh = dv.LastDouble;
    const al = dv.LastButtons;
    let kind = 0; // 5: same buttons, 7: pressed, 9: released
    if (al === bl) kind = 5;
    else if (al === 0) kind = 7;
    else if (bl === 0) kind = 9;
    else {
      bl = al; // 2nd button pressed/released or left<->right: ignore the change
      kind = 5;
    }
    if (kind === 5) {
      if (bl === 0) nothing = true;
      else {
        const moved = dv.IsGraphMode
          ? GX !== dv.LastWhereG.X || GY !== dv.LastWhereG.Y
          : cx !== dv.LastWhere.X || dx !== dv.LastWhere.Y;
        if (moved) {
          E.From.X = dv.LastWhere.X;
          E.From.Y = dv.LastWhere.Y;
          What = evMouseMove;
        } else if (((di - AutoTicks) & 0xffff) >= AutoDelay) {
          AutoTicks = di;
          AutoDelay = 1; // auto after RepeatDelay at each tick
          What = evMouseAuto;
        } else nothing = true;
      }
    } else if (kind === 7) {
      bh = 0;
      if (bl === dv.DownButtons && cx === dv.DownWhere.X && dx === dv.DownWhere.Y
        && ((di - DownTicks) & 0xff) < spec.DoubleDelay) bh = 1; // same place, same button in time
      dv.DownButtons = bl;
      dv.DownWhere.X = cx;
      dv.DownWhere.Y = dx;
      DownTicks = di;
      AutoTicks = di;
      AutoDelay = spec.RepeatDelay;
      What = evMouseDown;
    } else What = evMouseUp;
    if (!nothing) {
      dv.LastButtons = bl;
      dv.LastDouble = bh;
      dv.LastWhere.X = cx;
      dv.LastWhere.Y = dx;
      dv.LastWhereG.X = GX;
      dv.LastWhereG.Y = GY;
    }
  }
  if (nothing) {
    What = evNothing;
    bl = bh = cx = dx = GX = GY = 0;
  }
  E.What = What;
  E.Buttons = bl | (bh << 8);
  E.Where.X = cx;
  E.Where.Y = dx;
  E.WhereG.X = GX;
  E.WhereG.Y = GY;
}

// PAS: KEYBD.PAS GetRedKeyName (BP7) – the lFirst-coloured word at/left of the mouse on its row
function GetRedKeyName(): string {
  const E = DriversVars.Event;
  const bh = BaseVars.Colors.lFirst;
  const cols = BaseVars.TxtCols;
  const rowStart = E.Where.Y * cols;
  let x = E.Where.X + 1;
  if (x === cols) x--;
  let i = rowStart + x;
  const attr = (k: number): number => (ScrGet(k) >> 8) & 0xff;
  // scan left to a cell with attr lFirst, then left to the start of that run
  let found = false;
  while (i >= rowStart) {
    const a = attr(i--);
    if (a === bh) {
      found = true;
      break;
    }
  }
  if (found) {
    i++;
    let atStart = true;
    while (i >= rowStart) {
      const a = attr(i--);
      if (a !== bh) {
        atStart = false;
        break;
      }
    }
    if (!atStart) i++;
  }
  i++;
  let s = '';
  while (attr(i) === bh) {
    s += String.fromCharCode(ScrGet(i) & 0xff);
    i++;
    if (s.length === 8) break;
  }
  return s;
}

// PAS: KEYBD.PAS GetMouseKeyEvent (BP7) – right button = Esc, left button on the red keys of the last line
function GetMouseKeyEvent(): void {
  GetMouseEvent();
  const dv = DriversVars;
  const E = dv.Event;
  const key = (k: number): void => {
    E.KeyCode = k;
    E.What = evKeyDown;
  };
  if (E.What === evMouseDown && (E.Buttons & mbRightButton) !== 0) {
    key(_ESC_);
    return;
  }
  if (E.What !== evMouseAuto && E.What !== evMouseDown) return;
  if ((E.Buttons & mbLeftButton) === 0 || E.Where.Y !== BaseVars.TxtRows - 1) return;
  if (!dv.IsGraphMode) HideMaus();
  let RedKeyName = GetRedKeyName();
  if (!dv.IsGraphMode) ShowMaus();
  switch (RedKeyName) {
    case '>': return key(0x3e);
    case '\x18': return key(_up_);
    case '\x19': return key(_down_);
    case '\x11\xd9':
    case 'Enter': return key(_M_);
    case '\xc4\x10\xb3': return key(_Tab_);
    case '\xb3\x11\xc4': return key(_ShiftTab_);
    case 'Esc': return key(_ESC_);
    case 'PgUp': return key(_PgUp_);
    case 'PgDn': return key(_PgDn_);
    case 'Ctrl':
    case 'Alt':
    case 'Shift':
      dv.LLKeyFlags = RedKeyName === 'Ctrl' ? 0x04 : RedKeyName === 'Alt' ? 0x08 : 0x03;
      ClrEvent();
      return;
    case 'CtrlHome': return key(_CtrlHome_);
    case 'CtrlEnd': return key(_CtrlEnd_);
    case 'Home': return key(_Home_);
    case 'End': return key(_End_);
    case 'CtrlY': return key(_Y_);
  }
  let x = -1;
  if (Copy(RedKeyName, 1, 6) === 'ShiftF') {
    RedKeyName = RedKeyName.slice(6);
    x = 0x53;
  } else if (Copy(RedKeyName, 1, 5) === 'CtrlF') {
    RedKeyName = RedKeyName.slice(5);
    x = 0x5d;
  } else if (Copy(RedKeyName, 1, 4) === 'AltF') {
    RedKeyName = RedKeyName.slice(4);
    x = 0x67;
  } else if (RedKeyName[0] === 'F') {
    RedKeyName = RedKeyName.slice(1);
    x = 0x3a;
  }
  if (x >= 0) {
    const n = ref(0);
    const i = ref(0);
    ValI(RedKeyName, n, i);
    n.v &= 0xffff;
    if (i.v === 0 && n.v > 0 && n.v <= 10) key(((n.v + x) << 8) & 0xffff);
  }
}

let InMenu6 = false;
let InMenu8 = false;
// PAS: DRIVERS.PAS TestGlobalKey (private) – Alt+F8 keyboard menu, Alt+F6 printer menu
function TestGlobalKey(): void {
  const dv = DriversVars;
  if (dv.Event.What !== evKeyDown) return;
  switch (dv.Event.KeyCode) {
    case _AltF8_:
      if (!InMenu8) {
        ClrEvent();
        InMenu8 = true;
        try {
          const i = Menu(45, BaseVars.Spec.KbdTyp + 1);
          if (i !== 0) BaseVars.Spec.KbdTyp = i - 1;
        } finally {
          InMenu8 = false;
        }
      }
      break;
    case _AltF6_:
      if (!InMenu6) {
        ClrEvent();
        InMenu6 = true;
        try {
          PrinterMenu(46);
        } finally {
          InMenu6 = false;
        }
      }
      break;
    case _ESC_:
      if (dv.LLKeyFlags !== 0) {
        dv.LLKeyFlags = 0;
        ClrEvent();
      }
      break;
  }
}
// PAS: DRIVERS.PAS AddCtrlAltShift – Flgs: 04 = Ctrl, 08 = Alt, 03 = Shift (BP7: F1..F10 only)
export function AddCtrlAltShift(Flgs: number): number {
  const E = DriversVars.Event;
  if (E.What !== evKeyDown) return 0;
  let ax = E.KeyCode;
  let store = false;
  if ((Flgs & 0x04) !== 0) {
    if (ax === _Home_) {
      ax = _CtrlHome_;
      store = true;
    } else if (ax === _End_) {
      ax = _CtrlEnd_;
      store = true;
    } else if (ax === 0x59) {
      ax = _Y_;
      store = true;
    }
  }
  if (!store) {
    if (ax < _F1_ || ax > _F10_) return 0;
    if ((Flgs & 0x04) !== 0) ax += _CtrlF1_ - _F1_;
    else if ((Flgs & 0x08) !== 0) ax += _AltF1_ - _F1_;
    else if ((Flgs & 0x03) !== 0) ax += _ShiftF1_ - _F1_;
  }
  E.KeyCode = ax;
  TestGlobalKey();
  return 0;
}
// PAS: DRIVERS.PAS TestEvent
export function TestEvent(): boolean {
  const E = DriversVars.Event;
  for (;;) {
    if (E.What === 0) GetMouseKeyEvent();
    if (E.What === 0) GetKeyEvent();
    if (E.What === 0) return false;
    TestGlobalKey();
    if (E.What !== 0) return true;
  }
}

const MoveDelay = 10;
// PAS: KEYBD.PAS WaitEvent (BP7) – 0 = event, 1 = KbdFlgs changed, 2 = Delta ticks passed;
// the 'PC FAND' screen saver after spec.ScreenDelay ticks.
export function WaitEvent(Delta: number): number {
  const dv = DriversVars;
  const E = dv.Event;
  const Flgs = dv.KbdFlgs;
  let vis = false;
  let ce = false;
  let pos = 0;
  let t = 0;
  let t1 = 0;
  let x = 0;
  let y = 0;
  let result = 0;
  for (;;) {
    // label 0
    pos = 0;
    t = dv.Timer;
    for (;;) {
      // label 1
      if (E.What === 0) GetMouseKeyEvent();
      if (E.What === 0) GetKeyEvent();
      if (E.What === 0 && dv.FandBatch) {
        E.What = evKeyDown; // FPC: headless runs answer Esc
        E.KeyCode = _ESC_;
      }
      if (E.What !== 0) {
        result = 0;
        break;
      }
      if (dv.KbdFlgs !== 0) dv.KbdFlgs = 0; // TS: no key waiting - modifiers released
      if (Flgs !== dv.KbdFlgs) {
        result = 1;
        break;
      }
      if (Delta !== 0 && dv.Timer > t + Delta) {
        result = 2;
        break;
      }
      const ScreenDelay = BaseVars.Spec.ScreenDelay;
      if (pos !== 0) {
        if (dv.Timer > t1 + MoveDelay) {
          ScrWrStr(x, y, '       ', 7);
          x = Math.floor(Math.random() * (BaseVars.TxtCols - 8)); // TS: own RNG, RandSeed untouched
          y = Math.floor(Math.random() * (BaseVars.TxtRows - 1));
          ScrWrStr(x, y, 'PC FAND', 7);
          t1 = dv.Timer;
        }
      } else if (ScreenDelay > 0 && dv.Timer > t + ScreenDelay) {
        const l = dv.IsGraphMode ? 0x8010 : BaseVars.TxtCols * BaseVars.TxtRows * 2 + 50;
        if (StoreAvail() < l) t = dv.Timer;
        else {
          ce = dv.Crs.Enabled;
          CrsHide();
          pos = PushW1(1, 1, BaseVars.TxtCols, BaseVars.TxtRows, true, true);
          dv.TextAttr = 0;
          ClrScr();
          vis = dv.MausVisible;
          HideMouse();
          t1 = dv.Timer - MoveDelay;
        }
      }
      // TS: sleep until a key arrives or the next tick matters (BP7 polls)
      const timed = Delta !== 0 || pos !== 0 || ScreenDelay > 0 || dv.MausExist;
      BiosWaitKey(timed ? 55 : Infinity);
    }
    // label 2
    if (pos !== 0) {
      if (vis) ShowMouse();
      PopW(pos);
      if (ce) CrsShow();
      if (E.What !== 0) {
        E.What = 0; // the key only ends the screen saver
        continue;
      }
    }
    break;
  }
  TestGlobalKey();
  return result;
}
// PAS: DRIVERS.PAS GetEvent
export function GetEvent(): void {
  do WaitEvent(0);
  while (DriversVars.Event.What === 0);
}
// PAS: DRIVERS.PAS ClrEvent
export function ClrEvent(): void {
  DriversVars.Event.What = 0;
}
// PAS: DRIVERS.PAS KbdPressed – buffer + Bios
export function KbdPressed(): boolean {
  const dv = DriversVars;
  if (dv.KbdBuffer.length > 0) return true;
  if (KeyPressed()) return true;
  dv.Event.What = 0;
  GetMouseKeyEvent();
  if (dv.Event.What === evKeyDown) {
    AddToKbdBuf(dv.Event.KeyCode);
    ClrEvent();
    return true;
  }
  return false;
}
// PAS: DRIVERS.PAS ESCPressed – other Bios input lost
export function ESCPressed(): boolean {
  const E = DriversVars.Event;
  if (KeyPressed()) {
    if (ReadKey() === _ESC_) return true;
  } else {
    GetMouseKeyEvent();
    if (E.What === evKeyDown && E.KeyCode === _ESC_) {
      ClrEvent();
      return true;
    }
    ClrEvent();
  }
  return false;
}
// PAS: DRIVERS.PAS ReadKbd – buffer + Bios (+mouse)
export function ReadKbd(): number {
  const dv = DriversVars;
  while (dv.Event.What !== evKeyDown) {
    ClrEvent();
    GetEvent();
  }
  const k = dv.Event.KeyCode;
  dv.KbdChar = k;
  ClrEvent();
  return k;
}

// PAS: DRIVERS.PAS Delay – N ticks of the BIOS timer (FPC: Sleep(N*55))
export function Delay(N: number): void {
  HostSleep((N & 0xffff) * 55);
}
// PAS: DRIVERS.PAS Sound – PC speaker at N Hz (host hook)
export function Sound(N: number): void {
  if (N <= 0x12) return; // BP7: 1193180 div N would overflow
  DriversHost.sound?.(N);
}
// PAS: DRIVERS.PAS NoSound
export function NoSound(): void {
  DriversHost.sound?.(0);
}

// ---------------------------------------------------------------- CRT text driver

// PAS: DRIVERS.PAS LineFeed/ConLineFeed (private) – next line, scrolling the window up at its end
function ConLineFeed(): void {
  const { Crs, WindMin, WindMax } = DriversVars;
  if (Crs.Y < WindMax.Y) Crs.Y++;
  else Scroll(WindMin.X, WindMin.Y, WindMax.X - WindMin.X + 1, WindMax.Y - WindMin.Y + 1, true);
}
// PAS: DRIVERS.PAS WrOutput (private) – TextRec InOutFunc/FlushFunc of the CRT
function WrOutput(F: TextFile): number {
  BreakCheck();
  const buf = F.Buf;
  F.Buf = '';
  F.BufPos = 0;
  const dv = DriversVars;
  if (dv.FandBatch) {
    if (!dv.BatchQuiet) process.stderr.write(ToUnicode(buf)); // FPC: S852ToUtf8 to StdErr
    return 0;
  }
  const { Crs, WindMin, WindMax } = dv;
  let s = '';
  let sx = Crs.X;
  let sy = Crs.Y;
  const WrDirect = (): void => {
    if (s.length > 0) ScrWrStr(sx, sy, s, dv.TextAttr);
    s = '';
  };
  const mark = (): void => {
    sx = Crs.X;
    sy = Crs.Y;
  };
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    switch (c) {
      case '\x07':
        WrDirect();
        ScrBeep();
        break;
      case '\x08':
        WrDirect();
        if (Crs.X !== WindMin.X) Crs.X--;
        break;
      case '\x0a':
        WrDirect();
        ConLineFeed();
        break;
      case '\x0d':
        WrDirect();
        Crs.X = WindMin.X;
        break;
      default:
        s += c;
        Crs.X++;
        if (Crs.X <= WindMax.X) continue;
        WrDirect();
        ConLineFeed();
        Crs.X = WindMin.X;
    }
    mark();
  }
  WrDirect();
  CrsGotoXY(Crs.X, Crs.Y);
  return 0;
}
// PAS: DRIVERS.PAS DummyCrt (private)
function DummyCrt(F: TextFile): number {
  return 0;
}
// PAS: DRIVERS.PAS OpenCrt (private)
function OpenCrt(F: TextFile): number {
  F.InOutFunc = WrOutput;
  F.FlushFunc = WrOutput;
  F.CloseFunc = DummyCrt;
  return 0;
}
// PAS: DRIVERS.PAS AssignCrt – T writes through the drivers to the screen
export function AssignCrt(T: TextFile): void {
  T.Mode = 0xd7b0; // fmClosed
  T.BufSize = 128;
  T.Buf = '';
  T.BufPos = 0;
  T.BufEnd = 0;
  T.OpenFunc = OpenCrt;
  T.InOutFunc = null;
  T.FlushFunc = null;
  T.CloseFunc = null;
  T.Name = '';
  T.Handle = -2;
  T.LineEnd = '\r\n';
}

/** TS-only: the video memory cell at (X,Y) (tests, debugging). */
export function ScrCell(X: number, Y: number): number {
  return ScrGet(ScrGetPtr(X, Y));
}
/** TS-only: one screen row of video memory as a byte string. */
export function ScrRowStr(Y: number): string {
  let s = '';
  for (let x = 0; x < BaseVars.TxtCols; x++) s += String.fromCharCode(ScrCell(x, Y) & 0xff);
  return s;
}
