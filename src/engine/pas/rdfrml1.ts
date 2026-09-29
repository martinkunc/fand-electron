// PAS: RDFRML1.PAS (include of COMPILE) – formula nodes, field/file/link name lookup, field and
// access formulas (FILE.field, role.field, OWNED(...)), the default RdFldNameFrml hook.
//
// Porting notes:
// * No state. Uses AccessVars.CFile/CRdb/CatFD/LinkDRoot, FDLocVarAllowed/SpecFDNameAllowed/
//   FileVarsAllowed, RdRunVars.LVBD.
// * No asm. GetOp: BP7 allocates only the operand bytes of the op class (1/5/9/13) plus
//   BytesAfter, FPC allocates a whole FrmlElem; here it is `new FrmlElem(Op)` (FrmlElem.Inline
//   for the trailing data when an op needs it, see rdfrml.ts).
// * FindFileD also resolves 'f' (FILE) local vars (FDLocVarAllowed) and the name CATALOG.
// * TryRdFldFrml temporarily swaps RdFldNameFrml to RdFldNameFrmlF while reading OWNED(...).
// * Private routines: TryRdFldFrml.FindOwnLD (nested).

import { ref, ShortStr, type Ref } from './pasrt.ts';
import { SEquUpcase, Set2MsgPar } from './base.ts';
import {
  AccessVars, FrmlElem, _identifier, _access, _newfile, _field, _owned,
  type FileDPtr, type FieldDPtr, type FrmlPtr, type LinkDPtr, type LocVarPtr,
} from './access.ts';
import { RdRunVars } from './rdrun.ts';
import { Error, OldError, SkipBlank, RdLex, TestIdentif, Accept, EquUpcase, IsKeyWord, IsForwPoint } from './lexanal.ts';
import { FindLocVar } from './rdmix.ts';
import { RdFormula, TestBool } from './rdfrml.ts';

