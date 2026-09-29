// PAS: OBASEWW.PAS – window push/pop, frames, last-line messages, FAND RunError, progress messages.
//
// Porting notes:
// * asm/DOS: PushScr/PopScr pack C1,R1 with stosw/lodsw in front of the DRIVERS ScrPush buffer;
//   here the pushed screen is { C1, R1, cells } (ScrPush returns [SizeX, SizeY, cells...]).
//   PushW1 stores WParam + the screen image in TWork (StoreInTWork) and returns its position;
//   PopW2 reads it back with ReadDelInTWork. The LongStr length came from heap-pointer arithmetic
//   (AbsAdr(HeapPtr)); here the serialised bytes define it. {$ifdef FandGraph} pixel save is off.
// * WrLLF10MsgLine/PromptYN: FPC FandBatch mode prints the message to stderr (BatchLine, UTF-8 via
//   FANDCP.S852ToUtf8) and answers F10 / AbbrNo without waiting. Keep that for headless runs.
// * RunError(N) is FAND's error: ClearKbdBuf, WrLLF10Msg(N), EdBreak := 3, GoExit (never returns).
//   CFileError ends in CloseGoExit (ACCESS).
// * Key global state: BatchMsgCount (interface, FPC); private: CM (RunMsgD stack for RunMsgOn/N/Off).
//   Window state (WindMin/WindMax/TextAttr/cursor) lives in DriversVars; WParam saves it.
// * write()/gotoxy() in the Pascal code go to DRIVERS' CRT text driver (Window-relative, 1-based):
//   TxtWrite(Output, ...) - Output must have been AssignCrt-ed and rewritten (RUNFAND does it).
// * The TWork image of PushW1 has the BP7 heap layout: WParam (Min, Max, Attr: word; Cursor,
//   GrRoot: longint = 14 bytes), then PushScr's C1, R1 (words) and the ScrPush buffer (SizeX,
//   SizeY, cells).

import {
  StrI, ShortStr, Copy, UpCase, Div, TxtWrite, Output, ToUnicode, getWord, setWord, getLongint, setLongint,
  type Ref,
} from './pasrt.ts';
import {
  BaseVars, RdMsg, SetMsgPar, MouseInRect, MaxI, MinI, MinW, WShadow, WNoClrScr, WPushPixel, WHasFrame,
  WDoubleFrame, GoExit, type LongStrPtr,
} from './base.ts';
import {
  DriversVars, CrsGet, CrsSet, CrsHide, CrsShow, Window, ScrPush, ScrPop, ScrRdBuf, ScrWrBuf, ScrClr, ScrWrStr,
  ScrWrChar, ScrWrFrameLn, ScrColor, FrameChars, ClrEol, GotoXY, WhereX, WhereY, beep, GetEvent, ClrEvent,
  ReadKbd, ClearKbdBuf, MaxTxtCols, evMouseDown, evKeyDown, _F10_, _F1_, _ShiftF7_, _M_,
} from './drivers.ts';
import { AccessVars, StoreInTWork, ReadDelInTWork, CExtToT, CExtToX, CloseGoExit } from './access.ts';
import { SetCPathVol } from './oaccess.ts';

/** write(...) to the CRT (System.Output) */
function write(...S: string[]): void {
  TxtWrite(Output, ...S);
}

// PAS: OBASEWW.PAS WParam (implementation type) – saved window state
export class WParam {
  Min = 0; // word(WindMin): lo = X, hi = Y
  Max = 0;
  Attr = 0;
  Cursor = 0;
  GrRoot = 0;
}
export type WParamPtr = WParam | null;
const SizeOfWParam = 14;

/** TS: result of PushScr – the upper-left corner (0-based) and the DRIVERS ScrPush buffer. */
export interface PushedScr {
  C1: number;
  R1: number;
  Buf: Uint16Array;
}

// PAS: OBASEWW.PAS WGrBuf (implementation type; FandGraph pixel save, not ported)
export const MaxGrBufSz = 0x7fff - 4;

export const ObaseWWVars = {
  /** FPC: number of messages BatchLine wrote to stderr */
  BatchMsgCount: 0,
};

