// PAS: RDMERG.PAS – compiles a merge chapter (M): '#I1_FILE' inputs (conditions, key-in, match
// fields, '!' auto sort) and '#O1_FILE' outputs with conditions and assignment sequences
// (:=, +=, if-then-else), plus implicit field-by-field assignments for same-named fields.
//
// Porting notes:
// * State: fills RdRunVars (IDA[1..9], MaxIi, OldMFlds/NewMFlds, OldMXStr, OutpFDRoot, OutpRDs,
//   Join) and RdRunVars.LVBD. Private globals: WhatToRd ('i' = Oi output FDs, 'O' = output FDs),
//   ReadingOutpBool, Ii, Oi, SumIi, RD (current OutpRD). Hooks: RdFldNameFrml := RdFldNameFrmlM,
//   ChainSumEl := ChainSumElM.
// * No asm, no DOS. ReadMerge compiles whatever input is set: PROJMGR (chapter text via
//   SetInpTT/SetInpTTPos) or EXPIMP/PROJMGR strings ('#I1_X #O1_@' with SpecFDNameAllowed).
// * ImplAssign (_move): Pascal points ToPtr/FromPtr into the record buffers at F^.Displ and merges
//   adjacent moves by comparing addresses (A1^.FromPtr + A1^.L = A^.FromPtr and the same for
//   ToPtr). In TS the pointers are subarray views: `buffer` identity and `byteOffset + L` are
//   compared, and the merged view is re-created with the larger length.
// * FrmlPtr(@IDA[Ii]^.Op) & co. (COUNT, ERROR, WARNING, GROUP) are FrmlAt views of the InpD /
//   MergOpGroup fields (access.ts FrmlAt).
// * Private routines: InpFD, RdIiPrefix, FindIiandFldFrml, RdFldNameFrmlM (+ RdDirFilVar,
//   TestSetSumIi, RdOutpFldName, SetIi, TestNotSum, Err), ChainSumElM, ReadMerge's nested
//   CopyPrevMFlds, CheckMFlds, MakeOldMFlds, RdAutoSortSK, ImplAssign (+ AdjustComma,
//   FindIiandFldD), FindAssignToF, MakeImplAssign, TestIsOutpFile, RdAssign, RdAssSequ, RdOutpRD.

import { ref, fref, ord, CopyRec, type Ref } from './pasrt.ts';
import { ChainLast, IsDigit } from './base.ts';
import {
  AccessVars, FrmlAt, XScan, f_Stored, f_Comma, Power10, GetRecSpace, ResetCompilePars,
  _const, _times, _divide,
  type FileDPtr, type FieldDPtr, type FrmlPtr, type KeyFldDPtr, type KeyInDPtr, type LinkDPtr, type LocVarPtr,
} from './access.ts';
import {
  RdRunVars, ResetLVBD, InpD, OutpFD, OutpRD, AssignD, ConstListEl,
  _zero, _move, _output, _locvar, _parfile, _ifthenelseM,
  type InpDPtr, type OutpRDPtr, type OutpFDPtr, type AssignDPtr,
} from './rdrun.ts';
import { RdChkDsFromPos } from './rdfildcl.ts';
import {
  Error, OldError, ReadChar, RdLex, TestIdentif, TestLex, Accept, IsKeyWord, AcceptKeyWord, TestKeyWord,
  IsForwPoint, RdLocDcl, FindLocVar, RdAssignFrml, FldTypIdentity, RdViewKey, RdKFList,
  RdBool, RdKeyInBool, GetOp, FindFldName, RdFldName, RdFileName, IsRoleName, RdFAccess, TryRdFldFrml,
  FrmlContxt, MakeFldFrml,
} from './compile.ts';

const EOFChar = '\x1a'; // ^Z

let WhatToRd = '\0'; // i=Oi output FDs; O=O outp.FDs
let ReadingOutpBool = false;
let Ii = 0;
let Oi = 0;
let SumIi = 0;
let RD: OutpRDPtr = null;

// PAS: RDMERG.PAS InpFD
function InpFD(I: number): FileDPtr {
  return RdRunVars.IDA[I]!.Scan!.FD;
}

