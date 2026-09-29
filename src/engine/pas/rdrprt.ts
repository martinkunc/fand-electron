// PAS: RDRPRT.PAS – compiles a report chapter (R) or an automatic report: '#I1_FILE' inputs with
// conditions/key-in/match fields, and the blocks #RH #PH #DH #CH #DE #CF #PF #RF (literal text
// with '_'/'@' field runs, formulas, :=/+= assignments before/after a block, sums).
//
// Porting notes:
// * State: fills RdRunVars (IDA[1..9], MaxIi, OldMFlds/NewMFlds, RprtHd/PageHd/PageFt, PFZeroLst,
//   FrstLvM/LstLvM, SelQuest, PgeSizeZ/PgeLimitZ) and RdRunVars.LVBD. Private globals: CBlk,
//   CZeroLst, LvToRd (block/zero-list/level being read), Ii, Oi, SumIi, WhatToRd ('i' = #XXi,
//   'O' = #XX), WasIiPrefix, CBlkSave. Hooks: RdFldNameFrml := RdFldNameFrmlR, ChainSumEl :=
//   ChainSumElR (set only for footer blocks).
// * No asm, no DOS. Uses the scan object XScan (New(ID^.Scan, Init(...)) -> new XScan().Init(...)).
// * Tricky pointer casts:
//   - ChainSumElR: `SumElPtr(@IDA[SumIi]^.Sum)` / `@CBlk^.Sum` treat the list-root field as a fake
//     SumElem whose Chain is the root; `FloatPtrList(@LvToRd^.ZeroLst)` / `@PFZeroLst` the same
//     for zero lists. In TS the roots are Refs (fref) and the new element goes first.
//   - `Z^.RPtr:=@FrmlSumEl^.R`: a pointer to the sum's accumulator – fref(FrmlSumEl, 'R').
//   - RdBlock builds BlkD.Txt as one contiguous byte stream with GetStore(1) per char and
//     back-patched length bytes/words. Here it is built in a byte array with exactly the Pascal
//     layout, per text line: LnL (byte: printed line length, 255 = empty), StrL (word LE: number
//     of bytes stored), then the StrL bytes: literal chars, and per field #$FF followed by (L, M)
//     – except date fields ('__.__.__[__]': only #$FF) and ^P fields (only #$FF). RUNRPRT walks
//     this layout. ReleaseStore(LnL) (a line ended by '{' or '#') truncates the array.
//   - FDL: `@RO^.FDL` – the RprtOpt embeds the first RprtFDListEl (a record, not a pointer).
// * Private routines: InpFD, FindInLvBlk, RdFldNameFrmlR (+ RdIiPrefix, TestSetSumIi,
//   FindIiandFldFrml, RdDirFilVar, OwnInBlock, FindInRec, SetIi, TestNotSum, Err), ChainSumElR,
//   ReadReport's nested CopyPrevMFlds, CheckMFlds, MakeOldMLvD, RdAutoSortSK (+ NewLvS), RdBlock
//   (+ RdCh, StoreCh, NUnderscores, EndString, TestSetRFTyp, TestSetBlankOrWrap, RdBeginEnd,
//   RdAssign, RdAssignBlk, RdCond), RdKeyName, Rd_Oi.

import { ref, fref, ord, chr, UpCase, CopyRec, type Ref } from './pasrt.ts';
import { ChainLast, IsDigit } from './base.ts';
import {
  AccessVars, FrmlAt, XScan, FloatPtrListEl, f_Stored, GetRecSpace, ResetCompilePars, _const, _getwordvar,
  _identifier, _assign, _le,
  type FileDPtr, type FieldDPtr, type FrmlPtr, type KeyFldDPtr, type KeyInDPtr, type LinkDPtr, type LocVarPtr,
  type FloatPtrList, type SumElPtr,
} from './access.ts';
import {
  RdRunVars, ResetLVBD, InpD, LvDescr, BlkD, RFldD, AssignD, ConstListEl, _ifthenelseM, _parfile, _locvar,
  type RprtOptPtr, type RprtFDList, type InpDPtr, type LvDescrPtr, type BlkDPtr, type RFldDPtr, type AssignDPtr,
} from './rdrun.ts';
import { RdChkDsFromPos } from './rdfildcl.ts';
import {
  Error, OldError, ReadChar, SkipBlank, RdLex, TestIdentif, TestLex, Accept, IsKeyWord, AcceptKeyWord, EquUpcase,
  IsForwPoint, RdLocDcl, FindLocVar, RdAssignFrml, FldTypIdentity, RdViewKey, RdKFList, RdBool, RdRealFrml, RdFrml,
  RdKeyInBool, GetOp, FindFldName, RdFldName, RdFileName, IsRoleName, RdFAccess, TryRdFldFrml, FrmlContxt,
} from './compile.ts';
import { IsPrintCtrl } from './obase.ts';
import { RunEvalFrml } from './runfrml.ts';

