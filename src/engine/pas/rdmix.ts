// PAS: RDMIX.PAS (include of COMPILE) – local variable declarations, chapter lookup, field and
// key lists, edit/report option records, window/frame/attribute syntax, record length layout.
//
// Porting notes:
// * No state of its own except the private KeyArgFound/KeyArgFld used by IsKeyArg (SrchF/SrchZ).
//   Works on AccessVars.CFile/CRecPtr/CRdb/Chpt/Chpt* fields, RdRunVars.LVBD, BaseVars.spec.
// * No asm. DOS-free.
// * RdLocDcl: BPOfs slots grow by sizeof: 'B' 1, 'R' 6 (sizeof(float) in BP7; keep 6 so BPOfs match,
//   PORTING.md section 14), 'S' 4. A 'r' (record) var gets RecPtr = ptr(0,1) "not nil, never run":
//   a zero-length Uint8Array (NoRunRecPtr). A FILE local var compiles a nested file declaration with
//   SaveCompState/RdFileD/RestoreCompState and then restores CurrPos/Lexem/ForwChar.
// * RdChptName with '[expr]': Pascal casts the string formula into Pos.R (IRec=0); store it in
//   Pos.Frml (Pos.R = nil).
// * EditModeToFlags(Mode, var Flgs): Flgs is array[1..24] of boolean overlaid on EditD's
//   NoDelete..SelMode (RDEDIT) or a local array (RDPROC). Here Flgs is a boolean[] with index 0
//   unused; EditModeFlagFields names the EditD fields for the RDEDIT caller.
// * CompileRecLen: Displ starts at 1 for 'X'/'D' files (deleted flag byte); FrstDispl 4 for '8',
//   (n+1)*32+1 for 'D', else 6. Field NBytes for DBF: F -> L-1, D -> 8, T -> 10.
// * Private routines: RdLocDcl.RdVarName, SrchZ, SrchF.

import { ref, fref, chr, ord, UpCase, Pos, Copy, ShortStr, type Ref } from './pasrt.ts';
import type { StringPtr } from './base.ts';
import { BaseVars, ChainLast, SEquUpcase, SetStyleAttr, Set2MsgPar, StoreStr } from './base.ts';
import {
  AccessVars, f_Stored, FieldListEl, KeyFldD, LocVar, XWKey, GetRecSpace, ReadRec, _ShortS,
  _const, _getlocvar, _field, _access, _userfunc, _equ, _assign, _addass, _identifier, _quotedstr, _gt,
  type FileDPtr, type FieldDPtr, type FieldList, type FrmlPtr, type KeyDPtr, type XKey,
  type KeyFldDPtr, type LocVarBlkD, type LocVarPtr, type RdbPos, type WRectFrml,
} from './access.ts';
import { EditOpt, RprtOpt, RdRunVars, _ALstg, type EditOptPtr, type RprtOptPtr } from './rdrun.ts';
import { WNoClrScr, WPushPixel, WHasFrame, WDoubleFrame, WShadow } from './base.ts';
import { DriversVars, _ESC_ } from './drivers.ts';
import { RunError } from './obaseww.ts';
import { WwMixVars, PutSelect, SelectStr, GetSelect } from './wwmix.ts';
import { TrailChar } from './runfrml.ts';
import { RdFileD } from './rdfildcl.ts';
import {
  Error, OldError, RdLex, TestIdentif, TestLex, Accept, RdRealConst, EquUpcase, TestKeyWord, IsKeyWord,
  AcceptKeyWord, Rd1Char,
} from './lexanal.ts';
import { SaveCompState, RestoreCompState } from './compile.ts';
import { GetOp, FindFileD, RdFileName, FindFldName, RdFldName } from './rdfrml1.ts';
import { RdFrml, RdRealFrml, RdStrFrml } from './rdfrml.ts';

