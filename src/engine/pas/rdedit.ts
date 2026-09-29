// PAS: RDEDIT.PAS – builds an EditD (data editor descriptor) from EditOpt: screen form (F chapter:
// head lines, '#_FILE' field list, field positions from '_' runs) or an automatic layout,
// colours, mode flags, the file's #D/#L/#I sections (UDLI), key checks, standard head line.
//
// Porting notes:
// * State: `E: EditDPtr absolute EditDRoot` – an accessor for RdRunVars.EditDRoot (the EditD
//   stack, chained by PrevE). No other globals.
// * No asm. FPC vs BP7: NewEditD copies EditOpt.WFlags..SelKey into the EditD – BP7 with one Move
//   over the byte range, FPC field by field (WFlags, ExD, Journal, ViewName, OwnerTyp, DownLD,
//   DownLV, DownRecPtr, LVRecPtr, KIRoot, SQLFilter, SelKey). Port the FPC list.
// * EditModeToFlags(RunShortStr(EO^.Mode), NoDelete, false) overlays 24 booleans starting at
//   EditD.NoDelete: pass a temp boolean[] and copy by COMPILE.EditModeFlagFields.
// * Tricky: AutoDesign starts with `D:=EFldDPtr(@E^.FirstFld)` – uses the FirstFld field as the
//   Chain of a fake head node; in TS keep a local head/last pointer. RdEForm reads raw characters
//   (ReadChar/ForwChar) for head lines and field underscores, mixing with RdLex for the field list.
//   PushEdit sets V to (1,2,TxtCols,TxtRows-1). StandardHead pads with the 59-char template.
//   The catalog ('C') and RDB ('0') files get UDLI text from messages 53-55 via SetInpStr.
// * SetFrmlFlags walks P1/P2/P3 by the op ranges. Pascal reads them through the variant overlay
//   (e.g. _link's LinkLD sits where P1 is); in TS such non-formula slots are separate fields and
//   P1..P3 read nil there, so the walk only follows real formula operands.
// * Private routines: SToSL, StoreRT, RdEForm (+ FindScanNr), AutoDesign, NewEditD's nested
//   FindEFld, ZeroUsed, LstUsedFld, RdDepChkImpl (+ TestedFlagOff, SetFrmlFlags/SetFlag, RdDep,
//   RdCheck, RdImpl, RdUDLI, RdAllUDLIs), StandardHead, GetStr, NewChkKey.

import { ref, fref, chr, ord, Copy, ShortStr, StrI, Div, word, type Ref, type Pointer } from './pasrt.ts';
import {
  BaseVars, ChainLast, SetStyleAttr, Set2MsgPar, StoreStr, MarkStore, MarkStore2, ReleaseStore, ReleaseStore2,
  RdMsg, MinW, SEquUpcase, LenStyleStr, WHasFrame, WShadow, type StringPtr,
} from './base.ts';
import {
  AccessVars, FieldListEl, StringListEl, KeyListEl, DepD, ImplD, RdbPos, GetRecSpace, ResetCompilePars, EquKFlds,
  f_Stored, _field, _access, _userfunc, _assign, _number,
  type FileDPtr, type FieldList, type FieldDPtr, type FrmlPtr, type StringList, type KeyFldDPtr, type ChkDPtr,
  type KeyDPtr, type WKeyDPtr, type RdbDPtr,
} from './access.ts';
import {
  RdRunVars, EditD, EFldD, ERecTxtD, type EditOptPtr, type EFldDPtr,
} from './rdrun.ts';
import {
  Error, OldError, ReadChar, SkipBlank, Accept, TestLex, RdLex, RdInteger, RdFileName, RdFldName, RdBool, RdFrml,
  SetInpTT, SetInpTTxtPos, SetInpStr, EditModeToFlags, EditModeFlagFields,
} from './compile.ts';
import { RdChkD } from './rdfildcl.ts';
import {
  RunWordImpl, RunShortStr, RunWFrml, RunEvalFrml, RunInt, GetFromKey, FieldInList, TrailChar,
} from './runfrml.ts';
import { RunError } from './obaseww.ts';

