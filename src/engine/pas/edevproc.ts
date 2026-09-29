// PAS: EDEVPROC.PAS – include of EDEVENT, nested in HandleEvent: line insert/delete, scrolling
// (RollNext/RollPred), frame drawing (Frame/FrameStep with the box-drawing FrameString tables),
// character/line editing (DelChar, DeleteL, NewLine with Indent, WrChar with Insert/Wrap), paragraph
// formatting (Format with Just/margins), Calculate (evaluate the formula under the cursor via
// COMPILE/RUNFRML with NewExit), block operations (BlockHandle: upper/lower case, print, write/read
// file ^K^W/^K^R via WWMIX.SelectDiskFile and PRINTTXT.PrintArray; BlockGrasp/BlockDrop and column
// blocks BlockCGrasp/BlockCDrop, shifts), clipboard (DelStorClpBd/MarkRdClpBd in TWork),
// find/replace (FindReplaceString, MyVerifyLL), help paging (HelpLU/HelpRD).
//
// Porting notes:
// * State: EvFrame (edevent.ts: I, W1, fs, sp, P1 are HandleEvent's locals used here), EdFrame
//   (ededit.ts), EdPriv/EditorVars (editor.ts).
// * FrameString: Pascal sets FrameString[0] := chr(63), so the string runs on over the typed
//   constants FS1..FS3 behind it (each preceded by its length byte 15): FrameStr63 below.
// * BlockHandle: `WriteH(h, 0, ...)` is the DOS truncate at the file position (BP7; FPC's WriteH of
//   0 bytes does nothing): TruncAtPos.
// * BlockCGrasp: `L in [BegBLn..EndBLn]` / `Posi in [...]` are Pascal set tests (0..255 only); ported
//   as range tests.
// * MyVerifyLL: the Pascal busy wait for a key sleeps a tick per round (BiosWaitKey).

import { ref, chr, ord, UpCase, StrR, GoExitSignal, TxtWrite, Output, type Ref, type Pointer } from './pasrt.ts';
import {
  BaseVars, MinI, MinW, MaxW, MinL, MaxL, SetMsgPar, WriteMsg, StoreAvail, WriteH, SeekH, TruncH, PosH,
  ExitRecord, NewExit, RestoreExit,
} from './base.ts';
import { AccessVars, ResetCompilePars, type FrmlPtr } from './access.ts';
import {
  DriversVars, evKeyDown, ClrEvent, CrsNorm, CrsBig, CrsHide, CrsShow, GotoXY, InsLine, DelLine, ClrEol, WhereX,
  WhereY, KbdPressed, ReadKbd, BiosWaitKey, _ESC_, _left_, _right_, _up_, _down_, _U_, _CtrlF4_,
} from './drivers.ts';
import { PushW, PopW, WrLLF10Msg } from './obaseww.ts';
import { PromptLL } from './wwmix.ts';
import { PrintArray, PrintFandWork } from './printtxt.ts';
import { RdRunVars } from './rdrun.ts';
import { RunEdiVars } from './runedi.ts';
import { SetInpStr, RdLex } from './lexanal.ts';
import { Error } from './lexanal.ts';
import { RdFrml } from './rdfrml.ts';
import { RunReal, RunShortStr, RunBool, LeadChar, TrailChar } from './runfrml.ts';
import {
  EdPriv, EditorVars, Tg, Ts, LineSize, CtrlKey, TextBlock, ColBlock, TextM, HelpM, MemoT, FileT, DouFM,
  DelFM, NotFM, SinFM, _frmsin_, _frmdoub_, _dfrm_, _nfrm_,
} from './editor.ts';
import { FindString, TestOptStr, SetColorOrd, HMsgExit, RdFldNameFrmlT } from './edglobal.ts';
import { NullChangePart } from './edtextf.ts';
import {
  EdFrame, PredPart, NextPart, SetPart, SetPartLine, LineAbs, SetDekCurrI, SetDekLnCurrI, NextLine, TestKod,
  KodLine, DekodLine, TestLenText, LastPosLine, SetUpdat, SetCurrI, SetLine, FindLine, SetInd, PosDekFindLine,
  DekFindLine, NextPartDek, TestUpdFile, WrEndT, ModPage, SetScreen, ClrWord, WordNo2, WordFind, SetWord,
  WordExist, Position,
} from './ededit.ts';
import { UpdStatLine, Background } from './edscreen.ts';
import { MyGetEvent } from './edevinpt.ts';
import { EvFrame } from './edevent.ts';

const CR = 0x0d;
const LF = 0x0a;

/** TS-only: pos(chr(c), CtrlKey) <> 0 */
function IsCtrlKey(c: number): boolean {
  return CtrlKey.indexOf(chr(c)) >= 0;
}
/** TS-only: BP7 WriteH(h, 0, ...) = DOS truncate at the current position. */
function TruncAtPos(h: number): void {
  TruncH(h, PosH(h));
}

// PAS: EDEVPROC.PAS MyInsLine – nested in HandleEvent
export function MyInsLine(): void {
  DriversVars.TextAttr = EdPriv.TxtColor;
  InsLine();
}
// PAS: EDEVPROC.PAS MyDelLine – nested in HandleEvent
export function MyDelLine(): void {
  DriversVars.TextAttr = EdPriv.TxtColor;
  DelLine();
}

// PAS: EDEVPROC.PAS PredLine – nested in HandleEvent
export function PredLine(): void {
  const P = EdPriv;
  const F = EdFrame;
  TestKod();
  if (F.LineL === 1 && P.Part.PosP > 0) PredPart();
  if (F.LineL > 1) {
    if (Tg(P.LineI - 1) === LF) SetDekCurrI(P.LineI - 2);
    else SetDekCurrI(P.LineI - 1);
    F.LineL--;
    if (F.LineL < F.ScrL) {
      GotoXY(1, 1);
      MyInsLine();
      F.ScrL--;
      F.ChangeScr = true;
      if (F.Scroll) {
        F.RScrL--;
        if (ModPage(F.RScrL)) {
          GotoXY(1, 1);
          MyInsLine();
          F.RScrL--;
        }
      }
    }
  }
}

// PAS: EDEVPROC.PAS RollNext – nested in HandleEvent
export function RollNext(): void {
  const P = EdPriv;
  const F = EdFrame;
  if (F.NextI >= P.LenT && !P.AllRd) NextPartDek();
  if (F.NextI <= P.LenT) {
    GotoXY(1, 1);
    MyDelLine();
    F.ScrL++;
    F.ChangeScr = true;
    if (F.LineL < F.ScrL) {
      TestKod();
      F.LineL++;
      P.LineI = F.NextI;
      DekodLine();
    }
  }
}