// PAS: OBASEWW.PAS BatchLine (FPC) – 'fand: <msg>' to stderr, control chars dropped
export function BatchLine(S: string): void {
  let t = '';
  for (let i = 0; i < S.length; i++) if (S.charCodeAt(i) >= 0x20) t += S[i];
  process.stderr.write('fand: ' + ToUnicode(t) + '\n'); // FPC: S852ToUtf8
  ObaseWWVars.BatchMsgCount++;
}
// PAS: OBASEWW.PAS PushWParam – saves WindMin/WindMax/TextAttr/cursor; Window(C1..R2) if WW
export function PushWParam(C1: number, R1: number, C2: number, R2: number, WW: boolean): WParam {
  const dv = DriversVars;
  const wp = new WParam();
  wp.Min = dv.WindMin.X | (dv.WindMin.Y << 8);
  wp.Max = dv.WindMax.X | (dv.WindMax.Y << 8);
  wp.Attr = dv.TextAttr;
  wp.Cursor = CrsGet();
  if (WW) Window(C1, R1, C2, R2);
  return wp;
}
// PAS: OBASEWW.PAS PopWParam
export function PopWParam(p: WParam): void {
  const dv = DriversVars;
  dv.WindMin.X = p.Min & 0xff;
  dv.WindMin.Y = (p.Min >> 8) & 0xff;
  dv.WindMax.X = p.Max & 0xff;
  dv.WindMax.Y = (p.Max >> 8) & 0xff;
  dv.TextAttr = p.Attr & 0xff;
  CrsSet(p.Cursor);
}
// PAS: OBASEWW.PAS PushScr – 1-based window corners
export function PushScr(C1: number, R1: number, C2: number, R2: number): PushedScr {
  C1--;
  R1--;
  return { C1, R1, Buf: ScrPush(C1, R1, C2 - C1, R2 - R1) };
}
// PAS: OBASEWW.PAS PopScr
export function PopScr(p: PushedScr): void {
  ScrPop(p.C1, p.R1, p.Buf);
}

/** TS-only: WParam + pushed screen as the bytes of the TWork LongStr (BP7 heap layout). */
function WImageToBytes(w: WParam, p: PushedScr): Uint8Array {
  const n = p.Buf.length;
  const s = new Uint8Array(SizeOfWParam + 4 + 2 * n);
  setWord(s, 0, w.Min);
  setWord(s, 2, w.Max);
  setWord(s, 4, w.Attr);
  setLongint(s, 6, w.Cursor);
  setLongint(s, 10, w.GrRoot);
  setWord(s, 14, p.C1);
  setWord(s, 16, p.R1);
  for (let i = 0; i < n; i++) setWord(s, 18 + 2 * i, p.Buf[i]);
  return s;
}
/** TS-only: WParamPtr(@s^.A) */
function WParamFromBytes(s: Uint8Array): WParam {
  const w = new WParam();
  w.Min = getWord(s, 0);
  w.Max = getWord(s, 2);
  w.Attr = getWord(s, 4);
  w.Cursor = getLongint(s, 6);
  w.GrRoot = getLongint(s, 10);
  return w;
}
/** TS-only: the PushScr data after the WParam (inc(w)) */
function PushedScrFromBytes(s: Uint8Array): PushedScr {
  const C1 = getWord(s, SizeOfWParam);
  const R1 = getWord(s, SizeOfWParam + 2);
  const n = Math.max(0, (s.length - SizeOfWParam - 4) >> 1);
  const Buf = new Uint16Array(n);
  for (let i = 0; i < n; i++) Buf[i] = getWord(s, SizeOfWParam + 4 + 2 * i);
  return { C1, R1, Buf };
}

// PAS: OBASEWW.PAS PushW1 – returns the TWork position of the saved window
export function PushW1(C1: number, R1: number, C2: number, R2: number, PushPixel: boolean, WW: boolean): number {
  const pos = 0; // {$ifdef FandGraph} pixel images of the area (graphics: not ported)
  const w = PushWParam(C1, R1, C2, R2, WW);
  w.GrRoot = pos;
  const p = PushScr(C1, R1, C2, R2);
  const s: LongStrPtr = WImageToBytes(w, p);
  return StoreInTWork(s);
}
// PAS: OBASEWW.PAS PushW
export function PushW(C1: number, R1: number, C2: number, R2: number): number {
  return PushW1(C1, R1, C2, R2, false, true);
}
// PAS: OBASEWW.PAS PopW
export function PopW(pos: number): void {
  PopW2(pos, true);
}
// PAS: OBASEWW.PAS PopW2 – draw=false only restores the window parameters
export function PopW2(pos: number, draw: boolean): void {
  const s = ReadDelInTWork(pos);
  const w = WParamFromBytes(s);
  PopWParam(w);
  pos = w.GrRoot;
  if (draw) {
    const b = DriversVars.IsGraphMode;
    if (pos !== 0) DriversVars.IsGraphMode = false; // don't actually draw content of text buf
    PopScr(PushedScrFromBytes(s));
    DriversVars.IsGraphMode = b;
  }
  // {$ifdef FandGraph} pixel images chained from GrRoot: not ported
}

