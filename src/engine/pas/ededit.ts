// PAS: EDEDIT.PAS – include of EDITOR: procedure Edit (the editor session) and its nested helpers:
// part/line navigation (SetPart, NewL/NewRL, FindLine, SetInd, Position/Column for tab-free
// columns), line decode/encode between T and the line buffer Arr (DekodLine/KodLine, TestLenText
// grows or shrinks the text), screen positioning (SetScreen), help-word handling (WordFind,
// SetWord, CursorWord for HelpM). EDSCREEN and EDEVENT are included inside Edit.
//
// Porting notes:
// * Everything after Edit in this module is nested in Edit and shares its locals: EdFrame below.
//   Edit saves EdFrame (and HandleEvent's EvFrame) on entry and restores them on exit, so a nested
//   Edit (exit procedure, help) leaves the outer one intact (Pascal: locals on the stack).
// * Arr (array[1..SuccLineSize] of char) is indexed directly: EdFrame.Arr[i] is Pascal Arr[i]
//   (Arr[0] unused; a few spare bytes after 256 stand in for the stack bytes Pascal reads there).
//   A pointer into Arr or T (ArrPtr) is a subarray view whose [0] is P^[1].
// * asm/DOS: the Scroll Lock bit at 0:$417 (FPC: ignored) and `Regs` (BP7 only).
// * TestLenText: `L: word absolute LL` - the FPC branch decrements LL; SmallerPart moves the part
//   window when the buffer is full (UpdateFile first). Heap growth of T (GetStore/ReleaseStore):
//   T has room up to MaxLenT (editor.ts TxtBuf), so only the MaxLenT check remains.
// * Var parameters that alias Edit's locals (FindLine(LineL), FindLine(ScrL), WordFind(..., WordL))
//   are fref()s, so MoveIdx updates seen through them behave as in Pascal.

import { fref, ref, word, DirectorySeparator, Copy, chr, TxtWriteln, Output, type Ref } from './pasrt.ts';
import { MinI, MaxI, MinW, MaxW, MinL, StoreAvail, SetMsgPar } from './base.ts';
import { AccessVars } from './access.ts';
import { DriversVars, CrsHide, CrsNorm, Window, ClrScr } from './drivers.ts';
import { ClearKbdBuf, AddToKbdBuf } from './keybd.ts';
import { BaseVars } from './base.ts';
import { PromptYN, RunError, WrLLF10Msg } from './obaseww.ts';
import {
  EdPriv, Tg, Ts, TMove, IsOddel, LineSize, FileT, TextM, ViewM, HelpM, type ColorOrd,
} from './editor.ts';
import { FindChar, SetColorOrd, SimplePrintHead } from './edglobal.ts';
import { RdNextPart, RdPredPart, UpdateFile, NullChangePart, RdFirstPart } from './edtextf.ts';
import { InitScr, WrStatusLine, Background, WrLLMargMsg } from './edscreen.ts';
import { HandleEvent, EvFrame } from './edevent.ts';

/** EDEDIT.PAS ArrPtr (^ArrLine, array[1..SuccLineSize] of char): a view whose [0] is P^[1]. */
export type ArrPtr = Uint8Array;

const CR = 0x0d;
const LF = 0x0a;

/** TS-only: Arr size (index 0 unused, 1..256 = ArrLine, a few spare bytes). */
const ArrSize = 260;

/** TS-only: the local variables of Edit shared by its nested routines (EDEDIT/EDSCREEN/EDEVENT). */
export const EdFrame = {
  // line descriptor (LineI, Posi, BPos are in EdPriv)
  Arr: new Uint8Array(ArrSize), // Arr[1..SuccLineSize] = Arr[i]
  NextI: 0,
  LineL: 0,
  ScrL: 0,
  RScrL: 0,
  UpdatedL: false,
  CtrlL: false,
  HardL: false,
  // screen descriptor (ScrI is in EdPriv)
  BCol: 0,
  Colu: 0,
  Row: 0,
  ChangeScr: false,
  ColScr: '' as ColorOrd,
  IsWrScreen: false,
  FirstR: 0,
  FirstC: 0,
  LastR: 0,
  LastC: 0,
  MinC: 0,
  MinR: 0,
  MaxC: 0,
  MaxR: 0,
  MargLL: [0, 0, 0, 0, 0], // [1..4]
  PageS: 0,
  LineS: 0,
  Scroll: false,
  FirstScroll: false,
  HelpScroll: false,
  PredScLn: 0, // position before Scroll
  PredScPos: 0,
  FrameDir: 0,
  WordL: 0, // Mode=HelpM & ctrl-word is on screen
  Konec: false,
  /** EDSCREEN.PAS `var InsPage` (a local of Edit between EditWrline and ScrollWrline) */
  InsPage: false,
};
type EdFrameT = typeof EdFrame;

