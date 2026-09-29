// PAS: GENRPRT.PAS – automatic reports: generates the source text of a report chapter from a field
// selection (list/report/totals/error records), compiles it (RDRPRT.ReadReport) and runs it.
//
// Porting notes:
// * asm/DOS: Ovr (no-op), BP7 asm SubstChar. FPC deviation: the BP7 `assembler` routine gets the
//   value string by reference (no local copy) and changes the caller's string; the FPC Pascal
//   version changes a copy, so its generated reports keep ' in masks and _ { } @ # \ in names.
//   BP7 wins (like ReplaceChar, PORTING.md 1): SubstChar(S: Ref<string>, C1, C2).
// * Private state: PFldDs (PFldD chain: FldD, ColTxt, ColItem, IsCtrl, IsSum, NxtLine, Level),
//   KpLetter, MaxCol, MaxColOld, MaxColUsed, NLines, NLevels, Mode: AutoRprtMode, Txt (the report
//   text being built with WrChar/WrBlks/WrStr/WrLevel into a LongStr).
// * GenAutoRprt: Design lays out columns (headings from field names, widths from field lengths,
//   wrapping to NxtLine when wider than RO^.Width), then writes '#I' input, '#H'/'#RH' heads, '#Dn'
//   detail/level blocks, '#F' footings with sums; WithNRecs adds the record count. The generated
//   text must be byte-identical to BP7's when it is stored as a chapter (SelGenRprt from the
//   project manager, 'R' chapter with empty text).
// * RunAutoReport saves/restores RO^.FDL.FD^.RecPtr around ReadReport + RUNRPRT.RunReport.
// * SelForAutoRprt: sort keys (PromptSortKeys), Menu(4) mode, control and sum fields via WWMIX
//   (messages 37/38), spec.AutoRprtPrint -> Path 'LPT1'.

import { fref, ref, chr, type Ref } from './pasrt.ts';
import { BaseVars, RdMsg, ChainLast, ListLength, MaxI, type LongStrPtr } from './base.ts';
import { DriversVars, _ESC_ } from './drivers.ts';
import {
  AccessVars, FieldDMask, LeftJust, f_Comma, f_Stored,
  type FieldDPtr, type FieldList, type KeyFldDPtr, type RdbDPtr, type FileDPtr,
} from './access.ts';
import { _ARprt, _ATotal, _AErrRecs, type AutoRprtMode, type RprtOptPtr } from './rdrun.ts';
import { Menu } from './wwmenu.ts';
import { PutSelect, SelectStr, GetSelect, SelFieldList, SelMark, WwMixVars } from './wwmix.ts';
import { PromptSortKeys, GetRprtOpt, SetInpLongStr } from './compile.ts';
import { ReadReport } from './rdrprt.ts';
import { RunReport } from './runrprt.ts';
import { FieldInList } from './runfrml.ts';

export type PFldDPtr = PFldD | null;
// PAS: GENRPRT.PAS PFldD – a field of the generated report and its layout
export class PFldD {
  Chain: PFldDPtr = null;
  FldD: FieldDPtr = null;
  ColTxt = 0;
  ColItem = 0;
  IsCtrl = false;
  IsSum = false;
  NxtLine = false;
  Level = 0;
}

let PFldDs: PFldDPtr = null;
let KpLetter = false;
let MaxCol = 0;
let MaxColOld = 0;
let MaxColUsed = 0;
let NLines = 0;
let NLevels = 0;
let Mode: AutoRprtMode = 0;
/** the LongStr being built by WrChar/WrBlks/WrStr (GetStore after Txt^) */
let Txt: number[] = [];

// PAS: GENRPRT.PAS SubstChar – BP7 assembler: changes the caller's string (see the notes)
export function SubstChar(S: Ref<string>, C1: string, C2: string): void {
  S.v = S.v.split(C1).join(C2);
}

