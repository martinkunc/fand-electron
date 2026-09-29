// PAS: EDEVENT.PAS – include of EDEDIT, nested in Edit: HandleEvent, one editor command per call
// (keys, mouse, exit keys EdExitD, WordStar two-key commands, block commands, find/replace,
// frames, formatting, Calculate (Ctrl+F5), Alt+F8 keyboard menu...). It includes EDEVINPT
// (MyGetEvent) and EDEVPROC (the command procedures), nested in HandleEvent.
//
// Porting notes:
// * State: EdFrame (ededit.ts), EdPriv/EditorVars (editor.ts) and HandleEvent's own locals in
//   EvFrame below (used by the nested EDEVINPT/EDEVPROC routines; Edit saves/restores EvFrame).
// * NewExit around the command (label Opet): a GoExit in the command (Calculate, a RunError of
//   TestLenText...) runs the Opet code (window + SetScreen) and ends the command. While an exit
//   procedure runs, the NewExit is not armed (RestoreExit before, NewExit after), so its GoExit
//   goes to the outer handler: `armed` below. The `goto Nic` exits are returns of KeyDown.
// * FPC: Ctrl-key range $1001..$101F inserts the control char (BP7 $1000..$101F, where $1000 is
//   also the Opet label; in FPC key $1000 = ^P^@ runs the Opet code).

import { ref, chr, ord, fref, ValI, StrI, type Ref, GoExitSignal } from './pasrt.ts';
import type { LongStrPtr } from './base.ts';
import {
  BaseVars, MinI, MinW, ExitRecord, NewExit, RestoreExit, OpenH, CloseH, SeekH, ReadH, FileSizeH,
  _isnewfile, _isoverwritefile, _isoldfile, Exclusive, RdOnly, StoreAvail, SetMsgPar, TruncH, PosH, type TKbdConv,
} from './base.ts';
import { AccessVars, StoreInTWork, _LongS } from './access.ts';
import type { EdExitDPtr } from './rdrun.ts';
import { RdRunVars, TestExitKey } from './rdrun.ts';
import {
  DriversVars, evKeyDown, evMouseDown, ClrEvent, CrsHide, CrsShow, CrsBig, Window, GotoXY, ClrEol, ScrRdBuf,
  ScrWrBuf, ToggleCS, _left_, _right_, _up_, _down_, _PgUp_, _PgDn_, _CtrlLeft_, _CtrlRight_, _Z_, _W_, _Home_,
  _End_, _CtrlPgUp_, _CtrlPgDn_, _CtrlF3_, _M_, _N_, _Ins_, _Del_, _G_, _H_, _Y_, _T_, _L_, _I_, _J_, _B_, _F4_,
  _F7_, _F8_, _CtrlF7_, _ShiftF7_, _CtrlF5_, _AltF8_, _CtrlF6_, _U_, _ESC_, _AltEqual_,
} from './drivers.ts';
import { PromptYN, WrLLF10Msg } from './obaseww.ts';
import { SelectDiskFile } from './wwmix.ts';
import { Menu } from './wwmenu.ts';
import { StartExit, UpdateEdTFld, RunEdiVars } from './runedi.ts';
import { CallProcedure } from './runproc.ts';
import {
  EdPriv, EditorVars, Tg, Ts, IsOddel, SavePar, RestorePar, TxtBuf, Ovr, LineSize, TextBlock, ColBlock, FileT,
  LocalT, MemoT, HelpM, ViewM, TextM, SinFM, DouFM, DelFM, NotFM, _QY_, _QL_, _QK_, _QB_, _QI_, _QF_, _QE_, _QX_,
  _QA_, _framesingle_, _framedouble_, _delframe_, _KB_, _KK_, _KH_, _KY_, _KC_, _KV_, _KW_, _KR_, _KP_, _KN_,
  _KU_, _KL_, _OW_, _OL_, _OR_, _OJ_, _OC_, _KF_,
} from './editor.ts';
import { FindChar, TestOptStr, MyWrLLMsg, HMsgExit, SimplePrintHead } from './edglobal.ts';
import { OpenTxtFh, RdFirstPart, RdNextPart, NullChangePart } from './edtextf.ts';
import {
  EdFrame, TestKod, SetInd, TestUpdFile, DelEndT, WrEndT, SetScreen, Position, Column, LineAbs, NextLine,
  DekFindLine, CountChar, NewL, NewRL, ModPage, WordFind, WordNo, WordNo2, WordExist, SetWord, ClrWord, FindLine,
  LastPosLine, PredPart, SetDekCurrI, SetDekLnCurrI, NextPartDek, TestLenText, SetPart, KodLine, DekodLine,
  PosDekFindLine, SetPartLine,
} from './ededit.ts';
import { Background } from './edscreen.ts';
import { MyGetEvent } from './edevinpt.ts';
import {
  MyInsLine, MyDelLine, PredLine, RollNext, RollPred, CleanFrameM, FrameStep, TestLastPos, DelChar, FillBlank,
  DeleteL, NewLine, SetPredI, WrChar, Format, Calculate, BlockExist, SetBlockBound, BlockHandle, BlockGrasp,
  BlockDrop, BlockCGrasp, BlockCDrop, BlockCopyMove, BlockLRShift, BlockUDShift, MyPromptLL, FindReplaceString,
  HelpLU, HelpRD,
} from './edevproc.ts';