/** TS-only: a copy of a frame object (arrays and typed arrays copied). */
export function CopyFrame<T extends object>(f: T): T {
  const r = { ...f } as Record<string, unknown>;
  for (const [k, v] of Object.entries(r)) {
    if (v instanceof Uint8Array) r[k] = v.slice();
    else if (Array.isArray(v)) r[k] = v.slice();
  }
  return r as T;
}
/** TS-only: restore a frame copied by CopyFrame into the live object. */
export function RestoreFrame<T extends object>(f: T, saved: T): void {
  Object.assign(f, saved);
}
/** TS-only: a fresh frame for Edit (Pascal locals are uninitialized; zero is as good). */
function ResetEdFrame(F: EdFrameT): void {
  F.Arr = new Uint8Array(ArrSize);
  F.NextI = 0;
  F.LineL = 0;
  F.ScrL = 0;
  F.RScrL = 0;
  F.UpdatedL = false;
  F.CtrlL = false;
  F.HardL = false;
  F.BCol = 0;
  F.Colu = 0;
  F.Row = 0;
  F.ChangeScr = false;
  F.ColScr = '';
  F.IsWrScreen = false;
  F.MargLL = [0, 0, 0, 0, 0];
  F.Scroll = false;
  F.FirstScroll = false;
  F.HelpScroll = false;
  F.FrameDir = 0;
  F.WordL = 0;
  F.Konec = false;
  F.InsPage = false;
}

// ---------------------------------------------------------------- segmenty

// PAS: EDEDIT.PAS DelEndT – nested in Edit
export function DelEndT(): void {
  const P = EdPriv;
  if (P.LenT > 0) P.LenT--;
}
// PAS: EDEDIT.PAS WrEndT – nested in Edit
export function WrEndT(): void {
  const P = EdPriv;
  P.LenT++;
  Ts(P.LenT, CR);
}

// PAS: EDEDIT.PAS MoveIdx – nested in Edit
export function MoveIdx(dir: number): void {
  const P = EdPriv;
  const F = EdFrame;
  const mi = -dir * P.Part.MovI;
  const ml = -dir * P.Part.MovL;
  P.ScrI += mi; // ****GLOBAL***
  P.LineI += mi;
  F.NextI += mi; // ****Edit***
  F.LineL += ml;
  F.ScrL += ml;
}

// PAS: EDEDIT.PAS TestUpdFile – nested in Edit
export function TestUpdFile(): void {
  DelEndT();
  if (EdPriv.Part.UpdP) UpdateFile();
}
// PAS: EDEDIT.PAS SetUpdat – nested in Edit
export function SetUpdat(): void {
  const P = EdPriv;
  P.UpdatT = true;
  if (P.TypeT === FileT) {
    if (P.Part.PosP < 0x400) P.UpdPHead = true;
    P.Part.UpdP = true;
  }
}
// PAS: EDEDIT.PAS PredPart – nested in Edit
export function PredPart(): void {
  TestUpdFile();
  EdPriv.ChangePart = RdPredPart();
  MoveIdx(-1);
  WrEndT();
}
// PAS: EDEDIT.PAS NextPart – nested in Edit
export function NextPart(): void {
  TestUpdFile();
  EdPriv.ChangePart = RdNextPart();
  MoveIdx(1);
  WrEndT();
}
// PAS: EDEDIT.PAS NextPartDek – nested in Edit
export function NextPartDek(): void {
  NextPart();
  DekodLine();
}
// PAS: EDEDIT.PAS SetPart – nested in Edit
export function SetPart(Idx: number): void {
  const P = EdPriv;
  if ((Idx > P.Part.PosP && Idx < P.Part.PosP + P.LenT) || P.TypeT !== FileT) return;
  TestUpdFile();
  RdFirstPart();
  while (Idx > P.Part.PosP + P.Part.LenP && !P.AllRd) P.ChangePart = RdNextPart();
  WrEndT();
}

