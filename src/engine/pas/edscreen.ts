// PAS: EDSCREEN.PAS – include of EDEDIT, nested in Edit: status line (WrStatusLine, UpdStatLine
// with Row:Col and the Ins/Ind/Wrap/Just/Block flags), margins ruler, last-line messages
// (WrLLMargMsg), InitScr (window from the WRect / MinC..MaxR), line output with colour control
// chars (EditWrline) and in Scroll/View mode with graphic control chars (ScrollWrline, GrafCtrl),
// UpdScreen (redraw changed lines, WrEndL end-of-line marks), Background (idle redraw/testing
// events via MyTestEvent).
//
// Porting notes:
// * State: EdFrame (ededit.ts) + EdPriv/EditorVars (editor.ts). All routines are nested in Edit.
// * `Newvalue`/`Nv: array[1..2] of byte absolute` builds screen words (char, attr) -> Uint16Array
//   cells (lo = CP852 char, hi = attr) written with DRIVERS.ScrWrBuf. The line buffers are larger
//   than Pascal's 255 words (BPos+LineS may pass them; Pascal writes into the stack there).
// * UpdStatLine: `st: string[10]` with `len absolute` overlays - plain strings.
// * ScrollWrline: a ^L inside a Scroll line with InsPg off loops forever in Pascal (I is decremented
//   and incremented again); TS skips the ^L instead.

import { fref, StrI, Pos, Copy, ShortStr, type Ref } from './pasrt.ts';
import type { StringPtr } from './base.ts';
import { BaseVars, MinI, MaxI, MaxW } from './base.ts';
import {
  DriversVars, ScrWrStr, ScrWrBuf, ScrRdBuf, Window, GotoXY, TestEvent,
} from './drivers.ts';
import { WrLLMsg, WrLLMsgTxt } from './obaseww.ts';
import {
  EdPriv, EditorVars, Tg, LineSize, TStatL, CtrlKey, ColBlock, TextBlock, TextM, ViewM, HelpM, SinFM, DouFM, DelFM,
  type ColorOrd,
} from './editor.ts';
import { FindChar, SetColorOrd } from './edglobal.ts';
import {
  EdFrame, ShortName, LineInBlock, LineBndBlock, LineAbs, DekodLine, FindLine, NextPartDek, ModPage, Column,
  Position, type ArrPtr,
} from './ededit.ts';

const CR = 0x0d;
const LF = 0x0a;

// PAS: EDSCREEN.PAS WrStatusLine – nested in Edit
export function WrStatusLine(): void {
  const P = EdPriv;
  const TxtCols = BaseVars.TxtCols;
  if (P.Mode === HelpM) return;
  const Blanks = new Uint8Array(257); // string: Blanks[i] = Blanks[i]
  Blanks.fill(0x20, 1, TxtCols + 1);
  const Len = TxtCols;
  if (P.HeadS !== null) {
    const h = P.HeadS;
    for (let k = 0; k < h.length && k + 1 < 257; k++) Blanks[k + 1] = h.charCodeAt(k);
    let i = 0;
    for (let k = 1; k <= Len; k++)
      if (Blanks[k] === 0x5f /* _ */) {
        i = k;
        break;
      }
    if (i === 0) {
      Blanks.copyWithin(TStatL + 3, 1, 1 + 252 - TStatL);
      Blanks.fill(0x20, 1, TStatL + 3);
    } else {
      while (i <= Len && Blanks[i] === 0x5f) {
        Blanks[i] = 0x20;
        i++;
      }
    }
  } else {
    const s = ShortName(P.NameT);
    let i = TStatL + 3; // free
    if (s.length + i >= TxtCols) i = TxtCols - s.length - 2;
    for (let k = 0; k < s.length; k++) if (i + k >= 1 && i + k < 257) Blanks[i + k] = s.charCodeAt(k);
  }
  let str = '';
  for (let k = 1; k <= Len; k++) str += String.fromCharCode(Blanks[k]);
  ScrWrStr(0, 0, str, P.SysLColor);
}