// PAS: GENRPRT.PAS Design – columns of the fields (PFldDs) within RO^.Width
function Design(RO: RprtOptPtr): void {
  const ro = RO!;
  let L = 0;
  let Col = 0;
  let D: PFldDPtr;
  let D1: PFldDPtr = null;
  let WasTT: boolean;
  MaxCol = ro.Width;
  MaxColOld = MaxCol;
  let First = true;
  switch (ro.Style) {
    case 'C':
      KpLetter = true;
      break;
    case '?':
      KpLetter = true;
      MaxCol = Math.trunc(MaxCol / 0.6);
      break;
  }
  for (;;) {
    // label 1
    NLines = 1;
    Col = 1;
    WasTT = false;
    let LastTT = false;
    D = PFldDs;
    let frstOnLine = true;
    while (D !== null) {
      const F = D.FldD!;
      const LTxt = F.Name.length;
      const LItem = F.L;
      L = MaxI(LTxt, LItem);
      const L2 = D.IsSum ? 2 : 0;
      D.NxtLine = false;
      if (LastTT || F.Typ === 'T' || (!frstOnLine && Col + L2 + L > MaxCol + 1)) {
        D.NxtLine = true;
        NLines++;
        Col = 1;
        D1 = D;
      }
      frstOnLine = false;
      Col = Col + L2;
      D.ColItem = Col + Math.trunc((L - LItem + 1) / 2);
      if ((F.Typ === 'A' || F.Typ === 'N') && F.M === LeftJust) D.ColTxt = Col;
      else D.ColTxt = Col + L - LTxt;
      if (F.Typ === 'T') {
        D.ColItem = 1;
        D.ColTxt = 1;
        WasTT = true;
        LastTT = true;
      } else LastTT = false;
      Col += L + 1;
      D = D.Chain;
    }
    if (NLines > 1 && First && ro.Style === '?') {
      KpLetter = false;
      MaxCol = ro.Width;
      First = false;
      continue; // goto 1
    }
    break;
  }
  if (NLines > 1) {
    MaxColUsed = MaxCol;
    L = MaxCol + 1 - Col;
    if (L > 0) D = D1;
    if (!WasTT) {
      while (D !== null) {
        D.ColTxt = D.ColTxt + L;
        D.ColItem = D.ColItem + L;
        D = D.Chain;
      }
    }
  } else {
    MaxColUsed = Col;
    if (MaxColUsed <= ro.Width && ro.Style === '?') {
      MaxCol = ro.Width;
      KpLetter = false;
    }
  }
}

// PAS: GENRPRT.PAS WrChar
function WrChar(C: string): void {
  Txt.push(C.charCodeAt(0) & 0xff);
}
// PAS: GENRPRT.PAS WrBlks
function WrBlks(N: number): void {
  if (N <= 0) return;
  for (let i = 0; i < N; i++) Txt.push(0x20);
}
// PAS: GENRPRT.PAS WrStr
function WrStr(S: string): void {
  for (let i = 0; i < S.length; i++) Txt.push(S.charCodeAt(i) & 0xff);
}
// PAS: GENRPRT.PAS WrLevel – the field list and the '_' line of a #DE (Level 0) or footing block
function WrLevel(Level: number): void {
  const CFile = AccessVars.CFile!;
  const b = Level === 0 && Mode === _AErrRecs;
  if (b) WrStr('(warning) begin noErrRecs+=1 end,');
  let first = true;
  let d = PFldDs;
  while (d !== null) {
    if (Level === 0 || d.IsSum || (d.IsCtrl && d.Level >= Level)) {
      if (!first) WrChar(',');
      const f = d.FldD!;
      let s = f.Name.slice(0, 50);
      if (Level !== 0 && d.IsSum) s = ('sum(' + s + ')').slice(0, 50);
      if (f.Typ === 'D') {
        WrStr('strdate(');
        WrStr(s);
        WrStr(",'");
        const x = ref(FieldDMask(f) ?? '');
        SubstChar(x, "'", '"');
        WrStr(x.v);
        WrStr("')");
      } else WrStr(s);
      first = false;
    }
    d = d.Chain;
  }
  if (b) {
    if (!first) WrChar(',');
    WrStr("errortext+cond(^error:' ??')");
  }
  WrStr(';\r\n');
  let col = 1;
  if (CFile.Typ === '0') WrChar('\x11'); // RDB
  d = PFldDs;
  while (d !== null) {
    if (CFile.Typ === '0' && d.Chain === null) WrChar('\x11');
    if (d.NxtLine) {
      WrStr('\r\n');
      col = 1;
    }
    const f = d.FldD!;
    let l = f.L;
    let n = d.ColItem - col;
    col = d.ColItem + l;
    if (Level === 0 || d.IsSum || (d.IsCtrl && d.Level >= Level)) {
      if (Level !== 0 && d.IsSum) {
        n -= 2;
        l += 2;
      }
      WrBlks(n);
      if (f.Typ === 'F' || f.Typ === 'R') {
        const m = f.M;
        if (m !== 0) {
          for (let i = 1; i <= l - m - 1; i++) WrChar('_');
          l = m;
          if ((f.Flg & f_Comma) !== 0) WrChar(',');
          else WrChar('.');
        }
      }
      for (let i = 1; i <= l; i++) WrChar('_');
    } else WrBlks(n + l);
    d = d.Chain;
  }
  if (Level > 0) {
    WrBlks(MaxColUsed - col + 1);
    for (let I = 1; I <= Level; I++) WrChar('*');
  }
  if (b) {
    WrStr('\r\n\x17');
    WrBlks(5);
    WrStr('_\x17');
  }
  if (Mode !== _AErrRecs && NLines > 1) WrStr('\r\n');
}