// PAS: EDEDIT.PAS SetPartLine – nested in Edit
export function SetPartLine(Ln: number): void {
  const P = EdPriv;
  while (Ln <= P.Part.LineP && P.Part.PosP > 0) PredPart();
  while (Ln - P.Part.LineP > 0x7fff && !P.AllRd) NextPart();
}

// PAS: EDEDIT.PAS LineAbs – nested in Edit
export function LineAbs(Ln: number): number {
  return EdPriv.Part.LineP + Ln;
}
// PAS: EDEDIT.PAS LineInBlock – nested in Edit
export function LineInBlock(Ln: number): boolean {
  const P = EdPriv;
  return LineAbs(Ln) > P.BegBLn && LineAbs(Ln) < P.EndBLn;
}
// PAS: EDEDIT.PAS LineBndBlock – nested in Edit
export function LineBndBlock(Ln: number): boolean {
  const P = EdPriv;
  return LineAbs(Ln) === P.BegBLn || LineAbs(Ln) === P.EndBLn;
}

// ---------------------------------------------------------------- strankovani ve Scroll (paging)

// PAS: EDEDIT.PAS NewRL – nested in Edit (the page-head variant is commented out)
export function NewRL(Line: number): number {
  return LineAbs(Line);
}
// PAS: EDEDIT.PAS NewL – nested in Edit
export function NewL(RLine: number): number {
  return RLine - EdPriv.Part.LineP;
}
// PAS: EDEDIT.PAS ModPage – nested in Edit
export function ModPage(RLine: number): boolean {
  return false;
}

// PAS: EDEDIT.PAS TestLenText.SmallerPart (nested)
function SmallerPart(Ind: number, FreeSize: number): void {
  const P = EdPriv;
  const Part = P.Part;
  NullChangePart();
  if (StoreAvail() > FreeSize && P.MaxLenT - P.LenT > FreeSize) return;
  TestUpdFile();
  WrEndT();
  let lon = MinL(P.LenT + StoreAvail(), P.MaxLenT);
  lon -= FreeSize;
  if (lon <= 0) return;
  lon -= lon >>> 3;
  let i = 1;
  let il = 0;
  let l = 0;
  while (i < Ind) {
    if (Tg(i) === CR) {
      l++;
      il = i;
      if (Tg(il + 1) === LF) il++;
    }
    if (P.LenT - il < lon) i = Ind;
    i++;
  }
  if (il > 0) {
    Part.PosP += il;
    Part.LineP += l;
    Part.MovI = il;
    Part.MovL = l;
    SetColorOrd(fref(Part, 'ColorP'), 1, Part.MovI + 1);
    P.LenT -= il;
    TMove(il + 1, 1, P.LenT);
    Ts(P.LenT, CR);
    P.ChangePart = true;
    MoveIdx(1);
  }
  Ind -= il;
  if (P.LenT < lon) return;
  i = P.LenT;
  il = P.LenT;
  while (i > Ind) {
    if (Tg(i) === CR) {
      il = i;
      if (Tg(il + 1) === LF) il++;
    }
    i--;
    if (il < lon) i = Ind;
  }
  if (il < P.LenT) {
    if (il < P.LenT - 1) P.AllRd = false;
    Part.LenP = il;
    P.LenT = il + 1;
    Ts(P.LenT, CR);
  }
}

// PAS: EDEDIT.PAS TestLenText – nested in Edit: T^[F..LenT] moves to T^[LL..] (grow or shrink)
export function TestLenText(F: number, LL: number): void {
  const P = EdPriv;
  const size = LL - F;
  if (F < LL) {
    if (P.TypeT === FileT) {
      SmallerPart(F, size);
      F -= P.Part.MovI;
      LL -= P.Part.MovI;
    }
    if (StoreAvail() <= size || P.MaxLenT <= P.LenT + size) RunError(404); // text too long, not enough memory
    // else GetStore(Size)
  }
  if (P.LenT >= F) TMove(F, LL, P.LenT - F + 1);
  // if F>=LL then ReleaseStore(@T^[LenT+size+1])
  P.LenT += size;
  SetUpdat();
}