// PAS: EDEVPROC.PAS RollPred – nested in HandleEvent
export function RollPred(): void {
  const P = EdPriv;
  const F = EdFrame;
  if (F.ScrL === 1 && P.Part.PosP > 0) PredPart();
  if (F.ScrL > 1) {
    GotoXY(1, 1);
    MyInsLine();
    F.ScrL--;
    F.ChangeScr = true;
    if (F.LineL === F.ScrL + F.PageS) {
      TestKod();
      F.LineL--;
      if (Tg(P.LineI - 1) === LF) SetDekCurrI(P.LineI - 2);
      else SetDekCurrI(P.LineI - 1);
    }
  }
}

// FrameString (+ FS1..FS3 behind it): single, double-vertical, double-horizontal and double lines
const FS0 = '\x50\x48\xb3\x4d\xda\xc0\xc3\x4b\xbf\xd9\xb4\xc4\xc2\xc1\xc5';
const FS1 = '\x50\x48\xba\x4d\xd6\xd3\xc7\x4b\xb7\xbd\xb6\xc4\xd2\xd0\xd7';
const FS2 = '\x50\x48\xb3\x4d\xd5\xd4\xc6\x4b\xb8\xbe\xb5\xcd\xd1\xcf\xd8';
const FS3 = '\x50\x48\xba\x4d\xc9\xc8\xcc\x4b\xbb\xbc\xb9\xcd\xcb\xca\xce';
/** FrameString with length 63: FS0, #15, FS1, #15, FS2, #15, FS3 (see the notes). */
const FrameStr63 = FS0 + '\x0f' + FS1 + '\x0f' + FS2 + '\x0f' + FS3;

/** TS-only: one frame step at Posi for arrow KeyCode (shared body of Frame and FrameStep). */
function FrameDo(odir: Ref<number>, KeyCode: number, EvKeyC: number): void {
  const P = EdPriv;
  const F = EdFrame;
  const Arr = F.Arr;
  let zn1 = FrameStr63.indexOf(chr(Arr[P.Posi])) + 1;
  let zn2 = zn1 & 0x30;
  zn1 &= 0x0f;
  // PAS: direction (nested)
  const direction = (x: number): void => {
    let y = 0x10;
    if (x > 2) y <<= 1;
    if (x === 0) y = 0;
    if (P.Mode === DouFM) zn2 |= y;
    else zn2 &= ~y & 0xff;
  };
  const dir = FrameStr63.indexOf(chr((EvKeyC >> 8) & 0xff)) + 1;
  const s = dir + odir.v;
  if (s === 2 || s === 4 || s === 8 || s === 16) odir.v = 0;
  if (zn1 === 1 || zn1 === 2 || zn1 === 4 || zn1 === 8) zn1 = 0;
  let oldzn = Arr[P.Posi];
  Arr[P.Posi] = 0x20;
  let b: number;
  if (P.Mode === DelFM) b = zn1 & ~(odir.v | dir) & 0xff;
  else b = zn1 | (odir.v ^ dir);
  if (b === 1 || b === 2 || b === 4 || b === 8) b = 0;
  if (P.Mode === DelFM && zn1 !== 0 && b === 0) oldzn = 0x20;
  direction(dir);
  direction(odir.v);
  if (P.Mode === NotFM) b = 0;
  if (b !== 0 && (KeyCode === _left_ || KeyCode === _right_ || KeyCode === _up_ || KeyCode === _down_))
    Arr[P.Posi] = FrameStr63.charCodeAt(zn2 + b - 1);
  else Arr[P.Posi] = oldzn;
  if (dir === 1 || dir === 4) odir.v = dir * 2;
  else odir.v = dir >> 1;
  if (P.Mode === NotFM) odir.v = 0;
  else F.UpdatedL = true;
  switch (KeyCode) {
    case _left_:
      if (P.Posi > 1) P.Posi--;
      break;
    case _right_:
      if (P.Posi < LineSize) P.Posi++;
      break;
    case _up_:
      PredLine();
      break;
    case _down_:
      NextLine(true);
      break;
  }
}

// PAS: EDEVPROC.PAS Frame – nested in HandleEvent (not called: the frame keys use FrameStep)
export function Frame(): void {
  const P = EdPriv;
  const F = EdFrame;
  const E = DriversVars.Event;
  UpdStatLine(F.LineL, P.Posi);
  CrsBig();
  const odir = ref(0);
  ClrEvent();
  for (;;) {
    if (!MyGetEvent() || (E.What === evKeyDown && E.KeyCode === _ESC_) || E.What !== evKeyDown) {
      ClrEvent();
      CrsNorm();
      P.Mode = TextM;
      return;
    }
    switch (E.KeyCode) {
      case _frmsin_:
        P.Mode = SinFM;
        break;
      case _frmdoub_:
        P.Mode = DouFM;
        break;
      case _dfrm_:
        P.Mode = DelFM;
        break;
      case _nfrm_:
        P.Mode = NotFM;
        break;
      case _left_:
      case _right_:
      case _up_:
      case _down_:
        if (!F.Scroll) FrameDo(odir, E.KeyCode, E.KeyCode);
        break;
    }
    ClrEvent();
    UpdStatLine(F.LineL, P.Posi);
    Background();
  }
}

// PAS: EDEVPROC.PAS CleanFrameM – nested in HandleEvent
export function CleanFrameM(): void {
  const P = EdPriv;
  const E = DriversVars.Event;
  if (P.Mode === SinFM || P.Mode === DouFM || P.Mode === DelFM || P.Mode === NotFM) {
    if (!MyGetEvent() || (E.What === evKeyDown && E.KeyCode === _ESC_) || E.What !== evKeyDown) {
      ClrEvent();
      CrsNorm();
      P.Mode = TextM;
      UpdStatLine(EdFrame.LineL, P.Posi);
    }
  }
}

// PAS: EDEVPROC.PAS FrameStep – nested in HandleEvent
export function FrameStep(odir: Ref<number>, EvKeyC: number): void {
  const P = EdPriv;
  switch (EvKeyC) {
    case _frmsin_:
      P.Mode = SinFM;
      break;
    case _frmdoub_:
      P.Mode = DouFM;
      break;
    case _dfrm_:
      P.Mode = DelFM;
      break;
    case _nfrm_:
      P.Mode = NotFM;
      break;
    case _left_:
    case _right_:
    case _up_:
    case _down_:
      FrameDo(odir, DriversVars.Event.KeyCode, EvKeyC);
      break;
  }
  UpdStatLine(EdFrame.LineL, P.Posi);
}