// PAS: EDSCREEN.PAS WriteMargins – nested in Edit
export function WriteMargins(): void {
  const P = EdPriv;
  const F = EdFrame;
  if (P.Mode !== HelpM && P.Mode !== ViewM && EditorVars.Wrap) {
    const LastL = new Uint16Array(260); // array[0..200] of word (+ spare)
    const TxtRows = BaseVars.TxtRows;
    ScrRdBuf(F.FirstC - 1, TxtRows - 1, LastL.subarray(1), F.LineS);
    const M = F.MargLL;
    LastL[M[1]] = M[2];
    LastL[M[3]] = M[4];
    M[1] = MaxI(0, P.LeftMarg - P.BPos);
    if (M[1] > 0) {
      M[2] = LastL[M[1]];
      LastL[M[1]] = (LastL[F.LineS] & 0xff00) + 0x10;
    }
    M[3] = MaxI(0, P.RightMarg - P.BPos);
    if (M[3] > 0) {
      M[4] = LastL[M[3]];
      LastL[M[3]] = (LastL[F.LineS] & 0xff00) + 0x11;
    }
    ScrWrBuf(F.FirstC - 1, TxtRows - 1, LastL.subarray(1), F.LineS);
  }
}

// PAS: EDSCREEN.PAS WrLLMargMsg – nested in Edit
export function WrLLMargMsg(s: StringPtr, n: number): void {
  const P = EdPriv;
  const bv = BaseVars;
  if (s !== null) {
    bv.MsgLine = s;
    WrLLMsgTxt();
  } else if (n !== 0) WrLLMsg(n);
  else if (P.LastS !== null) {
    bv.MsgLine = P.LastS;
    WrLLMsgTxt();
  } else WrLLMsg(P.LastNr);
  if (P.Mode === TextM) WriteMargins();
}

// PAS: EDSCREEN.PAS InitScr – nested in Edit
export function InitScr(): void {
  const P = EdPriv;
  const F = EdFrame;
  const dv = DriversVars;
  F.FirstR = dv.WindMin.Y + 1;
  F.FirstC = dv.WindMin.X + 1;
  F.LastR = dv.WindMax.Y + 1;
  F.LastC = dv.WindMax.X + 1;
  if (F.FirstR === 1 && P.Mode !== HelpM) F.FirstR++;
  if (F.LastR === BaseVars.TxtRows) F.LastR--;
  F.MinC = F.FirstC;
  F.MinR = F.FirstR;
  F.MaxC = F.LastC;
  F.MaxR = F.LastR;
  Window(F.FirstC, F.FirstR, F.LastC, F.LastR);
  F.FirstR--;
  if (P.Mode !== HelpM && P.Mode !== ViewM && EditorVars.Wrap) F.LastC--;
  F.PageS = F.LastR - F.FirstR;
  F.LineS = F.LastC - F.FirstC + 1;
}

/** TS-only: move(s[1], StatLine[at], n) on a byte string of fixed length (bytes past s: #0). */
function PutStr(line: string, at: number, s: string, n: number): string {
  let src = s;
  while (src.length < n) src += '\0';
  return (line.slice(0, at - 1) + src.slice(0, n) + line.slice(at - 1 + n)).slice(0, line.length);
}

