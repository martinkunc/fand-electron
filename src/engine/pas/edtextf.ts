// PAS: EDTEXTF.PAS – include of EDITOR: a text file larger than the buffer is edited in parts:
// RdNextPart/RdPredPart slide the window over the file (keeping whole lines, updating Part.LineP/
// PosP and the colour state ColorP), UpdateFile writes the changed part back (moving the rest of the
// file), RdPart/RdFirstPart/NullChangePart, OpenTxtFh opens TxtPath (Mode: read-only for ViewM).
//
// Porting notes:
// * State: EdPriv (Part, TxtFH, TxtPath, TxtVol, AllRd, AbsLenT, ChangePart, T, LenT, MaxLenT).
//   All routines are unit-internal.
// * Heap (TS): `T:=GetStore(0)` starts a new text buffer (NewT, room for MaxLenT + TSlack); the
//   parts read behind T (`ppa:=GetStore(L)` right after T) go to T[LenT..]. ReleaseStore: no-op.
// * LastLine/FirstLine walk bytes with pointer arithmetic (`COfs absolute C`) - indices here.
// * Files go through HANDLE (OpenH/ReadH/WriteH/SeekH/TruncH, HandleError); UpdateFile shifts the
//   file tail when the part changed size. A final ^Z of the file stays out of LenT (but counts in
//   LenP), so the next UpdateFile drops it, as in FAND.

import { fref, type Ref } from './pasrt.ts';
import {
  BaseVars, SetMsgPar, StoreAvail, MinL, OpenH, ReadH, WriteH, SeekH, TruncH, FlushH, FileSizeH,
  _isoldnewfile, RdOnly, Exclusive, type FileUseMode,
} from './base.ts';
import { WrLLF10Msg, RunError } from './obaseww.ts';
import { TestMountVol } from './oaccess.ts';
import { EdPriv, Tg, TMove, TSlack, ViewM } from './editor.ts';
import { SetColorOrd } from './edglobal.ts';

const CR = 0x0d;
const LF = 0x0a;

/** TS-only: `T:=GetStore(0)` – a fresh text buffer for a file part. */
export function NewT(): Uint8Array {
  return new Uint8Array(Math.max(EdPriv.MaxLenT, 0xfff0) + TSlack);
}

// PAS: EDTEXTF.PAS RdNextPart.LastLine (nested)
function LastLine(from: number, num: number, Ind: Ref<number>, Count: Ref<number>): void {
  Count.v = 0;
  Ind.v = from;
  for (let i = 1; i <= num; i++) {
    if (Tg(from + i) === CR) {
      Count.v++;
      Ind.v = from + i;
    }
  }
  if (Count.v > 0 && Tg(Ind.v + 1) === LF) Ind.v++;
}

