// PAS: RDFILDCL.PAS – compiles a file declaration chapter (F): fields, #C computed fields,
// #K keys and links, #A cumulations (AddD), #U user views, #D dependencies, #L checks, #I implicit
// values; JOURNALOF and LIKE variants; LocVar 'FILE' declarations ('$' ext = compiled at run time).
//
// Porting notes:
// * No interface variables. Private globals: HasTT (a 'T' field was read), issql (ext '.SQL',
//   SQL not built – only used to force Typ 'X'), RecompFD (FPC only: the FD being recompiled by
//   CallRdFDSegment, skipped by the duplicate key/link checks), OrigInpBuf (FPC OrigInp).
// * No asm. FPC vs BP7:
//   - CallRdFDSegment (JOURNALOF/LIKE base file): BP7 loads the compiled declaration from the
//     chapter's OldTxt with PROJMGR1.RdFDSegment; FPC recompiles the chapter's source text
//     (SaveCompState, SetInpTTPos, RdFileD with RecompFD set, RestoreCompState, then unchains the
//     FDs the nested compile appended). Follow FPC: we never read BP7 binary compiled chapters.
//   - OrigInp: BP7 walks the CompInpD chain starting at @PrevCompInp (the globals as a record);
//     FPC snapshots the globals into OrigInpBuf with SaveCompInp. Same result.
//   - LiOfs: Pascal stores the byte offset of the LiRoots block from the FileD; keep the LiRoots
//     object on the FileD instead (nil when compiled from a string: InpRdbPos.R=nil, or – BP7
//     PtrRec(R).Seg=0 – the ShowErr sentinel ptr(0,1)).
//   - Field sizes: 'R' and 'D' are 6 bytes (Real48) in both builds; 'T' 4 (longint position).
// * Tricky: RdFileD mutates global chains (FileDRoot via ChainLast, LinkDRoot, CFile) and returns a
//   heap mark (Pointer; our marks are null, PROJMGR ignores it in the FPC path). The 'A' mask field
//   syntax ('[..]', '(a|bb)') computes L from the mask. RdByteList builds a byte string from
//   '(n, a..b, ...)'. RdByteListInStore stores it right after the preceding heap block (ViewNames
//   StringListEl -> StringListEl.After; the _trust FrmlElem -> FrmlElem.Inline): in TS it returns
//   the byte string and the caller stores it there.
// * The field masks ('A' mask, 'D' format) that Pascal stores after the FieldDescr are
//   FieldDescr.Mask (FieldDMask).
// * RdUserView re-reads the #U section of CFile and its OrigFD chain from the chapter text, restoring
//   the EditOpt from a copy (move(EOD, EO^)) for every view tried: a copy with its own embedded
//   records (FormPos, W), see CopyEditOpt.
// * Private routines: RdChkDChain, TestUserView (+ TestDupl), RdFieldDList, RdFileD.RdKeyD
//   (+ CheckDuplAlias, LookForK, RdFileOrAlias1, RdFileOrAlias), SetLDIndexRoot, TestDepend,
//   RdImpl, RdKumul (+ RdRoleField, RdImper, RdAssign), SetHCatTyp, GetTFileD, GetXFileD,
//   CallRdFDSegment, OrigInp.

import {
  ref, fref, chr, Pos, Copy, ShortStr, BytesToStr, CopyRec, AssignRec, FSplit, type Ref, type Pointer, type ExtStr,
} from './pasrt.ts';
import { BaseVars, ChainLast, LastInChain, SEquUpcase, SetMsgPar, MaxW, StoreStr } from './base.ts';
import {
  AccessVars, FieldDescr, ChkD, FieldListEl, StringListEl, LinkD, KeyFldD, ImplD, AddD, LiRoots, CompInpD,
  FileD, TFile, XFile, XKey, ShowErrRdb, DbtFormat, MaxIndexLen, LeftJust, f_Stored, f_Encryp, f_Comma, f_Mask,
  ResetCompilePars, SaveCompInp, ReadRec, _T, _ShortS,
  _identifier, _quotedstr, _subrange, _assign, _addass, _le, _const,
  type FieldDPtr, type ChkDPtr, type FileDPtr, type FrmlPtr, type KeyDPtr, type KeyFldDPtr, type LinkDPtr,
  type ImplDPtr, type CompInpDPtr, type AddDPtr,
} from './access.ts';
import type { EditOpt, EditOptPtr } from './rdrun.ts';
import { GetCatIRec } from './oaccess.ts';
import { FieldInList, TrailChar } from './runfrml.ts';
import { RdViewOpt } from './rdproc.ts';
import { ExtToTyp } from './projmgr1.ts';
import {
  Error, OldError, SetInpStr, SetInpTTPos, SetInpTTxtPos, SkipBlank, RdLex, TestIdentif, TestLex, Accept,
  RdInteger, EquUpcase, IsKeyWord, AcceptKeyWord, RdStrConst,
} from './lexanal.ts';
import {
  RdChptName, RdHelpName, RdFldList, RdViewKey, IsKeyArg, RdKFList, CompileRecLen, GetEditOpt,
} from './rdmix.ts';
import { GetOp, FindFldName, RdFldName, RdFileName, FindLD, IsRoleName } from './rdfrml1.ts';
import { RdFrml, RdBool, RdStrFrml, RdRealFrml, TestReal } from './rdfrml.ts';
import { SaveCompState, RestoreCompState } from './compile.ts';