// PAS: EDEVPROC.PAS TestLastPos – nested in HandleEvent: move Arr[F..] to Arr[T..] if the line allows
export function TestLastPos(F: number, T: number): boolean {
  const P = EdPriv;
  const Fr = EdFrame;
  const Arr = Fr.Arr;
  // PAS: TestLastPos.MoveB (nested)
  const MoveB = (B: number): number => {
    if (F <= T) {
      if (B > F) B += T - F;
    } else if (B >= F) B -= F - T;
    else if (B > T) B = T;
    return MinW(B, LastPosLine() + 1);
  };
  const LP = LastPosLine();
  if (F > LP) F = LP + 1;
  if (LP + T - F <= LineSize) {
    if (LP >= F) Arr.copyWithin(T, F, F + LP - F + 1);
    if (P.TypeB === TextBlock) {
      if (LineAbs(Fr.LineL) === P.BegBLn) P.BegBPos = MoveB(P.BegBPos);
      if (LineAbs(Fr.LineL) === P.EndBLn) P.EndBPos = MoveB(P.EndBPos);
    }
    if (F > T) {
      if (T <= LP) Arr.fill(0x20, LP + 1 + T - F, LP + 1 + T - F + F - T);
    }
    Fr.UpdatedL = true;
    return true;
  }
  return false;
}

// PAS: EDEVPROC.PAS DelChar – nested in HandleEvent
export function DelChar(): void {
  TestLastPos(EdPriv.Posi + 1, EdPriv.Posi);
}

// PAS: EDEVPROC.PAS FillBlank – nested in HandleEvent: blanks up to the cursor in T
export function FillBlank(): void {
  const P = EdPriv;
  const F = EdFrame;
  KodLine();
  const I = LastPosLine();
  if (P.Posi > I + 1) {
    TestLenText(P.LineI + I, P.LineI + P.Posi - 1);
    P.T!.fill(0x20, P.LineI + I - 1, P.LineI + I - 1 + P.Posi - I - 1);
    F.NextI += P.Posi - I - 1;
  }
}

// PAS: EDEVPROC.PAS DeleteL – nested in HandleEvent: join the next line
export function DeleteL(): void {
  const P = EdPriv;
  const F = EdFrame;
  FillBlank();
  if (LineAbs(F.LineL) + 1 <= P.BegBLn) {
    P.BegBLn--;
    if (LineAbs(F.LineL) === P.BegBLn && P.TypeB === TextBlock) P.BegBPos += LastPosLine();
  }
  if (LineAbs(F.LineL) + 1 <= P.EndBLn) {
    P.EndBLn--;
    if (LineAbs(F.LineL) === P.EndBLn && P.TypeB === TextBlock) P.EndBPos += LastPosLine();
  }
  if (F.NextI >= P.LenT && !P.AllRd) NextPartDek();
  if (F.NextI <= P.LenT) {
    if (Tg(F.NextI - 1) === LF) TestLenText(F.NextI, F.NextI - 2);
    else TestLenText(F.NextI, F.NextI - 1);
  }
  DekodLine();
}

// PAS: EDEVPROC.PAS NewLine – nested in HandleEvent: split the line at Posi (Mode 'm': go down)
export function NewLine(Mode: string): void {
  const P = EdPriv;
  const F = EdFrame;
  KodLine();
  let LP = P.LineI + MinI(LastPosLine(), P.Posi - 1);
  NullChangePart();
  TestLenText(LP, LP + 2);
  LP -= P.Part.MovI;
  if (LineAbs(F.LineL) <= P.BegBLn) {
    if (LineAbs(F.LineL) < P.BegBLn) P.BegBLn++;
    else if (P.BegBPos > P.Posi && P.TypeB === TextBlock) {
      P.BegBLn++;
      P.BegBPos -= P.Posi - 1;
    }
  }
  if (LineAbs(F.LineL) <= P.EndBLn) {
    if (LineAbs(F.LineL) < P.EndBLn) P.EndBLn++;
    else if (P.EndBPos > P.Posi && P.TypeB === TextBlock) {
      P.EndBLn++;
      P.EndBPos -= P.Posi - 1;
    }
  }
  Ts(LP, CR);
  Ts(LP + 1, LF);
  if (Mode === 'm') {
    F.LineL++;
    P.LineI = LP + 2;
  }
  DekodLine();
}

// PAS: EDEVPROC.PAS SetPredI – nested in HandleEvent: start of the previous line
export function SetPredI(): number {
  const P = EdPriv;
  if (EdFrame.LineL === 1 && P.Part.PosP > 0) PredPart();
  if (P.LineI <= 1) return P.LineI;
  if (Tg(P.LineI - 1) === LF) return SetCurrI(P.LineI - 2);
  return SetCurrI(P.LineI - 1);
}

// PAS: EDEVPROC.PAS WrChar – nested in HandleEvent
export function WrChar(Ch: string): void {
  const P = EdPriv;
  const F = EdFrame;
  if (EditorVars.Insert) {
    if (TestLastPos(P.Posi, P.Posi + 1)) {
      F.Arr[P.Posi] = ord(Ch);
      if (P.Posi < LineSize) P.Posi++;
    }
  } else {
    F.Arr[P.Posi] = ord(Ch);
    F.UpdatedL = true;
    if (P.Posi < LineSize) P.Posi++;
  }
}

