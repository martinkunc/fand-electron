// PAS: EDITOR.PAS (+ EDGLOBAL, EDTEXTF, EDEDIT with EDSCREEN, EDEVENT, EDEVINPT, EDEVPROC) – the
// FAND text editor: memo/T fields, local texts, text files (edited in parts), help viewer, the
// print view, block operations, find/replace, formatting, frame drawing.
//
// Porting notes:
// * Structure: EDITOR.PAS holds the interface routines and the editor globals; it includes
//   edglobal.ts (search helpers, messages), edtextf.ts (reading/writing a text file in parts) and
//   ededit.ts (procedure Edit). Edit itself includes edscreen.ts and edevent.ts, whose routines are
//   *nested in Edit* and share its locals (EdFrame in ededit.ts); HandleEvent (edevent.ts) includes
//   edevinpt.ts and edevproc.ts, nested in HandleEvent (its locals: EvFrame in edevent.ts).
//   None of the include routines is in the interface; they are exported only for each other.
// * asm/DOS: Ovr (no-op); BP7 asm FindChar/FindUpcChar/FindOrdChar/FindCtrl (EDGLOBAL; FindChar
//   keeps BP7's untouched Num); Edit/ScrollPress read the Scroll Lock bit at 0:$417 (FPC: always
//   off, so Scroll mode only comes from ViewM); EDEDIT `Regs: registers` (BP7 only).
//   EditWrline/ScrollWrline build Uint16Array screen lines (lo char, hi attr) for ScrWrBuf.
//   EDEVENT inserts Ctrl chars for keys $1001..$101F (FPC; BP7 $1000..$101F, $1000 = ^P^@).
// * Text buffer (TS): Pascal grows the text T on the heap behind it (GetStore/ReleaseStore). Here T
//   is a Uint8Array with room for MaxLenT + TSlack bytes (TxtBuf). EditText uses the caller's
//   pTxtPtr only when it is that large, otherwise it edits a copy; the edited text is always
//   EditorVars.EdTxt[0..pLen-1] after EditText, and is copied back into pTxtPtr when it fits
//   (a LongStr's array cannot grow: callers take the result from EdTxt).
// * SavePar/RestorePar (TS): Pascal copies Insert..Just and the Mode..T block into TWork; the
//   block holds pointers, so here it is a snapshot object kept in memory under the returned number.
// * Re-entrancy: Edit saves/restores its frame (EdFrame) and HandleEvent's (EvFrame) around a run,
//   since an exit procedure or Help may run a nested Edit (Pascal keeps them on the stack).

import { ref, CopyRec, GoExitSignal, word, type Ref } from './pasrt.ts';
import type { CharArrPtr, LongintPtr, StringPtr, WRectPtr, LongStrPtr } from './base.ts';
import {
  BaseVars, WRect, MaxLStrLen, WPushPixel, WNoPop, ExitRecord, NewExit, RestoreExit, MinI, MaxI,
  RdMsg, SetMsgPar, Set2MsgPar, FindCtrlM, SkipCtrlMJ, FileSizeH, CloseH, DeleteFile,
} from './base.ts';
import type { FileDPtr, RdbDPtr, RdbD } from './access.ts';
import { AccessVars, StoreInTWork } from './access.ts';
import type { EdExitDPtr, InstrPtr } from './rdrun.ts';
import { RdRunVars } from './rdrun.ts';
import {
  DriversVars, _F1, _F6, _F9, _F10, _AltF10, _CtrlHome, _CtrlEnd, _AltEqual_, _U_, _ESC_, _F9_, _AltF10_, _F1_,
  _F6_, _F10_, _CtrlHome_, _CtrlEnd_, _CtrlF1_, _L_,
} from './drivers.ts';
import { PushW, PushW1, PushWFramed, PopW, PopW2, WrLLF10Msg } from './obaseww.ts';
import { PrintArray, PrintTxtFile } from './printtxt.ts';
import { SetPrintTxtPath } from './obase.ts';
import { RunBool, RunInt } from './runfrml.ts';
import { GetHlpText } from './wwmenu.ts';
import { Edit } from './ededit.ts';
import { FindString, SimplePrintHead } from './edglobal.ts';
import { OpenTxtFh, RdFirstPart, RdNextPart, RdPart } from './edtextf.ts';