// PAS: GENRPRT.PAS GenAutoRprt – the source text of the automatic report RO
export function GenAutoRprt(RO: RprtOptPtr, WithNRecs: boolean): LongStrPtr {
  const av = AccessVars;
  const ro = RO!;
  av.CFile = ro.FDL.FD;
  const CFile = av.CFile!;
  Mode = ro.Mode;
  NLevels = ListLength(ro.Ctrl);
  PFldDs = null;
  let fl: FieldList = ro.Flds;
  while (fl !== null) {
    const d = new PFldD();
    const f = fl.FldD;
    d.FldD = f;
    d.IsSum = FieldInList(f, ro.Sum);
    let fl1 = ro.Ctrl;
    let i = NLevels;
    while (fl1 !== null) {
      if (fl1.FldD === f) {
        d.IsCtrl = true;
        d.Level = i;
      }
      i--;
      fl1 = fl1.Chain;
    }
    if (Mode === _ATotal && !d.IsSum && !d.IsCtrl) {
      // ReleaseStore(d)
    } else ChainLast(ref_PFldDs(), d);
    fl = fl.Chain;
  }
  Design(RO);

  Txt = [];

  if (Mode === _AErrRecs) WrStr('var noErrRecs:real;\r\n');
  WrStr('#I1_');
  WrStr(CFile.Name);
  if (ro.SK !== null) WrChar('!');
  WrBlks(2);
  let first = true;
  fl = ro.Ctrl;
  let kf: KeyFldDPtr = ro.SK;
  while (fl !== null) {
    if (!first) WrChar(',');
    const f = fl.FldD!;
    if (kf !== null && f === kf.FldD) {
      if (kf.Descend) WrChar('>');
      if (kf.CompLex) WrChar('~');
      kf = kf.Chain;
    } else if (f.Typ === 'A') WrChar('~');
    WrStr(f.Name);
    fl = fl.Chain;
    first = false;
  }
  if (kf !== null) {
    if (!first) WrChar(';');
    first = true;
    while (kf !== null) {
      if (!first) WrChar(',');
      if (kf.Descend) WrChar('>');
      if (kf.CompLex) WrChar('~');
      WrStr(kf.FldD!.Name);
      kf = kf.Chain;
      first = false;
    }
  }

  if (Mode === _ATotal && NLevels === 0) WrStr('\r\n#RH');
  else WrStr('\r\n#PH ');
  if (ro.HeadTxt === null) {
    WrStr('today,page;\r\n');
    WrBlks(19);
    WrChar('\x11');
    const s = ref(CFile.Name);
    WrBlks(8 - s.v.length);
    SubstChar(s, '_', '-');
    WrStr(s.v);
    WrChar('\x11');
    WrBlks(14);
    WrStr('__.__.____');
    RdMsg(17);
    WrBlks(12 - BaseVars.MsgLine.length);
    WrStr(BaseVars.MsgLine);
    WrStr('___');
  } else {
    const p = ro.HeadTxt;
    const l = p.length;
    let i = 0;
    first = true;
    while (i < l) {
      if (p[i] === 0x5f) {
        // '_'
        let point = false;
        while (i <= l && (p[i] === 0x5f || p[i] === 0x2e)) {
          if (p[i] === 0x2e) point = true;
          i++;
        }
        if (!first) WrChar(',');
        first = false;
        if (point) WrStr('today');
        else WrStr('page');
      }
      i++;
    }
    WrStr(';\r\n');
    for (i = 0; i <= l - 1; i++) WrChar(chr(p[i]));
  }
  if (Mode === _AErrRecs) {
    RdMsg(18);
    WrStr('\r\n\x17');
    WrBlks(Math.trunc((38 - BaseVars.MsgLine.length) / 2));
    WrStr(BaseVars.MsgLine);
    WrChar('\x17');
  }
  if (ro.CondTxt !== null) {
    WrStr('\r\n\x17');
    const s = ref(ro.CondTxt);
    SubstChar(s, '{', '%');
    SubstChar(s, '}', '%');
    SubstChar(s, '_', '-');
    SubstChar(s, '@', '*');
    SubstChar(s, '#', '=');
    SubstChar(s, '\\', '|');
    if (s.v.length > MaxCol) s.v = s.v.slice(0, MaxCol & 0xff);
    WrBlks(Math.trunc((MaxColOld - s.v.length) / 2));
    WrStr(s.v);
    WrChar('\x17');
  }
  WrStr('\r\n');
  if (KpLetter) WrChar('\x05');
  let d = PFldDs as PFldDPtr; // (TS narrowing: PFldDs was filled by ChainLast)
  let col = 1;
  while (d !== null) {
    if (d.NxtLine) {
      WrStr('\r\n');
      col = 1;
    }
    WrBlks(d.ColTxt - col);
    const s = ref(d.FldD!.Name);
    SubstChar(s, '_', '-');
    WrStr(s.v);
    col = d.ColTxt + d.FldD!.Name.length;
    d = d.Chain;
  }

  if (KpLetter) WrStr('\r\n#PF;\r\n\x05');

  WrStr('\r\n#DH .notsolo;\r\n');
  if (Mode !== _ATotal) {
    WrStr('\r\n#DE ');
    WrLevel(0);
  }
  for (let i = 1; i <= NLevels; i++) {
    WrStr('\r\n#CF_');
    d = PFldDs as PFldDPtr;
    while (d !== null) {
      if (d.IsCtrl && d.Level === i) WrStr(d.FldD!.Name);
      d = d.Chain;
    }
    WrChar(' ');
    WrLevel(i);
  }
  if (ro.Ctrl !== null || ro.Sum !== null) {
    WrStr('\r\n#RF (sum(1)>0) ');
    WrLevel(NLevels + 1);
  }
  if (WithNRecs) {
    WrStr('\r\n#RF ');
    if (Mode === _AErrRecs) WrStr('noErrRecs,');
    WrStr('sum(1);\r\n\r\n');
    if (Mode === _AErrRecs) {
      RdMsg(18);
      WrStr(BaseVars.MsgLine);
      WrStr(':_____\r\n');
    }
    RdMsg(20);
    WrStr(BaseVars.MsgLine);
    WrStr('_______');
  }
  return Uint8Array.from(Txt);
}
/** TS-only: Ref to the private PFldDs root (ChainLast(PFldDs, d)) */
function ref_PFldDs(): Ref<PFldDPtr> {
  return {
    get v() {
      return PFldDs;
    },
    set v(x: PFldDPtr) {
      PFldDs = x;
    },
  };
}