const EOFChar = '\x1a'; // ^Z

let HasTT = false;

const TabF = [0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 6, 7, 7, 8, 8]; // [0..18]

// PAS: RDFILDCL.PAS RdFldDescr – ':type,len...' after a field name
export function RdFldDescr(Name: string, Stored: boolean): FieldDPtr {
  const a = AccessVars;
  const F = new FieldDescr();
  F.Name = Name;
  let Flg = Stored ? f_Stored : 0;
  Accept(':');
  if (a.Lexem !== _identifier || a.LexWord.length > 1) Error(10);
  const Typ = a.LexWord[0];
  RdLex();
  let FrmlTyp = 'S';
  let M = 0;
  let L = 0;
  let NBytes = 0;
  if (Typ === 'N' || Typ === 'F') {
    Accept(',');
    L = RdInteger() & 0xffff;
  }
  let encr = false; // label 2
  switch (Typ) {
    case 'N':
      NBytes = (L + 1) >> 1;
      if (a.CurrChar === 'L') {
        RdLex();
        M = LeftJust;
      }
      break;
    case 'F':
      if ((a.Lexem as string) === ',') {
        Flg += f_Comma;
        RdLex();
      } else Accept('.');
      M = RdInteger() & 0xffff;
      if (M > 15 || L + M > 18) OldError(3);
      NBytes = TabF[L + M];
      if (M === 0) L++;
      else L += M + 2;
      FrmlTyp = 'R';
      break;
    case 'R':
      NBytes = 6;
      FrmlTyp = 'R';
      L = 17;
      M = 5;
      break;
    case 'A':
      Accept(',');
      if (!Stored || (a.Lexem as string) !== _quotedstr) {
        L = RdInteger() & 0xffff;
        if (L > 255) Error(3);
        if (a.CurrChar === 'R') RdLex();
        else M = LeftJust;
      } else {
        const S = RdStrConst()!;
        F.Mask = S; // stored right after the FieldDescr (FieldDMask)
        L = 0;
        let c = '?';
        let n = 0;
        let n1 = 0;
        for (let i = 0; i < S.length; i++) {
          switch (S[i]) {
            case '[':
              if (c === '?') c = '[';
              else Error(171);
              break;
            case ']':
              if (c === '[') c = '?';
              else Error(171);
              break;
            case '(':
              if (c === '?') {
                c = '(';
                n1 = 0;
                n = 0;
              } else Error(171);
              break;
            case ')':
              if (c === '(' && n1 > 0 && n > 0) {
                c = '?';
                L += MaxW(n1, n);
              } else Error(171);
              break;
            case '|':
              if (c === '(' && n1 > 0) {
                n = MaxW(n1, n);
                n1 = 0;
              } else Error(171);
              break;
            default:
              if (c === '(') n1++;
              else L++;
          }
        }
        Flg += f_Mask;
        M = LeftJust;
        if (c !== '?') Error(171); // 1:
      }
      NBytes = L;
      encr = true;
      break;
    case 'D': {
      let ss = '';
      if ((a.Lexem as string) === ',') {
        RdLex();
        ss = a.LexWord;
        Accept(_quotedstr);
      }
      if (ss.length === 0) ss = 'DD.MM.YY';
      const S = StoreStr(ss)!;
      F.Mask = S;
      FrmlTyp = 'R';
      NBytes = 6; // Real48 in both builds
      L = S.length;
      Flg += f_Mask;
      break;
    }
    case 'B':
      L = 1;
      NBytes = 1;
      FrmlTyp = 'B';
      break;
    case 'T':
      if ((a.Lexem as string) === ',') {
        RdLex();
        L = (RdInteger() + 2) & 0xffff;
      } else L = 1;
      NBytes = 4;
      HasTT = true;
      encr = true;
      break;
    default:
      OldError(10);
  }
  if (encr) {
    // 2:
    if (Stored && (a.Lexem as string) === '!') {
      RdLex();
      Flg += f_Encryp;
    }
  }
  if (NBytes === 0) OldError(113);
  if (L > BaseVars.TxtCols - 1 && Typ !== 'A') OldError(3);
  F.Typ = Typ;
  F.FrmlTyp = FrmlTyp;
  F.L = L;
  F.M = M;
  F.NBytes = NBytes;
  F.Flg = Flg;
  return F;
}

