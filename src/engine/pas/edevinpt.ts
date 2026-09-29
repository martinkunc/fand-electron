// PAS: EDEVINPT.PAS – include of EDEVENT, nested in HandleEvent: MyGetEvent reads the next event
// and pre-processes it: Ctrl/Shift/Alt last lines (CtrlShiftAlt), Scroll Lock switching
// (ScrollPress; FPC: the BIOS bit is not read, fyz = false), two-key WordStar prefixes (^Q ^K ^O ^P
// shown with Wr), and mode-specific filtering in Scroll (ScrollEvent), View (ViewEvent) and Help
// (HelpEvent).
//
// Porting notes:
// * State: EvFrame (edevent.ts), EdFrame (ededit.ts), EdPriv/EditorVars (editor.ts).
// * `OrigS: string[4]` is a typed constant (saved last-line characters) - module-level state.
// * MyGetEvent's result is not assigned for the frame modes (SinFM..NotFM) in Pascal; frame drawing
//   relies on it being non-zero, so it is true here.

import { chr, UpCase, fref } from './pasrt.ts';
import { BaseVars, CsKbd, SlKbd, MaxL } from './base.ts';
import {
  DriversVars, evKeyDown, evMouseDown, WaitEvent, GetEvent, ClrEvent, AddCtrlAltShift, CrsHide, CrsBig, CrsNorm,
  ScrRdBuf, ScrWrStr, _ESC_, _left_, _right_, _up_, _down_, _PgUp_, _PgDn_, _CtrlPgUp_, _CtrlPgDn_, _CtrlF5_,
  _AltF8_, _L_, _F7_, _F8_, _Home_, _End_, _CtrlLeft_, _CtrlRight_, _Z_, _W_, _CtrlF6_, _CtrlF3_, _M_, _S_, _D_,
  _E_, _X_, _R_, _C_, _A_, _F_, _V_, _P_, _Q_, _K_, _O_, _Y_, _B_, _I_, _H_, _N_, _U_, _J_, _Ins_,
} from './drivers.ts';
import { TestExitKey } from './rdrun.ts';
import {
  EdPriv, HelpM, ViewM, TextM, SinFM, DouFM, DelFM, NotFM, _QF_, _KP_, _QB_, _QK_, _QX_, _QE_, _KW_, _KB_, _KK_,
} from './editor.ts';
import { SetColorOrd, SimplePrintHead } from './edglobal.ts';
import {
  EdFrame, LineAbs, TestKod, SetPart, DekFindLine, NewRL, Column, PosDekFindLine,
} from './ededit.ts';
import { WrStatusLine, WrLLMargMsg, Background } from './edscreen.ts';

// PAS: EDEVINPT.PAS MyGetEvent.CtrlShiftAlt.ScrollPress (nested)
function ScrollPress(): void {
  const P = EdPriv;
  const F = EdFrame;
  const old = F.Scroll;
  const fyz = false; // FPC: the Scroll Lock bit 0:$417 is not read
  if (fyz === old) F.FirstScroll = false;
  F.Scroll = (fyz || F.FirstScroll) && P.Mode !== HelpM;
  F.HelpScroll = F.Scroll || P.Mode === HelpM;
  const L1 = LineAbs(F.ScrL);
  if (old !== F.Scroll) {
    if (F.Scroll) {
      WrStatusLine();
      TestKod();
      CrsHide();
      F.PredScLn = LineAbs(F.LineL);
      F.PredScPos = P.Posi;
      if (P.UpdPHead) {
        SetPart(1);
        SimplePrintHead();
        DekFindLine(MaxL(L1, P.PHNum + 1));
      } else DekFindLine(MaxL(L1, P.PHNum + 1));
      F.ScrL = F.LineL;
      F.RScrL = NewRL(F.ScrL);
      if (L1 !== LineAbs(F.ScrL)) F.ChangeScr = true;
      F.BCol = Column(P.BPos);
      F.Colu = Column(P.Posi);
      F.ColScr = P.Part.ColorP;
      SetColorOrd(fref(F, 'ColScr'), 1, P.ScrI);
    } else {
      if (F.PredScLn < L1 || F.PredScLn >= L1 + F.PageS) F.PredScLn = L1;
      if (!(F.PredScPos >= P.BPos + 1 && F.PredScPos <= P.BPos + F.LineS)) F.PredScPos = P.BPos + 1;
      PosDekFindLine(F.PredScLn, F.PredScPos, false);
      if (P.Mode === ViewM || P.Mode === SinFM || P.Mode === DouFM || P.Mode === DelFM || P.Mode === NotFM) CrsBig();
      else CrsNorm();
    }
    Background();
  }
}