// PAS: EDEDIT.PAS DekodLine – nested in Edit: the line at LineI into Arr
export function DekodLine(): void {
  const P = EdPriv;
  const F = EdFrame;
  const LL = ref(1);
  let LP = word(FindChar(LL, '\r', P.LineI, P.LenT) - P.LineI);
  F.HardL = true;
  F.Arr.fill(0x20, 1, LineSize + 1);
  F.NextI = P.LineI + LP + 1;
  if (F.NextI < P.LenT && Tg(F.NextI) === LF) F.NextI++;
  else F.HardL = false;
  if (LP > LineSize) {
    LP = LineSize;
    if (P.Mode === TextM) {
      if (PromptYN(402)) {
        let L = P.LineI + LineSize;
        NullChangePart();
        TestLenText(L, L + 1);
        L -= P.Part.MovI;
        Ts(L, CR);
        F.NextI = P.LineI + LP + 1;
      } else P.Mode = ViewM;
    }
  }
  if (LP > 0) F.Arr.set(P.T!.subarray(P.LineI - 1, P.LineI - 1 + LP), 1);
  F.UpdatedL = false;
}

// PAS: EDEDIT.PAS ShortName – nested in Edit
export function ShortName(Name: string): string {
  let J = Name.length;
  const isSep = (c: string | undefined): boolean => c === DirectorySeparator || c === ':';
  while (J > 0 && !isSep(Name[J - 1])) J--;
  let s = Copy(Name, J + 1, Name.length - J);
  if (Name[1] === ':') s = Copy(Name, 1, 2) + s;
  return s;
}

// PAS: EDEDIT.PAS CountChar – nested in Edit: occurrences of C in T^[First..Last)
export function CountChar(C: string, First: number, Last: number): number {
  const j = ref(1);
  let I = FindChar(j, C, First, EdPriv.LenT);
  let n = 0;
  while (I < Last) {
    n++;
    I = FindChar(j, C, I + 1, EdPriv.LenT);
  }
  return n;
}

// PAS: EDEDIT.PAS SetLine – nested in Edit
export function SetLine(Ind: number): number {
  return CountChar('\r', 1, Ind) + 1;
}

// PAS: EDEDIT.PAS SetCurrI – nested in Edit: start of the line containing Ind
export function SetCurrI(Ind: number): number {
  Ind--;
  while (Ind > 0) {
    if (Tg(Ind) === CR) {
      Ind++;
      if (Tg(Ind) === LF) Ind++;
      return Ind;
    }
    Ind--;
  }
  return 1;
}

// PAS: EDEDIT.PAS SetDekCurrI – nested in Edit
export function SetDekCurrI(Ind: number): void {
  EdPriv.LineI = SetCurrI(Ind);
  DekodLine();
}

// PAS: EDEDIT.PAS SetDekLnCurrI – nested in Edit
export function SetDekLnCurrI(Ind: number): void {
  SetDekCurrI(Ind);
  EdFrame.LineL = SetLine(EdPriv.LineI);
}

// PAS: EDEDIT.PAS FindLine – nested in Edit: index of line Num (of the part)
export function FindLine(Num: Ref<number>): number {
  const P = EdPriv;
  for (;;) {
    // 1:
    if (Num.v <= 0) {
      if (P.Part.PosP === 0) Num.v = 1;
      else {
        PredPart();
        continue;
      }
    }
    if (Num.v === 1) return 1;
    const J = ref(Num.v - 1);
    let I = FindChar(J, '\r', 1, P.LenT) + 1;
    if (Tg(I) === LF) I++;
    if (I > P.LenT) {
      if (P.AllRd) {
        Num.v = SetLine(P.LenT);
        return SetCurrI(P.LenT);
      }
      NextPart();
      if (Num.v !== EdFrame.LineL) Num.v -= P.Part.MovL;
      continue;
    }
    return I;
  }
}