const EOFChar = '\x1a'; // ^Z

/** TS-only: the lexer's ForwChar / Lexem, read fresh (the lexer calls change them) */
function FC(): string {
  return AccessVars.ForwChar;
}
function LX(): string {
  return AccessVars.Lexem;
}

/** PAS: `E: EditDPtr absolute EditDRoot` */
function E(): EditD {
  return RdRunVars.EditDRoot!;
}

// PAS: RDEDIT.PAS PushEdit – new EditD on top of EditDRoot
export function PushEdit(): void {
  const E1 = new EditD(); // GetZStore
  const V = E1.V;
  V.C1 = 1;
  V.R1 = 2;
  V.C2 = BaseVars.TxtCols;
  V.R2 = BaseVars.TxtRows - 1;
  E1.PrevE = RdRunVars.EditDRoot;
  RdRunVars.EditDRoot = E1;
}

// PAS: RDEDIT.PAS SToSL
function SToSL(SLRoot: Ref<StringList>, s: string): void {
  const SL = new StringListEl();
  SL.S = s;
  ChainLast(SLRoot, SL);
}

// PAS: RDEDIT.PAS StoreRT – the record text of one form page (Ln lines)
function StoreRT(Ln: number, SL: StringList, NFlds: number): void {
  if (NFlds === 0) Error(81);
  const RT = new ERecTxtD();
  ChainLast(fref(E(), 'RecTxt'), RT);
  RT.N = Ln;
  RT.SL = SL;
}

// PAS: RDEDIT.PAS RdEForm – head lines, '#_FILE [n:]field,...;' and the record lines of a form
function RdEForm(ParFD: FileDPtr, FormPos: RdbPos): void {
  const a = AccessVars;
  const e = E();
  // PAS: RDEDIT.PAS RdEForm.FindScanNr – the field with the least ScanNr >= N
  const FindScanNr = (N: number): EFldDPtr => {
    let D = e.FirstFld;
    let M = 0xffff;
    let D1: EFldDPtr = null;
    while (D !== null) {
      if (D.ScanNr >= N && D.ScanNr < M) {
        M = D.ScanNr;
        D1 = D;
      }
      D = D.Chain;
    }
    return D1;
  };
  let s: string;
  let D: EFldDPtr;
  let N = 0;
  SetInpTT(FormPos, true);
  // 1: read headlines
  for (;;) {
    s = '';
    while (!(FC() === '#' || FC() === EOFChar || FC() === '\r' || FC() === '{')) {
      s = ShortStr(s + a.ForwChar);
      ReadChar();
    }
    if (FC() === EOFChar) Error(76);
    if (FC() === '#') break; // goto 2
    if (FC() === '{') {
      SkipBlank(true);
      continue; // goto 1
    }
    ReadChar();
    if (FC() === '\n') ReadChar();
    SToSL(fref(e, 'HdTxt'), s);
    e.NHdTxt++;
    if (e.NHdTxt + 1 > e.Rows) Error(102);
  }
  // 2: read field list
  ReadChar();
  ReadChar();
  a.Lexem = a.CurrChar;
  Accept('_');
  const FD1 = RdFileName();
  if (ParFD === null) a.CFile = FD1;
  else a.CFile = ParFD;
  e.FD = a.CFile;
  for (;;) {
    // 3:
    N++;
    D = new EFldD(); // GetZStore
    if (LX() === _number) {
      const M = RdInteger();
      if (M === 0) OldError(115);
      Accept(':');
      D.ScanNr = M;
    } else D.ScanNr = N;
    const D1 = FindScanNr(D.ScanNr);
    ChainLast(fref(e, 'FirstFld'), D);
    if (D1 !== null && D.ScanNr === D1.ScanNr) Error(77);
    const F = RdFldName(a.CFile);
    D.FldD = F;
    const FL = new FieldListEl();
    FL.FldD = F;
    ChainLast(fref(e, 'Flds'), FL);
    if (LX() === ',') {
      RdLex();
      continue; // goto 3
    }
    break;
  }
  TestLex(';');
  SkipBlank(true);
  // read record lines
  D = e.FirstFld;
  let NPages = 0;
  let Ln = 0;
  let NFlds = 0;
  let SLRoot = ref<StringList>(null);
  page: for (;;) {
    // 4:
    NPages++;
    Ln = 0;
    NFlds = 0;
    SLRoot = ref<StringList>(null);
    for (;;) {
      // 5:
      s = '';
      Ln++;
      let Col = e.FrstCol;
      while (!(FC() === '\r' || FC() === EOFChar || FC() === '\\' || FC() === '{')) {
        if (FC() === '_') {
          if (D === null) Error(30);
          NFlds++;
          D.Col = Col;
          D.Ln = Ln;
          D.Page = NPages;
          let M = 0;
          while (FC() === '_') {
            s = ShortStr(s + ' ');
            M++;
            Col++;
            ReadChar();
          }
          const F = D.FldD!;
          D.L = F.L;
          if (F.Typ === 'T') D.L = 1;
          if (F.Typ === 'A' && M < F.L) D.L = M;
          else if (M !== D.L) {
            s = StrI(D.L, 2);
            Set2MsgPar(s, F.Name);
            Error(79);
          }
          if (Col > e.LastCol) Error(102);
          D = D.Chain;
        } else {
          const at = ref(0);
          if (!SetStyleAttr(a.ForwChar, at)) {
            if (Col > e.LastCol) Error(102);
            Col++;
          }
          s = ShortStr(s + a.ForwChar);
          ReadChar();
        }
      }
      SToSL(SLRoot, s);
      const c = a.ForwChar;
      if (c === '\\') ReadChar();
      SkipBlank(true);
      if (FC() !== EOFChar) {
        if (c === '\\' || e.NHdTxt + Ln === e.Rows) {
          StoreRT(Ln, SLRoot.v, NFlds);
          continue page; // goto 4
        }
        continue; // goto 5
      }
      break page;
    }
  }
  StoreRT(Ln, SLRoot.v, NFlds);
  e.NPages = NPages;

  if (D !== null) Error(30);
  // order the fields by ScanNr
  D = FindScanNr(1)!;
  D.ChainBack = null;
  let PrevD: EFldDPtr;
  for (let i = 2; i <= N; i++) {
    PrevD = D;
    D = FindScanNr(D!.ScanNr + 1)!;
    D.ChainBack = PrevD;
  }
  e.LastFld = D;
  PrevD = null;
  while (D !== null) {
    D.Chain = PrevD;
    PrevD = D;
    D = D.ChainBack;
  }
  e.FirstFld = PrevD;
}