const EOFChar = '\x1a'; // ^Z

let CBlk: BlkDPtr = null;
let CZeroLst: Ref<FloatPtrList> = ref<FloatPtrList>(null); // the root the zero list is chained into
let LvToRd: LvDescrPtr = null; // all used while translating frml
let Ii = 0;
let Oi = 0;
let SumIi = 0;
let WhatToRd = '\0'; // 'i'=#XXi 'O'=#XX
let WasIiPrefix = false;
let CBlkSave: BlkDPtr = null;

/** TS-only: the lexer's ForwChar / Lexem, read fresh (the lexer calls change them) */
function FC(): string {
  return AccessVars.ForwChar;
}
function LX(): string {
  return AccessVars.Lexem;
}

// PAS: RDRPRT.PAS InpFD
function InpFD(I: number): FileDPtr {
  return RdRunVars.IDA[I]!.Scan!.FD;
}

// PAS: RDRPRT.PAS FindInLvBlk – a named block field (RFldD) of the footers from L backwards,
// then of the detail (#DE) blocks
function FindInLvBlk(L: LvDescrPtr, B: Ref<BlkDPtr>, RF: Ref<RFldDPtr>): boolean {
  let first = true;
  for (;;) {
    // 1:
    while (L !== null) {
      let B1 = L.Ft;
      while (B1 !== null) {
        let RF1 = B1.RFD;
        while (RF1 !== null) {
          if (LX() === _identifier && EquUpcase(RF1.Name)) {
            RdLex();
            RF.v = RF1;
            B.v = B1;
            return true;
          }
          RF1 = RF1.Chain;
        }
        B1 = B1.Chain;
      }
      L = L.ChainBack;
    }
    if (!first) return false;
    first = false;
    L = RdRunVars.IDA[1]!.FrstLvS; // DE
  }
}