// PAS: EDEVINPT.PAS MyGetEvent.CtrlShiftAlt.DisplLL (nested)
function DisplLL(Flags: number): void {
  const P = EdPriv;
  if ((Flags & 0x04) !== 0) WrLLMargMsg(P.CtrlLastS, P.CtrlLastNr); // Ctrl
  else if ((Flags & 0x03) !== 0) WrLLMargMsg(P.ShiftLastS, 0); // Shift
  else if ((Flags & 0x08) !== 0) WrLLMargMsg(P.AltLastS, 0); // Alt
}

// PAS: EDEVINPT.PAS MyGetEvent.CtrlShiftAlt (nested)
function CtrlShiftAlt(): void {
  const P = EdPriv;
  const F = EdFrame;
  const dv = DriversVars;
  let Ctrl = false;
  let Delta = 0;
  let flgs = 0;
  for (;;) {
    // 1:
    WaitEvent(Delta);
    if (P.Mode !== HelpM) ScrollPress();
    if (dv.LLKeyFlags !== 0) {
      // mouse
      flgs = dv.LLKeyFlags;
      DisplLL(dv.LLKeyFlags);
      Ctrl = true;
    } else if ((dv.KbdFlgs & 0x0f) !== 0) {
      // Ctrl Shift Alt pressed
      if (!Ctrl) {
        if (Delta > 0) {
          flgs = dv.KbdFlgs;
          DisplLL(dv.KbdFlgs);
          Ctrl = true;
        } else Delta = BaseVars.Spec.CtrlDelay;
      }
    } else if (Ctrl) {
      flgs = 0;
      WrLLMargMsg(P.LastS, P.LastNr);
      Ctrl = false;
      Delta = 0;
    }
    const w = dv.Event.What;
    if (!(w === evKeyDown || w === evMouseDown)) {
      ClrEvent();
      if (!F.IsWrScreen) Background();
      continue;
    }
    break;
  }
  if (flgs !== 0) {
    dv.LLKeyFlags = 0;
    WrLLMargMsg(P.LastS, P.LastNr);
    AddCtrlAltShift(flgs);
  }
}

// typed constant OrigS: string[4] = '    '
let OrigS = '    ';

// PAS: EDEVINPT.PAS MyGetEvent.Wr (nested)
function Wr(s: string): void {
  const P = EdPriv;
  if (P.Mode !== HelpM) {
    if (s === '') s = OrigS;
    else {
      const b = new Uint16Array(2);
      ScrRdBuf(0, 0, b, 2); // OrigS[1..4] = char, attr, char, attr; OrigS[2] := OrigS[3]; length 2
      OrigS = chr(b[0] & 0xff) + chr(b[1] & 0xff);
    }
    ScrWrStr(0, 0, s, P.SysLColor);
  }
}

// PAS: EDEVINPT.PAS MyGetEvent.My2GetEvent (nested)
function My2GetEvent(): boolean {
  const E = DriversVars.Event;
  ClrEvent();
  GetEvent();
  if (E.What !== evKeyDown) {
    ClrEvent();
    return false;
  }
  const u = UpCase(chr(E.KeyCode)).charCodeAt(0);
  if (u >= 0x41 && u <= 0x5a) {
    E.KeyCode = u - 0x40;
    const kt = BaseVars.Spec.KbdTyp;
    if ((E.KeyCode === _Y_ || E.KeyCode === _Z_) && (kt === CsKbd || kt === SlKbd)) {
      if (E.KeyCode === _Z_) E.KeyCode = _Y_;
      else E.KeyCode = _Z_;
    }
  }
  return true;
}

// PAS: EDEVINPT.PAS MyGetEvent.ScrollEvent (nested)
function ScrollEvent(): boolean {
  const P = EdPriv;
  const E = DriversVars.Event;
  if (E.What !== evKeyDown) return false;
  switch (E.KeyCode) {
    case _ESC_:
    case _left_:
    case _right_:
    case _up_:
    case _down_:
    case _PgUp_:
    case _PgDn_:
    case _CtrlPgUp_:
    case _CtrlPgDn_:
    case _CtrlF5_:
    case _AltF8_:
      return true;
  }
  if ((E.KeyCode & 0xff) === 0 && P.Breaks.indexOf(chr(E.KeyCode >> 8)) >= 0) return true;
  let X = P.ExitD;
  while (X !== null) {
    if (TestExitKey(E.KeyCode, X)) return true;
    X = X.Chain;
  }
  return false;
}