// PAS: EDEVPROC.PAS Format – nested in HandleEvent: reformat T[First..Last) to the margins
export function Format(First: number, Last: number, Posit: number, Rep: boolean): void {
  const P = EdPriv;
  const V = EvFrame;
  const ev = EditorVars;
  const A = new Uint8Array(262); // array[1..260] of char, A[i]
  const AMax = 261;
  let fst: number;
  let lst: number;
  let ii1: number;
  let ii: number;
  let llst: number;
  let bool: boolean;
  let rp: number;
  let nb: number;
  let nw: number;
  let n: number;
  let RelPos: number;
  const LeftMarg = P.LeftMarg;
  const RightMarg = P.RightMarg;
  SetPart(First);
  fst = First - P.Part.PosP;
  llst = Last - P.Part.PosP;
  lst = llst > P.LenT ? P.LenT : llst;
  do {
    ii1 = P.LenT > 0x400 ? P.LenT - 0x400 : 0;
    if (fst >= ii1 && !P.AllRd) {
      NextPartDek();
      fst -= P.Part.MovI;
      lst -= P.Part.MovI;
      llst -= P.Part.MovI;
      lst = llst > P.LenT ? P.LenT : llst;
    }
    V.I = fst;
    ii1 = V.I;
    if (V.I < 2 || Tg(V.I - 1) === LF) {
      while (Tg(ii1) === 0x20) ii1++;
      Posit = MaxW(Posit, ii1 - V.I + 1);
    }
    ii1 = V.I;
    RelPos = 1;
    if (Posit > 1) {
      for (let k = 0; k < Posit && k + 1 <= AMax; k++) A[k + 1] = Tg(V.I + k);
      for (ii = 1; ii <= Posit - 1; ii++) {
        if (!IsCtrlKey(Tg(V.I))) RelPos++;
        if (Tg(V.I) === CR) A[ii] = 0x20;
        else V.I++;
      }
      if (Tg(V.I) === 0x20 && A[Posit - 1] !== 0x20) {
        Posit++;
        RelPos++;
      }
    }
    while (V.I < lst) {
      bool = true;
      nw = 0;
      nb = 0;
      if (RelPos < LeftMarg) {
        if (Posit === 1 || A[Posit - 1] === 0x20) {
          ii = LeftMarg - RelPos;
          A.fill(0x20, Posit, Math.min(Posit + ii, AMax + 1));
          Posit += ii;
          RelPos = LeftMarg;
        } else {
          while (RelPos < LeftMarg) {
            Posit++;
            if (!IsCtrlKey(Tg(V.I))) RelPos++;
            if (Tg(V.I) !== CR) V.I++;
            if (Tg(V.I) === CR) A[Posit] = 0x20;
            else A[Posit] = Tg(V.I);
          }
        }
      }
      while (RelPos <= RightMarg && V.I < lst) {
        if (Tg(V.I) === CR || Tg(V.I) === 0x20) {
          while ((Tg(V.I) === CR || Tg(V.I) === 0x20) && V.I < lst) {
            if (Tg(V.I + 1) === LF) lst = V.I;
            else {
              Ts(V.I, 0x20);
              V.I++;
            }
          }
          if (!bool) {
            nw++;
            if (V.I < lst) V.I--;
          }
        }
        if (V.I < lst) {
          bool = false;
          A[Posit] = Tg(V.I);
          if (!IsCtrlKey(A[Posit])) RelPos++;
          V.I++;
          Posit++;
        }
      }
      if (V.I < lst && Tg(V.I) !== 0x20 && Tg(V.I) !== CR) {
        ii = Posit - 1;
        if (IsCtrlKey(A[ii])) ii--;
        rp = RelPos;
        RelPos--;
        while (A[ii] !== 0x20 && ii > LeftMarg) {
          if (!IsCtrlKey(A[ii])) RelPos--;
          ii--;
        }
        if (RelPos > LeftMarg) {
          nb = rp - RelPos;
          V.I -= Posit - ii;
          Posit = ii;
        } else {
          while (Tg(V.I) !== 0x20 && Tg(V.I) !== CR && Posit < LineSize) {
            A[Posit] = Tg(V.I);
            V.I++;
            Posit++;
          }
          while ((Tg(V.I) === CR || Tg(V.I) === 0x20) && V.I < lst) {
            if (Tg(V.I + 1) === LF) lst = V.I;
            else {
              Ts(V.I, 0x20);
              V.I++;
            }
          }
        }
      }
      if (ev.Just) {
        ii = LeftMarg;
        while (nb > 0 && nw > 1) {
          while (ii < AMax && A[ii] === 0x20) ii++;
          while (ii < AMax && A[ii] !== 0x20) ii++;
          nw--;
          n = Math.trunc(nb / nw);
          if (nw % nb !== 0 && (nw & 1) === 1 && nb > n) n++;
          if (Posit - ii > 0) A.copyWithin(ii + n, ii, Math.min(ii + Posit - ii + 1, AMax + 1));
          A.fill(0x20, ii, Math.min(ii + n, AMax + 1));
          Posit += n;
          nb -= n;
        }
      }
      ii = 1;
      while (ii < AMax && A[ii] === 0x20) ii++;
      if (ii >= Posit) Posit = 1;
      if (V.I < lst) A[Posit] = CR;
      else Posit--;
      TestLenText(V.I, ii1 + Posit);
      if (Posit > 0) P.T!.set(A.subarray(1, 1 + Posit), ii1 - 1);
      ii = ii1 + Posit - V.I;
      V.I = ii1 + Posit;
      lst += ii;
      llst += ii;
      Posit = 1;
      RelPos = 1;
      ii1 = V.I;
    }
    if (Rep) {
      while (Tg(V.I) === CR || Tg(V.I) === LF) V.I++;
      fst = V.I;
      Rep = V.I < llst;
      lst = llst > P.LenT ? P.LenT : llst;
    }
  } while (Rep);
  P.BegBLn = 1;
  P.BegBPos = 1;
  P.EndBLn = 1;
  P.EndBPos = 1;
  P.TypeB = TextBlock;
}

// PAS: EDEVPROC.PAS Calculate – nested in HandleEvent: Ctrl+F5 calculator (Ctrl+F4 inserts the result)
export function Calculate(): void {
  const P = EdPriv;
  const F = EdFrame;
  const av = AccessVars;
  const bv = BaseVars;
  const dv = DriversVars;
  const rv = RdRunVars;
  const Txt = ref('');
  let I = 1;
  let Del = false;
  const er = new ExitRecord();
  NewExit(null, er);
  try {
    let lbl = 0;
    for (;;) {
      try {
        if (lbl === 0) {
          ResetCompilePars();
          av.RdFldNameFrml = RdFldNameFrmlT;
          lbl = 10; // 0:
        }
        if (lbl === 10) {
          Txt.v = rv.CalcTxt;
          Del = true;
          I = 1;
        } else if (lbl === 2) {
          // 2:
          const Msg = bv.MsgLine;
          I = av.CurrPos;
          SetMsgPar(Msg);
          WrLLF10Msg(110);
          av.IsCompileErr = false;
          Del = false;
        }
        lbl = 1;
        // 1:
        RunEdiVars.TxtEdCtrlUBrk = true;
        RunEdiVars.TxtEdCtrlF4Brk = true;
        PromptLL(114, Txt, I, Del);
        if (dv.KbdChar === _U_) {
          lbl = 10;
          continue;
        }
        if (dv.KbdChar === _ESC_ || Txt.v.length === 0) break; // 3
        rv.CalcTxt = Txt.v;
        if (dv.KbdChar === _CtrlF4_ && P.Mode === TextM && !F.Scroll) {
          if (Txt.v.length > LineSize - LastPosLine()) {
            I = LineSize - LastPosLine();
            WrLLF10Msg(419);
            continue;
          }
          if (P.Posi <= LastPosLine()) TestLastPos(P.Posi, P.Posi + Txt.v.length);
          for (let k = 0; k < Txt.v.length; k++) F.Arr[P.Posi + k] = Txt.v.charCodeAt(k);
          F.UpdatedL = true;
          break; // 3
        }
        SetInpStr(Txt);
        RdLex();
        const FTyp = ref('\0');
        const Z: FrmlPtr = RdFrml(FTyp);
        if (av.Lexem !== '\x1a') Error(21);
        switch (FTyp.v) {
          case 'R': {
            const R = RunReal(Z);
            let t = StrR(R, 30, 10);
            t = LeadChar(' ', TrailChar('0', t));
            if (t[t.length - 1] === '.') t = t.slice(0, -1);
            Txt.v = t;
            break;
          }
          case 'S':
            Txt.v = RunShortStr(Z); // wie RdMode fuer T ??
            break;
          case 'B':
            Txt.v = RunBool(Z) ? bv.AbbrYes : bv.AbbrNo;
            break;
        }
        I = 1;
      } catch (e) {
        if (!(e instanceof GoExitSignal)) throw e;
        lbl = 2;
      }
    }
  } finally {
    // 3:
    RestoreExit(er);
  }
}