const CR = 0x0d;
const LF = 0x0a;

/** TS-only: the local variables of HandleEvent shared with its nested routines. */
export const EvFrame = {
  I: 0,
  I1: 0,
  I2: 0,
  I3: 0,
  W1: 0,
  W2: 0,
  ww: 0,
  L1: 0,
  L2: 0,
  fs: 0,
  ss: '',
  j: 0,
  LastL: new Array<number>(161).fill(0), // [0..160]
  sp: null as LongStrPtr | null,
  P1: null as unknown,
  bb: false,
  X: null as EdExitDPtr,
};

/** TS-only: the Opet code of HandleEvent (label in the $1000 case). */
function Opet(): void {
  const P = EdPriv;
  const F = EdFrame;
  if (P.Mode !== HelpM && P.Mode !== ViewM && EditorVars.Wrap) Window(F.FirstC, F.FirstR + 1, F.LastC + 1, F.LastR);
  else Window(F.FirstC, F.FirstR + 1, F.LastC, F.LastR);
  if (!F.Scroll) CrsShow();
  SetScreen(P.LineI, 0, 0);
}

/** TS-only: val(s, n, code) for a word/longint result var of HandleEvent. */
function ValN(s: string, code: Ref<number>): number {
  const v = ref(0);
  ValI(s, v, code);
  return v.v;
}

// PAS: EDEVENT.PAS HandleEvent – nested in Edit
export function HandleEvent(): void {
  const F = EdFrame;
  F.IsWrScreen = false;
  if (!MyGetEvent()) {
    ClrEvent();
    F.IsWrScreen = false;
    return;
  }
  if (!F.Scroll) CleanFrameM();
  const er = new ExitRecord();
  NewExit(Ovr, er);
  const armed = ref(true);
  let opet = false;
  try {
    for (;;) {
      try {
        if (opet) Opet();
        else EventBody(er, armed);
        break;
      } catch (e) {
        if (!(e instanceof GoExitSignal) || !armed.v) throw e;
        opet = true; // goto Opet
      }
    }
  } finally {
    // Nic:
    RestoreExit(er);
    F.IsWrScreen = false;
  }
}

/** TS-only: the body of HandleEvent after NewExit (`with Event do ...`); return = goto Nic. */
function EventBody(er: ExitRecord, armed: Ref<boolean>): void {
  const P = EdPriv;
  const F = EdFrame;
  const V = EvFrame;
  const E = DriversVars.Event;
  if (E.What === evKeyDown) {
    AccessVars.EdOk = false;
    V.ww = E.KeyCode;
    ClrEvent();
    // exit procedures
    V.X = P.ExitD;
    while (V.X !== null) {
      if (TestExitKey(V.ww, V.X)) {
        // sets EdBreak too
        if (!RunExit(er, armed)) return;
      }
      V.X = V.X!.Chain;
    }
    if ((P.Mode === SinFM || P.Mode === DouFM || P.Mode === DelFM || P.Mode === NotFM) && !F.Scroll)
      FrameStep(fref(F, 'FrameDir'), V.ww);
    else KeyDown(V.ww);
  } else if (E.What === evMouseDown && (P.Mode === HelpM || P.Mode === TextM)) MouseDown();
  else ClrEvent();
}

/** TS-only: an exit key of EdExitD (inside the while of HandleEvent); false = goto Nic. */
function RunExit(er: ExitRecord, armed: Ref<boolean>): boolean {
  const P = EdPriv;
  const F = EdFrame;
  const V = EvFrame;
  const av = AccessVars;
  const X = V.X!;
  TestKod();
  P.IndT = SetInd(P.LineI, P.Posi);
  P.ScrT = ((F.LineL - F.ScrL + 1) << 8) + P.Posi - P.BPos;
  av.LastTxtPos = P.IndT + P.Part.PosP;
  av.TxtXY = P.ScrT + P.Posi * 0x10000;
  if (X.Typ === 'Q') {
    DriversVars.KbdChar = V.ww;
    F.Konec = true;
    P.EditT = false;
    return false;
  }
  switch (P.TypeT) {
    case FileT:
      TestUpdFile();
      CloseH(P.TxtFH);
      break;
    case LocalT:
    case MemoT:
      DelEndT();
      V.sp = P.T!.slice(0, P.LenT); // sp^.LL:=LenT over the text
      if (P.TypeT === LocalT) {
        av.TWork.Delete(P.LocalPPtr!.v);
        P.LocalPPtr!.v = StoreInTWork(V.sp);
      } else if (P.UpdatT) {
        UpdateEdTFld(V.sp);
        P.UpdatT = false;
      }
      break;
  }
  V.L2 = SavePar();
  CrsHide();
  RestoreExit(er);
  armed.v = false;
  if (P.TypeT === MemoT) StartExit(X, false);
  else CallProcedure(X.Proc);
  NewExit(Ovr, er);
  armed.v = true;
  if (!F.Scroll) CrsShow();
  RestorePar(V.L2);
  switch (P.TypeT) {
    case FileT: {
      V.fs = P.Part.PosP + P.IndT;
      OpenTxtFh(P.Mode);
      RdFirstPart();
      SimplePrintHead();
      while (V.fs > P.Part.PosP + P.Part.LenP && !P.AllRd) RdNextPart();
      P.IndT = V.fs - P.Part.PosP;
      break;
    }
    case LocalT:
    case MemoT: {
      if (P.TypeT === LocalT) V.sp = av.TWork.Read(1, P.LocalPPtr!.v);
      else {
        av.CRecPtr = RdRunVars.EditDRoot!.NewRecPtr;
        V.sp = _LongS(RunEdiVars.CFld!.FldD);
      }
      P.LenT = V.sp.length;
      P.T = TxtBuf(V.sp, P.LenT, P.MaxLenT); // T:=pointer(sp); move(T^[3],T^[1],LenT)
      break;
    }
  }
  WrEndT();
  P.IndT = MinW(P.IndT, P.LenT);
  if (P.TypeT !== FileT) {
    P.AbsLenT = P.LenT - 1;
    P.Part.LenP = P.AbsLenT;
    SimplePrintHead();
  }
  SetScreen(P.IndT, P.ScrT, P.Posi);
  if (!F.Scroll) CrsShow();
  if (!av.EdOk) return false;
  return true;
}