// PAS: EDEVINPT.PAS MyGetEvent.ViewEvent (nested)
function ViewEvent(): boolean {
  const E = DriversVars.Event;
  let result = ScrollEvent();
  if (E.What !== evKeyDown) return result;
  switch (E.KeyCode) {
    case _QF_:
    case _L_:
    case _F7_:
    case _F8_:
    case _KP_:
    case _QB_:
    case _QK_:
    case _CtrlF5_:
    case _AltF8_:
    case _CtrlF3_:
    case _Home_:
    case _End_:
    case _CtrlLeft_:
    case _CtrlRight_:
    case _QX_:
    case _QE_:
    case _Z_:
    case _W_:
    case _CtrlF6_:
    case _KW_:
    case _KB_:
    case _KK_:
      result = true;
  }
  return result;
}

// PAS: EDEVINPT.PAS MyGetEvent.HelpEvent (nested)
function HelpEvent(): boolean {
  const P = EdPriv;
  const E = DriversVars.Event;
  let result = false;
  if (E.What === evKeyDown) {
    switch (E.KeyCode) {
      case _ESC_:
      case _left_:
      case _right_:
      case _up_:
      case _down_:
      case _PgDn_:
      case _PgUp_:
      case _M_:
        result = true;
        break;
      default:
        if ((E.KeyCode & 0xff) === 0 && P.Breaks.indexOf(chr(E.KeyCode >> 8)) >= 0) result = true;
    }
  }
  if (E.What === evMouseDown) result = true;
  return result;
}

/** TS-only: Event.KeyCode re-read after a call (defeats TS narrowing of the switch). */
function KeyCodeOf(): number {
  return DriversVars.Event.KeyCode;
}

// PAS: EDEVINPT.PAS MyGetEvent – nested in HandleEvent
export function MyGetEvent(): boolean {
  const P = EdPriv;
  const F = EdFrame;
  const E = DriversVars.Event;
  CtrlShiftAlt();
  // key recoding
  GetEvent();
  if (E.What === evKeyDown) {
    let ww: number;
    switch (E.KeyCode) {
      case _S_:
        E.KeyCode = _left_;
        break;
      case _D_:
        E.KeyCode = _right_;
        break;
      case _E_:
        E.KeyCode = _up_;
        break;
      case _X_:
        E.KeyCode = _down_;
        break;
      case _R_:
        E.KeyCode = _PgUp_;
        break;
      case _C_:
        E.KeyCode = _PgDn_;
        break;
      case _A_:
        E.KeyCode = _CtrlLeft_;
        break;
      case _F_:
        E.KeyCode = _CtrlRight_;
        break;
      case _V_:
        E.KeyCode = _Ins_;
        break;
      case _P_:
        Wr('^P');
        ww = E.KeyCode;
        if (My2GetEvent()) {
          Wr('');
          if (KeyCodeOf() <= 0x31) E.KeyCode = (ww << 8) | E.KeyCode;
        }
        break;
      case _Q_:
        Wr('^Q');
        ww = E.KeyCode;
        if (My2GetEvent()) {
          Wr('');
          switch (KeyCodeOf()) {
            case _S_:
              E.KeyCode = _Home_;
              break;
            case _D_:
              E.KeyCode = _End_;
              break;
            case _R_:
              E.KeyCode = _CtrlPgUp_;
              break;
            case _C_:
              E.KeyCode = _CtrlPgDn_;
              break;
            case _E_:
            case _X_:
            case _Y_:
            case _L_:
            case _B_:
            case _K_:
            case _I_:
            case _F_:
            case _A_:
            case 0x2d: // -
            case 0x2f: // /
            case 0x3d: // =
              E.KeyCode = (ww << 8) | E.KeyCode;
              break;
            default:
              E.KeyCode = 0;
          }
        }
        break;
      case _K_:
        Wr('^K');
        ww = E.KeyCode;
        if (My2GetEvent()) {
          Wr('');
          const k = KeyCodeOf();
          if (k === _B_ || k === _K_ || k === _H_ || k === _S_ || k === _Y_ || k === _C_ || k === _V_ || k === _W_ ||
            k === _R_ || k === _P_ || k === _F_ || k === _U_ || k === _L_ || k === _N_) E.KeyCode = (ww << 8) | k;
          else E.KeyCode = 0;
        }
        break;
      case _O_:
        Wr('^O');
        ww = E.KeyCode;
        if (My2GetEvent()) {
          Wr('');
          const k = KeyCodeOf();
          if (k === _W_ || k === _R_ || k === _L_ || k === _J_ || k === _C_) E.KeyCode = (ww << 8) | k;
          else E.KeyCode = 0;
        }
        break;
    }
  }
  // mode test
  switch (P.Mode) {
    case HelpM:
      return HelpEvent();
    case ViewM:
      return F.Scroll ? ScrollEvent() : ViewEvent();
    case TextM:
      return F.Scroll ? ScrollEvent() : true;
  }
  return true; // frame modes: not assigned in Pascal (see the notes)
}