// ---------------------------------------------------------------- BLOCK

// PAS: EDEVPROC.PAS BlockExist – nested in HandleEvent
export function BlockExist(): boolean {
  const P = EdPriv;
  if (P.TypeB === TextBlock) return P.BegBLn < P.EndBLn || (P.BegBLn === P.EndBLn && P.BegBPos < P.EndBPos);
  return P.BegBLn <= P.EndBLn && P.BegBPos < P.EndBPos;
}

// PAS: EDEVPROC.PAS SetBlockBound – nested in HandleEvent: absolute text positions of the block
export function SetBlockBound(BBPos: Ref<number>, EBPos: Ref<number>): void {
  const P = EdPriv;
  SetPartLine(P.EndBLn);
  const i = ref(P.EndBLn - P.Part.LineP);
  EBPos.v = SetInd(FindLine(i), P.EndBPos) + P.Part.PosP;
  SetPartLine(P.BegBLn);
  i.v = P.BegBLn - P.Part.LineP;
  BBPos.v = SetInd(FindLine(i), P.BegBPos) + P.Part.PosP;
}

// PAS: EDEVPROC.PAS BlockHandle.LowCase (nested)
function LowCase(c: number): number {
  if (c >= 0x41 && c <= 0x5a) return c + 0x20;
  const tab = BaseVars.UpcCharTab;
  for (let i = 128; i <= 255; i++) if (tab[i] === c && i !== c) return i;
  return c;
}

// PAS: EDEVPROC.PAS BlockHandle – nested in HandleEvent: Y delete, U/L case, P/p print, W write
export function BlockHandle(Oper: string): boolean {
  const P = EdPriv;
  const F = EdFrame;
  const V = EvFrame;
  const bv = BaseVars;
  const Arr = F.Arr;
  let I1 = 0;
  let I2 = 0;
  const LL1 = ref(0);
  const LL2 = ref(0);
  let co = '';
  let isPrintFile = false;
  let p: Uint8Array | null = null;
  let tb = false;
  // PAS: BlockHandle.ResetPrint (nested)
  const ResetPrint = (LenPrint: number): void => {
    const c = { v: P.Part.ColorP };
    SetColorOrd(c, 1, I1);
    co = c.v;
    isPrintFile = false;
    V.fs = co.length;
    LenPrint += V.fs;
    if (Oper === 'p') LenPrint++;
    if (StoreAvail() > LenPrint && LenPrint < 0xfff0) {
      p = new Uint8Array(LenPrint + co.length + 2);
      for (let k = 0; k < co.length; k++) p[k] = co.charCodeAt(k);
    } else {
      isPrintFile = true;
      V.W1 = bv.WorkHandle;
      SeekH(V.W1, 0);
      const b = new Uint8Array(co.length);
      for (let k = 0; k < co.length; k++) b[k] = co.charCodeAt(k);
      WriteH(V.W1, co.length, b);
      HMsgExit(bv.CPath);
    }
  };
  TestKod();
  const Ln = LineAbs(F.LineL);
  const Ps = P.Posi;
  if (Oper === 'p') {
    tb = P.TypeB;
    P.TypeB = TextBlock;
  } else if (!BlockExist()) return false;
  CrsHide();
  if (P.TypeB === TextBlock) {
    if (Oper === 'p') {
      LL2.v = P.AbsLenT - P.Part.LenP + P.LenT;
      LL1.v = P.Part.PosP + SetInd(P.LineI, P.Posi);
    } else SetBlockBound(LL1, LL2);
    I1 = LL1.v - P.Part.PosP;
    if (UpCase(Oper) === 'P') ResetPrint(LL2.v - LL1.v);
    do {
      if (LL2.v > P.Part.PosP + P.LenT) I2 = P.LenT;
      else I2 = LL2.v - P.Part.PosP;
      switch (Oper) {
        case 'Y':
          TestLenText(I2, I1);
          LL2.v -= I2 - I1;
          break;
        case 'U': {
          const tab = bv.UpcCharTab;
          for (let i = I1; i <= I2 - 1; i++) Ts(i, tab[Tg(i)]);
          LL1.v += I2 - I1;
          break;
        }
        case 'L':
          for (let i = I1; i <= I2 - 1; i++) Ts(i, LowCase(Tg(i)));
          LL1.v += I2 - I1;
          break;
        case 'p':
        case 'P':
          if (isPrintFile) {
            WriteH(V.W1, I2 - I1, P.T!.subarray(I1 - 1));
            HMsgExit(bv.CPath);
          } else if (I2 > I1) (p as Uint8Array | null)!.set(P.T!.subarray(I1 - 1, I2 - 1), V.fs);
          V.fs += I2 - I1;
          LL1.v += I2 - I1;
          break;
        case 'W':
          SeekH(V.W1, V.fs);
          WriteH(V.W1, I2 - I1, P.T!.subarray(I1 - 1));
          HMsgExit(bv.CPath);
          V.fs += I2 - I1;
          LL1.v += I2 - I1;
          break;
      }
      if (Oper === 'U' || Oper === 'L' || Oper === 'Y') SetUpdat();
      if (Oper === 'p' && P.AllRd) LL1.v = LL2.v;
      if (!P.AllRd && LL1.v < LL2.v) {
        I1 = P.LenT;
        NextPart();
        I1 -= P.Part.MovI;
      }
    } while (LL1.v !== LL2.v);
  } else {
    // ColBlock
    PosDekFindLine(P.BegBLn, P.BegBPos, false);
    I1 = P.EndBPos - P.BegBPos;
    LL1.v = (P.EndBLn - P.BegBLn + 1) * (I1 + 2);
    LL2.v = 0;
    if (Oper === 'P') ResetPrint(LL1.v);
    do {
      switch (Oper) {
        case 'Y':
          TestLastPos(P.EndBPos, P.BegBPos);
          break;
        case 'U': {
          const tab = bv.UpcCharTab;
          for (let i = P.BegBPos; i <= P.EndBPos - 1; i++) Arr[i] = tab[Arr[i]];
          F.UpdatedL = true;
          break;
        }
        case 'L':
          for (let i = P.BegBPos; i <= P.EndBPos - 1; i++) Arr[i] = LowCase(Arr[i]);
          F.UpdatedL = true;
          break;
        case 'W':
        case 'P': {
          const a = new Uint8Array(I1 + 2); // ArrLine
          a.set(Arr.subarray(P.BegBPos, P.BegBPos + I1));
          a[I1] = CR;
          a[I1 + 1] = LF;
          if (Oper === 'P' && !isPrintFile) (p as Uint8Array | null)!.set(a, V.fs);
          else {
            WriteH(V.W1, I1 + 2, a);
            HMsgExit(bv.CPath);
          }
          V.fs += I1 + 2;
          break;
        }
      }
      LL2.v += I1 + 2;
      NextLine(false);
    } while (LL2.v !== LL1.v);
  }
  if (UpCase(Oper) === 'P') {
    if (isPrintFile) {
      TruncAtPos(V.W1); // WriteH(W1,0,T^) {truncH}
      PrintFandWork();
    } else PrintArray(p!, V.fs, false);
  }
  if (Oper === 'p') P.TypeB = tb;
  if (Oper === 'Y') PosDekFindLine(P.BegBLn, P.BegBPos, true);
  else {
    if (Oper === 'p') SetPart(1);
    PosDekFindLine(Ln, Ps, true);
  }
  if (!F.Scroll) CrsShow();
  return true;
}