// PAS: RDMERG.PAS RdIiPrefix – 'In.' prefix
function RdIiPrefix(): boolean {
  const a = AccessVars;
  const lw = a.LexWord;
  if (a.ForwChar === '.' && lw.length === 2 && lw[0] === 'I' && lw[1] >= '1' && lw[1] <= '9') {
    Ii = ord(lw[1]) - ord('0');
    if (Ii > RdRunVars.MaxIi || (WhatToRd === 'i' && Ii > Oi)) Error(9);
    RdLex();
    RdLex();
    return true;
  }
  Ii = 0;
  return false;
}
// PAS: RDMERG.PAS FindIiandFldFrml – a field of I1..In (for Oi only I1..Ii, Ii first)
function FindIiandFldFrml(FD: Ref<FileDPtr>, FTyp: Ref<string>): FrmlPtr {
  const rv = RdRunVars;
  let z: FrmlPtr;
  if (!rv.Join && WhatToRd === 'i') {
    // for Oi search first in Ii
    FD.v = InpFD(Oi);
    z = TryRdFldFrml(FD.v, FTyp);
    if (z !== null) {
      Ii = Oi;
      return z; // goto 1
    }
  }
  for (let i = 1; i <= rv.MaxIi; i++) {
    // search in I1 .. In, for Oi only I1 .. Ii
    FD.v = InpFD(i);
    z = TryRdFldFrml(FD.v, FTyp);
    if (z !== null) {
      Ii = i;
      return z;
    }
    if (WhatToRd === 'i' && i === Oi) return z;
  }
  return null; // (z of the last try, nil)
}

// PAS: RDMERG.PAS RdFldNameFrmlM – the RdFldNameFrml hook of merge chapters
function RdFldNameFrmlM(FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  const rv = RdRunVars;
  // PAS: RDMERG.PAS RdFldNameFrmlM.RdDirFilVar – [In.]file.field / role.field
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
    Accept('.'); // 2:
    let Z = RdFAccess(FD.v, LD.v, FTyp);
    if (LD.v === null) Ii = 0;
    else Z = FrmlContxt(Z, a.CFile, a.CFile!.RecPtr);
    return Z;
  };
  // PAS: RDMERG.PAS RdFldNameFrmlM.TestSetSumIi
  const TestSetSumIi = (): void => {
    if (a.FrmlSumEl !== null && Ii !== 0) {
      if (a.FrstSumVar || SumIi === 0) SumIi = Ii;
      else if (SumIi !== Ii) OldError(27);
    }
  };
  // PAS: RDMERG.PAS RdFldNameFrmlM.RdOutpFldName – O.field
  const RdOutpFldName = (): FrmlPtr => {
    if (RD!.OD === null) Error(85); // dummy
    const OD = RD!.OD!;
    return FrmlContxt(MakeFldFrml(RdFldName(OD.FD), FTyp), OD.FD, OD.RecPtr);
  };
  // PAS: RDMERG.PAS RdFldNameFrmlM.SetIi
  const SetIi = (): void => {
    if (!WasIiPrefix) {
      if (!rv.Join && WhatToRd === 'i') Ii = Oi;
      else Ii = 1;
    }
  };
  // PAS: RDMERG.PAS RdFldNameFrmlM.TestNotSum
  const TestNotSum = (): void => {
    if (a.FrmlSumEl !== null) OldError(41);
  };
  // PAS: RDMERG.PAS RdFldNameFrmlM.Err
  const Err = (): void => {
    TestNotSum();
    SetIi();
    const id = rv.IDA[Ii]!;
    if (id.ErrTxtFrml === null) id.ErrTxtFrml = GetOp(_const, 256);
  };
  // 1: COUNT / N
  const L1 = (): FrmlPtr => {
    TestNotSum();
    SetIi();
    FTyp.v = 'R';
    return FrmlAt(rv.IDA[Ii]!, { Op: 'Op', R: 'Count' });
  };
  // 2: GROUP / M
  const L2 = (): FrmlPtr => {
    TestNotSum();
    if (WasIiPrefix) OldError(41);
    FTyp.v = 'R';
    return FrmlAt(rv.MergOpGroup, { Op: 'Op', R: 'Group' });
  };

  const WasIiPrefix = RdIiPrefix();
  if (a.FrmlSumEl !== null && a.FrstSumVar) SumIi = 0;
  TestIdentif();
  if (a.LexWord === 'O' && IsForwPoint() && !WasIiPrefix) {
    RdLex();
    RdLex();
    if (a.FrmlSumEl !== null || ReadingOutpBool) Error(99);
    return RdOutpFldName();
  }
  if (IsForwPoint()) {
    const Z = RdDirFilVar();
    TestSetSumIi();
    return Z;
  }
  if (!WasIiPrefix) {
    const LV = ref<LocVarPtr>(null);
    if (FindLocVar(rv.LVBD.Root, LV)) {
      RdLex();
      TestNotSum();
      FTyp.v = LV.v!.FTyp;
      return FrmlAt(LV.v!, { Op: 'Op', BPOfs: 'BPOfs' });
    }
  }
  if (IsKeyWord('COUNT')) return L1();
  if (IsKeyWord('GROUP')) return L2();
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
  const FD = ref<FileDPtr>(null);
  let z: FrmlPtr;
  if (WasIiPrefix) {
    FD.v = InpFD(Ii);
    z = TryRdFldFrml(FD.v, FTyp);
  } else z = FindIiandFldFrml(FD, FTyp);
  if (z === null) {
    if (IsKeyWord('N')) return L1();
    if (IsKeyWord('M')) return L2();
    Error(8);
  }
  TestSetSumIi();
  return FrmlContxt(z, FD.v, FD.v!.RecPtr);
}