// PAS: OBASEWW.PAS WrHd (local of WriteWFrame)
function WrHd(Hd: string, Row: number, MaxCols: number): void {
  if (Hd === '') return;
  let s = ShortStr(' ' + Hd + ' ', 80); // ScreenStr
  if (s.length > MaxCols) s = s.slice(0, Math.max(0, MaxCols));
  GotoXY(Div(MaxCols - s.length, 2) + 2, Row);
  write(s);
}
// PAS: OBASEWW.PAS WriteWFrame
export function WriteWFrame(WFlags: number, top: string, bottom: string): void {
  if ((WFlags & WHasFrame) === 0) return;
  const { WindMin, WindMax } = DriversVars;
  let n = 0;
  if ((WFlags & WDoubleFrame) !== 0) n = 9;
  const cols = WindMax.X - WindMin.X + 1;
  const rows = WindMax.Y - WindMin.Y + 1;
  const attr = DriversVars.TextAttr;
  ScrWrFrameLn(WindMin.X, WindMin.Y, n, cols, attr);
  for (let i = 1; i <= rows - 2; i++)
    if ((WFlags & WNoClrScr) === 0) ScrWrFrameLn(WindMin.X, WindMin.Y + i, n + 6, cols, attr);
    else {
      ScrWrChar(WindMin.X, WindMin.Y + i, FrameChars[n + 6], attr);
      ScrWrChar(WindMin.X + cols - 1, WindMin.Y + i, FrameChars[n + 8], attr);
    }
  ScrWrFrameLn(WindMin.X, WindMax.Y, n + 3, cols, attr);
  WrHd(top, 1, cols - 2);
  WrHd(bottom, rows, cols - 2);
}
// PAS: OBASEWW.PAS CenterWw – 0 coordinates mean "centre"
export function CenterWw(C1: Ref<number>, R1: Ref<number>, C2: Ref<number>, R2: Ref<number>, WFlags: number): void {
  const { TxtCols, TxtRows } = BaseVars;
  let M = 0;
  if ((WFlags & WHasFrame) !== 0) M = 2;
  let Cols = C2.v + M;
  if (C1.v !== 0) Cols = C2.v - C1.v + 1;
  Cols = MaxI(M + 1, MinI(Cols, TxtCols));
  if (C1.v === 0) C1.v = Div(TxtCols - Cols, 2) + 1;
  else C1.v = MinI(C1.v, TxtCols - Cols + 1);
  C2.v = (C1.v + Cols - 1) & 0xff;
  let Rows = R2.v + M;
  if (R1.v !== 0) Rows = R2.v - R1.v + 1;
  Rows = MaxI(M + 1, MinI(Rows, TxtRows));
  if (R1.v === 0) R1.v = Div(TxtRows - Rows, 2) + 1;
  else R1.v = MinI(R1.v, TxtRows - Rows + 1);
  R2.v = (R1.v + Rows - 1) & 0xff;
  C1.v &= 0xff;
  R1.v &= 0xff;
}
// PAS: OBASEWW.PAS PushWFramed
export function PushWFramed(C1: number, R1: number, C2: number, R2: number, Attr: number, top: string, bottom: string, WFlags: number): number {
  const c1 = { v: C1 };
  const r1 = { v: R1 };
  const c2 = { v: C2 };
  const r2 = { v: R2 };
  CenterWw(c1, r1, c2, r2, WFlags);
  C1 = c1.v;
  R1 = r1.v;
  C2 = c2.v;
  R2 = r2.v;
  const { TxtCols, TxtRows } = BaseVars;
  let x = 0;
  let y = 0;
  if ((WFlags & WShadow) !== 0) {
    x = MinW(2, (TxtCols - C2) & 0xffff);
    y = MinW(1, (TxtRows - R2) & 0xffff);
  }
  const result = PushW1(C1, R1, C2 + x, R2 + y, (WFlags & WPushPixel) !== 0, true);
  CrsHide();
  const sh = BaseVars.Colors.ShadowAttr;
  if (y === 1) ScrColor(C1 + 1, R2, C2 - C1 + x - 1, sh);
  if (x > 0) for (let i = R1; i <= R2; i++) ScrColor(C2, i, x, sh);
  Window(C1, R1, C2, R2);
  DriversVars.TextAttr = Attr & 0xff;
  if ((WFlags & WHasFrame) !== 0) {
    WriteWFrame(WFlags, top, bottom);
    Window(C1 + 1, R1 + 1, C2 - 1, R2 - 1);
  }
  return result;
}