// PAS: EDITOR.PAS MsgStr – last-line messages of the editor
export class MsgStr {
  Head: StringPtr = null;
  Last: StringPtr = null;
  CtrlLast: StringPtr = null;
  AltLast: StringPtr = null;
  ShiftLast: StringPtr = null;
}
export type MsgStrPtr = MsgStr | null;

export const TextM = 'T';
export const ViewM = 'V';
export const HelpM = 'H';
export const SinFM = 'S';
export const DouFM = 'D';
export const DelFM = 'F';
export const NotFM = 'N';
export const FileT = 'F';
export const LocalT = 'V';
export const MemoT = 'M';

export const EditorVars = {
  Insert: false,
  Indent: false,
  Wrap: false,
  Just: false,
  /** TS-only: the text buffer of the last EditText (the text is EdTxt[0..pLen-1]), see the notes. */
  EdTxt: null as CharArrPtr,
};

// ---------------------------------------------------------------- implementation section (TS-only export)

export const InterfL = 4; // sizeof(Insert+Indent+Wrap+Just)
export const LineSize = 255;
export const SuccLineSize = 256;
export const TextStore = 0x1000;
export const TStatL = 35; // =10(Row:Col)+length(InsMsg+IndMsg+WrapMsg+JustMsg+BlockMsg)
export const CountC = 7;
export const ColBlock = true;
export const TextBlock = false;
// Oddel: word separators [#1..#47, #58..#64, #91..#94, #96, #123..#127]
export function IsOddel(c: number): boolean {
  return (c >= 1 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 94) || c === 96 || (c >= 123 && c <= 127);
}
// two-key commands (^Q.., ^K.., ^O..) and frame characters
export const _QY_ = 0x1119;
export const _QL_ = 0x110c;
export const _QK_ = 0x110b;
export const _QB_ = 0x1102;
export const _QI_ = 0x1109;
export const _QF_ = 0x1106;
export const _QE_ = 0x1105;
export const _QX_ = 0x1118;
export const _QA_ = 0x1101;
export const _framesingle_ = 0x112d;
export const _framedouble_ = 0x113d;
export const _delframe_ = 0x112f;
export const _frmsin_ = 0x2d;
export const _frmdoub_ = 0x3d;
export const _dfrm_ = 0x2f;
export const _nfrm_ = 0x20;
export const _KB_ = 0x0b02;
export const _KK_ = 0x0b0b;
export const _KH_ = 0x0b08;
export const _KS_ = 0x0b13;
export const _KY_ = 0x0b19;
export const _KC_ = 0x0b03;
export const _KV_ = 0x0b16;
export const _KW_ = 0x0b17;
export const _KR_ = 0x0b12;
export const _KP_ = 0x0b10;
export const _KN_ = 0x0b0e;
export const _KU_ = 0x0b15;
export const _KL_ = 0x0b0c;
export const _OW_ = 0x0f17;
export const _OL_ = 0x0f0c;
export const _OR_ = 0x0f12;
export const _OJ_ = 0x0f0a;
export const _OC_ = 0x0f03;
export const _KF_ = 0x0b06;
// ^S underline, ^W italic, ^Q expanded, ^D double, ^B bold, ^E compressed, ^A elite
export const CtrlKey = '\x13\x17\x11\x04\x02\x05\x01';

/** EDITOR.PAS ColorOrd = string[CountC] – the pending colour control chars of a line. */
export type ColorOrd = string;

// PAS: EDITOR.PAS PartDescr – the part of a text file held in T
export class PartDescr {
  PosP = 0;
  LineP = 0;
  LenP = 0;
  MovI = 0;
  MovL = 0;
  UpdP = false;
  ColorP: ColorOrd = '';
}

/** One entry of the help stack (EDITOR.PAS Stk). */
export class HelpStkEntry {
  Rdb: RdbDPtr = null;
  FD: FileDPtr = null;
  iR = 0;
  iT = 0;
}
export const maxStk = 15;

/**
 * TS-only: the implementation-section globals of EDITOR. Mode..T is the block SavePar/RestorePar
 * save (together with Insert..Just of EditorVars); iStk/Stk (help stack) are not part of it.
 */