/** TS-only: EditD fields that EditModeToFlags' Flgs[1..24] overlays (FlgTxt order). */
export const EditModeFlagFields = [
  '', 'NoDelete', 'VerifyDelete', 'NoCreate', 'F1Mode', 'OnlyAppend', 'OnlySearch', 'Only1Record', 'OnlyTabs',
  'NoESCPrompt', 'MustESCPrompt', 'Prompt158', 'NoSrchMsg', 'WithBoolDispl', 'Mode24', 'NoCondCheck', 'F3LeadIn',
  'LUpRDown', 'MouseEnter', 'TTExit', 'MakeWorkX', 'NoShiftF7Msg', 'MustAdd', 'MustCheck', 'SelMode',
] as const;

/** TS-only: Pascal ptr(0,1) in LocVar.RecPtr of a RECORD variable ("not nil, never run"). */
export const NoRunRecPtr = new Uint8Array(0);

// PAS: RDMIX.PAS RdLocDcl.RdVarName
function RdVarName(LVB: LocVarBlkD, IsParList: boolean): LocVar {
  const a = AccessVars;
  TestIdentif();
  let lv = LVB.Root;
  while (lv !== null) {
    if (EquUpcase(lv.Name)) Error(26);
    lv = lv.Chain;
  }
  const nlv = new LocVar();
  ChainLast(fref(LVB, 'Root'), nlv);
  nlv.Name = a.LexWord;
  RdLex();
  if (IsParList) {
    nlv.IsPar = true;
    LVB.NParam++;
  }
  return nlv;
}
// PAS: RDMIX.PAS RdLocDcl
export function RdLocDcl(LVB: LocVarBlkD, IsParList: boolean, WithRecVar: boolean, CTyp: string): void {
  const a = AccessVars;
  for (;;) {
    // 1:
    let rp = false;
    if (IsParList && IsKeyWord('VAR')) {
      if (CTyp === 'D') OldError(174);
      rp = true;
    }
    let lv: LocVarPtr = RdVarName(LVB, IsParList);
    if (!IsParList) {
      while (a.Lexem === ',') {
        RdLex();
        RdVarName(LVB, IsParList);
      }
    }
    Accept(':');
    let Z: FrmlPtr = null;
    let typ = '\0';
    let sz = 0;
    let simple = true;
    if (IsKeyWord('BOOLEAN')) {
      if (a.Lexem === _equ && !IsParList) {
        RdLex();
        if (IsKeyWord('TRUE')) {
          Z = GetOp(_const, 1)!;
          Z.B = true;
        } else if (!IsKeyWord('FALSE')) Error(42);
      }
      typ = 'B';
      sz = 1;
    } else if (IsKeyWord('REAL')) {
      if (a.Lexem === _equ && !IsParList) {
        RdLex();
        const r = RdRealConst();
        if (r !== 0) {
          Z = GetOp(_const, 6)!;
          Z.R = r;
        }
      }
      typ = 'R';
      sz = 6;
    } else if (IsKeyWord('STRING')) {
      if (a.Lexem === _equ && !IsParList) {
        RdLex();
        const s = a.LexWord;
        Accept(_quotedstr);
        if (s !== '') {
          Z = GetOp(_const, s.length + 1)!;
          Z.S = s;
        }
      }
      typ = 'S';
      sz = 4;
    } else simple = false;
    if (simple) {
      // 2:
      while (lv !== null) {
        lv.FTyp = typ;
        lv.Op = _getlocvar;
        lv.IsRetPar = rp;
        lv.Init = Z;
        lv.BPOfs = LVB.Size;
        LVB.Size += sz;
        lv = lv.Chain;
      }
    } else if (rp) Error(168);
    else if (WithRecVar) {
      if (TestKeyWord('FILE')) {
        const flv = lv!;
        flv.FTyp = 'f';
        a.LexWord = flv.Name;
        if (a.LexWord.length > 8) OldError(2);
        const fd = FindFileD();
        RdLex();
        if (IsParList) {
          if (!WithRecVar) OldError(162);
          if (fd === null) OldError(163);
          flv.FD = fd;
        } else {
          if (fd !== null) OldError(26);
          let FDTyp = '6';
          if (a.Lexem === '.') {
            RdLex();
            TestIdentif();
            if (EquUpcase('X')) FDTyp = 'X';
            else if (EquUpcase('DBF')) FDTyp = 'D';
            else Error(185);
            RdLex();
          }
          TestLex('[');
          const p = SaveCompState();
          RdFileD(flv.Name, FDTyp, '$');
          TestLex(']');
          flv.FD = a.CFile;
          const n = a.CurrPos;
          const lx = a.Lexem;
          const fc = a.ForwChar;
          RestoreCompState(p);
          a.CurrPos = n;
          a.Lexem = lx;
          a.ForwChar = fc;
          RdLex();
        }
      } else {
        let typ2 = '\0';
        if (IsKeyWord('INDEX')) typ2 = 'i';
        else if (IsKeyWord('RECORD')) typ2 = 'r';
        else Error(137);
        // 3:
        AcceptKeyWord('OF');
        const cf = a.CFile;
        const cr = a.CRecPtr;
        a.CFile = RdFileName();
        const kf1 = ref<KeyFldDPtr>(null);
        if (typ2 === 'i') {
          if (a.CFile!.Typ !== 'X') OldError(108);
          if (a.Lexem === '(') {
            RdLex();
            RdKFList(kf1, a.CFile);
            Accept(')');
          }
        }
        while (lv !== null) {
          lv.FTyp = typ2;
          lv.FD = a.CFile;
          if (typ2 === 'r') lv.RecPtr = NoRunRecPtr; // for RdProc nil-tests + no Run
          else {
            const k = new XWKey();
            k.Duplic = true;
            k.InWork = true;
            k.KFlds = kf1.v;
            let kf = kf1.v;
            while (kf !== null) {
              k.IndexLen += kf.FldD!.NBytes;
              kf = kf.Chain;
            }
            lv.RecPtr = k;
          }
          lv = lv.Chain;
        }
        a.CFile = cf;
        a.CRecPtr = cr;
      }
    } else Error(39);
    if (IsParList) {
      if (a.Lexem === ')') return;
      Accept(';');
      continue;
    }
    Accept(';');
    if (a.Lexem !== '#' && a.Lexem !== '.' && !TestKeyWord('BEGIN')) continue;
    return;
  }
}
// PAS: RDMIX.PAS FindLocVar
export function FindLocVar(LVRoot: LocVarPtr, LV: Ref<LocVarPtr>): boolean {
  if (AccessVars.Lexem !== _identifier) return false;
  LV.v = LVRoot;
  while (LV.v !== null) {
    if (EquUpcase(LV.v.Name)) return true;
    LV.v = LV.v.Chain;
  }
  return false;
}
// PAS: RDMIX.PAS FindChpt
export function FindChpt(Typ: string, Name: string, local: boolean, RP: RdbPos): boolean {
  const a = AccessVars;
  const CF = a.CFile;
  const CR = a.CRecPtr;
  a.CFile = a.Chpt;
  a.CRecPtr = GetRecSpace();
  let R = a.CRdb;
  let result = false;
  outer: while (R !== null) {
    a.CFile = R.FD;
    for (let I = 1; I <= a.CFile!.NRecs; I++) {
      ReadRec(I);
      if (_ShortS(a.ChptTyp) === Typ && SEquUpcase(TrailChar(' ', _ShortS(a.ChptName)), Name)) {
        RP.R = R;
        RP.IRec = I;
        result = true;
        break outer;
      }
    }
    if (local) break;
    R = R.ChainBack;
  }
  // 1:
  a.CFile = CF;
  a.CRecPtr = CR;
  return result;
}
// PAS: RDMIX.PAS RdChptName
export function RdChptName(C: string, Pos: RdbPos, TxtExpr: boolean): void {
  const a = AccessVars;
  if (TxtExpr && a.Lexem === '[') {
    RdLex();
    Pos.R = null;
    Pos.Frml = RdStrFrml(); // Pascal: Pos.R:=RdbDPtr(RdStrFrml)
    Pos.IRec = 0;
    Accept(']');
  } else {
    TestLex(_identifier);
    if (!FindChpt(C, a.LexWord, false, Pos)) Error(37);
    RdLex();
  }
}
// PAS: RDMIX.PAS AllFldsList
export function AllFldsList(FD: FileDPtr, OnlyStored: boolean): FieldList {
  let FLRoot: FieldList = null;
  let last: FieldList = null;
  for (let F = FD!.FldD; F !== null; F = F.Chain) {
    if ((F.Flg & f_Stored) !== 0 || !OnlyStored) {
      const FL = new FieldListEl();
      FL.FldD = F;
      if (last === null) FLRoot = FL;
      else last.Chain = FL;
      last = FL;
    }
  }
  return FLRoot;
}
// PAS: RDMIX.PAS GetEditOpt
export function GetEditOpt(): EditOptPtr {
  const EO = new EditOpt();
  EO.UserSelFlds = true;
  return EO;
}
// PAS: RDMIX.PAS GetRprtOpt
export function GetRprtOpt(): RprtOptPtr {
  const RO = new RprtOpt();
  RO.Mode = _ALstg;
  RO.Style = '?';
  RO.Width = BaseVars.Spec.AutoRprtWidth;
  return RO;
}
// PAS: RDMIX.PAS CFileLikeFD
export function CFileLikeFD(FD: FileDPtr, MsgNr: number): void {
  const cf = AccessVars.CFile!;
  if (!cf.IsJournal && (cf === FD || cf.OrigFD === FD)) return;
  Set2MsgPar(cf.Name, FD!.Name);
  RunError(MsgNr);
}
// PAS: RDMIX.PAS RdHelpName
export function RdHelpName(): StringPtr {
  const a = AccessVars;
  if (a.CRdb!.HelpFD === null) Error(132);
  if (a.Lexem !== _identifier) TestLex(_quotedstr);
  const s = StoreStr(a.LexWord);
  RdLex();
  return s;
}
// PAS: RDMIX.PAS RdAttr
export function RdAttr(): FrmlPtr {
  if (AccessVars.Lexem === '^') {
    RdLex();
    const c = chr(ord(UpCase(Rd1Char())) - 64);
    const n = ref(0);
    if (!SetStyleAttr(c, n)) OldError(120);
    const z = GetOp(_const, 6)!;
    z.R = n.v;
    return z;
  }
  return RdRealFrml();
}
// PAS: RDMIX.PAS RdW
export function RdW(W: WRectFrml): void {
  W.C1 = RdRealFrml();
  Accept(',');
  W.R1 = RdRealFrml();
  Accept(',');
  W.C2 = RdRealFrml();
  Accept(',');
  W.R2 = RdRealFrml();
}
// PAS: RDMIX.PAS RdFrame
export function RdFrame(Z: Ref<FrmlPtr>, WFlags: Ref<number>): void {
  const a = AccessVars;
  if (a.Lexem !== ',') return;
  RdLex();
  if ((a.Lexem as string) === '@') {
    WFlags.v = WFlags.v | WNoClrScr;
    RdLex();
  }
  if ((a.Lexem as string) === '*') {
    WFlags.v = WFlags.v | WPushPixel;
    RdLex();
  }
  if (!(a.Lexem === ',' || a.Lexem === ')' || a.Lexem === '!')) {
    WFlags.v = WFlags.v | WHasFrame;
    if (a.Lexem === _equ) {
      RdLex();
      WFlags.v = WFlags.v | WDoubleFrame;
    }
    Z.v = RdStrFrml();
  }
  if ((a.Lexem as string) === '!') {
    WFlags.v = WFlags.v | WShadow;
    RdLex();
  }
}
// PAS: RDMIX.PAS PromptSortKeys
export function PromptSortKeys(FL: FieldList, SKRoot: Ref<KeyFldDPtr>): boolean {
  const a = AccessVars;
  const ss = WwMixVars.ss;
  SKRoot.v = null;
  while (FL !== null) {
    if (FL.FldD!.Typ !== 'T') PutSelect(FL.FldD!.Name);
    FL = FL.Chain;
  }
  if (ss.Empty) return true;
  ss.AscDesc = true;
  ss.Subset = true;
  SelectStr(0, 0, 25, '');
  if (DriversVars.KbdChar === _ESC_) return false;
  for (;;) {
    // 1:
    a.LexWord = GetSelect();
    if (a.LexWord === '') break;
    const SK = new KeyFldD();
    ChainLast(SKRoot, SK);
    SK.FldD = FindFldName(a.CFile);
    if (ss.Tag === '>') SK.Descend = true;
    if (SK.FldD!.Typ === 'A') SK.CompLex = true;
  }
  return true;
}
// PAS: RDMIX.PAS RdAssignFrml
export function RdAssignFrml(FTyp: string, Add: Ref<boolean>, Z: Ref<FrmlPtr>): void {
  if (AccessVars.Lexem === _addass) {
    RdLex();
    Add.v = true;
  } else Accept(_assign);
  const Typ = ref('\0');
  Z.v = RdFrml(Typ);
  if (FTyp !== Typ.v || (Add.v && Typ.v !== 'R')) OldError(12);
}
// PAS: RDMIX.PAS FldTypIdentity
export function FldTypIdentity(F1: FieldDPtr, F2: FieldDPtr): boolean {
  const a = F1!, b = F2!;
  if (a.Typ !== b.Typ) return false;
  if (a.Typ === 'F' && a.M !== b.M) return false;
  if ((a.Typ === 'N' || a.Typ === 'A' || a.Typ === 'F') && a.L !== b.L) return false;
  return true;
}
// PAS: RDMIX.PAS RdFldList
export function RdFldList(FLRoot: Ref<FieldList>): void {
  for (;;) {
    const F = RdFldName(AccessVars.CFile);
    const FL = new FieldListEl();
    FL.FldD = F;
    ChainLast(FLRoot, FL);
    if (AccessVars.Lexem !== ',') break;
    RdLex();
  }
}
// PAS: RDMIX.PAS RdNegFldList
export function RdNegFldList(Neg: Ref<boolean>, FLRoot: Ref<FieldList>): void {
  if (AccessVars.Lexem === '^') {
    RdLex();
    Neg.v = true;
  }
  Accept('(');
  if (AccessVars.Lexem === ')') Neg.v = true;
  else RdFldList(FLRoot);
  Accept(')');
}