/** TS-only: the mouse branch of HandleEvent. */
function MouseDown(): void {
  const P = EdPriv;
  const F = EdFrame;
  const V = EvFrame;
  const dv = DriversVars;
  const E = dv.Event;
  if (P.Mode === TextM) TestKod();
  const y = E.Where.Y;
  const x = E.Where.X;
  if (!(y >= F.FirstR && y <= F.LastR - 1 && x >= F.FirstC - 1 && x <= F.LastC - 1)) {
    ClrEvent();
    return;
  }
  V.I3 = P.LineI;
  V.j = P.Posi;
  V.W1 = y - dv.WindMin.Y + F.ScrL;
  if (P.Mode === HelpM) V.W2 = WordNo2() + 1;
  DekFindLine(LineAbs(V.W1));
  P.Posi = x - dv.WindMin.X + 1;
  if (P.Mode !== TextM) P.Posi = Position(P.Posi);
  P.Posi += P.BPos;
  V.I = SetInd(P.LineI, P.Posi);
  if (V.I < P.LenT) {
    if (P.Mode === HelpM) {
      ClrWord();
      const I1 = ref(0);
      const I2 = ref(0);
      const W1 = ref(0);
      WordFind(WordNo(V.I + 1), I1, I2, W1);
      V.I1 = I1.v;
      V.I2 = I2.v;
      V.W1 = W1.v;
      if (V.I1 <= V.I && V.I2 >= V.I) {
        SetWord(V.I1, V.I2);
        dv.KbdChar = _M_;
        F.Konec = true;
      } else if (WordExist()) {
        WordFind(V.W2, I1, I2, W1);
        V.I1 = I1.v;
        V.I2 = I2.v;
        V.W1 = W1.v;
        SetWord(V.I1, V.I2);
      } else SetDekLnCurrI(V.I3);
    }
  } else {
    SetDekLnCurrI(V.I3);
    P.Posi = V.j;
  }
  ClrEvent();
}

/** TS-only: a Ref to one of EvFrame's word locals (FindChar/WordFind var parameters). */
function vref(k: 'I' | 'I1' | 'I2' | 'I3' | 'W1' | 'L1' | 'L2' | 'fs'): Ref<number> {
  return fref(EvFrame, k);
}