// PAS: EDEVPROC.PAS DelStorClpBd – nested in HandleEvent: sp becomes the clipboard
export function DelStorClpBd(): void {
  const av = AccessVars;
  av.TWork.Delete(av.ClpBdPos);
  av.ClpBdPos = av.TWork.Store(EvFrame.sp!);
}
// PAS: EDEVPROC.PAS MarkRdClpBd – nested in HandleEvent: sp := the clipboard
export function MarkRdClpBd(): void {
  EvFrame.P1 = null as Pointer; // MarkStore2(P1)
  EvFrame.sp = AccessVars.TWork.Read(2, AccessVars.ClpBdPos);
}

// PAS: EDEVPROC.PAS BlockGrasp.MovePart (nested)
function MovePart(Ind: number): void {
  const P = EdPriv;
  const Part = P.Part;
  if (P.TypeT !== FileT) return;
  TestUpdFile();
  WrEndT();
  Part.MovI = SetCurrI(Ind) - 1;
  Part.MovL = SetLine(Part.MovI) - 1;
  Part.LineP += Part.MovL;
  Part.PosP += Part.MovI;
  Part.LenP -= Part.MovI;
  const c = { v: Part.ColorP };
  SetColorOrd(c, 1, Part.MovI + 1);
  Part.ColorP = c.v;
  TestLenText(Part.MovI + 1, 1);
  P.ChangePart = true;
}

// PAS: EDEVPROC.PAS BlockGrasp – nested in HandleEvent: the text block into sp (G: clipboard, M: cut)
export function BlockGrasp(Oper: string): boolean {
  const P = EdPriv;
  const F = EdFrame;
  if (!BlockExist()) return false;
  let L = P.Part.PosP + P.LineI + P.Posi - 1;
  let ln = LineAbs(F.LineL);
  if (Oper === 'G') TestKod();
  const L1 = ref(0);
  const L2 = ref(0);
  SetBlockBound(L1, L2);
  if (L > L1.v && L < L2.v && Oper !== 'G') return false;
  L = L2.v - L1.v;
  if (L > 0x7fff) {
    WrLLF10Msg(418);
    return false;
  }
  if (L2.v > P.Part.PosP + P.LenT) MovePart(L1.v - P.Part.PosP);
  const I1 = L1.v - P.Part.PosP;
  EvFrame.sp = P.T!.slice(I1 - 1, I1 - 1 + L); // MarkStore2(P1); GetStore2(L+2)
  if (Oper === 'M') {
    TestLenText(I1 + L, I1);
    if (P.EndBLn <= ln) {
      if (P.EndBLn === ln && P.Posi >= P.EndBPos) P.Posi = P.BegBPos + P.Posi - P.EndBPos;
      ln -= P.EndBLn - P.BegBLn;
    }
  }
  if (Oper === 'G') DelStorClpBd();
  PosDekFindLine(ln, P.Posi, false);
  return true;
}

// PAS: EDEVPROC.PAS BlockDrop – nested in HandleEvent: insert sp at the cursor (D: the clipboard)
export function BlockDrop(Oper: string): void {
  const P = EdPriv;
  const F = EdFrame;
  if (Oper === 'D') MarkRdClpBd();
  const sp = EvFrame.sp!;
  if (sp.length === 0) return;
  if (Oper === 'D') FillBlank();
  let I = P.LineI + P.Posi - 1;
  const I2 = sp.length;
  P.BegBLn = LineAbs(F.LineL);
  P.BegBPos = P.Posi;
  NullChangePart();
  TestLenText(I, I + I2);
  if (P.ChangePart) I -= P.Part.MovI;
  P.T!.set(sp.subarray(0, I2), I - 1);
  SetDekLnCurrI(I + I2);
  P.EndBLn = P.Part.LineP + F.LineL;
  P.EndBPos = I + I2 - P.LineI + 1;
  PosDekFindLine(P.BegBLn, P.BegBPos, true);
}

// PAS: EDEVPROC.PAS BlockCGrasp – nested in HandleEvent: the column block into sp
export function BlockCGrasp(Oper: string): boolean {
  const P = EdPriv;
  const F = EdFrame;
  if (!BlockExist()) return false;
  TestKod();
  const L = LineAbs(F.LineL);
  const LInB = L >= P.BegBLn && L <= P.EndBLn;
  if (LInB && P.Posi >= P.BegBPos + 1 && P.Posi <= P.EndBPos - 1 && Oper !== 'G') return false;
  const l1 = (P.EndBLn - P.BegBLn + 1) * (P.EndBPos - P.BegBPos + 2);
  if (l1 > 0x7fff) {
    WrLLF10Msg(418);
    return false;
  }
  const sp = new Uint8Array(l1); // MarkStore2(P1); GetStore2(l1+2); sp^.LL:=l1
  EvFrame.sp = sp;
  PosDekFindLine(P.BegBLn, P.Posi, false);
  let I2 = 0;
  const i = P.EndBPos - P.BegBPos;
  do {
    const a = new Uint8Array(i + 2);
    a.set(F.Arr.subarray(P.BegBPos, P.BegBPos + i));
    a[i] = CR;
    a[i + 1] = LF;
    if (Oper === 'M') TestLastPos(P.EndBPos, P.BegBPos);
    sp.set(a, I2);
    I2 += i + 2;
    TestKod();
    NextLine(false);
  } while (I2 !== sp.length);
  if (Oper === 'M' && LInB && P.Posi > P.EndBPos) P.Posi -= P.EndBPos - P.BegBPos;
  if (Oper === 'G') DelStorClpBd();
  PosDekFindLine(L, P.Posi, false);
  return true;
}