const FlgTxt = [
  '', '^Y', '?Y', '^N', 'F1', 'F2', 'F3', '01',
  '!!', '??', '?E', '?N', '<=', 'R2', '24', 'CO', 'LI',
  '->', '^M', 'EX', 'WX', 'S7', '#A', '#L', 'SL',
]; // [1..24]

// PAS: RDMIX.PAS EditModeToFlags – Flgs[1..24], see EditModeFlagFields
export function EditModeToFlags(Mode: string, Flgs: boolean[], Err: boolean): void {
  let i = 1;
  let bad = false;
  while (i < Mode.length) {
    const s = UpCase(Mode[i - 1]) + UpCase(Mode[i]);
    i += 2;
    const j = FlgTxt.indexOf(s, 1);
    if (j < 1) {
      bad = true; // goto 2
      break;
    }
    Flgs[j] = true;
  }
  if (bad || i === Mode.length) {
    // 2:
    if (Err) Error(92);
  }
}
// PAS: RDMIX.PAS RdViewKey – '/key' after a file name, nil when no '/'
export function RdViewKey(): KeyDPtr {
  const a = AccessVars;
  if (a.Lexem !== '/') return null;
  RdLex();
  const cf = a.CFile!;
  let k = cf.Keys;
  found: {
    if ((a.Lexem as string) === '@') break found;
    TestIdentif();
    while (k !== null) {
      if (EquUpcase(k.Alias ?? '')) break found;
      k = k.Chain;
    }
    let s = a.LexWord;
    const i = Pos('_', s);
    if (i !== 0) s = Copy(s, i + 1, 255);
    s = ShortStr(cf.Name + '_' + s);
    k = cf.Keys;
    while (k !== null) {
      if (SEquUpcase(s, k.Alias ?? '')) break found;
      k = k.Chain;
    }
    const lv = ref<LocVarPtr>(null);
    if (a.IdxLocVarAllowed && FindLocVar(RdRunVars.LVBD.Root, lv) && lv.v!.FTyp === 'i') {
      if (lv.v!.FD !== cf) Error(164);
      k = lv.v!.RecPtr as XKey;
      break found;
    }
    Error(109);
  }
  // 1:
  if (cf.Typ !== 'X') Error(108);
  RdLex();
  return k;
}