// PAS: RDFILDCL.PAS RdChkD – one #L check (Low = start position for the error text)
export function RdChkD(Low: number): ChkDPtr {
  const a = AccessVars;
  const C = new ChkD();
  C.Bool = RdBool();
  const Upper = a.OldErrPos;
  if (a.Lexem === '?') {
    RdLex();
    C.Warning = true;
  }
  if (a.Lexem === ':') {
    RdLex();
    C.TxtZ = RdStrFrml();
  } else {
    let N = (Upper - Low) & 0xffff;
    if (N > 81 /* SizeOf(ScreenStr) */) N = 80;
    const Z = GetOp(_const, N + 1)!;
    C.TxtZ = Z;
    Z.S = BytesToStr(a.InpArrPtr!, Low - 1, N);
  }
  if (a.Lexem === ',') {
    RdLex();
    C.HelpName = RdHelpName();
  }
  return C;
}
// PAS: RDFILDCL.PAS RdChkDChain
function RdChkDChain(CRoot: Ref<ChkDPtr>): void {
  const a = AccessVars;
  SkipBlank(false);
  let Low = a.CurrPos;
  RdLex();
  for (;;) {
    // 1:
    ChainLast(CRoot, RdChkD(Low)!);
    if (a.Lexem === ';') {
      SkipBlank(false);
      Low = a.CurrPos;
      RdLex();
      if (!((a.Lexem as string) === '#' || (a.Lexem as string) === EOFChar)) continue;
    }
    break;
  }
}
// PAS: RDFILDCL.PAS RdChkDsFromPos – the #L checks of FD (and its OrigFD) appended to C
export function RdChkDsFromPos(FD: FileDPtr, C: Ref<ChkDPtr>): void {
  const a = AccessVars;
  if (FD!.OrigFD !== null) RdChkDsFromPos(FD!.OrigFD, C);
  if (FD!.ChptPos.R === null) return;
  if (FD!.TxtPosUDLI === 0) return;
  ResetCompilePars();
  SetInpTTxtPos(FD);
  RdLex();
  while (!(a.ForwChar === 'L' || a.ForwChar === EOFChar)) {
    do RdLex();
    while (!(a.Lexem === EOFChar || a.Lexem === '#'));
  }
  if (a.Lexem === EOFChar) return;
  RdLex();
  const cf = a.CFile;
  a.CFile = FD;
  RdChkDChain(C);
  a.CFile = cf;
}

// PAS: RDFILDCL.PAS RdBegViewDcl – field list of a view ('(..)', '^(..)', 'all')
export function RdBegViewDcl(EO: EditOptPtr): void {
  const a = AccessVars;
  const eo = EO!;
  if (a.Lexem === _identifier || a.Lexem === '[') {
    RdChptName('E', eo.FormPos, true);
    return;
  }
  let neg = false;
  let all = false;
  const fl1 = ref<FieldListEl | null>(null);
  eo.UserSelFlds = false;
  if (a.Lexem === '^') {
    RdLex();
    neg = true;
  }
  Accept('(');
  if (a.Lexem === _identifier) RdFldList(fl1);
  else neg = true;
  for (;;) {
    // 1:
    if (a.Lexem === '!' && neg) {
      RdLex();
      all = true;
      continue;
    }
    if (a.Lexem === '?') {
      RdLex();
      eo.UserSelFlds = true;
      continue;
    }
    break;
  }
  Accept(')');
  if (!neg) {
    eo.Flds = fl1.v;
    return;
  }
  eo.Flds = null;
  let f = a.CFile!.FldD;
  while (f !== null) {
    if (((f.Flg & f_Stored) !== 0 || all) && !FieldInList(f, fl1.v)) {
      const fl = new FieldListEl();
      fl.FldD = f;
      ChainLast(fref(eo, 'Flds'), fl);
    }
    f = f.Chain;
  }
  if (eo.Flds === null) OldError(117);
}

// PAS: RDFILDCL.PAS RdByteList
export function RdByteList(s: Ref<string>): void {
  const a = AccessVars;
  Accept('(');
  let l = 0;
  let r = '';
  for (;;) {
    // 1:
    const i1 = RdInteger();
    let i2 = i1;
    if (i1 < 0) OldError(133);
    if (a.Lexem === _subrange) {
      RdLex();
      i2 = RdInteger();
      if (i2 < i1) OldError(133);
    }
    if (i2 > 255 || l + i2 - i1 >= 255) OldError(133);
    for (let i = i1; i <= i2; i++) {
      l++;
      r += chr(i);
    }
    if (a.Lexem === ',') {
      RdLex();
      continue;
    }
    break;
  }
  s.v = r;
  Accept(')');
}
// PAS: RDFILDCL.PAS RdByteListInStore – TS: returns the byte string Pascal stores after the previous block
export function RdByteListInStore(): string {
  const s = ref('');
  RdByteList(s);
  return StoreStr(s.v)!;
}