// PAS: GENRPRT.PAS RunAutoReport
export function RunAutoReport(RO: RprtOptPtr): void {
  const ro = RO!;
  const p1 = ro.FDL.FD!.RecPtr;
  const txt = GenAutoRprt(RO, true);
  SetInpLongStr(txt, false);
  ReadReport(RO);
  RunReport(RO);
  ro.FDL.FD!.RecPtr = p1;
}

// PAS: GENRPRT.PAS SelForAutoRprt – interactive options of an auto report
export function SelForAutoRprt(RO: RprtOptPtr): boolean {
  const ro = RO!;
  if (ro.SK === null && !PromptSortKeys(ro.Flds, fref(ro, 'SK'))) return false;
  const N = Menu(4, 1);
  if (N === 0) return false;
  ro.Mode = N - 1;
  AccessVars.CFile = ro.FDL.FD;
  if (ro.Mode === _ARprt || ro.Mode === _ATotal) {
    let FL = ro.Flds;
    while (FL !== null) {
      if (FL.FldD!.Typ !== 'T') PutSelect(FL.FldD!.Name);
      FL = FL.Chain;
    }
    if (!SelFieldList(37, false, fref(ro, 'Ctrl'))) return false;
    FL = ro.Flds;
    while (FL !== null) {
      if (FL.FldD!.FrmlTyp === 'R') PutSelect(FL.FldD!.Name);
      FL = FL.Chain;
    }
    if (!SelFieldList(38, true, fref(ro, 'Sum'))) return false;
  }
  if (BaseVars.Spec.AutoRprtPrint) ro.Path = 'LPT1';
  return true;
}