// PAS: RDEDIT.PAS AutoDesign – an automatic form: field names centred above the fields
function AutoDesign(FL: FieldList): void {
  const e = E();
  let NPages = 1;
  let s = '';
  let Ln = 0;
  let SLRoot = ref<StringList>(null);
  // D = nil stands for the fake head `EFldDPtr(@E^.FirstFld)`
  let D: EFldDPtr = null;
  let PrevD: EFldDPtr = null;
  let Col = e.FrstCol;
  const maxcol = word(e.LastCol - e.FrstCol);
  while (FL !== null) {
    const F = FL.FldD!;
    FL = FL.Chain;
    const DNew = new EFldD(); // GetZStore
    if (D === null) e.FirstFld = DNew;
    else D.Chain = DNew;
    D = DNew;
    D.ChainBack = PrevD;
    PrevD = D;
    D.FldD = F;
    D.L = F.L;
    if (D.L > maxcol) D.L = maxcol;
    if (e.FD!.Typ === 'C' && D.L > 44) D.L = 44; // catalog pathname
    const FldLen = D.L;
    if (F.Typ === 'T') D.L = 1;
    let L = F.Name.length;
    if (FldLen > L) L = FldLen;
    if (Col + L > e.LastCol) {
      SToSL(SLRoot, s);
      SToSL(SLRoot, '');
      Ln += 2;
      if (Ln + 2 > e.Rows) {
        StoreRT(Ln, SLRoot.v, 1);
        NPages++;
        Ln = 0;
        SLRoot = ref<StringList>(null);
      }
      Col = e.FrstCol;
      s = '';
    }
    let m = Div(L - F.Name.length + 1, 2);
    for (let i = 1; i <= m; i++) s = ShortStr(s + ' ');
    s = ShortStr(s + F.Name);
    m = L - F.Name.length - m;
    for (let i = 1; i <= m + 1; i++) s = ShortStr(s + ' ');
    D.Col = Col + Div(L - FldLen + 1, 2);
    D.Ln = Ln + 2;
    D.Page = NPages;
    Col += L + 1;
  }
  SToSL(SLRoot, s);
  SToSL(SLRoot, '');
  Ln += 2;
  StoreRT(Ln, SLRoot.v, 1);
  if (D === null) {
    // no fields: the fake head's Chain is FirstFld (LastFld would point at the head)
    e.FirstFld = null;
    e.LastFld = null;
  } else {
    D.Chain = null;
    e.LastFld = D;
  }
  e.NPages = NPages;
  if (NPages === 1) {
    const RT = e.RecTxt!;
    if (RT.N === 2) {
      e.HdTxt = RT.SL;
      RT.SL = RT.SL!.Chain;
      e.HdTxt!.Chain = null;
      e.NHdTxt = 1;
      RT.N = 1;
      D = e.FirstFld;
      while (D !== null) {
        D.Ln--;
        D = D.Chain;
      }
      if (e.Rows === 1) {
        e.NHdTxt = 0;
        e.HdTxt = null;
      }
    } else if (RT.N < e.Rows) {
      s = '';
      for (let i = e.FrstCol; i <= e.LastCol; i++) s = ShortStr(s + '-');
      SToSL(fref(RT, 'SL'), s);
      RT.N++;
    }
  }
}