export const EdPriv = {
  // ---- global params (SavePar block begin)
  Mode: '\x00',
  TypeT: '\x00',
  NameT: '',
  ErrMsg: '',
  MaxLenT: 0,
  LenT: 0,
  IndT: 0,
  ScrT: 0,
  Breaks: '',
  ExitD: null as EdExitDPtr,
  SrchT: false,
  UpdatT: false,
  LastNr: 0,
  CtrlLastNr: 0,
  LeftMarg: 0,
  RightMarg: 0,
  TypeB: false,
  LastS: null as StringPtr,
  CtrlLastS: null as StringPtr,
  ShiftLastS: null as StringPtr,
  AltLastS: null as StringPtr,
  HeadS: null as StringPtr,
  LocalPPtr: null as LongintPtr,
  EditT: false,
  ColKey: new Array<number>(CountC + 1).fill(0), // [0..CountC]
  TxtColor: 0,
  BlockColor: 0,
  SysLColor: 0,
  InsMsg: '',
  nInsMsg: '',
  IndMsg: '',
  WrapMsg: '',
  JustMsg: '',
  BlockMsg: '',
  ViewMsg: '',
  CharPg: '\x00',
  InsPg: false,
  BegBLn: 0,
  EndBLn: 0,
  BegBPos: 0,
  EndBPos: 0,
  ScrI: 0, // screen status
  LineI: 0,
  Posi: 0,
  BPos: 0,
  FindStr: '',
  ReplaceStr: '',
  Replace: false,
  OptionStr: '',
  FirstEvent: false,
  PHNum: 0, // paging in Scroll
  PPageS: 0,
  Part: new PartDescr(),
  TxtFH: 0,
  TxtPath: '',
  TxtVol: '',
  AllRd: false,
  AbsLenT: 0,
  ChangePart: false,
  UpdPHead: false,
  T: null as CharArrPtr,
  // ---- SavePar block end
  // help stack (typed constant iStk)
  iStk: 0,
  Stk: Array.from({ length: maxStk + 1 }, () => new HelpStkEntry()), // [1..maxStk]
};

// ---------------------------------------------------------------- TS-only text buffer helpers

/** TS-only: extra room behind MaxLenT (the CR of WrEndT, a part read of $1000, SmallerPart). */
export const TSlack = 0x1100;

/** TS-only: a text buffer that can hold MaxLen + TSlack bytes, starting with p[0..Len-1]. */
export function TxtBuf(p: CharArrPtr, Len: number, MaxLen: number): Uint8Array {
  const need = MaxLen + TSlack;
  if (p !== null && p.length >= need) return p;
  const t = new Uint8Array(need);
  if (p !== null) t.set(p.subarray(0, Math.min(Len, p.length)));
  return t;
}

/** TS-only: T^[i] (1-based); a byte outside the buffer reads 0 (Pascal: stray heap bytes). */
export function Tg(i: number): number {
  return EdPriv.T![i - 1] ?? 0;
}
/** TS-only: T^[i] := b */
export function Ts(i: number, b: number): void {
  EdPriv.T![i - 1] = b;
}
/** TS-only: move(T^[src], T^[dst], n) */
export function TMove(src: number, dst: number, n: number): void {
  if (n <= 0) return;
  EdPriv.T!.copyWithin(dst - 1, src - 1, src - 1 + n);
}

// ---------------------------------------------------------------- SavePar / RestorePar

// PAS: EDITOR.PAS Ovr – overlay stack fix-up for NewExit (no-op)
export function Ovr(): void {}

/** TS-only: the fields of the SavePar block (EdPriv Mode..T). */
const SaveParKeys = (Object.keys(EdPriv) as (keyof typeof EdPriv)[]).filter((k) => k !== 'iStk' && k !== 'Stk');
type SaveParSnap = { intf: [boolean, boolean, boolean, boolean]; priv: Record<string, unknown> };
const SaveParStore = new Map<number, SaveParSnap>();
let SaveParNr = 0;