// PAS: RDRPRT.PAS RdFldNameFrmlR – the RdFldNameFrml hook of reports
function RdFldNameFrmlR(FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  const rv = RdRunVars;
  const CBlkRef: Ref<BlkDPtr> = {
    get v() {
      return CBlk;
    },
    set v(x: BlkDPtr) {
      CBlk = x;
    },
  };
  // PAS: RDRPRT.PAS RdFldNameFrmlR.RdIiPrefix – 'In.' prefix
  const RdIiPrefix = (): boolean => {
    const lw = a.LexWord;
    if (FC() === '.' && lw.length === 2 && lw[0] === 'I' && lw[1] >= '1' && lw[1] <= '9') {
      Ii = ord(lw[1]) - ord('0');
      if (Ii > rv.MaxIi || (WhatToRd === 'i' && Ii > Oi)) Error(9);
      RdLex();
      RdLex();
      return true;
    }
    Ii = 0;
    return false;
  };
  // PAS: RDRPRT.PAS RdFldNameFrmlR.TestSetSumIi
  const TestSetSumIi = (): void => {
    if (a.FrmlSumEl !== null && Ii !== 0) {
      if (a.FrstSumVar || SumIi === 0) SumIi = Ii;
      else if (SumIi !== Ii) OldError(27);
    }
  };
  // PAS: RDRPRT.PAS RdFldNameFrmlR.FindIiandFldFrml – a field of Oi first, then of I1..
  const FindIiandFldFrml = (FD: Ref<FileDPtr>, FTyp: Ref<string>): FrmlPtr => {
    let z: FrmlPtr = null;
    if (WhatToRd === 'i') {
      // search first in Ii
      FD.v = InpFD(Oi);
      z = TryRdFldFrml(FD.v, FTyp);
      if (z !== null) {
        Ii = Oi;
        return z;
      }
    }
    for (let i = 1; i <= rv.MaxIi; i++) {
      // search in I1 .. Imax resp. Oi
      FD.v = InpFD(i);
      z = TryRdFldFrml(FD.v, FTyp);
      if (z !== null) {
        Ii = i;
        return z;
      }
      if (WhatToRd === 'i' && i === Oi) return z;
    }
    return z;
  };
  // PAS: RDRPRT.PAS RdFldNameFrmlR.RdDirFilVar – [In.]file.field / role.field
  const RdDirFilVar = (): FrmlPtr => {
    const LD = ref<LinkDPtr>(null);
    const FD = ref<FileDPtr>(null);
    if (WasIiPrefix) {
      a.CFile = InpFD(Ii);
      if (!IsRoleName(true, FD, LD)) Error(9);
    } else {
      let found = false;
      if (!rv.Join && WhatToRd === 'i') {
        Ii = Oi;
        a.CFile = InpFD(Ii);
        if (IsRoleName(true, FD, LD)) found = true; // goto 2
      }
      if (!found) {
        for (let I = 1; I <= rv.MaxIi; I++) {
          a.CFile = InpFD(I);
          if (IsRoleName(true, FD, LD)) {
            Ii = I;
            found = true; // goto 2
            break;
          }
          if (WhatToRd === 'i' && I === Oi) break; // goto 1
        }
      }
      if (!found) Error(9); // 1:
    }
    RdLex(); // 2: '.'
    let Z = RdFAccess(FD.v, LD.v, FTyp);
    if (LD.v === null) Ii = 0;
    else {
      Z = FrmlContxt(Z, a.CFile, a.CFile!.RecPtr);
      TestSetSumIi();
      if (a.FrmlSumEl !== null && !a.FrstSumVar && CBlk !== null) OldError(59);
    }
    return Z;
  };
  // PAS: RDRPRT.PAS RdFldNameFrmlR.OwnInBlock – a named field of the block being read
  const OwnInBlock = (res: Ref<FrmlPtr>): boolean => {
    let RF = CBlk!.RFD;
    while (RF !== null) {
      if (EquUpcase(RF.Name)) {
        RdLex();
        FTyp.v = RF.FrmlTyp;
        res.v = RF.Frml;
        return true;
      }
      RF = RF.Chain;
    }
    return false;
  };
  // PAS: RDRPRT.PAS RdFldNameFrmlR.FindInRec – a field of an input record
  const FindInRec = (): FrmlPtr => {
    const FD = ref<FileDPtr>(null);
    let z: FrmlPtr;
    if (WasIiPrefix) {
      FD.v = InpFD(Ii);
      z = TryRdFldFrml(FD.v, FTyp);
    } else z = FindIiandFldFrml(FD, FTyp);
    if (z === null) Error(8);
    TestSetSumIi();
    return FrmlContxt(z, FD.v, FD.v!.RecPtr);
  };
  // PAS: RDRPRT.PAS RdFldNameFrmlR.SetIi
  const SetIi = (): void => {
    if (!WasIiPrefix) {
      if (WhatToRd === 'i') Ii = Oi;
      else Ii = 1;
    }
  };
  // PAS: RDRPRT.PAS RdFldNameFrmlR.TestNotSum
  const TestNotSum = (): void => {
    if (a.FrmlSumEl !== null) OldError(41);
  };
  // PAS: RDRPRT.PAS RdFldNameFrmlR.Err
  const Err = (): void => {
    TestNotSum();
    SetIi();
    const id = rv.IDA[Ii]!;
    if (id.ErrTxtFrml === null) id.ErrTxtFrml = GetOp(_const, 256);
  };

  WasIiPrefix = RdIiPrefix();
  if (a.FrmlSumEl !== null && a.FrstSumVar && CBlk !== null) {
    SumIi = 0;
    CBlkSave = CBlk;
    CBlk = null;
  }
  if (IsForwPoint()) return RdDirFilVar();
  const LV = ref<LocVarPtr>(null);
  if (!WasIiPrefix && FindLocVar(rv.LVBD.Root, LV)) {
    RdLex();
    TestNotSum();
    FTyp.v = LV.v!.FTyp;
    return FrmlAt(LV.v!, { Op: 'Op', BPOfs: 'BPOfs' });
  }
  if (IsKeyWord('COUNT')) {
    TestNotSum();
    SetIi();
    FTyp.v = 'R';
    return FrmlAt(rv.IDA[Ii]!, { Op: 'Op', R: 'Count' });
  }
  if (IsKeyWord('GROUP')) {
    TestNotSum();
    if (WasIiPrefix) OldError(41);
    FTyp.v = 'R';
    return FrmlAt(rv.MergOpGroup, { Op: 'Op', R: 'Group' });
  }
  let n = -1;
  if (IsKeyWord('LINE')) n = 0;
  else if (IsKeyWord('PAGE')) n = 1;
  else if (IsKeyWord('PAGELIMIT')) n = 2;
  if (n >= 0) {
    // 1:
    if (a.FrmlSumEl === null && !WasIiPrefix) {
      const Z = GetOp(_getwordvar, 1)!;
      Z.N01 = n;
      FTyp.v = 'R';
      return Z;
    }
  }
  if (IsKeyWord('ERROR')) {
    Err();
    FTyp.v = 'B';
    return FrmlAt(rv.IDA[Ii]!, { Op: 'OpErr', B: 'Error' });
  }
  if (IsKeyWord('WARNING')) {
    Err();
    FTyp.v = 'B';
    return FrmlAt(rv.IDA[Ii]!, { Op: 'OpWarn', B: 'Warning' });
  }
  if (IsKeyWord('ERRORTEXT')) {
    Err();
    FTyp.v = 'S';
    return rv.IDA[Ii]!.ErrTxtFrml;
  }
  const res = ref<FrmlPtr>(null);
  if (a.FrmlSumEl !== null) {
    if (a.FrstSumVar) {
      const RF = ref<RFldDPtr>(null);
      if (FindInLvBlk(LvToRd!.ChainBack, CBlkRef, RF)) {
        FTyp.v = RF.v!.FrmlTyp;
        return RF.v!.Frml;
      }
      return FindInRec();
    } else if (CBlk === null) return FindInRec();
    else if (OwnInBlock(res)) return res.v;
    else OldError(8);
  }
  if (OwnInBlock(res)) return res.v;
  return FindInRec();
}