/** TS-only: `EOD := EO^` – a record copy with its own embedded records (FormPos, W). */
function CopyEditOpt(EO: EditOpt): EditOpt {
  const c = CopyRec(EO);
  c.FormPos = CopyRec(EO.FormPos);
  c.W = CopyRec(EO.W);
  return c;
}
// PAS: RDFILDCL.PAS RdUserView
export function RdUserView(ViewName: string, EO: EditOptPtr): boolean {
  const a = AccessVars;
  const eo = EO!;
  let found = false;
  let fd = a.CFile;
  const EOD = CopyEditOpt(eo);
  for (;;) {
    // 1:
    if (fd!.TxtPosUDLI !== 0) {
      ResetCompilePars();
      SetInpTTxtPos(fd);
      RdLex();
      if (a.Lexem === '#' && a.ForwChar === 'U') {
        RdLex(); // U
        RdLex(); // the view name
        for (;;) {
          // 2:
          AssignRec(eo, CopyEditOpt(EOD));
          if (EquUpcase(ViewName)) found = true;
          eo.ViewName = StoreStr(a.LexWord);
          RdLex(); // '('
          do RdLex();
          while (!((a.Lexem as string) === ')' || (a.Lexem as string) === EOFChar));
          RdLex();
          RdLex(); // '):'
          const K = RdViewKey();
          if (K !== null) {
            RdLex(); // ','
            eo.ViewKey = K;
          }
          RdBegViewDcl(eo);
          while ((a.Lexem as string) === ',') {
            const FVA = a.FileVarsAllowed;
            a.FileVarsAllowed = false;
            if (!RdViewOpt(eo)) Error(44);
            a.FileVarsAllowed = FVA;
          }
          if (!found && (a.Lexem as string) === ';') {
            RdLex();
            if (!(a.Lexem === '#' || a.Lexem === EOFChar)) continue;
          }
          break;
        }
      }
    }
    // 3:
    fd = fd!.OrigFD;
    if (fd !== null && !found) continue;
    break;
  }
  return found;
}

let issql = false;
let RecompFD: FileDPtr = null; // FPC

// PAS: RDFILDCL.PAS TestUserView.TestDupl
function TestDupl(FD: FileDPtr): void {
  let S = FD!.ViewNames;
  while (S !== null) {
    if (EquUpcase(S.S)) Error(26);
    S = S.Chain;
  }
}
// PAS: RDFILDCL.PAS TestUserView
function TestUserView(): void {
  const a = AccessVars;
  RdLex();
  for (;;) {
    // 1:
    TestIdentif();
    TestDupl(a.CFile);
    let FD = a.FileDRoot;
    while (FD !== null) {
      // FPC recompiles a LIKE/JOURNALOF base file from its text (CallRdFDSegment); its own view
      // names are then not duplicates. BP7 loads the stored segment and never gets here. The FPC
      // source skips RecompFD in the key and link checks but misses this one (error 26 on e.g.
      // MODUL01 CisDruhVz 'CISDRVZ:file.X [like CISDRUH;]').
      if (FD !== RecompFD) TestDupl(FD);
      FD = FD.Chain;
    }
    const S = new StringListEl();
    S.S = a.LexWord;
    ChainLast(fref(a.CFile!, 'ViewNames'), S);
    RdLex();
    S.After = RdByteListInStore();
    Accept(':');
    const EO = GetEditOpt()!;
    const K = RdViewKey();
    if (K !== null) {
      Accept(',');
      EO.ViewKey = K;
    }
    RdBegViewDcl(EO);
    while (a.Lexem === ',') if (!RdViewOpt(EO)) Error(44);
    if (a.Lexem === ';') {
      RdLex();
      if (!((a.Lexem as string) === '#' || (a.Lexem as string) === EOFChar)) continue;
    }
    break;
  }
}

// PAS: RDFILDCL.PAS RdFieldDList
function RdFieldDList(Stored: boolean): void {
  const a = AccessVars;
  for (;;) {
    // 1:
    TestIdentif();
    const Name = ShortStr(a.LexWord, 80);
    let F = FindFldName(a.CFile);
    if (F !== null) Error(26);
    RdLex();
    let Z: FrmlPtr = null;
    const FTyp = ref('\0');
    if (!Stored) {
      Accept(_assign);
      Z = RdFrml(FTyp);
    }
    F = RdFldDescr(Name, Stored)!;
    const cf = a.CFile!;
    if (cf.Typ === 'D' && Stored && (F.Typ === 'R' || F.Typ === 'N')) OldError(86);
    ChainLast(fref(cf, 'FldD'), F);
    if (Stored) {
      if (cf.Typ === '8') {
        if (F.Typ === 'R' || F.Typ === 'B' || F.Typ === 'T') OldError(35);
        else if (F.Typ === 'F' && F.NBytes > 5) OldError(36);
      }
    } else {
      F.Frml = Z;
      if (FTyp.v !== F.FrmlTyp) OldError(12);
    }
    if (a.Lexem === ';') {
      RdLex();
      if (!((a.Lexem as string) === '#' || (a.Lexem as string) === EOFChar)) continue;
    }
    break;
  }
}