// PAS: EDITOR.PAS InterfLen – unit-internal
export function InterfLen(): number {
  return InterfL;
}
// PAS: EDITOR.PAS SavePar – unit-internal: save the editor state (TS: in memory, see the notes)
export function SavePar(): number {
  const ev = EditorVars;
  const priv: Record<string, unknown> = {};
  const src = EdPriv as unknown as Record<string, unknown>;
  for (const k of SaveParKeys) {
    const v = src[k];
    if (Array.isArray(v)) priv[k] = v.slice();
    else if (v instanceof PartDescr) priv[k] = CopyRec(v);
    else priv[k] = v;
  }
  SaveParNr++;
  SaveParStore.set(SaveParNr, { intf: [ev.Insert, ev.Indent, ev.Wrap, ev.Just], priv });
  return SaveParNr;
}
// PAS: EDITOR.PAS RestorePar – unit-internal
export function RestorePar(l: number): void {
  const s = SaveParStore.get(l);
  if (s === undefined) return;
  SaveParStore.delete(l);
  const ev = EditorVars;
  [ev.Insert, ev.Indent, ev.Wrap, ev.Just] = s.intf;
  const dst = EdPriv as unknown as Record<string, unknown>;
  for (const k of SaveParKeys) dst[k] = s.priv[k];
}

// ---------------------------------------------------------------- interface routines

// PAS: EDITOR.PAS SetEditTxt – the SETEDITTXT instruction
export function SetEditTxt(PD: InstrPtr): void {
  const P = EdPriv;
  const ev = EditorVars;
  const pd = PD!;
  if (pd.Insert !== null) ev.Insert = !RunBool(pd.Insert);
  if (pd.Indent !== null) ev.Indent = RunBool(pd.Indent);
  if (pd.Wrap !== null) ev.Wrap = RunBool(pd.Wrap);
  if (pd.Just !== null) ev.Just = RunBool(pd.Just);
  if (pd.ColBlk !== null) P.TypeB = RunBool(pd.ColBlk);
  if (pd.Left !== null) P.LeftMarg = MaxI(1, RunInt(pd.Left));
  if (pd.Right !== null) P.RightMarg = MaxI(P.LeftMarg, MinI(255, RunInt(pd.Right)));
}

// PAS: EDITOR.PAS GetEditTxt
export function GetEditTxt(pInsert: Ref<boolean>, pIndent: Ref<boolean>, pWrap: Ref<boolean>, pJust: Ref<boolean>,
  pColBlk: Ref<boolean>, pLeftMarg: Ref<number>, pRightMarg: Ref<number>): void {
  const ev = EditorVars;
  pInsert.v = ev.Insert;
  pIndent.v = ev.Indent;
  pWrap.v = ev.Wrap;
  pJust.v = ev.Just;
  pColBlk.v = EdPriv.TypeB;
  pLeftMarg.v = EdPriv.LeftMarg;
  pRightMarg.v = EdPriv.RightMarg;
}

// PAS: EDITOR.PAS EditText – edit the text pTxtPtr[1..pLen]; pScr = ScrT + Posi shl 16
export function EditText(pMode: string, pTxtType: string, pName: string, pErrMsg: string, pTxtPtr: CharArrPtr,
  pMaxLen: number, pLen: Ref<number>, pInd: Ref<number>, pScr: Ref<number>, pBreaks: string, pExD: EdExitDPtr,
  pSrch: Ref<boolean>, pUpdat: Ref<boolean>, pLastNr: number, pCtrlLastNr: number, pMsgS: MsgStrPtr): boolean {
  const P = EdPriv;
  const av = AccessVars;
  const dv = DriversVars;
  const oldEdOK = av.EdOk;
  P.EditT = true;
  P.Mode = pMode;
  P.TypeT = pTxtType;
  P.NameT = pName;
  P.ErrMsg = pErrMsg;
  P.T = TxtBuf(pTxtPtr, pLen.v, pMaxLen); // TS: room to grow
  P.MaxLenT = pMaxLen;
  P.LenT = pLen.v;
  P.IndT = pInd.v;
  P.ScrT = pScr.v & 0xffff;
  P.Posi = (pScr.v >>> 16) & 0xffff;
  P.Breaks = pBreaks;
  P.ExitD = pExD;
  P.SrchT = pSrch.v;
  P.UpdatT = pUpdat.v;
  P.LastNr = pLastNr;
  P.CtrlLastNr = pCtrlLastNr;
  if (pMsgS !== null) {
    P.LastS = pMsgS.Last;
    P.CtrlLastS = pMsgS.CtrlLast;
    P.ShiftLastS = pMsgS.ShiftLast;
    P.AltLastS = pMsgS.AltLast;
    P.HeadS = pMsgS.Head;
  } else {
    P.LastS = null;
    P.CtrlLastS = null;
    P.ShiftLastS = null;
    P.AltLastS = null;
    P.HeadS = null;
  }
  if (P.Mode !== HelpM) P.TxtColor = dv.TextAttr;
  P.FirstEvent = !P.SrchT;
  if (P.SrchT) {
    P.SrchT = false;
    dv.KbdBuffer = '\x0c' + dv.KbdBuffer;
    dv.KbdChar = _L_;
    P.IndT = 0;
  }

  Edit();
  if (P.Mode !== HelpM) dv.TextAttr = P.TxtColor;
  pUpdat.v = P.UpdatT;
  pSrch.v = P.SrchT;
  pLen.v = P.LenT;
  pInd.v = P.IndT;
  pScr.v = P.ScrT + P.Posi * 0x10000;
  // TS: hand the text to the caller (see the notes)
  const t = P.T!;
  EditorVars.EdTxt = t;
  if (pTxtPtr !== null && t !== pTxtPtr && pTxtPtr.length >= P.LenT) pTxtPtr.set(t.subarray(0, P.LenT));
  av.EdOk = oldEdOK;
  return P.EditT;
}