// PAS: EDSCREEN.PAS UpdStatLine – nested in Edit
export function UpdStatLine(Row: number, Col: number): void {
  const P = EdPriv;
  const F = EdFrame;
  const ev = EditorVars;
  if (F.HelpScroll) return;
  const lRow = Row + P.Part.LineP;
  let StatLine = ShortStr('     1:                             ', 35);
  StatLine = PutStr(StatLine, 2, StrI(lRow, 5), 5);
  let st = StrI(Col);
  while (st.length < 4) st += ' ';
  StatLine = PutStr(StatLine, 8, st, 4);
  switch (P.Mode) {
    case TextM:
      if (ev.Insert) StatLine = PutStr(StatLine, 11, P.InsMsg, 5);
      else StatLine = PutStr(StatLine, 11, P.nInsMsg, 5);
      if (ev.Indent) StatLine = PutStr(StatLine, 16, P.IndMsg, 5);
      if (ev.Wrap) StatLine = PutStr(StatLine, 21, P.WrapMsg, 5);
      if (ev.Just) StatLine = PutStr(StatLine, 26, P.JustMsg, 5);
      if (P.TypeB === ColBlock) StatLine = PutStr(StatLine, 31, P.BlockMsg, 5);
      break;
    case ViewM:
      StatLine = PutStr(StatLine, 11, P.ViewMsg, P.ViewMsg.length);
      break;
    case SinFM:
      StatLine = PutStr(StatLine, 13, '-', 1);
      break;
    case DouFM:
      StatLine = PutStr(StatLine, 13, '=', 1);
      break;
    case DelFM:
      StatLine = PutStr(StatLine, 13, '/', 1);
      break;
  }
  let i = 1;
  const TxtCols = BaseVars.TxtCols;
  if (P.HeadS !== null) {
    i = MaxW(1, Pos('_', P.HeadS));
    if (i > TxtCols - TStatL) i = MaxI(TxtCols - TStatL, 1);
  }
  ScrWrStr(i - 1, 0, StatLine, P.SysLColor);
}

/** TS-only: P^[I] of an ArrPtr view (beyond the view: 0). */
function At(p: ArrPtr, i: number): number {
  return p[i - 1] ?? 0;
}

// PAS: EDSCREEN.PAS EditWrline – nested in Edit
export function EditWrline(P: ArrPtr, Row: number): void {
  const E = EdPriv;
  const F = EdFrame;
  const BuffLine = new Uint16Array(520); // array[1..255] of word (+ spare)
  const Line = F.ScrL + Row - 1;
  const attr = LineInBlock(Line) && E.TypeB === TextBlock ? E.BlockColor : E.TxtColor;
  let I = 1;
  let IsCtrl = false;
  while (At(P, I) !== CR && I <= LineSize) {
    const c = At(P, I);
    BuffLine[I] = c | (attr << 8);
    if (c < 32) IsCtrl = true;
    I++;
  }
  const LP = I - 1;
  for (I = LP + 1; I <= E.BPos + F.LineS; I++) BuffLine[I] = 0x20 | (attr << 8);
  if (E.BegBLn <= E.EndBLn) {
    if (LineBndBlock(Line) || (E.TypeB === ColBlock && LineInBlock(Line))) {
      const B = E.BegBLn === LineAbs(Line) || E.TypeB === ColBlock ? MinI(E.BegBPos, F.LineS + E.BPos + 1) : 1;
      const EE = E.EndBLn === LineAbs(Line) || E.TypeB === ColBlock ? MinI(E.EndBPos, F.LineS + E.BPos + 1)
        : F.LineS + E.BPos + 1;
      for (I = B; I <= EE - 1; I++) BuffLine[I] = (BuffLine[I] & 0xff) + (E.BlockColor << 8);
    }
  }
  if (IsCtrl) {
    for (I = E.BPos + 1; I <= LP; I++) {
      const c = At(P, I);
      if (c < 32) BuffLine[I] = ((c + 64) & 0xff) + (E.ColKey[Pos(String.fromCharCode(c), CtrlKey)] << 8);
    }
  }
  const dv = DriversVars;
  ScrWrBuf(dv.WindMin.X, dv.WindMin.Y + Row - 1, BuffLine.subarray(E.BPos + 1), F.LineS);
}

const GrafCtrl = '\x03\x06\x09\x0b\x0f\x10\x12\x15\x16\x18\x19\x1a\x1d\x1e\x1f';