// PAS: RDEDIT.PAS RdFormOrDesign – FL=nil: read the form at FormPos, else auto layout of FL
export function RdFormOrDesign(F: FileDPtr, FL: FieldList, FormPos: RdbPos): void {
  const e = E();
  e.FrstCol = e.V.C1;
  e.FrstRow = e.V.R1;
  e.LastCol = e.V.C2;
  e.LastRow = e.V.R2;
  if ((e.WFlags & WHasFrame) !== 0) {
    e.FrstCol++;
    e.LastCol--;
    e.FrstRow++;
    e.LastRow--;
  }
  e.Rows = e.LastRow - e.FrstRow + 1;
  if (FL === null) {
    ResetCompilePars();
    RdEForm(F, FormPos);
    e.IsUserForm = true;
  } else {
    e.FD = F;
    e.Flds = FL;
    AutoDesign(FL);
  }
}

// PAS: RDEDIT.PAS NewEditD.FindEFld
function FindEFld(F: FieldDPtr): EFldDPtr {
  let D = E().FirstFld;
  while (D !== null) {
    if (D.FldD === F) break;
    D = D.Chain;
  }
  return D;
}
// PAS: RDEDIT.PAS NewEditD.ZeroUsed
function ZeroUsed(): void {
  let D = E().FirstFld;
  while (D !== null) {
    D.Used = false;
    D = D.Chain;
  }
}
// PAS: RDEDIT.PAS NewEditD.LstUsedFld
function LstUsedFld(): EFldDPtr {
  let D = E().LastFld;
  while (D !== null) {
    if (D.Used) break;
    D = D.ChainBack;
  }
  return D;
}