// PAS: EDEDIT.PAS DekFindLine – nested in Edit
export function DekFindLine(Num: number): void {
  const F = EdFrame;
  SetPartLine(Num);
  F.LineL = Num - EdPriv.Part.LineP;
  EdPriv.LineI = FindLine(fref(F, 'LineL'));
  DekodLine();
}

// PAS: EDEDIT.PAS PosDekFindLine – nested in Edit
export function PosDekFindLine(Num: number, Pos: number, ChScr: boolean): void {
  EdPriv.Posi = Pos;
  DekFindLine(Num);
  EdFrame.ChangeScr = EdFrame.ChangeScr || ChScr;
}

// PAS: EDEDIT.PAS SetInd – nested in Edit: line, position --> index
export function SetInd(Ind: number, Pos: number): number {
  const P = Ind - 1;
  if (Ind < EdPriv.LenT) while (Ind - P < Pos && Tg(Ind) !== CR) Ind++;
  return Ind;
}

/** TS-only: Arr[i]; beyond the array a blank (Pascal reads stack bytes there). */
function ArrAt(i: number): number {
  return EdFrame.Arr[i] ?? 0x20;
}

// PAS: EDEDIT.PAS Position – nested in Edit (PosToCol)
export function Position(c: number): number {
  let cc = 1;
  let p = 1;
  while (cc <= c) {
    if (ArrAt(p) >= 0x20) cc++;
    p++;
  }
  return p - 1;
}
// PAS: EDEDIT.PAS Column – nested in Edit (ColToPos)
export function Column(p: number): number {
  if (p === 0) return 0;
  let pp = 1;
  let c = 1;
  while (pp <= p) {
    if (ArrAt(pp) >= 0x20) c++;
    pp++;
  }
  if (ArrAt(p) >= 0x20) c--;
  return c;
}

// PAS: EDEDIT.PAS SetScreen – nested in Edit
export function SetScreen(Ind: number, ScrXY: number, Pos: number): void {
  const P = EdPriv;
  const F = EdFrame;
  SetDekLnCurrI(Ind);
  P.Posi = MinI(LineSize, MaxI(MaxW(1, Pos), Ind - P.LineI + 1));
  if (ScrXY > 0) {
    F.ScrL = F.LineL - (ScrXY >>> 8) + 1;
    P.Posi = MaxW(P.Posi, ScrXY & 0xff);
    P.BPos = P.Posi - (ScrXY & 0xff);
    F.ChangeScr = true;
  }
  F.Colu = Column(P.Posi);
  F.BCol = Column(P.BPos);
  if (F.Scroll) {
    F.RScrL = NewRL(F.ScrL);
    F.LineL = MaxI(P.PHNum + 1, LineAbs(F.LineL)) - P.Part.LineP;
    const rl = NewRL(F.LineL);
    if (rl >= F.RScrL + F.PageS || rl < F.RScrL) {
      F.RScrL = rl > 10 ? rl - 10 : 1;
      F.ChangeScr = true;
      F.ScrL = NewL(F.RScrL);
    }
    F.LineL = F.ScrL;
    DekFindLine(LineAbs(F.LineL));
  } else if (F.LineL >= F.ScrL + F.PageS || F.LineL < F.ScrL) {
    F.ScrL = F.LineL > 10 ? F.LineL - 10 : 1;
    F.ChangeScr = true;
  }
}

// PAS: EDEDIT.PAS LastPosLine – nested in Edit
export function LastPosLine(): number {
  let LP = LineSize;
  while (LP > 0 && EdFrame.Arr[LP] === 0x20) LP--;
  return LP;
}

// PAS: EDEDIT.PAS KodLine – nested in Edit: Arr back into T
export function KodLine(): void {
  const P = EdPriv;
  const F = EdFrame;
  let LP = LastPosLine() + 1;
  if (F.HardL) LP++;
  TestLenText(F.NextI, P.LineI + LP);
  P.T!.set(F.Arr.subarray(1, 1 + LP), P.LineI - 1);
  F.NextI = P.LineI + LP;
  LP = F.NextI - 1;
  if (F.HardL) LP--;
  Ts(LP, CR);
  if (F.HardL) Ts(LP + 1, LF);
  F.UpdatedL = false;
}