// PAS: RDMERG.PAS ChainSumElM – the ChainSumEl hook: sums belong to an input (SumIi)
function ChainSumElM(): void {
  const a = AccessVars;
  const rv = RdRunVars;
  if (a.FrstSumVar || SumIi === 0) SumIi = 1;
  a.FrmlSumEl!.Chain = rv.IDA[SumIi]!.Sum;
  rv.IDA[SumIi]!.Sum = a.FrmlSumEl;
}

// PAS: RDMERG.PAS ReadMerge.CopyPrevMFlds – match fields of I(n-1) by name in In
function CopyPrevMFlds(): void {
  const a = AccessVars;
  const rv = RdRunVars;
  let M = rv.IDA[Ii - 1]!.MFld;
  const S = a.LexWord;
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
  a.LexWord = S;
}
// PAS: RDMERG.PAS ReadMerge.CheckMFlds
function CheckMFlds(M1: KeyFldDPtr, M2: KeyFldDPtr): void {
  while (M1 !== null) {
    if (M2 === null) OldError(30);
    if (!FldTypIdentity(M1.FldD, M2.FldD) || M1.Descend !== M2.Descend || M1.CompLex !== M2.CompLex) OldError(12);
    M1 = M1.Chain;
    M2 = M2.Chain;
  }
  if (M2 !== null) OldError(30);
}
// PAS: RDMERG.PAS ReadMerge.MakeOldMFlds – one constant per match field of I1
function MakeOldMFlds(): void {
  const rv = RdRunVars;
  let M = rv.IDA[1]!.MFld;
  rv.OldMFlds = null;
  while (M !== null) {
    // case M^.FldD^.FrmlTyp of 'B':1; 'R':sizeof(float) else 256 – the value slot of ConstListEl
    ChainLast(fref(rv, 'OldMFlds'), new ConstListEl());
    M = M.Chain;
  }
}
// PAS: RDMERG.PAS ReadMerge.RdAutoSortSK – '!' input: sort keys = match fields [; more keys]
function RdAutoSortSK(ID: NonNullable<InpDPtr>): void {
  const a = AccessVars;
  if (!ID.AutoSort) return;
  let M = ID.MFld;
  while (M !== null) {
    const SK = CopyRec(M);
    ChainLast(fref(ID, 'SK'), SK);
    M = M.Chain;
  }
  if (a.Lexem === ';') {
    RdLex();
    RdKFList(fref(ID, 'SK'), a.CFile);
  }
  if (ID.SK === null) OldError(60);
}