// PAS: EDTEXTF.PAS RdNextPart – unit-internal
export function RdNextPart(): boolean {
  const P = EdPriv;
  const Part = P.Part;
  let Max = MinL(P.MaxLenT, StoreAvail() + P.LenT);
  const Pass = Max - (Max >>> 3);
  Part.MovL = 0;
  Part.MovI = 0;
  const MI = { v: 0 };
  if (P.AllRd) return false;
  if (Part.LenP === 0) {
    P.LenT = 0;
    P.T = NewT();
  }
  let Pos = Part.PosP;
  const BL = Part.LineP;
  if (P.LenT > Pass >>> 1) {
    LastLine(0, P.LenT - (Pass >>> 1), MI, fref(Part, 'MovL')); // 28kB+1 line
    SetColorOrd(fref(Part, 'ColorP'), 1, MI.v + 1);
    Pos += MI.v;
    P.LenT -= MI.v;
    TMove(MI.v + 1, 1, P.LenT);
    Part.LineP = BL + Part.MovL;
    Part.PosP = Pos;
    Part.MovI = MI.v;
  }
  // 1:
  Pos += P.LenT;
  const FSize = FileSizeH(P.TxtFH);
  P.AllRd = false;
  const iL = { v: P.LenT };
  const L1 = { v: 0 };
  let L11: number;
  do {
    const Rest = FSize - Pos;
    L11 = Rest > 0x1000 ? 0x1000 : Math.max(Rest, 0);
    Max = StoreAvail();
    if (Max > 0x400) Max -= 0x400;
    if (L11 > Max) L11 = Max;
    L1.v = L11;
    if (L1.v > 0) {
      SeekH(P.TxtFH, Pos);
      ReadH(P.TxtFH, L1.v, P.T!.subarray(P.LenT)); // ppa = @T^[LenT+1]
    }
    P.AllRd = Pos + L11 >= FSize;
    P.LenT += L1.v;
    Pos += L1.v;
  } while (!(P.LenT > Pass || P.AllRd || L11 === Max));
  LastLine(iL.v, P.LenT - iL.v - 1, iL, L1);
  if (P.AllRd) iL.v = P.LenT;
  if (iL.v < P.LenT) {
    P.LenT = iL.v;
    P.AllRd = false;
  }
  Part.LenP = P.LenT;
  Part.UpdP = false;
  if (Tg(P.LenT) === 0x1a && P.AllRd) P.LenT--;
  if (P.LenT <= 1) return false; // ????????
  return true;
}

// PAS: EDTEXTF.PAS RdPredPart.FirstLine (nested)
function FirstLine(from: number, num: number, Ind: Ref<number>, Count: Ref<number>): void {
  Count.v = 0;
  Ind.v = from - 1;
  for (let i = 0; i <= num - 1; i++) {
    if (Tg(from - 1 - i) === CR) {
      Count.v++;
      Ind.v = from - i;
    }
  }
  if (Count.v > 0 && Tg(Ind.v + 1) === LF) Ind.v++;
}

// PAS: EDTEXTF.PAS RdPredPart – unit-internal
export function RdPredPart(): boolean {
  const P = EdPriv;
  const Part = P.Part;
  let Max = MinL(P.MaxLenT, StoreAvail() + P.LenT);
  const Pass = Max - (Max >>> 3);
  Part.MovL = 0;
  const MI = { v: 0 };
  if (Part.PosP === 0) return false;
  let Pos = Part.PosP;
  const BL = Part.LineP;
  const L1 = { v: 0 };
  const L11 = { v: 0 };
  if (P.LenT > Pass >>> 1) {
    FirstLine(P.LenT + 1, P.LenT - (Pass >>> 1), L1, L11);
    if (L1.v < P.LenT) {
      P.AllRd = false;
      P.LenT = L1.v;
    }
  }
  // 1:
  L11.v = P.LenT;
  do {
    L1.v = Pos > 0x1000 ? 0x1000 : Pos;
    Max = StoreAvail();
    if (Max > 0x400) Max -= 0x400;
    if (L1.v > Max) L1.v = Max;
    TMove(1, L1.v + 1, P.LenT);
    if (L1.v > 0) {
      SeekH(P.TxtFH, Pos - L1.v);
      ReadH(P.TxtFH, L1.v, P.T!);
    }
    P.LenT += L1.v;
    Pos -= L1.v;
  } while (!(P.LenT > Pass || Pos === 0 || L1.v === Max));
  L11.v = P.LenT - L11.v;
  FirstLine(L11.v + 1, L11.v, MI, fref(Part, 'MovL'));
  if (Pos === 0) MI.v = L11.v;
  else if (Part.MovL > 0) {
    Part.MovL--;
    MI.v = L11.v - MI.v;
  }
  L1.v = L11.v - MI.v;
  P.LenT -= L1.v;
  Pos += L1.v;
  if (L1.v > 0) TMove(L1.v + 1, 1, P.LenT);
  Part.PosP = Pos;
  Part.LineP = BL - Part.MovL;
  Part.LenP = P.LenT;
  Part.MovI = MI.v;
  Part.UpdP = false;
  SetColorOrd(fref(Part, 'ColorP'), 1, MI.v + 1);
  if (P.LenT === 0) return false; // ????????
  return true;
}