// PAS: EDEDIT.PAS TestKod – nested in Edit
export function TestKod(): void {
  if (EdFrame.UpdatedL) KodLine();
}

// PAS: EDEDIT.PAS NextLine.MyWriteln (nested)
function MyWriteln(): void {
  DriversVars.TextAttr = EdPriv.TxtColor;
  TxtWriteln(Output);
}
// PAS: EDEDIT.PAS NextLine – nested in Edit
export function NextLine(WrScr: boolean): void {
  const P = EdPriv;
  const F = EdFrame;
  TestKod();
  if (F.NextI >= P.LenT && !P.AllRd) NextPartDek();
  if (F.NextI <= P.LenT) {
    P.LineI = F.NextI;
    DekodLine();
    F.LineL++;
    if (F.Scroll) {
      if (F.PageS > 1) MyWriteln();
      F.ScrL++;
      F.ChangeScr = true;
      F.RScrL++;
      if (ModPage(F.RScrL)) {
        if (F.PageS > 1) MyWriteln();
        F.RScrL++;
      }
    } else if (WrScr && F.LineL === F.ScrL + F.PageS) {
      if (F.PageS > 1) MyWriteln();
      F.ScrL++;
      F.ChangeScr = true;
    }
  }
}

// ---------------------------------------------------------------- HELP

// PAS: EDEDIT.PAS WordExist – nested in Edit
export function WordExist(): boolean {
  const F = EdFrame;
  return F.WordL >= F.ScrL && F.WordL < F.ScrL + F.PageS;
}

// PAS: EDEDIT.PAS WordNo – nested in Edit
export function WordNo(I: number): number {
  return Math.trunc((CountChar('\x13', 1, MinW(EdPriv.LenT, I - 1)) + 1) / 2);
}

// PAS: EDEDIT.PAS WordNo2 – nested in Edit
export function WordNo2(): number {
  const P = EdPriv;
  if (WordExist()) return WordNo(SetInd(P.LineI, P.Posi));
  return WordNo(P.ScrI);
}

// PAS: EDEDIT.PAS ClrWord – nested in Edit: the selected help word (^Q..^Q) back to ^S..^S
export function ClrWord(): void {
  const P = EdPriv;
  const m = ref(1);
  let k = FindChar(m, '\x11', 1, P.LenT);
  while (k < P.LenT) {
    Ts(k, 0x13);
    m.v = 1;
    k = FindChar(m, '\x11', k, P.LenT);
  }
}

// PAS: EDEDIT.PAS WordFind – nested in Edit: the i-th help word ^S..^S
export function WordFind(i: number, WB: Ref<number>, WE: Ref<number>, LI: Ref<number>): boolean {
  const P = EdPriv;
  if (i === 0) return false;
  const n = ref(i * 2 - 1);
  let k = FindChar(n, '\x13', 1, P.LenT);
  if (k >= P.LenT) return false;
  WB.v = k;
  k++;
  while (Tg(k) !== 0x13 && k < P.LenT) k++; // TS: stop at the text end
  if (k >= P.LenT) return false;
  WE.v = k;
  LI.v = SetLine(WB.v);
  return true;
}

// PAS: EDEDIT.PAS SetWord – nested in Edit
export function SetWord(WB: number, WE: number): void {
  const P = EdPriv;
  const F = EdFrame;
  Ts(WB, 0x11);
  Ts(WE, 0x11);
  SetDekLnCurrI(WB);
  F.WordL = F.LineL;
  P.Posi = WB - P.LineI + 1;
  F.Colu = Column(P.Posi);
}

// PAS: EDEDIT.PAS CursorWord – nested in Edit: the word at the cursor into LexWord
export function CursorWord(): void {
  const P = EdPriv;
  const Arr = EdFrame.Arr;
  const av = AccessVars;
  av.LexWord = '';
  let pp = P.Posi;
  const inO = P.Mode === HelpM ? (c: number): boolean => c === 0x11 : IsOddel;
  if (P.Mode !== HelpM && inO(Arr[pp])) pp--;
  while (pp > 0 && !inO(Arr[pp])) pp--;
  pp++;
  const lp = LastPosLine();
  while (pp <= lp && !inO(Arr[pp])) {
    av.LexWord += chr(Arr[pp]);
    pp++;
  }
}