// PAS: RDRPRT.PAS ChainSumElR – the ChainSumEl hook of footer blocks: the sum goes to the input
// (first sum variable) or to the block, its accumulator into the zero list of the level
function ChainSumElR(): void {
  const a = AccessVars;
  const rv = RdRunVars;
  if (a.FrstSumVar || SumIi === 0) SumIi = 1;
  const S: Ref<SumElPtr> = a.FrstSumVar || CBlk === null ? fref(rv.IDA[SumIi]!, 'Sum') : fref(CBlk, 'Sum');
  a.FrmlSumEl!.Chain = S.v;
  S.v = a.FrmlSumEl;
  if (CBlkSave !== null) {
    CBlk = CBlkSave;
    CBlkSave = null;
  }
  const Z = new FloatPtrListEl();
  Z.RPtr = fref(a.FrmlSumEl!, 'R');
  Z.Chain = CZeroLst.v;
  CZeroLst.v = Z;
}

// PAS: RDRPRT.PAS ReadReport.CopyPrevMFlds – match fields of I(n-1) by name in In
function CopyPrevMFlds(): void {
  const a = AccessVars;
  const rv = RdRunVars;
  const s = a.LexWord;
  let M = rv.IDA[Ii - 1]!.MFld;
  while (M !== null) {
    a.LexWord = M.FldD!.Name;
    const F = FindFldName(InpFD(Ii));
    if (F === null) OldError(8);
    if (!FldTypIdentity(M.FldD, F)) OldError(12);
    const MNew = CopyRec(M); // Move(M^,MNew^,sizeof(MNew^))
    MNew.FldD = F;
    ChainLast(fref(rv.IDA[Ii]!, 'MFld'), MNew);
    M = M.Chain;
  }
  a.LexWord = s;
}
// PAS: RDRPRT.PAS ReadReport.CheckMFlds
function CheckMFlds(M1: KeyFldDPtr, M2: KeyFldDPtr): void {
  while (M1 !== null) {
    if (M2 === null) OldError(30);
    if (!FldTypIdentity(M1.FldD, M2.FldD) || M1.Descend !== M2.Descend || M1.CompLex !== M2.CompLex) OldError(12);
    M1 = M1.Chain;
    M2 = M2.Chain;
  }
  if (M2 !== null) OldError(30);
}
// PAS: RDRPRT.PAS ReadReport.MakeOldMLvD – one level per match field of I1 (+ the report level
// LstLvM); OldMFlds/NewMFlds get one constant slot per match field
function MakeOldMLvD(): LvDescrPtr {
  const rv = RdRunVars;
  rv.OldMFlds = null;
  rv.NewMFlds = null;
  let L = new LvDescr(); // GetZStore
  rv.LstLvM = L;
  let M = rv.IDA[1]!.MFld;
  while (M !== null) {
    // GetStore(sizeof(pointer)+M^.FldD^.NBytes+1): the value slot of ConstListEl
    ChainLast(fref(rv, 'OldMFlds'), new ConstListEl());
    ChainLast(fref(rv, 'NewMFlds'), new ConstListEl());
    const L1 = new LvDescr();
    L.ChainBack = L1;
    L1.Chain = L;
    L = L1;
    L.Fld = M.FldD;
    M = M.Chain;
  }
  return L;
}
// PAS: RDRPRT.PAS ReadReport.RdAutoSortSK – '; sort fields' of an input, its levels (FrstLvS..
// LstLvS) and, with '!', the sort key = match fields + sort fields
function RdAutoSortSK(ID: InpD): void {
  const a = AccessVars;
  // PAS: RDRPRT.PAS ReadReport.RdAutoSortSK.NewLvS
  const NewLvS = (L: LvDescrPtr): LvDescr => {
    const L1 = new LvDescr();
    L1.Chain = L;
    if (L === null) ID.LstLvS = L1;
    else L.ChainBack = L1;
    return L1;
  };
  if (LX() === ';') {
    RdLex();
    RdKFList(fref(ID, 'SFld'), a.CFile);
  }
  let L: LvDescrPtr = null;
  const as = ID.AutoSort;
  // SK:=KeyFldDPtr(@ID^.SK) – a fake head; SkLast = nil stands for it
  let SkLast: KeyFldDPtr = null;
  const AddSK = (M: NonNullable<KeyFldDPtr>): void => {
    const SK = CopyRec(M); // Move(M^,SK^,sizeof(SK^))
    SK.Chain = null; // the next copy (or the last Move's nil Chain) ends it
    if (SkLast === null) ID.SK = SK;
    else SkLast.Chain = SK;
    SkLast = SK;
  };
  let M: KeyFldDPtr;
  if (as) {
    M = ID.MFld;
    while (M !== null) {
      AddSK(M);
      M = M.Chain;
    }
  }
  M = ID.SFld;
  while (M !== null) {
    L = NewLvS(L);
    L.Fld = M.FldD;
    ChainLast(fref(ID, 'OldSFlds'), new ConstListEl());
    if (as) AddSK(M);
    M = M.Chain;
  }
  if (as && ID.SK === null) OldError(60);
  ID.FrstLvS = NewLvS(L);
}