// PAS: EDEVPROC.PAS BlockCDrop – nested in HandleEvent: insert sp as a column block (R: file read)
export function BlockCDrop(Oper: string): void {
  const P = EdPriv;
  const F = EdFrame;
  if (Oper === 'D') MarkRdClpBd();
  const sp = EvFrame.sp!;
  if (sp.length === 0) return;
  let i = 0;
  let I1 = 1;
  let I3 = 1;
  let ww: number;
  // PAS: BlockCDrop.InsertLine (nested)
  const InsertLine = (): void => {
    i = MinW(I1 - I3, LineSize - LastPosLine());
    if (i > 0) {
      TestLastPos(ww, ww + i);
      F.Arr.set(sp.subarray(I3 - 1, I3 - 1 + i), ww);
    }
    TestKod();
  };
  if (Oper !== 'R') {
    P.EndBPos = P.Posi;
    P.BegBPos = P.Posi;
    P.BegBLn = F.LineL + P.Part.LineP;
  }
  ww = P.BegBPos;
  do {
    const c = sp[I1 - 1] ?? 0;
    if (c === CR) {
      InsertLine();
      ww = P.BegBPos;
      P.EndBPos = MaxW(ww + i, P.EndBPos);
      if (F.NextI > P.LenT && (P.TypeT !== FileT || P.AllRd)) {
        TestLenText(P.LenT, P.LenT + 2);
        Ts(P.LenT - 2, CR);
        Ts(P.LenT - 1, LF);
        F.NextI = P.LenT;
      }
      NextLine(false);
    }
    if (c === CR || c === LF || c === 0x1a) I3 = I1 + 1;
    I1++;
  } while (!(I1 > sp.length));
  if (I3 < I1) InsertLine();
  if (Oper !== 'R') {
    P.EndBLn = P.Part.LineP + F.LineL - 1;
    PosDekFindLine(P.BegBLn, P.BegBPos, true);
  }
}

// PAS: EDEVPROC.PAS BlockCopyMove – nested in HandleEvent
export function BlockCopyMove(Oper: string): void {
  if (!BlockExist()) return;
  FillBlank();
  if (EdPriv.TypeB === TextBlock) {
    if (BlockGrasp(Oper)) BlockDrop(Oper);
  } else if (BlockCGrasp(Oper)) BlockCDrop(Oper);
}

// PAS: EDEVPROC.PAS ColBlockExist – nested in HandleEvent
export function ColBlockExist(): boolean {
  const P = EdPriv;
  if (P.TypeB === ColBlock && P.BegBPos === P.EndBPos && P.BegBLn < P.EndBLn) return true;
  return BlockExist();
}

// PAS: EDEVPROC.PAS BlockLRShift – nested in HandleEvent: Shift+left/right marks a block
export function BlockLRShift(I1: number): void {
  const P = EdPriv;
  const F = EdFrame;
  if (!F.Scroll && P.Mode !== HelpM && (DriversVars.KbdFlgs & 0x03) !== 0) {
    // Shift
    const L2 = LineAbs(F.LineL);
    // PAS: BlockLRShift.NewBlock (nested)
    const NewBlock = (): void => {
      if (I1 !== P.Posi) {
        P.BegBLn = L2;
        P.EndBLn = L2;
        P.BegBPos = MinW(I1, P.Posi);
        P.EndBPos = MaxW(I1, P.Posi);
      }
    };
    if (!ColBlockExist()) NewBlock();
    else if (P.TypeB === TextBlock) {
      if (P.BegBLn === P.EndBLn && L2 === P.BegBLn && P.EndBPos === P.BegBPos && I1 === P.BegBPos) {
        if (I1 > P.Posi) P.BegBPos = P.Posi;
        else P.EndBPos = P.Posi;
      } else if (L2 === P.BegBLn && I1 === P.BegBPos) P.BegBPos = P.Posi;
      else if (L2 === P.EndBLn && I1 === P.EndBPos) P.EndBPos = P.Posi;
      else NewBlock();
    } else {
      // ColBlock
      if (L2 >= P.BegBLn && L2 <= P.EndBLn) {
        if (P.EndBPos === P.BegBPos && I1 === P.BegBPos) {
          if (I1 > P.Posi) P.BegBPos = P.Posi;
          else P.EndBPos = P.Posi;
        } else if (I1 === P.BegBPos) P.BegBPos = P.Posi;
        else if (I1 === P.EndBPos) P.EndBPos = P.Posi;
        else NewBlock();
      } else NewBlock();
    }
  }
}

// PAS: EDEVPROC.PAS BlockUDShift – nested in HandleEvent: Shift+up/down marks a block
export function BlockUDShift(L1: number): void {
  const P = EdPriv;
  const F = EdFrame;
  if (!F.Scroll && P.Mode !== HelpM && (DriversVars.KbdFlgs & 0x03) !== 0) {
    // Shift
    const L2 = LineAbs(F.LineL);
    // PAS: BlockUDShift.NewBlock (nested)
    const NewBlock = (): void => {
      if (L1 !== L2) {
        P.BegBPos = P.Posi;
        P.EndBPos = P.Posi;
        P.BegBLn = MinL(L1, L2);
        P.EndBLn = MaxL(L1, L2);
      }
    };
    if (!ColBlockExist()) NewBlock();
    else if (P.TypeB === TextBlock) {
      if (P.BegBLn === P.EndBLn && L1 === P.BegBLn) {
        if (P.Posi >= P.BegBPos && P.Posi <= P.EndBPos) {
          if (L1 < L2) {
            P.EndBLn = L2;
            P.EndBPos = P.Posi;
          } else {
            P.BegBLn = L2;
            P.BegBPos = P.Posi;
          }
        } else NewBlock();
      } else if (L1 === P.BegBLn && P.BegBPos === P.Posi) P.BegBLn = L2;
      else if (L1 === P.EndBLn && P.EndBPos === P.Posi) P.EndBLn = L2;
      else NewBlock();
    } else {
      // ColBlock
      if (P.Posi >= P.BegBPos && P.Posi <= P.EndBPos) {
        if (P.BegBLn === P.EndBLn && L1 === P.BegBLn) {
          if (L1 < L2) P.EndBLn = L2;
          else P.BegBLn = L2;
        } else if (L1 === P.BegBLn) P.BegBLn = L2;
        else if (L1 === P.EndBLn) P.EndBLn = L2;
        else NewBlock();
      } else NewBlock();
    }
  }
}