// PAS: RDEDIT.PAS NewEditD.RdDepChkImpl.TestedFlagOff
function TestedFlagOff(): void {
  let F = AccessVars.CFile!.FldD;
  while (F !== null) {
    F.Typ = chr(ord(F.Typ) & 0x7f);
    F = F.Chain;
  }
}
// PAS: RDEDIT.PAS NewEditD.RdDepChkImpl.SetFrmlFlags – mark the form fields a formula depends on
// (stored fields: Used; computed fields: their formula); bit 7 of Typ = already visited
function SetFrmlFlags(Z: FrmlPtr): void {
  // PAS: RDEDIT.PAS NewEditD.RdDepChkImpl.SetFrmlFlags.SetFlag
  const SetFlag = (F: FieldDPtr): void => {
    const f = F!;
    if ((ord(f.Typ) & 0x80) !== 0) return;
    f.Typ = chr(ord(f.Typ) | 0x80);
    if ((f.Flg & f_Stored) !== 0) {
      const D = FindEFld(f);
      if (D !== null) D.Used = true;
    } else SetFrmlFlags(f.Frml);
  };
  if (Z === null) return;
  const op = ord(Z.Op);
  if (Z.Op === _field) SetFlag(Z.Field);
  else if (Z.Op === _access) {
    if (Z.LD !== null) {
      let Arg: KeyFldDPtr = Z.LD.Args;
      while (Arg !== null) {
        SetFlag(Arg.FldD);
        Arg = Arg.Chain;
      }
    }
  } else if (Z.Op === _userfunc) {
    let fl = Z.FrmlL;
    while (fl !== null) {
      SetFrmlFlags(fl.Frml);
      fl = fl.Chain;
    }
  } else if (op >= 0x60 && op <= 0xaf) {
    SetFrmlFlags(Z.P1); // 1-ary
  } else if (op >= 0xb0 && op <= 0xef) {
    SetFrmlFlags(Z.P1); // 2-ary
    SetFrmlFlags(Z.P2);
  } else if (op >= 0xf0 && op <= 0xff) {
    SetFrmlFlags(Z.P1); // 3-ary
    SetFrmlFlags(Z.P2);
    SetFrmlFlags(Z.P3);
  }
}

// PAS: RDEDIT.PAS NewEditD.RdDepChkImpl.RdDep – '#D (bool) field:=frml; field:=frml; ...'
function RdDep(): void {
  const a = AccessVars;
  let Bool: FrmlPtr = null;
  let withBool = true;
  RdLex();
  for (;;) {
    if (withBool) {
      // 1:
      Accept('(');
      Bool = RdBool();
      Accept(')');
    }
    // 2:
    const D = FindEFld(RdFldName(a.CFile));
    Accept(_assign);
    const FTyp = ref('\0');
    const Z = RdFrml(FTyp);
    if (D !== null) {
      const Dp = new DepD();
      Dp.Bool = Bool;
      Dp.Frml = Z;
      ChainLast(fref(D, 'Dep'), Dp);
    }
    if (LX() === ';') {
      RdLex();
      if (!(LX() === '#' || LX() === EOFChar)) {
        withBool = LX() === '(';
        continue;
      }
    }
    break;
  }
}
// PAS: RDEDIT.PAS NewEditD.RdDepChkImpl.RdCheck – '#L' checks, each hung on the last form field it uses
function RdCheck(): void {
  const a = AccessVars;
  SkipBlank(false);
  let Low = a.CurrPos;
  RdLex();
  for (;;) {
    // 1:
    const C: ChkDPtr = RdChkD(Low);
    ZeroUsed();
    SetFrmlFlags(C!.Bool);
    TestedFlagOff();
    const D = LstUsedFld();
    if (D !== null) ChainLast(fref(D, 'Chk'), C!);
    else ReleaseStore(C);
    if (LX() === ';') {
      SkipBlank(false);
      Low = a.CurrPos;
      RdLex();
      if (!(LX() === '#' || LX() === EOFChar)) continue;
    }
    break;
  }
}
// PAS: RDEDIT.PAS NewEditD.RdDepChkImpl.RdImpl – '#I field:=frml; ...' implicit values
function RdImpl(): void {
  const a = AccessVars;
  RdLex();
  for (;;) {
    // 1:
    const F = RdFldName(a.CFile);
    Accept(_assign);
    const FTyp = ref('\0');
    const Z = RdFrml(FTyp);
    const D = FindEFld(F);
    if (D !== null) D.Impl = Z;
    else {
      const ID = new ImplD();
      ID.FldD = F;
      ID.Frml = Z;
      ChainLast(fref(E(), 'Impl'), ID);
    }
    if (LX() === ';') {
      RdLex();
      if (!(LX() === '#' || LX() === EOFChar)) continue;
    }
    break;
  }
}
// PAS: RDEDIT.PAS NewEditD.RdDepChkImpl.RdUDLI – the #U (skipped), #D, #L, #I sections
function RdUDLI(): void {
  RdLex();
  if (LX() === '#' && FC() === 'U') {
    do RdLex();
    while (!(LX() === '#' || LX() === EOFChar));
  }
  if (LX() === '#' && FC() === 'D') {
    RdLex();
    RdDep();
  }
  if (LX() === '#' && FC() === 'L') {
    RdLex();
    RdCheck();
  }
  if (LX() === '#' && FC() === 'I') {
    RdLex();
    RdImpl();
  }
}
// PAS: RDEDIT.PAS NewEditD.RdDepChkImpl.RdAllUDLIs – of the file and the files it is 'LIKE'
function RdAllUDLIs(FD: FileDPtr): void {
  const a = AccessVars;
  if (FD!.OrigFD !== null) RdAllUDLIs(FD!.OrigFD);
  if (FD!.TxtPosUDLI !== 0) {
    ResetCompilePars();
    SetInpTTxtPos(FD);
    const r: RdbDPtr = a.CRdb;
    a.CRdb = FD!.ChptPos.R;
    RdUDLI();
    a.CRdb = r;
  }
}
// PAS: RDEDIT.PAS NewEditD.RdDepChkImpl
function RdDepChkImpl(): void {
  const a = AccessVars;
  a.CFile = E().FD;
  let s: string;
  switch (a.CFile!.Typ) {
    case '0':
      RdMsg(53);
      s = BaseVars.MsgLine;
      break; // goto 1
    case 'C': {
      const cpm = BaseVars.Spec.CPMdrive;
      RdMsg(54);
      s = BaseVars.MsgLine;
      if (cpm !== ' ') s = ShortStr(s + ",'" + cpm + ":'");
      RdMsg(55);
      s = ShortStr(s + BaseVars.MsgLine);
      if (cpm !== ' ') s = ShortStr(s + ',' + cpm + ':');
      s = ShortStr(s + "'");
      break;
    }
    default:
      RdAllUDLIs(a.CFile);
      return;
  }
  // 1:
  ResetCompilePars();
  SetInpStr(ref(s));
  RdUDLI();
}