// PAS: EDSCREEN.PAS ScrollWrline – nested in Edit
export function ScrollWrline(P: ArrPtr, Row: number, CO: Ref<ColorOrd>): void {
  const E = EdPriv;
  const F = EdFrame;
  // PAS: ScrollWrline.Color (nested)
  const Color = (): number => (CO.v === '' ? E.TxtColor : E.ColKey[Pos(CO.v[CO.v.length - 1], CtrlKey)]);
  const BuffLine = new Uint16Array(520);
  let Col = Color();
  let I = 1;
  let J = 1;
  let IsCtrl = false;
  let cc = At(P, I);
  const isGraf = (c: number): boolean => GrafCtrl.indexOf(String.fromCharCode(c)) >= 0;
  const isCtrlKey = (c: number): boolean => CtrlKey.indexOf(String.fromCharCode(c)) >= 0;
  while (cc !== CR && I <= LineSize && !F.InsPage) {
    if (cc >= 32 || isGraf(cc)) {
      BuffLine[J] = cc | (Col << 8);
      J++;
    } else if (isCtrlKey(cc)) IsCtrl = true;
    else if (F.Scroll && cc === 0x0c) {
      F.InsPage = E.InsPg;
      if (F.InsPage) I--; // TS: without InsPg Pascal loops here forever; skip the ^L
    }
    I++;
    cc = At(P, I);
  }
  const LP = I - 1;
  while (J <= F.BCol + F.LineS) {
    BuffLine[J] = 0x20 | (Col << 8);
    J++;
  }
  if (IsCtrl) {
    I = 1;
    J = 1;
    while (I <= LP) {
      cc = At(P, I);
      if (cc >= 32 || isGraf(cc)) {
        BuffLine[J] = (BuffLine[J] & 0xff) + (Col << 8);
        J++;
      } else if (isCtrlKey(cc)) {
        const ch = String.fromCharCode(cc);
        const pp = Pos(ch, CO.v);
        if (pp > 0) CO.v = Copy(CO.v, 1, pp - 1) + Copy(CO.v, pp + 1, CO.v.length - pp);
        else CO.v = (CO.v + ch).slice(0, 7);
        Col = Color();
      } else if (cc === 0x0c) BuffLine[J] = 219 + (Col << 8);
      I++;
    }
    while (J <= F.BCol + F.LineS) {
      BuffLine[J] = (BuffLine[J] & 0xff) + (Col << 8);
      J++;
    }
  }
  const dv = DriversVars;
  ScrWrBuf(dv.WindMin.X, dv.WindMin.Y + Row - 1, BuffLine.subarray(F.BCol + 1), F.LineS);
}

// PAS: EDSCREEN.PAS MyTestEvent – nested in Edit
export function MyTestEvent(): boolean {
  if (EdPriv.FirstEvent) return false;
  return TestEvent();
}

// PAS: EDSCREEN.PAS UpdScreen.WrEndL (nested)
function WrEndL(Hard: boolean, Row: number): void {
  const P = EdPriv;
  const F = EdFrame;
  if (P.Mode !== HelpM && P.Mode !== ViewM && EditorVars.Wrap) {
    const w = Hard ? 0x11 + (P.TxtColor << 8) : 32 + (P.TxtColor << 8);
    const dv = DriversVars;
    ScrWrBuf(dv.WindMin.X + F.LineS, dv.WindMin.Y + Row - 1, Uint16Array.of(w), 1);
  }
}