// PAS: EDTEXTF.PAS UpdateFile – unit-internal
export function UpdateFile(): void {
  const P = EdPriv;
  const bv = BaseVars;
  const Part = P.Part;
  let n = 0xfff0;
  if (n > StoreAvail()) n = StoreAvail();
  const p = new Uint8Array(n);
  const d = P.LenT - Part.LenP;
  let HErr = 0;
  const pos1 = Part.PosP + Part.LenP;
  if (d > 0) {
    let pos = P.AbsLenT;
    while (pos > pos1) {
      if (pos - pos1 < n) n = pos - pos1;
      pos -= n;
      SeekH(P.TxtFH, pos);
      ReadH(P.TxtFH, n, p);
      SeekH(P.TxtFH, pos + d);
      WriteH(P.TxtFH, n, p);
      if (bv.HandleError !== 0) HErr = bv.HandleError;
    }
  } else if (d < 0) {
    let pos = pos1;
    while (pos < P.AbsLenT) {
      if (pos + n > P.AbsLenT) n = P.AbsLenT - pos;
      SeekH(P.TxtFH, pos);
      ReadH(P.TxtFH, n, p);
      SeekH(P.TxtFH, pos + d);
      WriteH(P.TxtFH, n, p);
      pos += n;
    }
    TruncH(P.TxtFH, P.AbsLenT + d);
  }
  SeekH(P.TxtFH, Part.PosP);
  if (P.LenT > 0) WriteH(P.TxtFH, P.LenT, P.T!);
  if (bv.HandleError !== 0) HErr = bv.HandleError;
  FlushH(P.TxtFH);
  P.AbsLenT = FileSizeH(P.TxtFH);
  if (HErr !== 0) {
    SetMsgPar(P.TxtPath);
    WrLLF10Msg(700 + HErr);
  }
  Part.UpdP = false;
  Part.LenP = P.LenT;
  if (Part.PosP < 400 && Part.LenP > 0x400) P.UpdPHead = false;
}

// PAS: EDTEXTF.PAS RdPart – unit-internal
export function RdPart(): void {
  const P = EdPriv;
  P.LenT = P.Part.LenP;
  P.T = NewT();
  if (P.LenT === 0) return;
  SeekH(P.TxtFH, P.Part.PosP);
  ReadH(P.TxtFH, P.LenT, P.T);
}
// PAS: EDTEXTF.PAS NullChangePart – unit-internal
export function NullChangePart(): void {
  const P = EdPriv;
  P.ChangePart = false;
  P.Part.MovI = 0;
  P.Part.MovL = 0;
}
// PAS: EDTEXTF.PAS RdFirstPart – unit-internal
export function RdFirstPart(): void {
  const P = EdPriv;
  NullChangePart();
  const Part = P.Part;
  Part.PosP = 0;
  Part.LineP = 0;
  Part.LenP = 0;
  Part.ColorP = '';
  P.AllRd = false;
  P.ChangePart = RdNextPart();
}

// PAS: EDTEXTF.PAS OpenTxtFh – unit-internal
export function OpenTxtFh(Mode: string): void {
  const P = EdPriv;
  const bv = BaseVars;
  bv.CPath = P.TxtPath;
  bv.CVol = P.TxtVol;
  TestMountVol(bv.CPath.length > 0 ? bv.CPath[0] : '\0');
  const UM: FileUseMode = Mode === ViewM ? RdOnly : Exclusive;
  P.TxtFH = OpenH(_isoldnewfile, UM);
  if (bv.HandleError !== 0) {
    SetMsgPar(bv.CPath);
    RunError(700 + bv.HandleError);
  }
  P.AbsLenT = FileSizeH(P.TxtFH);
}