// PAS: RDEDIT.PAS StandardHead – '          FILE[/alias]                  __.__.____'
function StandardHead(): StringPtr {
  const e = E();
  const c = '          ______                                 __.__.____';
  let s: string;
  if (e.ViewName !== null) s = e.ViewName;
  else if (e.EdRecVar) s = '';
  else {
    s = e.FD!.Name;
    switch (e.FD!.Typ) {
      case 'X': {
        const p = e.VK !== null ? e.VK.Alias : null; // Pascal reads nil^.Alias (garbage) when no key
        if (p !== null && p !== '') s = s + '/' + p;
        break;
      }
      case '0':
        s = s + '.RDB';
        break;
      case '8':
        s = s + '.DTA';
        break;
    }
  }
  if (s.length > 16) s = s.slice(0, 16);
  return StoreStr(ShortStr(Copy(c, 17, 20 - s.length) + s + c));
}

// PAS: RDEDIT.PAS GetStr – a head/last line formula, cut to the screen width
function GetStr(Z: FrmlPtr): StringPtr {
  if (Z === null) return null;
  let s = RunShortStr(Z);
  while (LenStyleStr(s) > BaseVars.TxtCols) s = s.slice(0, -1);
  return StoreStr(s);
}
// PAS: RDEDIT.PAS NewChkKey – each unique key is checked at the last form field of its key fields
function NewChkKey(): void {
  let K: KeyDPtr = AccessVars.CFile!.Keys;
  while (K !== null) {
    if (!K.Duplic) {
      ZeroUsed();
      let KF = K.KFlds;
      while (KF !== null) {
        const D = FindEFld(KF.FldD);
        if (D !== null) D.Used = true;
        KF = KF.Chain;
      }
      const D = LstUsedFld();
      if (D !== null) {
        const KL = new KeyListEl();
        ChainLast(fref(D, 'KL'), KL);
        KL.Key = K;
      }
    }
    K = K.Chain;
  }
}