// PAS: RDMERG.PAS ReadMerge.ImplAssign.AdjustComma
function AdjustComma(Z1: FrmlPtr, F: FieldDPtr, Op: string): FrmlPtr {
  if (F!.Typ !== 'F') return Z1;
  if ((F!.Flg & f_Comma) === 0) return Z1;
  const Z2 = GetOp(_const, 6)!;
  Z2.R = Power10[F!.M];
  const Z = GetOp(Op, 0)!;
  Z.P1 = Z1;
  Z.P2 = Z2;
  return Z;
}
// PAS: RDMERG.PAS ReadMerge.ImplAssign.FindIiandFldD – LexWord as a field of the inputs
function FindIiandFldD(F: Ref<FieldDPtr>): void {
  const rv = RdRunVars;
  if (!rv.Join && WhatToRd === 'i') {
    // for Oi search first in Ii
    F.v = FindFldName(InpFD(Oi));
    if (F.v !== null) {
      Ii = Oi;
      return;
    }
  }
  for (let i = 1; i <= rv.MaxIi; i++) {
    // search in I1 .. In, for Oi only I1 .. Ii
    F.v = FindFldName(InpFD(i));
    if (F.v !== null) {
      Ii = i;
      return;
    }
    if (WhatToRd === 'i' && i === Oi) return;
  }
}
// PAS: RDMERG.PAS ReadMerge.ImplAssign – implicit FNew := same-named input field
function ImplAssign(RD: NonNullable<OutpRDPtr>, FNew: NonNullable<FieldDPtr>): void {
  const a = AccessVars;
  const FDNew = RD.OD!.FD!;
  const RPNew = RD.OD!.RecPtr!;
  const S = a.LexWord;
  const A = new AssignD(); // GetZStore
  const A1 = RD.Ass;
  a.LexWord = FNew.Name;
  const F = ref<FieldDPtr>(null);
  FindIiandFldD(F);
  const f = F.v;
  if (f === null || f.FrmlTyp !== FNew.FrmlTyp || (f.FrmlTyp === 'R' && f.Typ !== FNew.Typ)) {
    A.Kind = _zero;
    A.FldD = FNew;
  } else {
    const FD = InpFD(Ii)!;
    const RP = FD.RecPtr!;
    if (
      FD.Typ === FDNew.Typ &&
      FldTypIdentity(f, FNew) &&
      f.Typ !== 'T' &&
      (f.Flg & f_Stored) !== 0 &&
      FNew.Flg === f.Flg
    ) {
      A.Kind = _move;
      A.L = FNew.NBytes;
      A.ToPtr = RPNew.subarray(FNew.Displ, FNew.Displ + A.L);
      A.FromPtr = RP.subarray(f.Displ, f.Displ + A.L);
      if (
        A1 !== null &&
        A1.Kind === _move &&
        A1.FromPtr!.buffer === A.FromPtr.buffer &&
        A1.FromPtr!.byteOffset + A1.L === A.FromPtr.byteOffset &&
        A1.ToPtr!.buffer === A.ToPtr.buffer &&
        A1.ToPtr!.byteOffset + A1.L === A.ToPtr.byteOffset
      ) {
        A1.L = A1.L + A.L;
        A1.FromPtr = new Uint8Array(A1.FromPtr!.buffer, A1.FromPtr!.byteOffset, A1.L);
        A1.ToPtr = new Uint8Array(A1.ToPtr!.buffer, A1.ToPtr!.byteOffset, A1.L);
        // ReleaseStore(A); goto 1
        a.LexWord = S;
        return;
      }
    } else {
      A.Kind = _output;
      A.OFldD = FNew;
      const FTyp = ref('\0');
      let Z = MakeFldFrml(f, FTyp);
      Z = AdjustComma(Z, f, _divide);
      Z = AdjustComma(Z, FNew, _times);
      A.Frml = FrmlContxt(Z, FD, FD.RecPtr);
    }
  }
  A.Chain = A1;
  RD.Ass = A;
  a.LexWord = S; // 1:
}
// PAS: RDMERG.PAS ReadMerge.FindAssignToF – an explicit 'F :=' already exists
function FindAssignToF(A: AssignDPtr, F: FieldDPtr): boolean {
  while (A !== null) {
    if (A.Kind === _output && A.OFldD === F && !A.Add) return true;
    A = A.Chain;
  }
  return false;
}
// PAS: RDMERG.PAS ReadMerge.MakeImplAssign – implicit assignments name:=name of the current RD
function MakeImplAssign(): void {
  if (RD!.OD === null) return;
  let FNew = RD!.OD.FD!.FldD;
  while (FNew !== null) {
    // implic.assign   name:=name
    if ((FNew.Flg & f_Stored) !== 0 && !FindAssignToF(RD!.Ass, FNew)) ImplAssign(RD!, FNew);
    FNew = FNew.Chain;
  }
}
// PAS: RDMERG.PAS ReadMerge.TestIsOutpFile
function TestIsOutpFile(FD: FileDPtr): void {
  let OFD: OutpFDPtr = RdRunVars.OutpFDRoot;
  while (OFD !== null) {
    if (OFD.FD === FD) OldError(173);
    OFD = OFD.Chain;
  }
}
// PAS: RDMERG.PAS ReadMerge.RdAssign – one assignment (BEGIN..END, IF, PARFILE.f, locvar, field)
function RdAssign(): AssignDPtr {
  const a = AccessVars;
  if (IsKeyWord('BEGIN')) {
    const r = RdAssSequ();
    AcceptKeyWord('END');
    return r;
  }
  const AD = new AssignD(); // GetZStore
  TestIdentif();
  const LV = ref<LocVarPtr>(null);
  if (IsKeyWord('IF')) {
    AD.Kind = _ifthenelseM;
    AD.Bool = RdBool();
    AcceptKeyWord('THEN');
    AD.Instr = RdAssign();
    if (IsKeyWord('ELSE')) AD.ElseInstr = RdAssign();
  } else if (a.ForwChar === '.') {
    AD.Kind = _parfile;
    const FD = RdFileName()!;
    if (!FD.IsParFile) OldError(9);
    TestIsOutpFile(FD);
    Accept('.');
    AD.FD = FD;
    const F = RdFldName(FD)!;
    AD.PFldD = F;
    if ((F.Flg & f_Stored) === 0) OldError(14);
    RdAssignFrml(F.FrmlTyp, fref(AD, 'Add'), fref(AD, 'Frml'));
  } else if (FindLocVar(RdRunVars.LVBD.Root, LV)) {
    RdLex();
    AD.Kind = _locvar;
    AD.LV = LV.v;
    RdAssignFrml(LV.v!.FTyp, fref(AD, 'Add'), fref(AD, 'Frml'));
  } else {
    if (RD!.OD === null) Error(72); // dummy
    AD.Kind = _output;
    const F = RdFldName(RD!.OD!.FD)!;
    AD.OFldD = F;
    if ((F.Flg & f_Stored) === 0) OldError(14);
    RdAssignFrml(F.FrmlTyp, fref(AD, 'Add'), fref(AD, 'Frml'));
  }
  return AD;
}
// PAS: RDMERG.PAS ReadMerge.RdAssSequ – 'a1; a2; ...' up to '#', ^Z or END
function RdAssSequ(): AssignDPtr {
  const a = AccessVars;
  const ARoot = ref<AssignDPtr>(null);
  for (;;) {
    // 1: A:=AssignDPtr(@ARoot); while A^.Chain<>nil do A:=A^.Chain; A^.Chain:=RdAssign
    const Ass = RdAssign();
    if (ARoot.v === null) ARoot.v = Ass;
    else {
      let A = ARoot.v;
      while (A.Chain !== null) A = A.Chain;
      A.Chain = Ass;
    }
    if (a.Lexem === ';') {
      RdLex();
      if (!((a.Lexem as string) === EOFChar || (a.Lexem as string) === '#') && !TestKeyWord('END')) continue;
    }
    return ARoot.v;
  }
}
// PAS: RDMERG.PAS ReadMerge.RdOutpRD – 'FILE[+] [(cond)] assignments' or DUMMY
function RdOutpRD(RDRoot: Ref<OutpRDPtr>): void {
  const a = AccessVars;
  const rv = RdRunVars;
  RD = new OutpRD();
  ChainLast(RDRoot, RD);
  RD.Ass = null;
  RD.Bool = null;
  if (IsKeyWord('DUMMY')) RD.OD = null;
  else {
    const FD = RdFileName();
    let OD: OutpFDPtr = rv.OutpFDRoot;
    let found = false;
    while (OD !== null) {
      if (OD.FD === FD) {
        if (a.Lexem === '+') {
          if (OD.Append) RdLex();
          else Error(31);
        } else if (OD.Append) Error(31);
        found = true; // goto 1
        break;
      }
      OD = OD.Chain;
    }
    if (!found) {
      OD = new OutpFD();
      OD.FD = FD;
      a.CFile = FD;
      OD.RecPtr = GetRecSpace();
      OD.InplFD = null;
      for (let I = 1; I <= rv.MaxIi; I++) {
        if (InpFD(I) === FD) {
          OD.InplFD = FD;
          rv.IDA[I]!.IsInplace = true;
          if (FD!.typSQLFile) Error(172);
        }
      }
      if (a.Lexem === '+') {
        OD.Append = true;
        if (OD.InplFD !== null) Error(32);
        RdLex();
      } else OD.Append = false;
      ChainLast(fref(rv, 'OutpFDRoot'), OD);
    }
    RD.OD = OD; // 1:
  }
  if (a.Lexem === '(') {
    RdLex();
    ReadingOutpBool = true;
    RD.Bool = RdBool();
    ReadingOutpBool = false;
    Accept(')');
  }
  if (!((a.Lexem as string) === '#' || (a.Lexem as string) === EOFChar)) RD.Ass = RdAssSequ();
  MakeImplAssign();
}