// PAS: EDITOR.PAS SimpleEditText
export function SimpleEditText(pMode: string, pErrMsg: string, pName: string, TxtPtr: CharArrPtr, MaxLen: number,
  Len: Ref<number>, Ind: Ref<number>, Updat: Ref<boolean>): void {
  const Srch = ref(false);
  const Scr = ref(0);
  EditText(pMode, LocalT, pName, pErrMsg, TxtPtr, MaxLen, Len, Ind, Scr, '', null, Srch, Updat, 0, 0, null);
}

// PAS: EDITOR.PAS FindText – position of Pstr (options Popt) in PTxtPtr[1..PLen], 0 = not found
export function FindText(Pstr: string, Popt: string, PTxtPtr: CharArrPtr, PLen: number): number {
  const P = EdPriv;
  const tt = P.T;
  P.T = PTxtPtr;
  const f = P.FindStr;
  const o = P.OptionStr;
  const r = P.Replace;
  P.FindStr = Pstr;
  P.OptionStr = Popt;
  P.Replace = false;
  const I = ref(1);
  let result: number;
  try {
    result = FindString(I, PLen + 1) ? I.v : 0;
  } finally {
    P.FindStr = f;
    P.OptionStr = o;
    P.Replace = r;
    P.T = tt;
  }
  return result;
}

// ---------------------------------------------------------------- TEXT-FILE