// PAS: RDEDIT.PAS NewEditD
export function NewEditD(ParFD: FileDPtr, EO: EditOptPtr): void {
  const a = AccessVars;
  const spec = BaseVars.Spec;
  const colors = BaseVars.Colors;
  const eo = EO!;
  const p = ref<Pointer>(null);
  PushEdit();
  MarkStore2(p);
  const e = E();
  // FPC: field by field (BP7: Move(EO^.WFlags, WFlags, ofs(SelKey)-ofs(WFlags)+4))
  e.WFlags = eo.WFlags;
  e.ExD = eo.ExD;
  e.Journal = eo.Journal;
  e.ViewName = eo.ViewName;
  e.OwnerTyp = eo.OwnerTyp;
  e.DownLD = eo.DownLD;
  e.DownLV = eo.DownLV;
  e.DownRecPtr = eo.DownRecPtr;
  e.LVRecPtr = eo.LVRecPtr;
  e.KIRoot = eo.KIRoot;
  e.SQLFilter = eo.SQLFilter;
  e.SelKey = eo.SelKey as WKeyDPtr; // WKeyDPtr(EO^.SelKey)
  e.Attr = RunWordImpl(eo.ZAttr, colors.dTxt);
  e.dNorm = RunWordImpl(eo.ZdNorm, colors.dNorm);
  e.dHiLi = RunWordImpl(eo.ZdHiLi, colors.dHili);
  e.dSubSet = RunWordImpl(eo.ZdSubset, colors.dSubset);
  e.dDel = RunWordImpl(eo.ZdDel, colors.dDeleted);
  e.dTab = RunWordImpl(eo.ZdTab, e.Attr | 0x08);
  e.dSelect = RunWordImpl(eo.ZdSelect, colors.dSelect);
  e.Top = StoreStr(RunShortStr(eo.Top));
  if (eo.Mode !== null) {
    // EditModeToFlags(..., NoDelete, false): the 24 booleans from EditD.NoDelete on
    const ef = e as unknown as Record<string, boolean>;
    const flg: boolean[] = [];
    for (let j = 1; j < EditModeFlagFields.length; j++) flg[j] = ef[EditModeFlagFields[j]];
    EditModeToFlags(RunShortStr(eo.Mode), flg, false);
    for (let j = 1; j < EditModeFlagFields.length; j++) ef[EditModeFlagFields[j]] = flg[j] === true;
  }
  if (spec.Prompt158) e.Prompt158 = true;
  if (eo.SetOnlyView) {
    // UpwEdit
    eo.Tab = null;
    e.OnlyTabs = true;
    e.OnlySearch = false;
  }
  if (e.LVRecPtr !== null) {
    e.EdRecVar = true;
    e.Only1Record = true;
  }
  if (e.Only1Record) e.OnlySearch = false;
  if (eo.W.C1 !== null) {
    RunWFrml(eo.W, e.WFlags, e.V);
    e.WwPart = true;
    if ((e.WFlags & WShadow) !== 0) {
      e.ShdwX = MinW(2, BaseVars.TxtCols - e.V.C2);
      e.ShdwY = MinW(1, BaseVars.TxtRows - e.V.R2);
    }
  } else {
    if (e.WithBoolDispl) e.V.R1 = 3;
    if (e.Mode24) e.V.R2--;
  }
  RdFormOrDesign(ParFD, eo.Flds, eo.FormPos);
  if (e.NPages > 1) e.NRecs = 1;
  else e.NRecs = Div(e.Rows - e.NHdTxt, e.RecTxt!.N);
  e.BaseRec = 1;
  e.IRec = 1;
  e.CFld = e.FirstFld;
  e.FirstEmptyFld = e.FirstFld;
  e.ChkSwitch = true;
  e.WarnSwitch = true;
  a.CFile = e.FD;
  a.CRecPtr = GetRecSpace();
  e.OldRecPtr = a.CRecPtr;
  if (e.EdRecVar) {
    e.NewRecPtr = e.LVRecPtr;
    e.NoDelete = true;
    e.NoCreate = true;
    e.Journal = null;
    e.KIRoot = null;
  } else {
    a.CRecPtr = GetRecSpace();
    e.NewRecPtr = a.CRecPtr;
    e.AddSwitch = true;
    e.Cond = RunEvalFrml(eo.Cond);
    e.RefreshDelay = word(RunWordImpl(eo.RefreshDelayZ, spec.RefreshDelay) * 18);
    e.SaveAfter = RunWordImpl(eo.SaveAfterZ, spec.UpdCount);
    if (eo.StartRecKeyZ !== null) e.StartRecKey = StoreStr(RunShortStr(eo.StartRecKeyZ));
    e.StartRecNo = RunInt(eo.StartRecNoZ);
    e.StartIRec = RunInt(eo.StartIRecZ);
    e.VK = eo.ViewKey;
    if (e.DownLD !== null) {
      e.DownSet = true;
      e.DownKey = GetFromKey(e.DownLD);
      if (e.VK === null) e.VK = e.DownKey;
      switch (e.OwnerTyp) {
        case 'r':
          e.DownRecPtr = e.DownLV!.RecPtr as Uint8Array | null;
          break;
        case 'F':
          // RDPROC.RdOwner stores the '[recno]' formula in DownLV (Pascal FrmlPtr(EO^.DownLV))
          e.OwnerRecNo = RunInt(eo.DownLV as unknown as FrmlPtr);
          a.CFile = e.DownLD.ToFD;
          e.DownRecPtr = GetRecSpace();
          a.CFile = e.FD;
          break;
      }
    } else if (e.VK === null) e.VK = e.FD!.Keys;
    if (e.SelKey !== null) {
      if (e.SelKey.KFlds === null) e.SelKey.KFlds = e.VK!.KFlds;
      else if (!EquKFlds(e.SelKey.KFlds, e.VK!.KFlds)) RunError(663);
    }
  }
  if (eo.StartFieldZ !== null) {
    const s = TrailChar(' ', RunShortStr(eo.StartFieldZ));
    let D = e.FirstFld;
    while (D !== null) {
      if (SEquUpcase(D.FldD!.Name, s)) e.StartFld = D;
      D = D.Chain;
    }
  }
  e.WatchDelay = word(RunInt(eo.WatchDelayZ) * 18);
  if (eo.Head === null) e.Head = StandardHead();
  else e.Head = GetStr(eo.Head);
  e.Last = GetStr(eo.Last);
  e.AltLast = GetStr(eo.AltLast);
  e.CtrlLast = GetStr(eo.CtrlLast);
  e.ShiftLast = GetStr(eo.ShiftLast);
  const F2NoUpd = e.OnlyTabs && eo.Tab === null && !eo.NegTab && e.OnlyAppend;
  let D = e.FirstFld;
  while (D !== null) {
    e.NFlds++;
    const F = D.FldD!;
    let b = FieldInList(F, eo.Tab);
    if (eo.NegTab) b = !b;
    if (b) {
      D.Tab = true;
      e.NTabsSet++;
    }
    let b2 = FieldInList(F, eo.NoEd);
    if (eo.NegNoEd) b2 = !b2;
    D.EdU = !(b2 || (e.OnlyTabs && !b));
    D.EdN = F2NoUpd;
    if ((F.Flg & f_Stored) !== 0 && D.EdU) e.NEdSet++;
    b = FieldInList(F, eo.Dupl);
    if (eo.NegDupl) b = !b;
    if (b && (F.Flg & f_Stored) !== 0) D.Dupl = true;
    if (b || (F.Flg & f_Stored) !== 0) e.NDuplSet++;
    D = D.Chain;
  }
  if (e.OnlyTabs && e.NTabsSet === 0) {
    e.NoDelete = true;
    if (!e.OnlyAppend) e.NoCreate = true;
  }
  RdDepChkImpl();
  NewChkKey();
  MarkStore(fref(e, 'AfterE'));
  ReleaseStore2(p.v);
}