let KeyArgFound = false;
let KeyArgFld: FieldDPtr = null;

// PAS: RDMIX.PAS SrchF
function SrchF(F: FieldDPtr): void {
  if (F === KeyArgFld) {
    KeyArgFound = true;
    return;
  }
  if ((F!.Flg & f_Stored) === 0) SrchZ(F!.Frml);
}
// PAS: RDMIX.PAS SrchZ
function SrchZ(Z: FrmlPtr): void {
  if (Z === null) return;
  const op = Z.Op;
  const o = ord(op);
  if (op === _field) SrchF(Z.Field);
  else if (op === _access) {
    if (Z.LD !== null) {
      let KF = Z.LD.Args;
      while (KF !== null) {
        SrchF(KF.FldD);
        KF = KF.Chain;
      }
    }
  } else if (op === _userfunc) {
    let fl = Z.FrmlL;
    while (fl !== null) {
      SrchZ(fl.Frml);
      fl = fl.Chain;
    }
  } else if (o >= 0x60 && o <= 0xaf) SrchZ(Z.P1); // 1-ary
  else if (o >= 0xb0 && o <= 0xef) {
    // 2-ary
    SrchZ(Z.P1);
    SrchZ(Z.P2);
  } else if (o >= 0xf0) {
    // 3-ary
    SrchZ(Z.P1);
    SrchZ(Z.P2);
    SrchZ(Z.P3);
  }
}
// PAS: RDMIX.PAS IsKeyArg – F is (or a computed field depends on) a key field of FD
export function IsKeyArg(F: FieldDPtr, FD: FileDPtr): boolean {
  KeyArgFound = false;
  let k = FD!.Keys;
  while (k !== null) {
    KeyArgFld = F;
    let kf = k.KFlds;
    while (kf !== null) {
      SrchF(kf.FldD);
      if (KeyArgFound) return true;
      kf = kf.Chain;
    }
    k = k.Chain;
  }
  return false;
}
// PAS: RDMIX.PAS RdKF
export function RdKF(FD: FileDPtr): KeyFldDPtr {
  const KF = new KeyFldD();
  if (AccessVars.Lexem === _gt) {
    RdLex();
    KF.Descend = true;
  }
  if (AccessVars.Lexem === '~') {
    RdLex();
    KF.CompLex = true;
  }
  const F = RdFldName(FD);
  KF.FldD = F;
  if (F!.Typ === 'T') OldError(84);
  if (KF.CompLex && F!.Typ !== 'A') OldError(94);
  return KF;
}
// PAS: RDMIX.PAS RdKFList – returns the key length in bytes
export function RdKFList(KFRoot: Ref<KeyFldDPtr>, FD: FileDPtr): number {
  for (;;) {
    ChainLast(KFRoot, RdKF(FD)!);
    if (AccessVars.Lexem !== ',') break;
    RdLex();
  }
  let n = 0;
  let KF = KFRoot.v; // looping over all fields, not only the last read
  while (KF !== null) {
    n += KF.FldD!.NBytes;
    KF = KF.Chain;
  }
  if (n > 255) OldError(126);
  return n;
}
// PAS: RDMIX.PAS CompileRecLen
export function CompileRecLen(): void {
  const cf = AccessVars.CFile!;
  let F = cf.FldD;
  let l = 0;
  let n = 0;
  if (cf.Typ === 'X' || cf.Typ === 'D') l = 1;
  while (F !== null) {
    switch (cf.Typ) {
      case '8':
        if (F.Typ === 'D') F.NBytes = 2;
        break;
      case 'D':
        switch (F.Typ) {
          case 'F': F.NBytes = F.L - 1; break;
          case 'D': F.NBytes = 8; break;
          case 'T': F.NBytes = 10; break;
        }
        break;
    }
    if ((F.Flg & f_Stored) !== 0) {
      F.Displ = l;
      l += F.NBytes;
      n++;
    }
    F = F.Chain;
  }
  cf.RecLen = l;
  switch (cf.Typ) {
    case '8': cf.FrstDispl = 4; break;
    case 'D': cf.FrstDispl = (n + 1) * 32 + 1; break;
    default: cf.FrstDispl = 6;
  }
}