// PAS: EDITOR.PAS EditTxtFile – edit CPath (LP=nil) or the TWork text at LP^ (local text variable)
export function EditTxtFile(LP: LongintPtr, Mode: string, ErrMsg: string, ExD: EdExitDPtr, TxtPos: number,
  Txtxy: number, V: WRectPtr, Atr: number, Hd: string, WFlags: number, MsgS: MsgStrPtr): void {
  const P = EdPriv;
  const bv = BaseVars;
  const av = AccessVars;
  const dv = DriversVars;
  const tw = av.TWork;
  let Size = 0;
  let L = 0;
  let w1 = 0;
  let w2 = 0;
  let w3 = 0;
  const er = new ExitRecord();
  let Loc = false;
  let Ind = 0;
  let oldInd = 0;
  let oldTxtxy = 0;
  let LS: LongStrPtr = new Uint8Array(0);
  if (Atr === 0) Atr = bv.Colors.tNorm;
  if (V !== null) {
    w1 = PushW1(1, 1, bv.TxtCols, 1, (WFlags & WPushPixel) !== 0, false);
    w2 = PushW1(1, bv.TxtRows, bv.TxtCols, bv.TxtRows, (WFlags & WPushPixel) !== 0, false);
    w3 = PushWFramed(V.C1, V.R1, V.C2, V.R2, Atr, Hd, '', WFlags);
  } else {
    w1 = PushW(1, 1, bv.TxtCols, bv.TxtRows);
    dv.TextAttr = Atr;
  }
  NewExit(Ovr, er);
  try {
    Loc = LP !== null;
    P.LocalPPtr = LP;
    if (!Loc) {
      P.MaxLenT = 0xfff0;
      P.LenT = 0;
      P.Part.UpdP = false;
      P.TxtPath = bv.CPath;
      P.TxtVol = bv.CVol;
      OpenTxtFh(Mode);
      RdFirstPart();
      SimplePrintHead();
      while (TxtPos > P.Part.PosP + P.Part.LenP && !P.AllRd) RdNextPart();
      Ind = TxtPos - P.Part.PosP;
    } else {
      LS = tw.Read(1, LP!.v);
      Ind = TxtPos;
      L = StoreInTWork(LS);
    }
    oldInd = Ind;
    oldTxtxy = Txtxy;

    for (;;) {
      // 1:
      const Srch = ref(false);
      const Upd = ref(false);
      const pInd = ref(Ind);
      const pScr = ref(Txtxy);
      if (!Loc) {
        const pLen = ref(P.LenT);
        EditText(Mode, FileT, P.TxtPath, ErrMsg, P.T, 0xfff0, pLen, pInd, pScr, _F1 + _F6 + _F9 + _AltF10, ExD,
          Srch, Upd, 126, 143, MsgS);
        P.LenT = pLen.v;
      } else {
        const LL = ref(LS.length);
        EditText(Mode, LocalT, '', ErrMsg, LS, MaxLStrLen, LL, pInd, pScr, _F1 + _F6, ExD, Srch, Upd, 126, 143, MsgS);
        LS = EditorVars.EdTxt!.slice(0, LL.v); // TS: LS^.A is the edited text
      }
      Ind = pInd.v;
      Txtxy = pScr.v;
      TxtPos = Ind + P.Part.PosP;
      if (Upd.v) av.EdUpdated = true;
      if (dv.KbdChar === _AltEqual_ || dv.KbdChar === _U_) {
        LS = tw.Read(1, L);
        if (dv.KbdChar === _AltEqual_) {
          dv.KbdChar = _ESC_;
          break; // goto 4
        }
        Ind = oldInd;
        Txtxy = oldTxtxy;
        continue;
      }
      // if not Loc then ReleaseStore(T)
      if (av.EdBreak === 0xffff) {
        if (dv.KbdChar === _F9_) {
          if (Loc) {
            tw.Delete(LP!.v);
            LP!.v = StoreInTWork(LS);
          } else RdPart();
          continue;
        }
        if (dv.KbdChar === _AltF10_ || dv.KbdChar === _F1_) {
          if (dv.KbdChar === _AltF10_) Help(null, '', false);
          else {
            RdMsg(6);
            Help(av.HelpFD as unknown as RdbD, bv.MsgLine, false);
          }
          // 2:
          if (!Loc) RdPart();
          continue;
        }
      }
      if (!Loc) {
        Size = FileSizeH(P.TxtFH);
        CloseH(P.TxtFH);
      }
      if (av.EdBreak === 0xffff && dv.KbdChar === _F6_) {
        if (Loc) {
          PrintArray(P.T!, P.LenT, false);
          continue;
        }
        bv.CPath = P.TxtPath;
        bv.CVol = P.TxtVol;
        PrintTxtFile(0);
        OpenTxtFh(Mode);
        RdPart();
        continue;
      }
      if (!Loc && Size < 1) DeleteFile(P.TxtPath);
      // if Loc and (KbdChar=_Esc_) then LS^.LL:=LenT  (TS: LS already has the edited length)
      break;
    }
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
  }
  // 4:
  if (av.IsCompileErr) {
    av.IsCompileErr = false;
    const compErrTxt = bv.MsgLine;
    SetMsgPar(compErrTxt);
    WrLLF10Msg(110);
  }
  if (Loc) {
    tw.Delete(L);
    tw.Delete(LP!.v);
    LP!.v = StoreInTWork(LS);
  }
  if (w3 !== 0) PopW2(w3, (WFlags & WNoPop) === 0);
  if (w2 !== 0) PopW(w2);
  PopW(w1);
  av.LastTxtPos = Ind + P.Part.PosP;
  RestoreExit(er);
}