// PAS: RDFILDCL.PAS RdFileD.RdKeyD.CheckDuplAlias.LookForK
function LookForK(Name: string, F: FileDPtr): void {
  if (SEquUpcase(F!.Name, Name)) Error(26);
  let K = F!.Keys;
  while (K !== null) {
    if (SEquUpcase(K.Alias ?? '', Name)) Error(26);
    K = K.Chain;
  }
}
// PAS: RDFILDCL.PAS RdFileD.RdKeyD.CheckDuplAlias
function CheckDuplAlias(Name: string): void {
  const a = AccessVars;
  if (a.CFile!.Typ !== 'X') Error(108);
  LookForK(Name, a.CFile);
  let F = a.FileDRoot;
  while (F !== null) {
    if (F !== RecompFD) LookForK(Name, F);
    F = F.Chain;
  }
}
// PAS: RDFILDCL.PAS RdFileD.RdKeyD.RdFileOrAlias1
function RdFileOrAlias1(F: FileDPtr): KeyDPtr {
  let k = F!.Keys;
  if (!EquUpcase(F!.Name)) {
    while (k !== null) {
      if (EquUpcase(k.Alias ?? '')) break;
      k = k.Chain;
    }
  }
  return k;
}
// PAS: RDFILDCL.PAS RdFileD.RdKeyD.RdFileOrAlias
function RdFileOrAlias(FD: Ref<FileDPtr>, KD: Ref<KeyDPtr>): void {
  const a = AccessVars;
  TestIdentif();
  let f = a.CFile;
  let k = RdFileOrAlias1(f);
  if (k === null) {
    let r = a.CRdb;
    search: while (r !== null) {
      f = r.FD;
      while (f !== null) {
        k = RdFileOrAlias1(f);
        if (k !== null) break search;
        f = f.Chain;
      }
      r = r.ChainBack;
    }
    if (k === null) Error(9);
  }
  // 1:
  if (k === null) Error(24);
  RdLex();
  FD.v = f;
  KD.v = k;
}
// PAS: RDFILDCL.PAS RdFileD.RdKeyD – label 1: a key of CFile (Name = alias)
function RdKeyDNewKey(Name: string): void {
  const a = AccessVars;
  const cf = a.CFile!;
  const K = new XKey();
  let N = 1;
  if (cf.Keys === null) cf.Keys = K;
  else {
    let K1 = cf.Keys;
    N = 2;
    while (K1.Chain !== null) {
      K1 = K1.Chain;
      N++;
    }
    K1.Chain = K;
  }
  K.Alias = StoreStr(Name);
  K.Intervaltest = false;
  K.Duplic = false;
  if (a.Lexem === _le) {
    K.Intervaltest = true;
    RdLex();
  } else if (a.Lexem === '*') {
    K.Duplic = true;
    RdLex();
  }
  K.IndexRoot = N;
  K.IndexLen = RdKFList(fref(K, 'KFlds'), cf);
  if (K.IndexLen > MaxIndexLen) OldError(105);
}
// PAS: RDFILDCL.PAS RdFileD.RdKeyD
function RdKeyD(): void {
  const a = AccessVars;
  RdLex();
  let label2 = true;
  if (a.Lexem === '@') {
    if (a.CFile!.Keys !== null || a.CFile!.IsParFile) Error(26);
    RdLex();
    if (a.Lexem === '@') {
      RdLex();
      a.CFile!.IsParFile = true;
    } else RdKeyDNewKey('');
    label2 = false; // goto 6
  }
  for (;;) {
    if (label2) {
      // 2:
      TestIdentif();
      const Name = ShortStr(a.LexWord, 80);
      SkipBlank(false);
      const FD = ref<FileDPtr>(null);
      const K = ref<KeyDPtr>(null);
      let isKey = false;
      if (a.ForwChar === '(') {
        RdLex();
        RdLex();
        if (a.Lexem === '@') {
          CheckDuplAlias(Name);
          RdLex();
          Accept(')');
          RdKeyDNewKey(Name); // goto 1
          isKey = true;
        } else {
          RdFileOrAlias(FD, K);
          Accept(')');
        }
      } else RdFileOrAlias(FD, K);
      if (!isKey) {
        let L = FindLD(Name);
        if (L !== null && L.FromFD !== RecompFD) OldError(26);
        L = new LinkD();
        L.Chain = a.LinkDRoot;
        a.LinkDRoot = L;
        L.RoleName = Name;
        L.FromFD = a.CFile;
        L.ToFD = FD.v;
        L.ToKey = K.v;
        if (a.Lexem === '!') {
          if (a.CFile!.Typ !== 'X') Error(108);
          if (K.v!.Duplic) Error(153);
          RdLex();
          L.MemberRef = 1;
          if (a.Lexem === '!') {
            RdLex();
            L.MemberRef = 2;
          }
        }
        let Arg: KeyFldD | null = null; // KeyFldDPtr(@L^.Args)
        let KF = K.v!.KFlds;
        for (;;) {
          // 3:
          const F = RdFldName(a.CFile)!;
          if (F.Typ === 'T') OldError(84);
          const nArg = new KeyFldD();
          if (Arg === null) L.Args = nArg;
          else Arg.Chain = nArg;
          Arg = nArg;
          Arg.FldD = F;
          Arg.CompLex = KF!.CompLex;
          Arg.Descend = KF!.Descend;
          const F2 = KF!.FldD!;
          if (F.Typ !== F2.Typ || (F.Typ !== 'D' && F.L !== F2.L) || (F.Typ === 'F' && F.M !== F2.M)) OldError(12);
          KF = KF!.Chain;
          if (KF !== null) {
            Accept(',');
            continue;
          }
          break;
        }
      }
    }
    // 6:
    label2 = true;
    if (a.Lexem === ';') {
      RdLex();
      if (!((a.Lexem as string) === '#' || (a.Lexem as string) === EOFChar)) continue;
    }
    break;
  }
}
// PAS: RDFILDCL.PAS RdFileD.SetLDIndexRoot – L is reset to LinkDRoot (as in Pascal)
function SetLDIndexRoot(L: LinkDPtr, L2: LinkDPtr): void {
  const a = AccessVars;
  const cf = a.CFile!;
  let cmptd = false;
  L = a.LinkDRoot;
  while (L !== L2) {
    // find key with equal beginning
    if (cf.Typ === 'X') {
      let K = cf.Keys;
      while (K !== null) {
        let KF: KeyFldDPtr = K.KFlds;
        let Arg = L!.Args;
        cmptd = false;
        let equal = true;
        while (Arg !== null) {
          if (KF === null || Arg.FldD !== KF.FldD || Arg.CompLex !== KF.CompLex || Arg.Descend !== KF.Descend) {
            equal = false; // goto 1
            break;
          }
          if ((Arg.FldD!.Flg & f_Stored) === 0) cmptd = true;
          Arg = Arg.Chain;
          KF = KF.Chain;
        }
        if (equal) {
          L!.IndexRoot = K.IndexRoot;
          break; // goto 2
        }
        // 1:
        K = K.Chain;
      }
    }
    // 2:
    if (L!.MemberRef !== 0 && (L!.IndexRoot === 0 || cmptd)) {
      SetMsgPar(L!.RoleName);
      OldError(152);
    }
    L = L!.Chain;
    cf.nLDs++;
  }
}
// PAS: RDFILDCL.PAS RdFileD.TestDepend
function TestDepend(): void {
  const a = AccessVars;
  const FTyp = ref('\0');
  RdLex();
  let withBool = true;
  for (;;) {
    if (withBool) {
      // 1:
      Accept('(');
      RdBool();
      Accept(')');
    }
    // 2:
    const F = RdFldName(a.CFile)!;
    if ((F.Flg & f_Stored) === 0) OldError(14);
    Accept(_assign);
    RdFrml(FTyp);
    if (F.FrmlTyp !== FTyp.v) Error(12);
    if (a.Lexem === ';') {
      RdLex();
      if (!((a.Lexem as string) === '#' || (a.Lexem as string) === EOFChar)) {
        withBool = (a.Lexem as string) === '(';
        continue;
      }
    }
    break;
  }
}
// PAS: RDFILDCL.PAS RdFileD.RdImpl
function RdImpl(IDRoot: Ref<ImplDPtr>): void {
  const a = AccessVars;
  const FTyp = ref('\0');
  RdLex();
  for (;;) {
    // 1:
    const F = RdFldName(a.CFile)!;
    if ((F.Flg & f_Stored) === 0) OldError(14);
    Accept(_assign);
    const Z = RdFrml(FTyp);
    if (FTyp.v !== F.FrmlTyp) OldError(12);
    const ID = new ImplD();
    ID.FldD = F;
    ID.Frml = Z;
    ChainLast(IDRoot, ID);
    if (a.Lexem === ';') {
      RdLex();
      if (!((a.Lexem as string) === '#' || (a.Lexem as string) === EOFChar)) continue;
    }
    break;
  }
}
// PAS: RDFILDCL.PAS RdFileD.RdKumul.RdRoleField
function RdRoleField(AD: AddD): void {
  if (!IsRoleName(true, fref(AD, 'File2'), fref(AD, 'LD'))) Error(9);
  Accept('.');
  const F = RdFldName(AD.File2)!;
  AD.Field = F;
  if ((F.Flg & f_Stored) === 0) OldError(14);
  if (IsKeyArg(F, AD.File2)) OldError(135);
}
// PAS: RDFILDCL.PAS RdFileD.RdKumul.RdImper
function RdImper(AD: AddD): void {
  const a = AccessVars;
  if (a.Lexem === '!') {
    RdLex();
    AD.Create = 1;
    if (AD.LD !== null) {
      let KF = AD.LD.ToKey!.KFlds;
      while (KF !== null) {
        if ((KF.FldD!.Flg & f_Stored) === 0) OldError(148);
        KF = KF.Chain;
      }
    }
    if (a.Lexem === '!') {
      RdLex();
      AD.Create = 2;
    }
  }
}
// PAS: RDFILDCL.PAS RdFileD.RdKumul.RdAssign
function RdAssign(AD: AddD): void {
  const FTyp = ref('\0');
  Accept(_assign);
  AD.Assign = true;
  AD.Frml = RdFrml(FTyp);
  if (FTyp.v !== AD.Field!.FrmlTyp) OldError(12);
}
// PAS: RDFILDCL.PAS RdFileD.RdKumul
function RdKumul(): void {
  const a = AccessVars;
  RdLex();
  let AD: AddDPtr = null; // AddDPtr(@CFile^.Add)
  for (;;) {
    // 1:
    const nAD = new AddD();
    if (AD === null) a.CFile!.Add = nAD;
    else AD.Chain = nAD;
    AD = nAD;
    if (IsKeyWord('IF')) {
      AD.Bool = RdBool();
      AcceptKeyWord('THEN');
      RdRoleField(AD);
      RdImper(AD);
      RdAssign(AD);
    } else {
      RdRoleField(AD);
      if (a.Lexem === '(') {
        const Low = a.CurrPos;
        RdLex();
        const CF = a.CFile;
        a.CFile = AD.File2;
        AD.Chk = RdChkD(Low);
        a.CFile = CF;
        Accept(')');
      }
      RdImper(AD);
      if (AD.Chk === null && a.Lexem === _assign) RdAssign(AD);
      else {
        Accept(_addass);
        AD.Assign = false;
        TestReal(AD.Field!.FrmlTyp);
        AD.Frml = RdRealFrml();
      }
    }
    if (a.Lexem === ';') {
      RdLex();
      if (!((a.Lexem as string) === '#' || (a.Lexem as string) === EOFChar)) continue;
    }
    break;
  }
}
// PAS: RDFILDCL.PAS RdFileD.CallRdFDSegment (FPC: recompile the chapter text)
function CallRdFDSegment(FD: FileDPtr): void {
  const a = AccessVars;
  if (a.Lexem !== EOFChar) Accept(';');
  const rdb = a.CRdb;
  const cr = a.CRecPtr;
  const r = FD!.ChptPos.R;
  if (r === null || FD!.IsDynFile) OldError(106);
  a.CRdb = r;
  const i = FD!.ChptPos.IRec;
  a.CFile = a.CRdb!.FD;
  a.CRecPtr = a.CFile!.RecPtr;
  ReadRec(i);
  const pos = _T(a.ChptTxt);
  if (pos <= 0) Error(25);
  const onm = ShortStr(TrailChar(' ', _ShortS(a.ChptName)), 12);
  const prev = LastInChain(fref(a, 'FileDRoot'));
  const st = SaveCompState();
  SetInpTTPos(pos, r!.Encrypted);
  const dir = ref(''), nm = ref(''), ext = ref('');
  FSplit(onm, dir, nm, ext);
  const rf = RecompFD;
  RecompFD = FD;
  RdFileD(nm.v, ExtToTyp(ext.v), ext.v);
  RecompFD = rf;
  let cf = a.CFile;
  RestoreCompState(st);
  a.CFile = cf;
  if (prev !== null) prev.Chain = null;
  a.CFile!.Chain = null;
  const b = true;
  cf = a.CFile;
  a.CRdb = rdb;
  if (a.InpRdbPos.IRec !== 0) {
    a.CFile = rdb!.FD;
    ReadRec(a.InpRdbPos.IRec);
    a.CFile = cf;
  }
  a.CRecPtr = cr;
  if (!b) Error(25);
  a.CFile!.OrigFD = FD;
  a.CFile!.TxtPosUDLI = 0;
}