// ---------------------------------------------------------------- messages

// PAS: OBASEWW.PAS PushWrLLMsg
export function PushWrLLMsg(N: number, WithESC: boolean): number {
  const { TxtCols, TxtRows } = BaseVars;
  const zNorm = BaseVars.Colors.zNorm;
  const result = PushW(1, TxtRows, TxtCols, TxtRows);
  DriversVars.TextAttr = zNorm;
  ClrEol();
  DriversVars.TextAttr = zNorm | 0x80;
  write('  ');
  DriversVars.TextAttr = zNorm;
  if (WithESC) write('(ESC) ');
  RdMsg(N);
  const l = TxtCols - WhereX();
  if (BaseVars.MsgLine.length > l) BaseVars.MsgLine = BaseVars.MsgLine.slice(0, Math.max(0, l));
  write(BaseVars.MsgLine);
  return result;
}
// PAS: OBASEWW.PAS WrLLMsg
export function WrLLMsg(N: number): void {
  RdMsg(N);
  WrLLMsgTxt();
}
// PAS: OBASEWW.PAS WrLLMsgTxt – BaseVars.MsgLine on the last line (^W toggles lFirst)
export function WrLLMsgTxt(): void {
  const { TxtCols, TxtRows, MsgLine } = BaseVars;
  const colors = BaseVars.Colors;
  const p = PushWParam(1, TxtRows, TxtCols, TxtRows, true);
  const Buf = new Uint16Array(MaxTxtCols + 1);
  let hi = colors.lNorm;
  let On = false;
  let i = 1;
  let j = 0;
  while (i <= MsgLine.length && j < TxtCols) {
    if (MsgLine[i - 1] === '\x17') {
      if (On) {
        hi = colors.lNorm;
        On = false;
      } else {
        hi = colors.lFirst;
        On = true;
      }
    } else {
      Buf[j] = (hi << 8) | MsgLine.charCodeAt(i - 1);
      j++;
    }
    i++;
  }
  while (j < TxtCols) {
    Buf[j] = (hi << 8) | 0x20;
    j++;
  }
  ScrWrBuf(0, TxtRows - 1, Buf, TxtCols);
  PopWParam(p);
}
// PAS: OBASEWW.PAS WrLLF10MsgLine – waits for F10 (or F10SpecKey), sets KbdChar
export function WrLLF10MsgLine(): void {
  const dv = DriversVars;
  const bv = BaseVars;
  if (dv.FandBatch) {
    BatchLine(bv.MsgLine); // FPC
    dv.KbdChar = _F10_;
    bv.F10SpecKey = 0;
    return;
  }
  const { TxtCols, TxtRows } = bv;
  const zNorm = bv.Colors.zNorm;
  const Buf = new Uint16Array(MaxTxtCols);
  const row = TxtRows - 1;
  ScrRdBuf(0, row, Buf, TxtCols);
  beep();
  ScrClr(0, row, TxtCols, 1, ' ', zNorm);
  if (bv.F10SpecKey === 0xffff) ScrWrStr(0, row, '...!', zNorm | 0x80);
  else if (bv.Spec.F10Enter) ScrWrStr(0, row, '\x11\xd9 !', zNorm | 0x80);
  else ScrWrStr(0, row, 'F10!', zNorm | 0x80);
  const col = bv.MsgLine.length + 5;
  let len = 0;
  if (bv.F10SpecKey === 0xfffe || bv.F10SpecKey === _F1_) {
    bv.MsgLine = ShortStr(bv.MsgLine + ' \x10F1');
    len = 2;
  }
  if (bv.F10SpecKey === 0xfffe || bv.F10SpecKey === _ShiftF7_) {
    bv.MsgLine = ShortStr(bv.MsgLine + ' \x10ShiftF7');
    len = len + 7;
  }
  if (bv.MsgLine.length > TxtCols - 5) {
    bv.MsgLine = bv.MsgLine.slice(0, TxtCols - 5);
    len = 0;
  }
  ScrWrStr(5, row, bv.MsgLine, zNorm);
  const E = dv.Event;
  for (;;) {
    GetEvent();
    let done = false;
    if (E.What === evMouseDown) {
      if (MouseInRect(0, row, 3, 1)) {
        dv.KbdChar = _F10_;
        done = true;
      } else if (len > 0 && MouseInRect(col, row, len, 1)) {
        dv.KbdChar = bv.F10SpecKey;
        done = true;
      }
    } else if (E.What === evKeyDown) {
      const K = E.KeyCode;
      if (bv.Spec.F10Enter && K === _M_) {
        dv.KbdChar = _F10_;
        done = true;
      } else if (K === _F10_ || K === bv.F10SpecKey || bv.F10SpecKey === 0xffff
        || (bv.F10SpecKey === 0xfffe && (K === _ShiftF7_ || K === _F1_))) {
        dv.KbdChar = K;
        done = true;
      }
    }
    ClrEvent();
    if (done) break;
  }
  bv.F10SpecKey = 0;
  ScrWrBuf(0, row, Buf, TxtCols);
}
// PAS: OBASEWW.PAS WrLLF10Msg
export function WrLLF10Msg(N: number): void {
  RdMsg(N);
  WrLLF10MsgLine();
}
// PAS: OBASEWW.PAS PromptYN
export function PromptYN(NMsg: number): boolean {
  const dv = DriversVars;
  const bv = BaseVars;
  if (dv.FandBatch) {
    RdMsg(NMsg); // FPC
    BatchLine(bv.MsgLine + ' -> ' + bv.AbbrNo);
    return false;
  }
  const { TxtCols, TxtRows } = bv;
  const w = PushW(1, TxtRows, TxtCols, TxtRows);
  dv.TextAttr = bv.Colors.pTxt;
  ClrEol();
  RdMsg(NMsg);
  write(Copy(bv.MsgLine, MaxI(bv.MsgLine.length - TxtCols + 3, 1), 255));
  const col = WhereX();
  const row = WhereY();
  dv.TextAttr = bv.Colors.pNorm;
  write(' ');
  GotoXY(col, row);
  CrsShow();
  let cc: string;
  for (;;) {
    cc = UpCase(String.fromCharCode(ReadKbd() & 0xff));
    if (!(dv.KbdChar !== bv.F10SpecKey && cc !== bv.AbbrYes && cc !== bv.AbbrNo)) break;
  }
  bv.F10SpecKey = 0;
  PopW(w);
  return cc === bv.AbbrYes;
}
// PAS: OBASEWW.PAS RunError – FAND error message N, EdBreak := 3, GoExit
export function RunError(N: number): never {
  ClearKbdBuf();
  WrLLF10Msg(N);
  AccessVars.EdBreak = 3;
  GoExit();
}
// PAS: OBASEWW.PAS CFileMsg – Typ 'T'/'X' switches CPath to the .T/.X file
export function CFileMsg(n: number, typ: string): void {
  SetCPathVol();
  switch (typ) {
    case 'T':
      CExtToT();
      break;
    case 'X':
      CExtToX();
      break;
  }
  SetMsgPar(BaseVars.CPath);
  WrLLF10Msg(n);
}
// PAS: OBASEWW.PAS CFileError – CFileMsg + CloseGoExit
export function CFileError(n: number): never {
  CFileMsg(n, '0');
  CloseGoExit();
}