// PAS: RDFRML1.PAS GetOp
export function GetOp(Op: string, BytesAfter: number): FrmlPtr {
  return new FrmlElem(Op);
}
// PAS: RDFRML1.PAS FindFldName – current lexeme as a field of FD, nil if none
export function FindFldName(FD: FileDPtr): FieldDPtr {
  let F = FD!.FldD;
  while (F !== null) {
    if (EquUpcase(F.Name)) break;
    F = F.Chain;
  }
  return F;
}
// PAS: RDFRML1.PAS RdFldName
export function RdFldName(FD: FileDPtr): FieldDPtr {
  TestIdentif();
  const F = FindFldName(FD);
  if (F === null) {
    Set2MsgPar(AccessVars.LexWord, FD!.Name);
    Error(87);
  }
  RdLex();
  return F;
}
// PAS: RDFRML1.PAS FindFileD
export function FindFileD(): FileDPtr {
  const a = AccessVars;
  const LV = ref<LocVarPtr>(null);
  if (a.FDLocVarAllowed && FindLocVar(RdRunVars.LVBD.Root, LV) && LV.v!.FTyp === 'f') return LV.v!.FD;
  let R = a.CRdb;
  while (R !== null) {
    let FD = R.FD;
    while (FD !== null) {
      if (EquUpcase(FD.Name)) return FD;
      FD = FD.Chain;
    }
    R = R.ChainBack;
  }
  if (EquUpcase('CATALOG')) return a.CatFD;
  return null;
}
// PAS: RDFRML1.PAS RdFileName
export function RdFileName(): FileDPtr {
  const a = AccessVars;
  if (a.SpecFDNameAllowed && a.Lexem === '@') {
    a.LexWord = '@';
    a.Lexem = _identifier;
  }
  TestIdentif();
  const FD = FindFileD();
  if (FD === null || (FD === a.CRdb!.FD && !a.SpecFDNameAllowed)) Error(9);
  RdLex();
  return FD;
}
// PAS: RDFRML1.PAS FindLD
export function FindLD(RoleName: string): LinkDPtr {
  let L = AccessVars.LinkDRoot;
  while (L !== null) {
    if (L.FromFD === AccessVars.CFile && SEquUpcase(L.RoleName, RoleName)) return L;
    L = L.Chain;
  }
  return null;
}
// PAS: RDFRML1.PAS IsRoleName
export function IsRoleName(Both: boolean, FD: Ref<FileDPtr>, LD: Ref<LinkDPtr>): boolean {
  TestIdentif();
  FD.v = FindFileD();
  if (FD.v !== null && FD.v.IsParFile) {
    RdLex();
    LD.v = null;
    return true;
  }
  if (Both) {
    LD.v = FindLD(AccessVars.LexWord);
    if (LD.v !== null) {
      RdLex();
      FD.v = LD.v.ToFD;
      return true;
    }
  }
  return false;
}
// PAS: RDFRML1.PAS RdFAccess
export function RdFAccess(FD: FileDPtr, LD: LinkDPtr, FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  TestIdentif();
  const Z = GetOp(_access, 12)!;
  Z.File2 = FD;
  Z.LD = LD;
  if (LD !== null && EquUpcase('EXIST')) {
    RdLex();
    FTyp.v = 'B';
  } else {
    const cf = a.CFile;
    a.CFile = FD;
    const fa = a.FileVarsAllowed;
    a.FileVarsAllowed = true;
    Z.P1 = RdFldNameFrmlF(FTyp);
    a.CFile = cf;
    a.FileVarsAllowed = fa;
  }
  return Z;
}
// PAS: RDFRML1.PAS TryRdFldFrml.FindOwnLD
function FindOwnLD(FD: FileDPtr, RoleName: string): LinkDPtr {
  let ld = AccessVars.LinkDRoot;
  while (ld !== null) {
    if (ld.ToFD === FD && EquUpcase(ld.FromFD!.Name) && ld.IndexRoot !== 0 && SEquUpcase(ld.RoleName, RoleName)) break;
    ld = ld.Chain;
  }
  // 1:
  RdLex();
  return ld;
}
// PAS: RDFRML1.PAS TryRdFldFrml
export function TryRdFldFrml(FD: FileDPtr, FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  let z: FrmlPtr;
  if (IsKeyWord('OWNED')) {
    const rff = a.RdFldNameFrml;
    a.RdFldNameFrml = RdFldNameFrmlF;
    Accept('(');
    z = GetOp(_owned, 12)!;
    TestIdentif();
    SkipBlank(false);
    let ld: LinkDPtr;
    if (a.ForwChar === '(') {
      const roleNm = ShortStr(a.LexWord, 32);
      RdLex();
      RdLex();
      ld = FindOwnLD(FD, roleNm);
      Accept(')');
    } else ld = FindOwnLD(FD, FD!.Name);
    if (ld === null) OldError(182);
    z.ownLD = ld;
    const cf = a.CFile;
    a.CFile = ld!.FromFD;
    if (a.Lexem === '.') {
      RdLex();
      z.ownSum = RdFldNameFrmlF(FTyp);
      if (FTyp.v !== 'R') OldError(20);
    }
    if (a.Lexem === ':') {
      RdLex();
      const typ = ref('\0');
      z.ownBool = RdFormula(typ);
      TestBool(typ.v);
    }
    Accept(')');
    a.CFile = cf;
    FTyp.v = 'R';
    a.RdFldNameFrml = rff;
  } else {
    const f = FindFldName(FD);
    if (f === null) z = null;
    else {
      RdLex();
      z = MakeFldFrml(f, FTyp);
    }
  }
  return z;
}
// PAS: RDFRML1.PAS RdFldNameFrmlF – the default RdFldNameFrml hook (called implicitly)
export function RdFldNameFrmlF(FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  if (IsForwPoint()) {
    const fd = ref<FileDPtr>(null);
    const ld = ref<LinkDPtr>(null);
    if (!IsRoleName(a.FileVarsAllowed, fd, ld)) Error(9);
    RdLex();
    return RdFAccess(fd.v, ld.v, FTyp);
  }
  if (!a.FileVarsAllowed) Error(110);
  const z = TryRdFldFrml(a.CFile, FTyp);
  if (z === null) Error(8);
  return z;
}
// PAS: RDFRML1.PAS FrmlContxt – wraps Z in _newfile (NewFile, NewRP = record buffer)
export function FrmlContxt(Z: FrmlPtr, FD: FileDPtr, RP: Uint8Array | null): FrmlPtr {
  const Z1 = GetOp(_newfile, 8)!;
  Z1.Frml = Z;
  Z1.NewFile = FD;
  Z1.NewRP = RP;
  return Z1;
}
// PAS: RDFRML1.PAS MakeFldFrml
export function MakeFldFrml(F: FieldDPtr, FTyp: Ref<string>): FrmlPtr {
  const Z = GetOp(_field, 4)!;
  Z.Field = F;
  FTyp.v = F!.FrmlTyp;
  return Z;
}