// PAS: GENRPRT.PAS SelGenRprt – choose file and fields, return the generated report text (nil = ESC)
export function SelGenRprt(RprtName: string): LongStrPtr | null {
  const av = AccessVars;
  let r: RdbDPtr = av.CRdb;
  let fd: FileDPtr;
  let s: string;
  while (r !== null) {
    fd = r.FD!.Chain;
    while (fd !== null) {
      s = fd.Name;
      if (r !== av.CRdb) s = r.FD!.Name + '.' + s;
      PutSelect(s);
      fd = fd.Chain;
    }
    r = r.ChainBack;
  }
  WwMixVars.ss.Abcd = true;
  SelectStr(0, 0, 19, '"' + RprtName + '"');
  if (DriversVars.KbdChar === _ESC_) return null;
  s = GetSelect();
  const i = s.indexOf('.') + 1;
  r = av.CRdb;
  if (i !== 0) {
    do r = r!.ChainBack;
    while (r!.FD!.Name !== s.slice(0, i - 1));
    s = s.slice(i, i + 255);
  }
  fd = r!.FD;
  do fd = fd!.Chain;
  while (fd!.Name !== s);
  const ro = GetRprtOpt()!;
  ro.FDL.FD = fd;
  let f = fd!.FldD;
  while (f !== null) {
    s = f.Name;
    if ((f.Flg & f_Stored) === 0) s = SelMark + s;
    PutSelect(s);
    f = f.Chain;
  }
  av.CFile = fd;
  SelFieldList(36, true, fref(ro, 'Flds'));
  if (ro.Flds === null) return null;
  ro.Mode = _ARprt;
  let fl: FieldList = ro.Flds;
  while (fl !== null) {
    PutSelect(fl.FldD!.Name);
    fl = fl.Chain;
  }
  if (!SelFieldList(37, false, fref(ro, 'Ctrl'))) return null;
  fl = ro.Flds;
  while (fl !== null) {
    if (fl.FldD!.FrmlTyp === 'R') PutSelect(fl.FldD!.Name);
    fl = fl.Chain;
  }
  if (!SelFieldList(38, false, fref(ro, 'Sum'))) return null;
  return GenAutoRprt(ro, false);
}