// ---------------------------------------------------------------- progress

// PAS: OBASEWW.PAS RunMsgD (implementation type)
class RunMsgD {
  Last: RunMsgD | null = null;
  MsgNN = 0;
  MsgStep = 0;
  MsgKum = 0;
  W = 0;
}
let CM: RunMsgD | null = null;

// PAS: OBASEWW.PAS RunMsgOn
export function RunMsgOn(C: string, N: number): void {
  const CM1 = new RunMsgD();
  CM1.Last = CM;
  CM = CM1;
  CM.MsgStep = Math.trunc(N / 100);
  if (CM.MsgStep === 0) CM.MsgStep = 1;
  CM.MsgKum = CM.MsgStep;
  CM.MsgNN = N;
  CM.W = PushW1(1, BaseVars.TxtRows, 8, BaseVars.TxtRows, true, true);
  DriversVars.TextAttr = BaseVars.Colors.zNorm;
  write('\x10', C);
  if (N === 0) write('    \x11');
  else write('  0%\x11');
}
// PAS: OBASEWW.PAS RunMsgN
export function RunMsgN(N: number): void {
  const cm = CM!;
  if (N < cm.MsgKum) return;
  while (N >= cm.MsgKum) cm.MsgKum += cm.MsgStep;
  const Perc = Div(N * 100, cm.MsgNN) & 0xffff;
  GotoXY(3, 1);
  write(StrI(Perc, 3));
}
// PAS: OBASEWW.PAS RunMsgOff
export function RunMsgOff(): void {
  if (CM === null) return;
  PopW(CM.W);
  CM = CM.Last;
}
// PAS: OBASEWW.PAS RunMsgClear
export function RunMsgClear(): void {
  CM = null;
}