// PAS: EDITOR.PAS ViewPrinterTxt – view the print file (window 1,2,80,24)
export function ViewPrinterTxt(): void {
  if (!RdRunVars.PrintView) return;
  SetPrintTxtPath();
  const v = new WRect(); // typed constant (C1:1;R1:2;C2:80;R2:24)
  v.C1 = 1;
  v.R1 = 2;
  v.C2 = BaseVars.TxtCols;
  v.R2 = BaseVars.TxtRows - 1;
  EditTxtFile(null, 'T', '', null, 1, 0, v, 0, '', WPushPixel, null);
}

// ---------------------------------------------------------------- HELP

// PAS: EDITOR.PAS ClearHelpStkForCRdb
export function ClearHelpStkForCRdb(): void {
  const P = EdPriv;
  let i = 1;
  while (i <= P.iStk) {
    if (P.Stk[i].Rdb === AccessVars.CRdb) {
      for (let j = i; j < P.iStk; j++) P.Stk[j] = P.Stk[j + 1];
      P.Stk[P.iStk] = new HelpStkEntry();
      P.iStk--;
    } else i++;
  }
}

// PAS: EDITOR.PAS Help.ViewHelpText (nested in Help)
function ViewHelpText(S: LongStrPtr, TxtPos: Ref<number>): void {
  const P = EdPriv;
  const c = BaseVars.Colors;
  const L = SavePar();
  P.TxtColor = c.hNorm;
  P.ColKey.fill(c.tCtrl);
  P.ColKey[5] = c.hSpec;
  P.ColKey[3] = c.hHili;
  P.ColKey[1] = c.hMenu;
  const Srch = ref(false);
  const Upd = ref(false);
  const Scr = ref(0);
  const LL = ref(S.length);
  let txt: Uint8Array = S;
  for (;;) {
    EditText(HelpM, MemoT, '', '', txt, 0xfff0, LL, TxtPos, Scr, _F1 + _F10 + _F6 + _CtrlHome + _CtrlEnd, null,
      Srch, Upd, 142, 145, null);
    txt = EditorVars.EdTxt!.slice(0, LL.v);
    if (DriversVars.KbdChar === _F6_) {
      PrintArray(txt, LL.v, true);
      continue;
    }
    break;
  }
  RestorePar(L);
}