let origInpBuf: CompInpD | null = null;
// PAS: RDFILDCL.PAS OrigInp (FPC)
function OrigInp(): CompInpDPtr {
  const a = AccessVars;
  if (a.PrevCompInp !== null) {
    let i = a.PrevCompInp;
    while (i.ChainBack !== null) i = i.ChainBack;
    return i;
  }
  origInpBuf ??= new CompInpD();
  SaveCompInp(origInpBuf);
  return origInpBuf;
}

const JournalFlds = "Upd:A,1;RecNr:F,8.0;User:F,4.0;TimeStamp:D,'DD.MM.YYYY hh:mm:ss'";

// PAS: RDFILDCL.PAS RdFileD – FDTyp '6','X','8','D','C'(catalog),'0'; Ext '$' = run-time FILE var
export function RdFileD(FileName: string, FDTyp: string, Ext: ExtStr): Pointer {
  const a = AccessVars;
  const p: Pointer = null; // MarkStore(p)

  // PAS: RDFILDCL.PAS RdFileD.SetHCatTyp
  const SetHCatTyp = (): void => {
    const cf = a.CFile!;
    cf.Handle = 0xff;
    cf.Typ = FDTyp;
    cf.CatIRec = GetCatIRec(cf.Name, cf.Typ === '0' /* multilevel */);
  };
  // PAS: RDFILDCL.PAS RdFileD.GetTFileD
  const GetTFileD = (): void => {
    const cf = a.CFile!;
    if (!HasTT && cf.TF === null) return;
    if (cf.TF === null) cf.TF = new TFile();
    cf.TF.Handle = 0xff;
    if (FDTyp === 'D') cf.TF.Format = DbtFormat;
  };
  // PAS: RDFILDCL.PAS RdFileD.GetXFileD
  const GetXFileD = (): void => {
    const cf = a.CFile!;
    if (cf.Typ !== 'X') {
      if (cf.XF !== null) OldError(104);
    } else {
      if (cf.XF === null) cf.XF = new XFile();
      cf.XF.Handle = 0xff;
    }
  };

  ResetCompilePars();
  RdLex();
  issql = SEquUpcase(Ext, '.SQL');
  const isHlp = SEquUpcase(Ext, '.HLP');
  if (IsKeyWord('JOURNALOF')) {
    const FD = RdFileName();
    if (a.Lexem === ';') RdLex();
    SetMsgPar(FileName);
    if (FDTyp !== '6') OldError(103);
    if (a.Lexem !== EOFChar) Error(40);
    const LDOld = a.LinkDRoot;
    CallRdFDSegment(FD);
    a.LinkDRoot = LDOld;
    let F = a.CFile!.FldD;
    AssignRec(a.CFile!, new FileD()); // fillchar(CFile^,sizeof(FileD),0)
    a.CFile!.Name = FileName;
    a.CFile!.IsJournal = true;
    SetHCatTyp();
    a.CFile!.ChptPos = CopyRec(OrigInp()!.InpRdbPos);
    SetInpStr(ref(JournalFlds));
    RdLex();
    RdFieldDList(true);
    let F2 = LastInChain(fref(a.CFile!, 'FldD'));
    while (F !== null) {
      const next = F.Chain;
      if ((F.Flg & f_Stored) !== 0) {
        F2.Chain = F;
        F2 = F;
        if (F.Typ === 'T') {
          F.FrmlTyp = 'R';
          F.Typ = 'F';
          F.L = 10;
          F.Flg = F.Flg & ~f_Encryp;
        }
      }
      F = next;
    }
    F2.Chain = null;
    CompileRecLen();
    ChainLast(fref(a, 'FileDRoot'), a.CFile!);
    return p; // MarkStore(p); goto 1
  }
  if (IsKeyWord('LIKE')) {
    let Prefix = ShortStr(FileName, 32);
    const FD = RdFileName();
    if (a.Lexem === '(') {
      RdLex();
      TestIdentif();
      Prefix = ShortStr(a.LexWord, 32);
      RdLex();
      Accept(')');
    }
    CallRdFDSegment(FD);
    a.CFile!.IsHlpFile = false;
    if (!(FDTyp === '6' || FDTyp === 'X') || !(a.CFile!.Typ === '6' || a.CFile!.Typ === 'X')) OldError(106);
    let K = a.CFile!.Keys;
    while (K !== null) {
      if ((K.Alias ?? '') !== '') {
        let s = ShortStr(K.Alias!, 32);
        const i = Pos('_', s);
        if (i !== 0) s = Copy(s, i + 1, 255);
        s = ShortStr(Prefix + '_' + s, 32);
        K.Alias = StoreStr(s);
      }
      K = K.Chain;
    }
  } else {
    a.CFile = new FileD(); // AlignLongStr; GetStore(2); GetZStore(sizeof(FileD))
  }
  const cf = a.CFile!;
  cf.Name = FileName;
  SetHCatTyp();
  HasTT = false;
  if (cf.OrigFD === null || !(a.Lexem === EOFChar || a.Lexem === '#' || a.Lexem === ']')) RdFieldDList(true);
  GetTFileD();
  const LDOld = a.LinkDRoot;
  cf.ChptPos = CopyRec(OrigInp()!.InpRdbPos);
  if (isHlp) {
    const F = cf.FldD;
    const F2 = F?.Chain ?? null;
    if (F === null || F.Typ !== 'A' || F2 === null || F2.Typ !== 'T' || F2.Chain !== null) OldError(128);
    cf.IsHlpFile = true;
  }
  for (;;) {
    // 2:
    if (a.Lexem === '#' && a.ForwChar === 'C') {
      RdLex();
      RdLex();
      RdFieldDList(false);
      continue;
    }
    if (a.Lexem === '#' && a.ForwChar === 'K') {
      RdLex();
      RdKeyD();
      continue;
    }
    break;
  }
  if (issql && cf.Keys !== null) cf.Typ = 'X';
  GetXFileD();
  CompileRecLen();
  SetLDIndexRoot(a.LinkDRoot, LDOld);
  if (cf.Typ === 'X' && cf.Keys === null) Error(107);
  if (a.Lexem === '#' && a.ForwChar === 'A') {
    RdLex();
    RdKumul();
  }
  ChainLast(fref(a, 'FileDRoot'), cf);
  if (Ext === '$' /* compile from text at run time */) {
    cf.IsDynFile = true;
    cf.ChptPos.R = a.CRdb;
    return p; // MarkStore(p); goto 1
  }
  if (a.Lexem !== EOFChar) cf.TxtPosUDLI = (OrigInp()!.CurrPos - 1) & 0xffff;
  if (a.Lexem === '#' && a.ForwChar === 'U') {
    RdLex();
    TestUserView();
  }
  const li = new LiRoots();
  cf.LiOfs = li;
  if (a.Lexem === '#' && a.ForwChar === 'D') {
    RdLex();
    TestDepend();
  }
  if (a.Lexem === '#' && a.ForwChar === 'L') {
    RdLex();
    RdChkDChain(fref(li, 'Chks'));
  }
  if (a.Lexem === '#' && a.ForwChar === 'I') {
    RdLex();
    RdImpl(fref(li, 'Impls'));
  }
  if (a.InpRdbPos.R === null || a.InpRdbPos.R === ShowErrRdb /* compiled from string */) {
    cf.LiOfs = null;
  }
  if (a.Lexem !== EOFChar) Error(66);
  return p;
}