// PAS: RDRPRT.PAS ReadReport.RdBlock – one block: condition, BEGIN..END before, field formulas
// and '.' options, BEGIN..END after, then the text lines up to the next '#'
function RdBlock(BB: Ref<BlkDPtr>): void {
  const a = AccessVars;
  const rv = RdRunVars;
  let LineLen = 0;
  let NBytesStored = 0;
  const txt: number[] = []; // the block's text stream (see the notes)
  let started = false;
  let LnL = 0; // offset of the line-length byte
  let StrL = 0; // offset of the stored-bytes word
  // PAS: RDRPRT.PAS ReadReport.RdBlock.RdCh
  const RdCh = (): void => {
    if (!IsPrintCtrl(a.ForwChar)) LineLen++;
    ReadChar();
  };
  // PAS: RDRPRT.PAS ReadReport.RdBlock.StoreCh
  const StoreCh = (C: string): void => {
    txt.push(ord(C) & 0xff);
    NBytesStored++;
  };
  // PAS: RDRPRT.PAS ReadReport.RdBlock.NUnderscores
  const NUnderscores = (C: string): number => {
    let N = 0;
    while (FC() === C) {
      N++;
      RdCh();
    }
    return N;
  };
  // PAS: RDRPRT.PAS ReadReport.RdBlock.EndString
  const EndString = (): void => {
    txt[StrL] = NBytesStored & 0xff;
    txt[StrL + 1] = (NBytesStored >>> 8) & 0xff;
    CBlk!.NTxtLines++;
    if (LineLen === 0) txt[LnL] = 255;
    else txt[LnL] = LineLen & 0xff;
  };
  let RepeatedGrp = false;
  let RF: RFldDPtr = null;
  let UC = '\0';
  // PAS: RDRPRT.PAS ReadReport.RdBlock.TestSetRFTyp
  const TestSetRFTyp = (Typ: string): void => {
    if (RepeatedGrp) {
      if (RF!.Typ !== Typ) Error(73);
    } else RF!.Typ = Typ;
    if (FC() === '.' || FC() === ',' || FC() === ':') Error(95);
  };
  // PAS: RDRPRT.PAS ReadReport.RdBlock.TestSetBlankOrWrap – '@' runs: blank zero / wrap text
  const TestSetBlankOrWrap = (): void => {
    const t = RF!.Typ;
    if (t === 'R' || t === 'F' || t === 'S') {
      if (!RepeatedGrp) RF!.BlankOrWrap = UC === '@';
      else if (RF!.BlankOrWrap && UC === '_') Error(73);
    } else if (UC === '@') Error(80);
  };
  // PAS: RDRPRT.PAS ReadReport.RdBlock.RdAssignBlk
  const RdAssignBlk = (ARoot: Ref<AssignDPtr>): void => {
    if (IsKeyWord('BEGIN')) RdBeginEnd(ARoot);
    else {
      const A = RdAssign();
      ChainLast(ARoot, A);
    }
  };
  // PAS: RDRPRT.PAS ReadReport.RdBlock.RdAssign – IF..THEN..ELSE, PARFILE.field or local variable
  const RdAssign = (): AssignD => {
    const A = new AssignD(); // GetZStore
    const LV = ref<LocVarPtr>(null);
    if (IsKeyWord('IF')) {
      A.Kind = _ifthenelseM;
      A.Bool = RdBool();
      AcceptKeyWord('THEN');
      RdAssignBlk(fref(A, 'Instr'));
      if (IsKeyWord('ELSE')) RdAssignBlk(fref(A, 'ElseInstr'));
    } else if (FC() === '.') {
      A.Kind = _parfile;
      const FD = RdFileName();
      if (!FD!.IsParFile) OldError(9);
      Accept('.');
      A.FD = FD;
      const F = RdFldName(FD);
      A.PFldD = F;
      if ((F!.Flg & f_Stored) === 0) OldError(14);
      RdAssignFrml(F!.FrmlTyp, fref(A, 'Add'), fref(A, 'Frml'));
    } else if (FindLocVar(rv.LVBD.Root, LV)) {
      RdLex();
      A.Kind = _locvar;
      A.LV = LV.v;
      RdAssignFrml(LV.v!.FTyp, fref(A, 'Add'), fref(A, 'Frml'));
    } else Error(147);
    return A;
  };
  // PAS: RDRPRT.PAS ReadReport.RdBlock.RdBeginEnd
  const RdBeginEnd = (ARoot: Ref<AssignDPtr>): void => {
    for (;;) {
      // 1:
      if (IsKeyWord('END')) return;
      RdAssignBlk(ARoot);
      if (LX() === ';') {
        RdLex();
        continue;
      }
      AcceptKeyWord('END');
      return;
    }
  };
  // PAS: RDRPRT.PAS ReadReport.RdBlock.RdCond
  const RdCond = (): void => {
    if (LX() === '(') {
      RdLex();
      CBlk!.Bool = RdBool();
      Accept(')');
    }
  };

  CBlk = new BlkD(); // GetZStore
  const blk = CBlk;
  ChainLast(BB, blk);
  RdCond();
  let lbl: 0 | 1 | 2;
  if (IsKeyWord('BEGIN')) {
    RdBeginEnd(fref(blk, 'BeforeProc'));
    lbl = 1;
  } else if (LX() === ';') lbl = 2; // read var decl.
  else lbl = 0;
  while (lbl !== 2) {
    if (lbl === 0) {
      // 0:
      if (IsKeyWord('BEGIN')) {
        RdBeginEnd(fref(blk, 'AfterProc'));
        break; // goto 2
      }
      if (LX() === '.') {
        RdLex();
        if (IsKeyWord('LINE')) {
          if (LX() === _le) {
            RdLex();
            blk.LineBound = RdRealFrml();
          } else {
            Accept(_assign);
            blk.AbsLine = true;
            blk.LineNo = RdRealFrml();
          }
        } else if (IsKeyWord('PAGE')) {
          Accept(_assign);
          blk.SetPage = true;
          blk.PageNo = RdRealFrml();
        } else if (IsKeyWord('NOTATEND')) blk.NotAtEnd = true;
        else if (IsKeyWord('NOTSOLO')) blk.DHLevel = 1;
        else Error(54);
      } else {
        const NewRF = new RFldD();
        SkipBlank(false);
        if (FC() === ':') {
          TestIdentif();
          NewRF.Name = a.LexWord;
          const DummyB = ref<BlkDPtr>(null);
          const RF1 = ref<RFldDPtr>(null);
          const LV = ref<LocVarPtr>(null);
          if (FindInLvBlk(rv.LstLvM, DummyB, RF1) || FindLocVar(rv.LVBD.Root, LV)) Error(26);
          RdLex();
          Accept(_assign);
        } else NewRF.Name = '';
        NewRF.Frml = RdFrml(fref(NewRF, 'FrmlTyp'));
        NewRF.BlankOrWrap = false;
        ChainLast(fref(blk, 'RFD'), NewRF);
      }
    }
    // 1:
    if (LX() !== ';') {
      Accept(',');
      lbl = 0;
      continue; // goto 0
    }
    break;
  }
  // 2:
  RF = blk.RFD;
  RepeatedGrp = false;
  SkipBlank(true);
  let to4 = false;
  if (FC() === EOFChar) to4 = true;
  else if (FC() === '\\') {
    blk.FF1 = true;
    ReadChar();
  }
  if (!to4) {
    line: for (;;) {
      // 3:
      LnL = txt.length;
      txt.push(0); // GetZStore(1)
      StrL = txt.length;
      txt.push(0, 0); // GetZStore(2)
      LineLen = 0;
      NBytesStored = 0;
      if (blk.NTxtLines === 0) {
        started = true; // CBlk^.Txt:=Pchar(LnL)
        while (FC() === ' ') RdCh();
        blk.NBlksFrst = LineLen;
      }
      while (!(FC() === '\r' || FC() === EOFChar)) {
        const fc = FC();
        if (fc === '_' || fc === '@' || fc === '\x10') {
          UC = fc;
          StoreCh('\xff');
          if (RF === null) {
            RF = blk.RFD;
            if (RF === null) Error(30);
            RepeatedGrp = true;
          }
          const rf = RF;
          if (UC === '\x10') {
            // ^P
            if (rf.FrmlTyp !== 'S') Error(12);
            if (!RepeatedGrp) rf.Typ = 'P';
            else if (rf.Typ !== 'P') Error(73);
            ReadChar();
            RF = rf.Chain; // goto 5
            continue;
          }
          let L = NUnderscores(UC);
          let M: number;
          let N: number;
          switch (FC()) {
            case ',':
              RdCh();
              if (rf.FrmlTyp !== 'R') Error(12);
              M = NUnderscores(UC);
              L = L + M + 1;
              StoreCh(chr(L & 0xff));
              StoreCh(chr(M & 0xff));
              TestSetRFTyp('F');
              break;
            case '.':
              RdCh();
              if (rf.FrmlTyp !== 'R') Error(12);
              M = NUnderscores(UC);
              if (FC() === '.') {
                RdCh();
                N = NUnderscores(UC);
                if (L !== 2 || M !== 2 || !(N === 2 || N === 4)) Error(71);
                TestSetRFTyp('D');
                if (N === 4) rf.BlankOrWrap = true;
              } else {
                L = L + M + 1;
                StoreCh(chr(L & 0xff));
                StoreCh(chr(M & 0xff));
                TestSetRFTyp('R');
              }
              break;
            case ':':
              RdCh();
              if (rf.FrmlTyp !== 'R') Error(12);
              M = NUnderscores(UC);
              if (M !== 2) Error(69);
              M = 3;
              if (FC() === ':') {
                RdCh();
                N = NUnderscores(UC);
                if (N !== 2) Error(69);
                M = 6;
                if (FC() === '.') {
                  RdCh();
                  N = NUnderscores(UC);
                  if (N !== 2) Error(69);
                  M = 9;
                }
              }
              StoreCh(chr(L & 0xff));
              StoreCh(chr(M & 0xff));
              TestSetRFTyp('T');
              break;
            default:
              StoreCh(chr(L & 0xff));
              TestSetRFTyp(rf.FrmlTyp);
              M = 0;
              if (rf.Typ === 'S') M = LineLen - L + 1; // current column
              StoreCh(chr(M & 0xff));
          }
          TestSetBlankOrWrap();
          RF = rf.Chain; // 5:
        } else if (fc === '\\') {
          blk.FF2 = true;
          EndString();
          ReadChar();
          break line; // goto 4
        } else if (fc === '{' || fc === '#') {
          txt.length = LnL; // ReleaseStore(LnL)
          break line; // goto 4
        } else {
          if (fc === '\xff') StoreCh(' ');
          else StoreCh(fc);
          RdCh();
        }
      }
      EndString();
      SkipBlank(true);
      if (FC() !== EOFChar) continue; // goto 3
      break;
    }
  }
  // 4:
  if (started) blk.Txt = Uint8Array.from(txt);
  if (blk.NTxtLines === 1 && blk.Txt![1] === 0 && blk.FF1) {
    blk.NTxtLines = 0;
    blk.FF1 = false;
    blk.FF2 = true;
  }
  if (RF !== null) Error(30);
  RdLex();
}