// PAS: RDMERG.PAS ReadMerge
export function ReadMerge(): void {
  const a = AccessVars;
  const rv = RdRunVars;
  ResetCompilePars();
  RdLex();
  ResetLVBD();
  if (IsKeyWord('VAR')) RdLocDcl(rv.LVBD, false, false, 'M');
  WhatToRd = 'I';
  ReadingOutpBool = false;
  const WasSqlFile = false; // FandSQL: set by typSQLFile inputs
  Ii = 0;
  TestLex('#');
  let I = 0;
  do {
    let ok = false;
    ReadChar();
    if (a.CurrChar === 'I') {
      ReadChar();
      if (IsDigit(a.CurrChar)) {
        I = ord(a.CurrChar) - ord('0');
        ReadChar();
        if ((a.CurrChar as string) === '_') {
          RdLex();
          ok = true; // goto 1
        }
      }
    }
    if (!ok) Error(89);
    Ii++; // 1:
    if (I !== Ii) OldError(61);
    const ID = new InpD(); // GetZStore
    rv.IDA[Ii] = ID;
    const FD = RdFileName()!;
    a.CFile = FD;
    for (I = 1; I <= Ii - 1; I++) if (InpFD(I) === FD) OldError(26);
    a.CViewKey = RdViewKey();
    if (a.Lexem === '!') {
      RdLex();
      ID.AutoSort = true;
    }
    ID.Op = _const;
    ID.OpErr = _const;
    ID.OpWarn = _const;
    const KI = ref<KeyInDPtr>(null);
    ID.ForwRecPtr = GetRecSpace();
    FD.RecPtr = GetRecSpace();
    if (a.Lexem === '(') {
      RdLex();
      ID.Bool = RdKeyInBool(KI, false, false, fref(ID, 'SQLFilter'));
      Accept(')');
    }
    ID.Scan = new XScan().Init(FD, a.CViewKey, KI.v, true);
    if (!(a.Lexem === ';' || a.Lexem === '#' || a.Lexem === EOFChar)) RdKFList(fref(ID, 'MFld'), FD);
    if (Ii > 1) {
      if (rv.IDA[Ii - 1]!.MFld === null) {
        if (ID.MFld !== null) OldError(22);
      } else if (ID.MFld === null) CopyPrevMFlds();
      else CheckMFlds(rv.IDA[Ii - 1]!.MFld, ID.MFld);
    }
    RdAutoSortSK(ID);
    TestLex('#');
  } while (a.ForwChar === 'I');

  rv.MaxIi = Ii;
  MakeOldMFlds();
  rv.OldMXStr.Clear();
  rv.OutpFDRoot = null;
  rv.OutpRDs = null;
  rv.Join = false;
  let WasOi = false;
  a.RdFldNameFrml = RdFldNameFrmlM;

  for (;;) {
    // 3:
    ReadChar();
    if (a.CurrChar === 'O') {
      ReadChar();
      let L4 = false;
      if (IsDigit(a.CurrChar)) {
        if (rv.Join) Error(91);
        WasOi = true;
        Oi = ord(a.CurrChar) - ord('0');
        if (Oi === 0 || Oi > rv.MaxIi) Error(62);
        L4 = true; // goto 4
      } else if ((a.CurrChar as string) === '*') {
        if (WasOi) Error(91);
        if (WasSqlFile) Error(155);
        rv.Join = true;
        Oi = rv.MaxIi;
        L4 = true;
      } else if ((a.CurrChar as string) === '_') {
        RdLex();
        WhatToRd = 'O';
        a.ChainSumEl = ChainSumElM;
        RdOutpRD(fref(rv, 'OutpRDs'));
      } else Error(90);
      if (L4) {
        // 4:
        ReadChar();
        if ((a.CurrChar as string) !== '_') Error(90);
        RdLex();
        WhatToRd = 'i';
        a.ChainSumEl = null;
        RdOutpRD(fref(rv.IDA[Oi]!, 'RD'));
      }
    } else Error(90);
    if (a.Lexem !== EOFChar) {
      TestLex('#');
      continue; // goto 3
    }
    break;
  }

  for (let i = 1; i <= rv.MaxIi; i++) {
    const ID = rv.IDA[i]!;
    if (ID.ErrTxtFrml !== null) RdChkDsFromPos(ID.Scan!.FD, fref(ID, 'Chk'));
  }
}