// ---------------------------------------------------------------- BEGIN OF Edit

// PAS: EDEDIT.PAS Edit – unit-internal
export function Edit(): void {
  const P = EdPriv;
  const F = EdFrame;
  const dv = DriversVars;
  const bv = BaseVars;
  const savedF = CopyFrame(EdFrame); // TS: Edit's locals (re-entrancy)
  const savedEv = CopyFrame(EvFrame);
  ResetEdFrame(F);
  try {
    InitScr();
    F.IsWrScreen = false;
    WrEndT();
    P.IndT = MinW(MaxW(1, P.IndT), P.LenT);
    P.BegBLn = 1;
    P.EndBLn = 1;
    P.BegBPos = 1;
    P.EndBPos = 1;
    F.ScrL = 1;
    P.ScrI = 1;
    F.RScrL = 1;
    F.PredScLn = 1;
    F.PredScPos = 1;
    P.UpdPHead = false;
    if (P.TypeT !== FileT) {
      const Part = P.Part;
      P.AllRd = true;
      P.AbsLenT = P.LenT - 1;
      Part.LineP = 0;
      Part.PosP = 0;
      Part.LenP = P.AbsLenT;
      Part.ColorP = '';
      Part.UpdP = false;
      NullChangePart();
      SimplePrintHead();
    }
    F.FirstScroll = P.Mode === ViewM; // FPC: no Scroll Lock bit
    F.Scroll = F.FirstScroll && P.Mode !== HelpM;
    if (F.Scroll) {
      F.ScrL = NewL(F.RScrL);
      F.ChangeScr = true;
    }
    F.HelpScroll = F.Scroll || P.Mode === HelpM;
    if (F.HelpScroll) CrsHide();
    else CrsNorm();
    F.BCol = 0;
    P.BPos = 0;
    SetScreen(P.IndT, P.ScrT, P.Posi);
    F.Konec = false;
    if (P.Mode === HelpM) {
      F.WordL = 0;
      P.ScrI = SetInd(P.LineI, P.Posi);
      const i1 = ref(0);
      const i2 = ref(0);
      const i3 = ref(0);
      if (WordFind(WordNo2() + 1, i1, i2, i3)) SetWord(i1.v, i2.v);
      if (!WordExist()) SetDekLnCurrI(P.IndT);
      P.ScrI = 1;
    }
    F.MargLL = [0, 0, 0, 0, 0];
    F.ColScr = P.Part.ColorP;
    WrStatusLine();
    dv.TextAttr = P.TxtColor;
    ClrScr();
    Background();
    P.FirstEvent = false;
    if (P.ErrMsg !== '') {
      SetMsgPar(P.ErrMsg);
      bv.F10SpecKey = 0xffff;
      WrLLF10Msg(110);
      ClearKbdBuf();
      AddToKbdBuf(dv.KbdChar);
    }
    F.MargLL = [0, 0, 0, 0, 0];
    WrLLMargMsg(P.LastS, P.LastNr);
    do {
      if (P.TypeT === FileT) NullChangePart();
      HandleEvent();
      if (!(F.Konec || F.IsWrScreen)) Background();
    } while (!F.Konec);
    if (F.Scroll && P.Mode !== HelpM) {
      P.Posi = P.BPos + 1;
      F.LineL = F.ScrL;
      P.LineI = P.ScrI;
    }
    P.IndT = SetInd(P.LineI, P.Posi);
    P.ScrT = word(((F.LineL - F.ScrL + 1) << 8) + P.Posi - P.BPos);
    if (P.Mode !== HelpM) AccessVars.TxtXY = P.ScrT + P.Posi * 0x10000;
    CursorWord();
    if (P.Mode === HelpM) ClrWord();
    CrsHide();
    Window(F.MinC, F.MinR, F.MaxC, F.MaxR);
    TestUpdFile();
  } finally {
    RestoreFrame(EdFrame, savedF);
    RestoreFrame(EvFrame, savedEv);
  }
}