// PAS: RDRPRT.PAS ReadReport.RdKeyName – '_field' after #CH/#CF: its level
function RdKeyName(): LvDescr {
  const a = AccessVars;
  const rv = RdRunVars;
  ReadChar();
  a.Lexem = a.CurrChar;
  Accept('_');
  let L: LvDescrPtr;
  if (WhatToRd === 'O') L = rv.FrstLvM;
  else L = rv.IDA[Oi]!.FrstLvS;
  const F: FieldDPtr = RdFldName(InpFD(Oi));
  while (L !== null) {
    if (L.Fld === F) return L;
    L = L.Chain;
  }
  return OldError(46);
}
// PAS: RDRPRT.PAS ReadReport.Rd_Oi – the optional input digit after #XX
function Rd_Oi(): void {
  const a = AccessVars;
  Oi = 1;
  if (IsDigit(FC())) {
    ReadChar();
    Oi = ord(a.CurrChar) - ord('0');
    if (Oi === 0 || Oi > RdRunVars.MaxIi) Error(62);
    WhatToRd = 'i';
  }
}

// PAS: RDRPRT.PAS ReadReport – RO=nil from PROJMGR (chapter), RO from REPORT/GENRPRT (auto report)
export function ReadReport(RO: RprtOptPtr): void {
  const a = AccessVars;
  const rv = RdRunVars;
  ResetCompilePars();
  RdLex();
  CBlkSave = null;
  rv.PgeSizeZ = null;
  rv.PgeLimitZ = null;
  let FDL: RprtFDList = null;
  if (RO !== null && RO.FDL.FD !== null) FDL = RO.FDL;
  ResetLVBD();
  if (IsKeyWord('VAR')) RdLocDcl(rv.LVBD, false, false, 'R');
  for (;;) {
    // 1:
    if (LX() === '.') {
      RdLex();
      TestIdentif();
      if (IsKeyWord('PAGESIZE')) {
        Accept(_assign);
        rv.PgeSizeZ = RdRealFrml();
      } else if (IsKeyWord('PAGELIMIT')) {
        Accept(_assign);
        rv.PgeLimitZ = RdRealFrml();
      } else Error(56);
      if (LX() === ';') {
        RdLex();
        continue;
      }
    }
    break;
  }
  rv.SelQuest = false;
  Ii = 0;
  TestLex('#');
  do {
    Ii++;
    ReadChar();
    let ok = false;
    if (a.CurrChar === 'I') {
      ReadChar();
      if (IsDigit(a.CurrChar)) {
        if (Ii !== ord(a.CurrChar) - ord('0')) Error(61);
        ReadChar();
        if ((a.CurrChar as string) === '_') ok = true;
      } else if (Ii === 1) ok = true;
    }
    if (!ok) Error(89);
    // 2:
    const ID = new InpD(); // GetZStore
    rv.IDA[Ii] = ID;
    RdLex();
    let FD = RdFileName();
    a.CFile = FD;
    for (let i = 1; i <= Ii - 1; i++) if (InpFD(i) === FD) OldError(26);
    if (FDL !== null) {
      a.CFile = FDL.FD;
      FD = a.CFile;
    }
    a.CViewKey = RdViewKey();
    if (FDL !== null) {
      if (FDL.ViewKey !== null) a.CViewKey = FDL.ViewKey;
    }
    if (LX() === '!') {
      RdLex();
      ID.AutoSort = true;
    }
    ID.Op = _const;
    ID.OpErr = _const;
    ID.OpWarn = _const;
    const KI = ref<KeyInDPtr>(null);
    ID.ForwRecPtr = GetRecSpace();
    FD!.RecPtr = GetRecSpace();
    if (LX() === '(') {
      RdLex();
      if (Ii === 1 && LX() === '?') {
        rv.SelQuest = true;
        RdLex();
      } else ID.Bool = RdKeyInBool(KI, false, false, fref(ID, 'SQLFilter'));
      Accept(')');
    }
    if (
      FDL !== null &&
      FDL.LVRecPtr === null &&
      (FDL.Cond !== null || FDL.KeyIn !== null || (Ii === 1 && RO!.UserCondQuest))
    ) {
      ID.Bool = RunEvalFrml(FDL.Cond);
      KI.v = FDL.KeyIn;
      ID.SQLFilter = FDL.SQLFilter;
      if (Ii === 1) rv.SelQuest = RO!.UserCondQuest;
    }
    ID.Scan = new XScan().Init(FD, a.CViewKey, KI.v, true);
    if (FDL !== null && FDL.LVRecPtr !== null) ID.Scan.ResetLV(FDL.LVRecPtr);
    if (!(LX() === ';' || LX() === '#' || LX() === EOFChar)) RdKFList(fref(ID, 'MFld'), FD);
    if (Ii > 1) {
      if (rv.IDA[Ii - 1]!.MFld === null) {
        if (ID.MFld !== null) OldError(22);
      } else if (ID.MFld === null) CopyPrevMFlds();
      else CheckMFlds(rv.IDA[Ii - 1]!.MFld, ID.MFld);
    }
    RdAutoSortSK(ID);
    TestLex('#');
    if (FDL !== null) FDL = FDL.Chain;
  } while (FC() === 'I');
  rv.MaxIi = Ii;
  rv.FrstLvM = MakeOldMLvD();

  rv.PageHd = null;
  rv.RprtHd = null;
  rv.PageFt = null;
  rv.PFZeroLst = null;
  for (;;) {
    // 3:
    ReadChar();
    let s = UpCase(a.CurrChar);
    ReadChar();
    s += UpCase(a.CurrChar);
    a.ChainSumEl = null;
    a.RdFldNameFrml = RdFldNameFrmlR;
    WhatToRd = 'O';
    if (s === 'DE') {
      Rd_Oi();
      RdLex();
      WhatToRd = 'i';
      RdBlock(fref(rv.IDA[Oi]!.FrstLvS!, 'Ft'));
    } else if (s === 'RH') {
      RdLex();
      RdBlock(fref(rv, 'RprtHd'));
    } else if (s === 'PH') {
      RdLex();
      RdBlock(fref(rv, 'PageHd'));
    } else if (s === 'DH') {
      Rd_Oi();
      RdLex();
      WhatToRd = 'i';
      RdBlock(fref(rv.IDA[Oi]!.FrstLvS!, 'Hd'));
    } else if (s === 'CH') {
      Rd_Oi();
      const L = RdKeyName();
      RdBlock(fref(L, 'Hd'));
    } else {
      a.ChainSumEl = ChainSumElR;
      if (s === 'RF') {
        RdLex();
        LvToRd = rv.LstLvM;
        CZeroLst = fref(LvToRd!, 'ZeroLst');
        RdBlock(fref(LvToRd!, 'Ft'));
      } else if (s === 'CF') {
        Rd_Oi();
        LvToRd = RdKeyName();
        CZeroLst = fref(LvToRd, 'ZeroLst');
        RdBlock(fref(LvToRd, 'Ft'));
      } else if (s === 'PF') {
        RdLex();
        LvToRd = rv.LstLvM;
        CZeroLst = fref(rv, 'PFZeroLst');
        RdBlock(fref(rv, 'PageFt'));
      } else Error(57);
    }
    // 4:
    if (LX() !== EOFChar) {
      TestLex('#');
      continue; // goto 3
    }
    break;
  }

  for (let i = 1; i <= rv.MaxIi; i++) {
    const ID: InpDPtr = rv.IDA[i];
    if (ID!.ErrTxtFrml !== null) RdChkDsFromPos(ID!.Scan!.FD, fref(ID!, 'Chk'));
  }
}