// PAS: EDEVPROC.PAS MyPromptLL – nested in HandleEvent: true = Esc
export function MyPromptLL(n: number, s: Ref<string>): boolean {
  PromptLL(n, s, 1, true);
  return DriversVars.KbdChar === _ESC_;
}

// PAS: EDEVPROC.PAS FindReplaceString.MyVerifyLL (nested): Yes/No/Esc prompt, blinking cursor
function MyVerifyLL(n: number, s: string): string {
  const F = EdFrame;
  const bv = BaseVars;
  const dv = DriversVars;
  const c2 = WhereX() + F.FirstC - 1;
  const r2 = WhereY() + F.FirstR;
  const w = PushW(1, 1, bv.TxtCols, bv.TxtRows);
  GotoXY(1, bv.TxtRows);
  dv.TextAttr = bv.Colors.pTxt;
  ClrEol();
  SetMsgPar(s);
  WriteMsg(n);
  const c1 = WhereX();
  const r1 = WhereY();
  dv.TextAttr = bv.Colors.pNorm;
  TxtWrite(Output, ' ');
  CrsNorm();
  let t = dv.Timer + 15;
  let r = r1;
  let cc: string;
  do {
    while (!KbdPressed()) {
      if (dv.Timer >= t) {
        t = dv.Timer + 15;
        if (r === r1) {
          GotoXY(c2, r2);
          r = r2;
        } else {
          GotoXY(c1, r1);
          r = r1;
        }
      }
      BiosWaitKey(55); // TS: no busy wait
    }
    cc = UpCase(chr(ReadKbd()));
  } while (!(cc === bv.AbbrYes || cc === bv.AbbrNo || cc === '\x1b'));
  PopW(w);
  return cc;
}

// PAS: EDEVPROC.PAS FindReplaceString – nested in HandleEvent: find (and replace) in [First..Last)
export function FindReplaceString(First: number, Last: number): void {
  const P = EdPriv;
  const F = EdFrame;
  const bv = BaseVars;
  const fst = ref(0);
  let lst = 0;
  // PAS: FindReplaceString.ChangeP (nested)
  const ChangeP = (): void => {
    if (P.ChangePart) {
      if (fst.v <= P.Part.MovI) fst.v = 1;
      else fst.v -= P.Part.MovI;
      NullChangePart();
    }
  };
  // PAS: FindReplaceString.ReplaceString (nested)
  const ReplaceString = (J: Ref<number>): void => {
    const r = P.ReplaceStr.length;
    const f = P.FindStr.length;
    TestLenText(J.v, J.v + r - f);
    ChangeP();
    TestLastPos(P.Posi, P.Posi + r - f);
    for (let k = 0; k < r; k++) Ts(J.v - f + k, P.ReplaceStr.charCodeAt(k));
    J.v += r - f;
    SetScreen(J.v, 0, 0);
    lst += r - f;
    Last += r - f;
  };
  if (First >= Last) {
    if (P.TypeT === MemoT && TestOptStr('e')) {
      P.SrchT = true;
      F.Konec = true;
    }
    return;
  }
  P.FirstEvent = false;
  SetPart(First);
  fst.v = First - P.Part.PosP;
  NullChangePart();
  for (;;) {
    // 1:
    if (Last > P.Part.PosP + P.LenT) lst = P.LenT - 1;
    else lst = Last - P.Part.PosP;
    ChangeP(); // Background may call NextPart
    if (FindString(fst, lst)) {
      SetScreen(fst.v, 0, 0);
      if (P.Replace) {
        if (TestOptStr('n')) {
          ReplaceString(fst);
          UpdStatLine(F.LineL, P.Posi);
        } else {
          P.FirstEvent = true;
          Background();
          P.FirstEvent = false;
          const c = MyVerifyLL(408, '');
          if (c === bv.AbbrYes) ReplaceString(fst);
          else if (c === '\x1b') return;
        }
        if (TestOptStr('g') || TestOptStr('e') || TestOptStr('l')) continue;
      }
    } else if (!P.AllRd && Last > P.Part.PosP + P.LenT) {
      NextPart();
      continue;
    } else if (TestOptStr('e') && P.TypeT === MemoT) {
      P.SrchT = true;
      F.Konec = true;
    } else SetScreen(lst, 0, 0);
    return;
  }
}

// PAS: EDEVPROC.PAS HelpLU – nested in HandleEvent: help: previous word (left/up)
export function HelpLU(dir: string): void {
  const P = EdPriv;
  const F = EdFrame;
  const I = ref(0);
  const I1 = ref(0);
  const I2 = ref(0);
  ClrWord();
  const h1 = WordNo2();
  let h2: number;
  if (dir === 'U') {
    DekFindLine(F.LineL - 1);
    P.Posi = Position(F.Colu);
    h2 = MinW(h1, WordNo2() + 1);
  } else h2 = h1;
  if (WordFind(h2, I1, I2, I) && I.v >= F.ScrL - 1) SetWord(I1.v, I2.v);
  else {
    if (WordFind(h1 + 1, I1, I2, I) && I.v >= F.ScrL) SetWord(I1.v, I2.v);
    else {
      I1.v = SetInd(P.LineI, P.Posi);
      F.WordL = 0;
    }
    I.v = F.ScrL - 1;
  }
  if (I.v <= F.ScrL - 1) {
    DekFindLine(F.ScrL);
    RollPred();
  }
  if (WordExist()) SetDekLnCurrI(I1.v);
}

// PAS: EDEVPROC.PAS HelpRD – nested in HandleEvent: help: next word (right/down)
export function HelpRD(dir: string): void {
  const P = EdPriv;
  const F = EdFrame;
  const I = ref(0);
  const I1 = ref(0);
  const I2 = ref(0);
  ClrWord();
  let h1 = WordNo2();
  if (WordExist()) h1++;
  let h2: number;
  if (dir === 'D') {
    NextLine(false);
    P.Posi = Position(F.Colu);
    while (P.Posi > 0 && F.Arr[P.Posi] !== 0x13) P.Posi--;
    P.Posi++;
    h2 = MaxW(h1 + 1, WordNo2() + 1);
  } else h2 = h1 + 1;
  if (WordFind(h2, I1, I2, I) && I.v <= F.ScrL + F.PageS) SetWord(I1.v, I2.v);
  else {
    if (WordNo2() > h1) h1++;
    if (WordFind(h1, I1, I2, I) && I.v <= F.ScrL + F.PageS) SetWord(I1.v, I2.v);
    else {
      I1.v = SetInd(P.LineI, P.Posi);
      F.WordL = 0;
    }
    I.v = F.ScrL + F.PageS;
  }
  if (I.v >= F.ScrL + F.PageS) {
    DekFindLine(F.ScrL + F.PageS - 1);
    RollNext();
  }
  if (WordExist()) SetDekLnCurrI(I1.v);
}