/** TS-only: the `case ww of` of HandleEvent (evKeyDown); return = goto Nic. */
function KeyDown(ww: number): void {
  const P = EdPriv;
  const F = EdFrame;
  const V = EvFrame;
  const ev = EditorVars;
  const av = AccessVars;
  const bv = BaseVars;
  const dv = DriversVars;
  const Arr = F.Arr;

  // ***CHAR***
  if (ww >= 0x0020 && ww <= 0x00ff) {
    WrChar(chr(ww & 0xff));
    if (ev.Wrap) {
      if (P.Posi > P.RightMarg + 1) {
        V.W1 = Arr[P.Posi];
        Arr[P.Posi] = 0xff;
        KodLine();
        V.I1 = P.LeftMarg;
        while (Arr[V.I1] === 0x20) V.I1++;
        if (V.I1 > P.RightMarg) V.I1 = P.RightMarg;
        V.L1 = P.Part.PosP + P.LineI;
        Format(V.L1, P.AbsLenT + P.LenT - P.Part.LenP, V.I1, false);
        SetPart(V.L1);
        V.I = 1;
        V.I = FindChar(vref('I'), '\xff', 1, P.LenT);
        Ts(V.I, V.W1);
        SetDekLnCurrI(V.I);
        P.Posi = V.I - P.LineI + 1;
      }
    }
    return;
  }
  // ***CTRL keys*** (FPC: $1001..$101F)
  if (ww >= 0x1001 && ww <= 0x101f) {
    WrChar(chr(ww & 0xff));
    if (ww === 0x100d) {
      TestKod();
      DekodLine();
      P.Posi--;
    }
    return;
  }

  switch (ww) {
    case _left_:
      if (P.Mode === HelpM) HelpLU('L');
      else if (F.Scroll) {
        if (F.BCol > 0) {
          F.Colu = F.BCol;
          P.Posi = Position(F.Colu);
        }
      } else {
        V.I1 = P.Posi;
        if (P.Posi > 1) P.Posi--;
        BlockLRShift(V.I1);
      }
      break;
    case _right_:
      if (P.Mode === HelpM) HelpRD('R');
      else if (F.Scroll) {
        P.Posi = MinI(LineSize, Position(F.BCol + F.LineS + 1));
        F.Colu = Column(P.Posi);
      } else {
        V.I1 = P.Posi;
        if (P.Posi < LineSize) P.Posi++;
        BlockLRShift(V.I1);
      }
      break;
    case _up_:
      if (P.Mode === HelpM) HelpLU('U');
      else {
        if (F.Scroll) if (F.RScrL === 1) return;
        V.L1 = LineAbs(F.LineL);
        PredLine();
        BlockUDShift(V.L1);
        if (F.Scroll) P.Posi = Position(F.Colu);
      }
      break;
    case _down_:
      if (P.Mode === HelpM) HelpRD('D');
      else {
        V.L1 = LineAbs(F.LineL);
        NextLine(true);
        BlockUDShift(V.L1);
        if (F.Scroll) P.Posi = Position(F.Colu);
      }
      break;
    case _PgUp_:
      if (P.Mode !== HelpM) TestKod();
      else {
        ClrWord();
        F.LineL = F.ScrL;
      }
      V.L1 = LineAbs(F.LineL);
      if (F.Scroll) {
        F.RScrL = Math.max(1, F.RScrL - F.PageS);
        if (ModPage(F.RScrL)) F.RScrL++;
        F.ScrL = NewL(F.RScrL);
        F.LineL = F.ScrL;
        DekFindLine(LineAbs(F.LineL));
        P.Posi = Position(F.Colu);
        V.j = CountChar('\x0c', P.LineI, P.ScrI);
        if (V.j > 0 && P.InsPg) {
          DekFindLine(LineAbs(F.LineL + V.j));
          F.ScrL = F.LineL;
          F.RScrL = NewRL(F.ScrL);
        }
      } else {
        F.ScrL -= F.PageS;
        DekFindLine(LineAbs(F.LineL - F.PageS));
      }
      F.ChangeScr = true;
      if (P.Mode === HelpM) {
        P.ScrI = FindLine(fref(F, 'ScrL'));
        P.Posi = Position(F.Colu);
        const I1 = ref(0);
        const I2 = ref(0);
        if (WordFind(WordNo2() + 1, I1, I2, fref(F, 'WordL')) && WordExist()) SetWord(I1.v, I2.v);
        else F.WordL = 0;
        V.I1 = I1.v;
        V.I2 = I2.v;
      } else BlockUDShift(V.L1);
      break;
    case _PgDn_:
      if (P.Mode !== HelpM) TestKod();
      else {
        ClrWord();
        F.LineL = F.ScrL;
      }
      V.L1 = LineAbs(F.LineL);
      if (F.Scroll) {
        F.RScrL += F.PageS;
        if (ModPage(F.RScrL)) F.RScrL--;
        DekFindLine(LineAbs(NewL(F.RScrL)));
        P.Posi = Position(F.Colu);
        V.j = CountChar('\x0c', P.ScrI, P.LineI);
        if (V.j > 0 && P.InsPg) DekFindLine(LineAbs(F.LineL - V.j));
        F.ScrL = F.LineL;
        F.RScrL = NewRL(F.ScrL);
      } else {
        DekFindLine(LineAbs(F.LineL) + F.PageS);
        if (F.LineL >= F.ScrL + F.PageS) F.ScrL += F.PageS;
      }
      F.ChangeScr = true;
      if (P.Mode === HelpM) {
        P.ScrI = FindLine(fref(F, 'ScrL'));
        P.Posi = Position(F.Colu);
        V.W1 = WordNo2();
        V.I3 = F.WordL;
        const I1 = ref(0);
        const I2 = ref(0);
        const WordL = fref(F, 'WordL');
        if (WordFind(V.W1 + 1, I1, I2, WordL) && WordExist()) SetWord(I1.v, I2.v);
        else if (WordFind(V.W1, I1, I2, WordL) && WordExist()) SetWord(I1.v, I2.v);
        else F.WordL = 0;
        V.I1 = I1.v;
        V.I2 = I2.v;
      } else BlockUDShift(V.L1);
      break;

    case _CtrlLeft_: {
      let found = false; // goto 1
      do {
        P.Posi--;
        if (P.Posi === 0) {
          V.I = P.LineI;
          PredLine();
          if (V.I > 1 || P.ChangePart) P.Posi = LastPosLine();
          found = true;
          break;
        }
      } while (IsOddel(Arr[P.Posi]));
      if (!found) {
        while (!IsOddel(Arr[P.Posi])) {
          P.Posi--;
          if (P.Posi === 0) break;
        }
      }
      // 1:
      P.Posi++;
      break;
    }
    case _CtrlRight_: {
      lbl2: {
        while (!IsOddel(Arr[P.Posi])) {
          P.Posi++;
          if (P.Posi > LastPosLine()) break lbl2;
        }
        while (IsOddel(Arr[P.Posi])) {
          P.Posi++;
          V.I = LastPosLine();
          if (P.Posi > V.I) {
            if (F.NextI <= P.LenT && (V.I === 0 || P.Posi > V.I + 1)) {
              NextLine(true);
              P.Posi = 1;
            } else {
              P.Posi = V.I + 1;
              break lbl2;
            }
          }
        }
      }
      break;
    }

    case _Z_:
      RollNext();
      break;
    case _W_:
      RollPred();
      break;

    case _Home_:
      V.I1 = P.Posi;
      P.Posi = 1;
      if (ev.Wrap) P.Posi = Math.max(P.LeftMarg, 1);
      BlockLRShift(V.I1);
      break;
    case _End_:
      V.I1 = P.Posi;
      P.Posi = LastPosLine();
      if (P.Posi < LineSize) P.Posi++;
      BlockLRShift(V.I1);
      break;
    case _QE_:
      TestKod();
      F.LineL = F.ScrL;
      P.LineI = P.ScrI;
      DekodLine();
      break;
    case _QX_:
      TestKod();
      DekFindLine(LineAbs(F.ScrL + F.PageS - 1));
      break;

    case _CtrlPgUp_:
      TestKod();
      SetPart(1);
      SetScreen(1, 0, 0);
      break;
    case _CtrlPgDn_:
      TestKod();
      SetPart(P.AbsLenT - P.Part.LenP + P.LenT);
      SetScreen(P.LenT, 0, 0);
      break;
    case _CtrlF3_: {
      const ss = ref('');
      TestKod();
      do {
        if (MyPromptLL(420, ss)) return;
        V.L1 = ValN(ss.v, vref('I'));
      } while (!(V.L1 > 0));
      V.ss = ss.v;
      DekFindLine(V.L1);
      break;
    }

    case _M_:
      if (P.Mode === HelpM) {
        F.Konec = WordExist();
        dv.KbdChar = ww;
      } else {
        if (F.NextI >= P.LenT && !P.AllRd) NextPartDek();
        if (F.NextI > P.LenT || ev.Insert) {
          NewLine('m');
          P.Posi = 1;
          ClrEol();
          if (F.LineL - F.ScrL === F.PageS) {
            GotoXY(1, 1);
            MyDelLine();
            F.ScrL++;
            F.ChangeScr = true;
          } else {
            GotoXY(1, F.LineL - F.ScrL + 1);
            MyInsLine();
          }
          if (ev.Indent) {
            V.I1 = SetPredI();
            V.I = V.I1;
            while (Tg(V.I) === 0x20 && Tg(V.I) !== CR) V.I++;
            if (Tg(V.I) !== CR) P.Posi = V.I - V.I1 + 1;
          } else if (ev.Wrap) P.Posi = P.LeftMarg;
          if (TestLastPos(1, P.Posi)) Arr.fill(0x20, 1, P.Posi);
        } else if (F.NextI <= P.LenT) {
          NextLine(true);
          P.Posi = 1;
        }
      }
      break;
    case _N_:
      NewLine('n');
      ClrEol();
      GotoXY(1, F.LineL - F.ScrL + 2);
      MyInsLine();
      break;

    case _Ins_:
      ev.Insert = !ev.Insert;
      break;

    case _Del_:
    case _G_:
      if (P.Posi <= LastPosLine()) DelChar();
      else DeleteL();
      break;
    case _H_:
      if (P.Posi > 1) {
        P.Posi--;
        DelChar();
      } else {
        if (F.LineL === 1 && P.Part.PosP > 0) PredPart();
        if (P.LineI > 1) {
          TestKod();
          F.LineL--;
          if (Tg(P.LineI - 1) === LF) SetDekCurrI(P.LineI - 2);
          else SetDekCurrI(P.LineI - 1);
          P.Posi = MinW(255, LastPosLine() + 1);
          DeleteL();
          if (F.LineL < F.ScrL) {
            F.ScrL--;
            F.ChangeScr = true;
          }
        }
      }
      break;
    case _Y_:
      if (F.NextI >= P.LenT && !P.AllRd) NextPartDek();
      F.NextI = MinW(F.NextI, P.LenT);
      TestLenText(F.NextI, P.LineI);
      if (P.BegBLn > LineAbs(F.LineL)) P.BegBLn--;
      else if (P.BegBLn === LineAbs(F.LineL)) {
        if (P.TypeB === TextBlock) P.BegBPos = 1;
      }
      if (P.EndBLn >= LineAbs(F.LineL)) {
        if (P.EndBLn === LineAbs(F.LineL) && P.TypeB === TextBlock) P.EndBPos = 1;
        else P.EndBLn--;
      }
      MyDelLine();
      DekodLine();
      P.Posi = 1;
      break;
    case _T_:
      if (P.Posi > LastPosLine()) DeleteL();
      else {
        V.I = P.Posi;
        if (IsOddel(Arr[P.Posi])) DelChar();
        else while (V.I <= LastPosLine() && !IsOddel(Arr[V.I])) V.I++;
        while (V.I <= LastPosLine() && Arr[V.I] === 0x20) V.I++;
        if (V.I > P.Posi) TestLastPos(V.I, P.Posi);
      }
      break;
    case _QI_:
      ev.Indent = !ev.Indent;
      break;
    case _QL_:
      if (F.UpdatedL) DekodLine();
      break;
    case _QY_:
      if (TestLastPos(LastPosLine() + 1, P.Posi)) ClrEol();
      break;

    case _QF_:
    case _QA_: {
      P.Replace = false;
      const fsr = fref(P, 'FindStr');
      if (MyPromptLL(405, fsr)) return;
      if (ww === _QA_) {
        if (MyPromptLL(407, fref(P, 'ReplaceStr'))) return;
        P.Replace = true;
      }
      const ss = ref(P.OptionStr);
      if (MyPromptLL(406, ss)) return;
      V.ss = ss.v;
      P.OptionStr = ss.v;
      TestKod();
      if (TestOptStr('l') && (!BlockExist() || P.TypeB === ColBlock)) return;
      if (TestOptStr('l')) SetBlockBound(vref('L1'), vref('L2'));
      else {
        V.L2 = P.AbsLenT - P.Part.LenP + P.LenT;
        if (TestOptStr('g') || TestOptStr('e')) V.L1 = 1;
        else V.L1 = P.Part.PosP + SetInd(P.LineI, P.Posi);
      }
      FindReplaceString(V.L1, V.L2);
      if (ww === _QA_) DekodLine();
      if (!F.Konec) {
        P.FirstEvent = false;
        Background();
      }
      break;
    }
    case _L_:
      if (P.FindStr !== '') {
        TestKod();
        if (TestOptStr('l') && (!BlockExist() || P.TypeB === ColBlock)) return;
        V.fs = 1;
        V.L1 = P.Part.PosP + SetInd(P.LineI, P.Posi);
        if (TestOptStr('l')) SetBlockBound(vref('fs'), vref('L2'));
        else V.L2 = P.AbsLenT - P.Part.LenP + P.LenT;
        if (V.L1 < V.fs) V.L1 = V.fs;
        FindReplaceString(V.L1, V.L2);
        if (!F.Konec) {
          P.FirstEvent = false;
          Background();
        }
      }
      break;

    case _I_:
      V.I1 = SetPredI() + P.Posi;
      if (V.I1 >= P.LineI - 1) return;
      V.I = V.I1;
      while (Tg(V.I) !== 0x20 && Tg(V.I) !== CR) V.I++;
      while (Tg(V.I) === 0x20) V.I++;
      V.I2 = V.I - V.I1 + 1;
      if (TestLastPos(P.Posi, P.Posi + V.I2)) Arr.fill(0x20, P.Posi, P.Posi + V.I2);
      P.Posi += V.I2;
      break;
    case _J_:
      V.I1 = SetPredI() + P.Posi - 2;
      if (V.I1 >= P.LineI - 1 || V.I1 === 0) return;
      V.I = V.I1;
      while (Tg(V.I) === 0x20) V.I++;
      while (Tg(V.I) !== 0x20 && Tg(V.I) !== CR) V.I++;
      if (V.I === V.I1) return;
      V.I2 = V.I - V.I1 - 1;
      V.I = P.Posi;
      P.Posi--;
      while (P.Posi > 0 && Arr[P.Posi] !== 0x20) P.Posi--;
      P.Posi++;
      if (TestLastPos(P.Posi, P.Posi + V.I2)) Arr.fill(0x20, P.Posi, P.Posi + V.I2);
      P.Posi = V.I + V.I2 + 1;
      break;

    case _QB_:
      TestKod();
      PosDekFindLine(P.BegBLn, MinW(LastPosLine() + 1, P.BegBPos), false);
      break;
    case _QK_:
      TestKod();
      PosDekFindLine(P.EndBLn, MinW(LastPosLine() + 1, P.EndBPos), false);
      break;

    case _KB_:
    case _F7_:
    case _KH_:
      P.BegBLn = LineAbs(F.LineL);
      if (P.TypeB === TextBlock) P.BegBPos = MinI(LastPosLine() + 1, P.Posi);
      else P.BegBPos = P.Posi;
      if (ww === _KH_) OznB();
      break;
    case _KK_:
    case _F8_:
      OznB();
      break;
    case _KN_:
      if (P.TypeB === TextBlock) P.TypeB = ColBlock;
      else P.TypeB = TextBlock;
      break;
    case _KY_:
      if (BlockHandle('Y')) {
        P.EndBLn = P.BegBLn;
        P.EndBPos = P.BegBPos;
      }
      break;
    case _KC_:
      BlockCopyMove('C');
      break;
    case _KV_:
      BlockCopyMove('M');
      break;
    case _KU_:
      BlockHandle('U');
      break;
    case _KL_:
      BlockHandle('L');
      break;
    case _CtrlF7_:
      if (P.TypeB === TextBlock) BlockGrasp('G');
      else BlockCGrasp('G');
      break;
    case _KW_: {
      V.I1 = P.BegBLn;
      V.I2 = P.BegBPos;
      V.I3 = P.EndBLn;
      V.I = P.EndBPos;
      V.bb = P.TypeB;
      if (!BlockExist()) {
        P.BegBLn = 1;
        P.EndBLn = 0x7fff;
        P.BegBPos = 1;
        P.EndBPos = 0xff;
        P.TypeB = TextBlock;
      }
      bv.CPath = SelectDiskFile('.TXT', 401, false);
      if (bv.CPath === '') return;
      bv.CVol = '';
      V.W1 = OpenH(_isnewfile, Exclusive);
      if (bv.HandleError === 80) {
        SetMsgPar(bv.CPath);
        if (PromptYN(780)) V.W1 = OpenH(_isoverwritefile, Exclusive);
        else return;
      }
      if (bv.HandleError !== 0) {
        MyWrLLMsg(bv.CPath);
        return;
      }
      V.fs = 0;
      if (BlockHandle('W')) {
        TruncH(V.W1, PosH(V.W1)); // WriteH(W1,0,T^) {truncH}: BP7 DOS truncate
        CloseH(V.W1);
        HMsgExit(bv.CPath);
      }
      P.BegBLn = V.I1;
      P.BegBPos = V.I2;
      P.EndBLn = V.I3;
      P.EndBPos = V.I;
      P.TypeB = V.bb;
      break;
    }
    case _ShiftF7_:
      if (P.TypeB === TextBlock) BlockDrop('D');
      else BlockCDrop('D');
      break;
    case _KR_: {
      bv.CPath = SelectDiskFile('.TXT', 400, false);
      if (bv.CPath === '') return;
      bv.CVol = '';
      V.W1 = OpenH(_isoldfile, RdOnly);
      if (bv.HandleError !== 0) {
        MyWrLLMsg(bv.CPath);
        return;
      }
      P.BegBLn = P.Part.LineP + F.LineL;
      P.BegBPos = P.Posi;
      V.L1 = P.Part.PosP + P.LineI + P.Posi - 1;
      FillBlank();
      V.fs = FileSizeH(V.W1);
      V.L2 = 0;
      NullChangePart();
      if (P.TypeB === TextBlock) {
        do {
          V.I2 = 0x1000;
          if (V.fs - V.L2 < V.I2) V.I2 = V.fs - V.L2;
          if (P.TypeT !== FileT && (V.I2 >= P.MaxLenT - P.LenT || V.I2 >= StoreAvail())) {
            if (V.I2 >= StoreAvail()) V.I2 = StoreAvail();
            V.I2 = MinW(V.I2, P.MaxLenT - P.LenT) - 2;
            V.fs = V.L2 + V.I2;
            WrLLF10Msg(404);
          }
          V.I1 = V.L1 + V.L2 - P.Part.PosP;
          TestLenText(V.I1, V.I1 + V.I2);
          if (P.ChangePart) V.I1 -= P.Part.MovI;
          SeekH(V.W1, V.L2);
          ReadH(V.W1, V.I2, P.T!.subarray(V.I1 - 1));
          HMsgExit('');
          V.L2 += V.I2;
        } while (V.L2 !== V.fs);
        V.I = V.L1 + V.L2 - P.Part.PosP;
        if (Tg(V.I - 1) === 0x1a) {
          TestLenText(V.I, V.I - 1);
          V.I--;
        }
        SetDekLnCurrI(V.I);
        P.EndBLn = P.Part.LineP + F.LineL;
        P.EndBPos = V.I - P.LineI + 1;
      } else {
        // ColBlock
        P.EndBPos = P.Posi;
        V.I2 = 0x1000;
        const buf = new Uint8Array(V.I2 + 2); // MarkStore2(P1); sp:=GetStore2(I2+2)
        do {
          if (V.fs - V.L2 < V.I2) V.I2 = V.fs - V.L2;
          SeekH(V.W1, V.L2);
          ReadH(V.W1, V.I2, buf);
          HMsgExit('');
          V.L2 += V.I2;
          V.sp = buf.subarray(0, V.I2); // sp^.LL:=I2
          BlockCDrop('R');
        } while (V.L2 !== V.fs);
        P.EndBLn = P.Part.LineP + F.LineL - 1;
      }
      CloseH(V.W1);
      HMsgExit('');
      SetPartLine(P.BegBLn);
      SetDekLnCurrI(V.L1 - P.Part.PosP);
      F.UpdatedL = true;
      break;
    }
    case _KP_:
      if (!BlockHandle('P')) {
        V.I1 = P.BegBLn;
        V.I2 = P.BegBPos;
        V.I3 = P.EndBLn;
        V.I = P.EndBPos;
        V.bb = P.TypeB;
        P.BegBLn = 1;
        P.EndBLn = 0x7fff;
        P.BegBPos = 1;
        P.EndBPos = 0xff;
        P.TypeB = TextBlock;
        BlockHandle('P');
        P.BegBLn = V.I1;
        P.BegBPos = V.I2;
        P.EndBLn = V.I3;
        P.EndBPos = V.I;
        P.TypeB = V.bb;
      }
      break;
    case _KF_:
      if (BlockExist() && P.TypeB === TextBlock) {
        TestKod();
        CrsHide();
        SetPartLine(P.EndBLn);
        const i2 = ref(P.EndBLn - P.Part.LineP);
        V.L1 = SetInd(FindLine(i2), P.EndBPos) + P.Part.PosP;
        V.L2 = P.BegBLn;
        P.Posi = P.BegBPos;
        SetPartLine(V.L2);
        i2.v = P.BegBLn - P.Part.LineP;
        const fl = FindLine(i2);
        V.I2 = i2.v;
        Format(fl + P.Part.PosP, V.L1, P.BegBPos, true);
        DekFindLine(V.L2);
        if (!F.Scroll) CrsShow();
      }
      break;

    case _OJ_:
      ev.Just = !ev.Just;
      break;
    case _OW_:
      ev.Wrap = !ev.Wrap;
      if (ev.Wrap) {
        F.LineS--;
        F.LastC--;
      } else {
        F.LastC++;
        F.LineS++;
        const LastL = new Uint16Array(262); // array[0..160] of word (+ spare)
        const TxtRows = bv.TxtRows;
        ScrRdBuf(F.FirstC - 1, TxtRows - 1, LastL.subarray(1), F.LineS);
        LastL[F.MargLL[1]] = F.MargLL[2];
        LastL[F.MargLL[3]] = F.MargLL[4];
        ScrWrBuf(F.FirstC - 1, TxtRows - 1, LastL.subarray(1), F.LineS);
      }
      break;
    case _OL_: {
      // LeftMarg
      const ss = ref('');
      do {
        ss.v = StrI(P.Posi);
        if (MyPromptLL(410, ss)) return;
        V.I1 = ValN(ss.v, vref('I'));
      } while (!(V.I1 < P.RightMarg && V.I1 > 0));
      V.ss = ss.v;
      P.LeftMarg = V.I1;
      break;
    }
    case _OR_: {
      // RightMarg
      const ss = ref('');
      do {
        ss.v = StrI(P.Posi);
        if (MyPromptLL(409, ss)) return;
        V.I1 = ValN(ss.v, vref('I'));
      } while (!(V.I1 <= 255 && P.LeftMarg < V.I1));
      V.ss = ss.v;
      P.RightMarg = V.I1;
      break;
    }
    case _OC_:
      V.I1 = 1;
      while (V.I1 < LastPosLine() && Arr[V.I1] === 0x20) V.I1++;
      V.I2 = LastPosLine();
      while (V.I2 > 1 && Arr[V.I2] === 0x20) V.I2--;
      V.j = P.LeftMarg + Math.trunc((P.RightMarg - P.LeftMarg) / 2) - (V.I1 + Math.trunc((V.I2 - V.I1) / 2));
      if (V.I2 < V.I1 || V.j === 0) return;
      if (V.j > 0) {
        if (TestLastPos(1, V.j + 1)) Arr.fill(0x20, 1, 1 + V.j);
      } else {
        V.j = MinI(-V.j, V.I1 - 1);
        TestLastPos(V.j + 1, 1);
      }
      P.Posi = MinW(LineSize, LastPosLine() + 1);
      break;

    case _B_:
      TestKod();
      V.L1 = P.Part.PosP + P.LineI;
      Format(V.L1, P.AbsLenT + P.LenT - P.Part.LenP, MinI(P.LeftMarg, P.Posi), false);
      SetPart(V.L1);
      V.I2 = V.L1 - P.Part.PosP;
      SetDekLnCurrI(V.I2);
      P.Posi = 1;
      break;

    case _framesingle_:
      P.Mode = SinFM;
      CrsBig();
      F.FrameDir = 0;
      break;
    case _framedouble_:
      P.Mode = DouFM;
      CrsBig();
      F.FrameDir = 0;
      break;
    case _delframe_:
      P.Mode = DelFM;
      CrsBig();
      F.FrameDir = 0;
      break;

    case _F4_:
      V.W1 = ord(ToggleCS(chr(Arr[P.Posi])));
      F.UpdatedL = V.W1 !== Arr[P.Posi];
      Arr[P.Posi] = V.W1;
      break;
    case _CtrlF5_:
      Calculate();
      break;
    case _AltF8_: {
      V.L2 = SavePar();
      V.W1 = Menu(45, bv.Spec.KbdTyp + 1);
      if (V.W1 !== 0) bv.Spec.KbdTyp = (V.W1 - 1) as TKbdConv;
      RestorePar(V.L2);
      break;
    }
    case _CtrlF6_:
      if (P.TypeT === FileT || P.TypeT === LocalT) BlockHandle('p');
      break;

    case 0x1000:
      Opet();
      break;
    // ***ERROR TESTLENTEXT***
    case _U_:
      if (P.TypeT !== FileT) {
        if (PromptYN(108)) {
          P.IndT = 1;
          dv.KbdChar = _U_;
          F.Konec = true;
          av.EdBreak = 0xffff;
        }
      }
      break;
    default:
      // ***BREAKS***
      if (((ww & 0xff) === 0 && P.Breaks.indexOf(chr(ww >> 8)) >= 0) || (ww === _AltEqual_ && P.TypeT !== FileT)) {
        TestKod();
        dv.KbdChar = ww;
        F.Konec = true;
        av.EdBreak = 0xffff;
      } else if (ww === _ESC_) {
        TestKod();
        dv.KbdChar = ww;
        F.Konec = true;
        av.EdBreak = 0;
      }
  }

  // PAS: HandleEvent label OznB (end of block)
  function OznB(): void {
    P.EndBLn = LineAbs(F.LineL);
    if (P.TypeB === TextBlock) P.EndBPos = MinI(LastPosLine() + 1, P.Posi);
    else P.EndBPos = P.Posi;
  }
}