// PAS: EDITOR.PAS Help – show help Name of R (InCWw: in the current window)
export function Help(R: RdbDPtr, Name: string, InCWw: boolean): void {
  const P = EdPriv;
  const av = AccessVars;
  const bv = BaseVars;
  const dv = DriversVars;
  const HelpR = av.HelpFD as unknown as RdbDPtr; // RdbDPtr(HelpFD)
  let backw: boolean;
  if (R === null) {
    if (P.iStk === 0) return;
    R = P.Stk[P.iStk].Rdb;
    backw = true;
  } else {
    if (Name === '') return;
    backw = false;
  }
  let fd: FileDPtr;
  if (R === HelpR) {
    fd = av.HelpFD;
    if (av.HelpFD!.Handle === 0xff) {
      WrLLF10Msg(57);
      return;
    }
  } else {
    fd = R!.HelpFD;
    if (fd === null) return;
  }
  const cf = av.CFile;
  let w = 0;
  let w2 = 0;
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    if (InCWw) {
      const c1 = dv.WindMin.X + 1;
      const c2 = dv.WindMax.X + 1;
      let r1 = dv.WindMin.Y + 1;
      const r2 = dv.WindMax.Y + 1;
      if (c1 === 1 && c2 === bv.TxtCols && r1 === 2 && r2 === bv.TxtRows) r1 = 1;
      w = PushW(1, bv.TxtRows, bv.TxtCols, bv.TxtRows);
      w2 = PushW1(c1, r1, c2, r2, true, true);
    } else w = PushW1(1, 1, bv.TxtCols, bv.TxtRows, true, true);
    const i = ref(1);
    let frst = true;
    let delta = 0;
    let byName = false;
    const iRec = ref(0);
    let oldIRec = 0;
    let cf2: FileDPtr = null;
    let lbl = backw ? 3 : 1;
    for (;;) {
      if (lbl === 3) {
        // 3:
        if (P.iStk > 0) {
          const e = P.Stk[P.iStk];
          R = e.Rdb;
          av.CFile = e.FD;
          iRec.v = e.iR;
          i.v = e.iT;
          P.iStk--;
          lbl = 2;
          continue;
        }
        break; // 4
      }
      if (lbl === 1) byName = true;
      // 2:
      const s = GetHlpText(R, Name, byName, iRec);
      cf2 = av.CFile;
      if (s === null) {
        if (frst && R === HelpR && dv.KbdChar === _CtrlF1_) {
          dv.KbdChar = 0;
          Name = 'Ctrl-F1 error';
          lbl = 1;
          continue;
        }
        Set2MsgPar(Name, fd!.Name);
        WrLLF10Msg(146);
        break;
      }
      frst = false;
      byName = false;
      let s2 = s;
      if (s.length > 0 && s[0] === 0x7b /* { */) {
        // view after 1. line
        let l = FindCtrlM(s, 1, 1);
        l = SkipCtrlMJ(s, l) - 1;
        s2 = s.subarray(l);
      }
      if (s2.length === 0) {
        if (delta === 0) break;
        if (iRec.v !== oldIRec) {
          oldIRec = iRec.v;
          iRec.v = word(iRec.v + delta);
          lbl = 2;
          continue;
        }
      }
      ViewHelpText(s2, i);
      if (P.iStk < maxStk) P.iStk++;
      else {
        for (let j = 1; j < maxStk; j++) P.Stk[j] = P.Stk[j + 1];
        P.Stk[maxStk] = new HelpStkEntry();
      }
      const e = P.Stk[P.iStk];
      e.Rdb = R;
      e.FD = cf2;
      e.iR = iRec.v;
      e.iT = i.v;
      oldIRec = iRec.v;
      i.v = 1;
      delta = 0;
      av.CFile = cf2;
      const k = dv.KbdChar;
      if (k === _ESC_) break;
      if (k === _F10_) {
        P.iStk--;
        lbl = 3;
        continue;
      }
      if (k === _CtrlHome_) {
        iRec.v = word(iRec.v - 1);
        delta = -1;
        lbl = 2;
        continue;
      }
      if (k === _CtrlEnd_) {
        iRec.v = word(iRec.v + 1);
        delta = 1;
        lbl = 2;
        continue;
      }
      Name = k === _F1_ ? 'root' : av.LexWord;
      lbl = 1;
    }
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
  }
  // 4:
  RestoreExit(er);
  if (w2 !== 0) PopW(w2);
  if (w !== 0) PopW(w);
  av.CFile = cf;
}

// PAS: EDITOR.PAS InitTxtEditor – colours, messages 411..417, default switches
export function InitTxtEditor(): void {
  const P = EdPriv;
  const bv = BaseVars;
  const c = bv.Colors;
  P.FindStr = '';
  P.ReplaceStr = '';
  P.OptionStr = '';
  P.Replace = false;
  P.TxtColor = c.tNorm;
  P.BlockColor = c.tBlock;
  P.SysLColor = c.fNorm;
  P.ColKey[0] = c.tCtrl;
  // move(colors.tUnderline, ColKey[1], 7)
  P.ColKey[1] = c.tUnderline;
  P.ColKey[2] = c.tItalic;
  P.ColKey[3] = c.tDWidth;
  P.ColKey[4] = c.tDStrike;
  P.ColKey[5] = c.tEmphasized;
  P.ColKey[6] = c.tCompressed;
  P.ColKey[7] = c.tElite;
  // string[5] / string[20] variables
  const s5 = (): string => bv.MsgLine.slice(0, 5);
  RdMsg(411);
  P.InsMsg = s5();
  RdMsg(412);
  P.nInsMsg = s5();
  RdMsg(413);
  P.IndMsg = s5();
  RdMsg(414);
  P.WrapMsg = s5();
  RdMsg(415);
  P.JustMsg = s5();
  RdMsg(417);
  P.BlockMsg = s5();
  RdMsg(416);
  P.ViewMsg = bv.MsgLine.slice(0, 20);
  const ev = EditorVars;
  ev.Insert = true;
  ev.Indent = true;
  ev.Wrap = false;
  ev.Just = false;
  P.TypeB = false;
  P.LeftMarg = 1;
  P.RightMarg = 78;
  P.CharPg = bv.Spec.TxtCharPg;
  P.InsPg = bv.Spec.TxtInsPg;
}