// PAS: EDSCREEN.PAS UpdScreen – nested in Edit
export function UpdScreen(): void {
  const P = EdPriv;
  const F = EdFrame;
  const Arr = F.Arr;
  F.InsPage = false;
  if (F.ChangeScr) {
    if (P.ChangePart) DekodLine();
    F.ChangeScr = false;
    if (F.Scroll) P.ScrI = P.LineI;
    else P.ScrI = FindLine(fref(F, 'ScrL'));
    if (F.HelpScroll) {
      F.ColScr = P.Part.ColorP;
      SetColorOrd(fref(F, 'ColScr'), 1, P.ScrI);
    }
  }
  const co1 = { v: '' as ColorOrd };
  let PgStr: Uint8Array | null = null;
  if (F.Scroll) {
    // current line
    PgStr = new Uint8Array(256).fill(P.CharPg.charCodeAt(0)); // PgStr[1..255]
    co1.v = F.ColScr;
    let r = 1;
    while (Arr[r] === 0x0c) r++;
    ScrollWrline(Arr.subarray(r), 1, co1);
  } else if (P.Mode === HelpM) {
    co1.v = P.Part.ColorP;
    SetColorOrd(co1, 1, P.LineI);
    ScrollWrline(Arr.subarray(1), F.LineL - F.ScrL + 1, co1);
  } else EditWrline(Arr.subarray(1), F.LineL - F.ScrL + 1);
  WrEndL(F.HardL, F.LineL - F.ScrL + 1);
  if (MyTestEvent()) return;
  let Ind = P.ScrI;
  let r = 1;
  let rr = 0;
  const w = { v: 1 };
  F.InsPage = false;
  const co2 = { v: F.ColScr };
  if (F.Scroll) while (Tg(Ind) === 0x0c) Ind++;
  do {
    // whole window
    if (MyTestEvent()) return;
    body: {
      if (Ind >= P.LenT && !P.AllRd) {
        NextPartDek();
        Ind -= P.Part.MovI;
      }
      if (F.Scroll && Ind < P.LenT) {
        if ((P.InsPg && ModPage(r - rr + F.RScrL - 1)) || F.InsPage) {
          EditWrline(PgStr ?? new Uint8Array(256).fill(P.CharPg.charCodeAt(0)), r);
          WrEndL(false, r);
          if (F.InsPage) rr++;
          F.InsPage = false;
          break body;
        }
      }
      if (!F.Scroll && Ind === P.LineI) {
        Ind = F.NextI;
        co2.v = co1.v;
        break body;
      }
      if (Ind < P.LenT) {
        if (F.HelpScroll) ScrollWrline(P.T!.subarray(Ind - 1), r, co2);
        else EditWrline(P.T!.subarray(Ind - 1), r);
        if (F.InsPage) Ind = FindChar(w, '\x0c', Ind, P.LenT) + 1;
        else Ind = FindChar(w, '\r', Ind, P.LenT) + 1;
        WrEndL(Ind < P.LenT && Tg(Ind) === LF, r);
        if (Tg(Ind) === LF) Ind++;
      } else {
        EditWrline(P.T!.subarray(P.LenT - 1), r);
        WrEndL(false, r);
      }
    }
    // 1:
    r++;
    if (F.Scroll && Tg(Ind) === 0x0c) {
      F.InsPage = P.InsPg;
      Ind++;
    }
  } while (!(r > F.PageS));
}

// PAS: EDSCREEN.PAS Background – nested in Edit
export function Background(): void {
  const P = EdPriv;
  const F = EdFrame;
  UpdStatLine(F.LineL, P.Posi);
  if (MyTestEvent()) return;
  if (F.HelpScroll) {
    let p = P.Posi;
    if (P.Mode === HelpM) if (F.WordL === F.LineL) while (F.Arr[p + 1] !== 0x11 && p < LineSize) p++;
    if (Column(p) - F.BCol > F.LineS) {
      F.BCol = Column(p) - F.LineS;
      P.BPos = Position(F.BCol);
    }
    if (Column(P.Posi) <= F.BCol) {
      F.BCol = Column(P.Posi) - 1;
      P.BPos = Position(F.BCol);
    }
  } else {
    if (P.Posi > F.LineS) if (P.Posi > P.BPos + F.LineS) P.BPos = P.Posi - F.LineS;
    if (P.Posi <= P.BPos) P.BPos = P.Posi - 1;
  }
  if (F.LineL < F.ScrL) {
    F.ScrL = F.LineL;
    F.ChangeScr = true;
  }
  if (F.LineL >= F.ScrL + F.PageS) {
    F.ScrL = F.LineL - F.PageS + 1;
    F.ChangeScr = true;
  }
  UpdScreen(); // print the screen
  WriteMargins();
  GotoXY(P.Posi - P.BPos, F.LineL - F.ScrL + 1);
  F.IsWrScreen = true;
}
