// PAS: PROJMGR1.PAS – include of RUNPROJ: chapter-record helpers of the project manager (Ctrl+F10
// chapter list): IsCurrChpt, ExtToTyp, delete/write of chapter records (renaming data files when a
// 'F' chapter is renamed, net-file tests), help-record lookup, EditHelpOrCat, StoreChptTxt.
//
// Porting notes:
// * State: RunProjPriv in runproj.ts (CFileF, sz, nTb, Tb; EditHelpOrCat's typed constants
//   nCat/iCat/nHelp/iHelp). Routines not in the RUNPROJ interface are marked unit-internal.
// * FPC deviation: WrFDSegment is a no-op and RdFDSegment returns false - the BP7 version stores the
//   compiled file declaration (FileD + fields/keys/links, pointers relocated to segment offsets by
//   O/OCF/OTb/OFrml/OKF and back by GetFD/GetFC/GetLinkD/SgFrml/SgKF) in the chapter's OldTxt so that
//   the next start skips recompiling. We follow FPC (always recompile): the BP7 image is raw 16-bit
//   heap memory that has no TS counterpart. OldTxt is never written here, so a task edited by us and
//   reopened by UFAND.EXE still carries BP7's last segment (UFAND then compares against it).
// * StoreChptTxt: chapter texts are encrypted with the licence number (LicNr, Crypt/XDecode in
//   fand/coding.ts) when the RDB is encrypted; `Del` deletes the old T text.
// * ChptWriteCRec returns 0 O.K., 1 fail, 2 fail and undo; it compares old/new RdbRecVars (type,
//   name, ext, catalog record) and renames the data files (RenameWithOldExt) when a name changed.
// * ReleaseFDLDAfterChpt: FPC uses Chpt^.RecPtr when E=nil (editor not active).

import { ref, type Ref, type Pointer } from './pasrt.ts';
import {
  BaseVars, MarkBoth, ReleaseBoth, MarkStore, ReleaseStore, GetStore, SetMsgPar, SEquUpcase, DeleteFile,
  RenameFile56, SetUpdHandle, IsNetCVol, EqualsMask, WPushPixel, type LongStrPtr,
} from './base.ts';
import {
  AccessVars, FrmlElem, CExtToT, CExtToX, GetRecSpace, ReadRec, _ShortS, _T, T_, B_, CompArea, CodingLongStr,
  NewLMode, OldLMode, RdMode, _equ, _const, type FieldDPtr, type FileDPtr, type RdbDPtr, type LinkDPtr, type LockMode,
} from './access.ts';
import { DriversVars, ConvToNoDiakr, _AltF2_, _ESC_ } from './drivers.ts';
import { RdRunVars, SetCompileAll, type EditOptPtr } from './rdrun.ts';
import { CloseFAfter, GetCatIRec, RdCatPathVol, TestMountVol, WrCatField } from './oaccess.ts';
import { WrLLF10Msg, PromptYN } from './obaseww.ts';
import { IsIdentifStr, GetEditOpt, AllFldsList } from './compile.ts';
import { TrailChar } from './runfrml.ts';
import { PromptLL } from './wwmix.ts';
import { CRec, TestIsNewRec, WrEStatus, RdEStatus, EditDataFile } from './runedi.ts';
import { ResetCatalog } from './runproc.ts';
import { XEncode } from './expimp.ts';
import { RunProjPriv, RunProjE } from './runproj.ts';

// PAS: PROJMGR1.PAS RdbRecVars (implementation type) – the fields of a chapter record
export class RdbRecVars {
  Typ = ' ';
  Name = ''; // string12
  Ext = '';
  Txt = 0;
  OldTxt = 0;
  FTyp = ' ';
  CatIRec = 0;
  isSQL = false;
}

// PAS: PROJMGR1.PAS IsCurrChpt
export function IsCurrChpt(): boolean {
  return AccessVars.CRdb!.FD === AccessVars.CFile;
}
// PAS: PROJMGR1.PAS ExtToTyp
export function ExtToTyp(Ext: string): string {
  if (Ext === '' || SEquUpcase(Ext, '.HLP')) return '6';
  if (SEquUpcase(Ext, '.X')) return 'X';
  if (SEquUpcase(Ext, '.DTA')) return '8';
  if (SEquUpcase(Ext, '.DBF')) return 'D';
  if (SEquUpcase(Ext, '.RDB')) return '0';
  return '?';
}
// PAS: PROJMGR1.PAS ReleaseFDLDAfterChpt
export function ReleaseFDLDAfterChpt(): void {
  const av = AccessVars;
  const E = RunProjE();
  // FPC: guards against invalid pointers; only nil can occur here
  if (av.Chpt === null || av.CRdb === null) {
    RdRunVars.CompileFD = true;
    return;
  }
  const Chpt = av.Chpt;
  if (Chpt.Chain !== null) CloseFAfter(Chpt.Chain);
  Chpt.Chain = null;
  av.LinkDRoot = av.CRdb.OldLDRoot;
  av.FuncDRoot = av.CRdb.OldFCRoot;
  av.CFile = Chpt;
  if (E === null) av.CRecPtr = Chpt.RecPtr;
  else av.CRecPtr = E.NewRecPtr;
  const R: RdbDPtr = av.CRdb.ChainBack;
  if (R !== null) av.CRdb.HelpFD = R.HelpFD;
  else av.CRdb.HelpFD = null;
  RdRunVars.CompileFD = true;
}

// PAS: PROJMGR1.PAS NetFileTest – unit-internal
export function NetFileTest(X: RdbRecVars): boolean {
  if (X.Typ !== 'F' || X.CatIRec === 0 || X.isSQL) return false;
  RdCatPathVol(X.CatIRec);
  if (IsNetCVol()) return true;
  return false;
}
// PAS: PROJMGR1.PAS GetSplitChptName – unit-internal
export function GetSplitChptName(Name: Ref<string>, Ext: Ref<string>): void {
  Ext.v = '';
  Name.v = TrailChar(' ', _ShortS(AccessVars.ChptName)).slice(0, 12);
  const i = Name.v.indexOf('.') + 1;
  if (i === 0) return;
  Ext.v = Name.v.slice(i - 1);
  Name.v = Name.v.slice(0, i - 1);
}
// PAS: PROJMGR1.PAS GetRdbRecVars – unit-internal
export function GetRdbRecVars(RecPtr: Uint8Array | null, X: RdbRecVars): void {
  const av = AccessVars;
  const cr = av.CRecPtr;
  av.CRecPtr = RecPtr;
  const s1 = _ShortS(av.ChptTyp);
  X.Typ = s1.length > 0 ? s1[0] : '\0';
  const name = ref(''), ext = ref('');
  GetSplitChptName(name, ext);
  X.Name = name.v;
  X.Ext = ext.v;
  X.Txt = _T(av.ChptTxt);
  X.OldTxt = _T(av.ChptOldTxt);
  if (X.Typ === 'F') {
    X.FTyp = ExtToTyp(X.Ext);
    X.CatIRec = GetCatIRec(X.Name, false);
    X.isSQL = false;
    if (X.OldTxt !== 0) {
      const ld: LinkDPtr = av.LinkDRoot;
      const p = ref<Pointer>(null), p2 = ref<Pointer>(null);
      MarkBoth(p, p2);
      if (RdFDSegment(0, X.OldTxt)) {
        X.FTyp = av.CFile!.Typ;
        if (av.CFile!.IsSQLFile) X.Ext = '.SQL';
        else {
          switch (X.FTyp) {
            case '0':
              X.Ext = '.RDB';
              break;
            case 'D':
              X.Ext = '.DBF';
              break;
            case '8':
              X.Ext = '.DTA';
              break;
            default:
              X.Ext = '.000';
          }
        }
      }
      av.LinkDRoot = ld;
      av.CFile = av.Chpt;
      ReleaseBoth(p.v, p2.v);
    }
  }
  av.CRecPtr = cr;
}
// PAS: PROJMGR1.PAS ChptDelFor – unit-internal
export function ChptDelFor(X: RdbRecVars): boolean {
  const av = AccessVars;
  const bv = BaseVars;
  SetUpdHandle(av.ChptTF!.Handle);
  ReleaseFDLDAfterChpt();
  switch (X.Typ) {
    case ' ':
      return true;
    case 'D':
    case 'P':
      SetCompileAll();
      break;
    case 'F': {
      if (X.OldTxt === 0) return true; // don't delete if the record is new
      SetCompileAll();
      if (X.isSQL) return true;
      SetMsgPar(X.Name);
      if (!PromptYN(814) || (NetFileTest(X) && !PromptYN(836))) return false;
      if (X.CatIRec !== 0) {
        WrCatField(X.CatIRec, av.CatFileName, '');
        if (!PromptYN(815)) return true;
        RdCatPathVol(X.CatIRec);
        TestMountVol(bv.CPath[0] ?? '\0');
      } else {
        bv.CDir = '';
        bv.CName = X.Name;
        bv.CExt = X.Ext;
      }
      DeleteFile(bv.CDir + bv.CName + bv.CExt);
      CExtToT();
      DeleteFile(bv.CPath);
      if (X.FTyp === 'X') {
        CExtToX();
        DeleteFile(bv.CPath);
      }
      break;
    }
    default:
      av.ChptTF!.CompileProc = true;
  }
  return true;
}
// PAS: PROJMGR1.PAS ChptDel
export function ChptDel(): boolean {
  if (!IsCurrChpt()) return true;
  const New = new RdbRecVars();
  GetRdbRecVars(RunProjE()!.NewRecPtr, New);
  return ChptDelFor(New);
}
// PAS: PROJMGR1.PAS ChptWriteCRec – 0 O.K., 1 fail, 2 fail and undo
export function ChptWriteCRec(): number {
  const av = AccessVars;
  const bv = BaseVars;
  const E = RunProjE()!;
  const New = new RdbRecVars(), Old = new RdbRecVars();

  function RenameWithOldExt(): void {
    bv.CExt = Old.Ext;
    RenameFile56(Old.Name + bv.CExt, New.Name + bv.CExt, false);
    CExtToT();
    RenameFile56(Old.Name + bv.CExt, New.Name + bv.CExt, false);
    CExtToX();
    if (Old.FTyp === 'X') RenameFile56(Old.Name + bv.CExt, New.Name + bv.CExt, false);
  }
  function IsDuplFileName(name: string): boolean {
    if (SEquUpcase(name, av.Chpt!.Name)) return true;
    const cr = av.CRecPtr;
    av.CRecPtr = GetRecSpace();
    let result = false;
    const cRec = CRec();
    for (let I = 1; I <= av.Chpt!.NRecs; I++) {
      if (I !== cRec) {
        ReadRec(I);
        if (_ShortS(av.ChptTyp) === 'F') {
          const n = ref(''), e = ref('');
          GetSplitChptName(n, e);
          if (SEquUpcase(name, n.v)) {
            result = true;
            break;
          }
        }
      }
    }
    // 1:
    ReleaseStore(av.CRecPtr);
    av.CRecPtr = cr;
    return result;
  }

  let eq = 0;
  if (!IsCurrChpt()) return 0;
  if (!TestIsNewRec()) {
    eq = CompArea(av.CRecPtr!.subarray(2), E.OldRecPtr!.subarray(2), av.CFile!.RecLen - 2);
    if (eq === _equ.charCodeAt(0)) return 0;
  }
  GetRdbRecVars(E.NewRecPtr, New);
  if (!TestIsNewRec()) GetRdbRecVars(E.OldRecPtr, Old);
  // {$ifndef FandGraph}
  if (New.Typ === 'L') {
    WrLLF10Msg(659);
    return 1;
  }
  if (New.Typ === 'D' || New.Typ === 'U') {
    if (New.Name !== '') {
      WrLLF10Msg(623);
      return 1;
    }
  } else if (New.Typ !== ' ') {
    if (!IsIdentifStr(New.Name) || (New.Typ !== 'F' && New.Ext !== '')) {
      WrLLF10Msg(138);
      return 1;
    }
  }
  if (New.Typ === 'F') {
    if (New.Name.length > 8) {
      WrLLF10Msg(1002);
      return 1;
    }
    if (New.FTyp === '?') {
      WrLLF10Msg(1067);
      return 1;
    }
    if (IsDuplFileName(New.Name)) {
      WrLLF10Msg(1068);
      return 1;
    }
    if (New.FTyp === '0' && New.Txt !== 0) {
      WrLLF10Msg(1083);
      return 1;
    }
    if (NetFileTest(New) && !TestIsNewRec() && Old.Typ === 'F' && eq !== _equ.charCodeAt(0) && !PromptYN(824)) return 2;
  }
  const isDIU = (t: string): boolean => t === 'D' || t === 'I' || t === 'U';
  if (isDIU(New.Typ) || (!TestIsNewRec() && isDIU(Old.Typ))) {
    ReleaseFDLDAfterChpt();
    SetCompileAll();
  }
  // label 2 is the common tail below
  const tail = (): number => {
    B_(av.ChptVerif, true);
    SetUpdHandle(av.ChptTF!.Handle);
    return 0;
  };
  if (TestIsNewRec()) {
    ReleaseFDLDAfterChpt();
    return tail();
  }
  if (New.Typ !== Old.Typ) {
    // 1:
    if (!ChptDelFor(Old)) return 1;
    T_(av.ChptOldTxt, 0);
    if (New.Typ === 'F') ReleaseFDLDAfterChpt();
    return tail();
  }
  if (New.Typ === ' ' || New.Typ === 'I') return tail();
  if (New.Typ !== 'F') {
    if (New.Name !== Old.Name) {
      if (New.Typ === 'E' || New.Typ === 'P') {
        ReleaseFDLDAfterChpt();
        SetCompileAll();
      } else av.ChptTF!.CompileProc = true;
    }
    if (New.Typ === 'R' && New.Txt === 0) ReleaseFDLDAfterChpt();
    return tail();
  }
  ReleaseFDLDAfterChpt();
  SetCompileAll();
  if (New.OldTxt !== 0 && New.Name !== Old.Name) {
    if (Old.CatIRec !== 0) WrCatField(Old.CatIRec, av.CatFileName, New.Name);
    else if (!Old.isSQL) RenameWithOldExt();
  }
  return tail();
}

// ==========================================================================

// PAS: PROJMGR1.PAS WrFDSegment – unit-internal. FPC: empty (see the porting notes).
export function WrFDSegment(RecNr: number): void {}
// PAS: PROJMGR1.PAS RdFDSegment – FPC: always false (the BP7 segment image is not readable here).
export function RdFDSegment(FromI: number, Pos: number): boolean {
  void RunProjPriv; // BP7 work variables CFileF, sz, nTb, Tb are unused in the FPC branch
  return false;
}

// PAS: PROJMGR1.PAS FindHelpRecNr – unit-internal
export function FindHelpRecNr(FD: FileDPtr, txt: string): number {
  const av = AccessVars;
  const tb = Uint8Array.from(txt, (c) => c.charCodeAt(0));
  ConvToNoDiakr(tb, tb.length, BaseVars.Fonts.VFont);
  const cf = av.CFile, cr = av.CRecPtr;
  av.CFile = FD;
  av.CRecPtr = GetRecSpace();
  const md: LockMode = NewLMode(RdMode);
  let result = 0;
  if (av.CFile!.Handle !== 0xff) {
    const NmF = av.CFile!.FldD!;
    const TxtF = NmF.Chain;
    for (let i = 1; i <= av.CFile!.NRecs; i++) {
      ReadRec(i);
      const nm = TrailChar(' ', _ShortS(NmF)).slice(0, 80);
      const nb = Uint8Array.from(nm, (c) => c.charCodeAt(0));
      ConvToNoDiakr(nb, nb.length, BaseVars.Fonts.VFont);
      const nmConv = String.fromCharCode(...nb);
      if (EqualsMask(tb, tb.length, nmConv)) {
        while (i < av.CFile!.NRecs && _T(TxtF) === 0) {
          i++;
          ReadRec(i);
        }
        result = i;
        break;
      }
    }
  }
  // 2:
  OldLMode(md);
  ReleaseStore(av.CRecPtr);
  av.CFile = cf;
  av.CRecPtr = cr;
  return result;
}
// PAS: PROJMGR1.PAS PromptHelpName
export function PromptHelpName(N: Ref<number>): boolean {
  const txt = ref('');
  PromptLL(153, txt, 1, true);
  if (txt.v.length === 0 || DriversVars.KbdChar === _ESC_) return false;
  N.v = FindHelpRecNr(AccessVars.CFile, txt.v);
  return N.v !== 0;
}
// PAS: PROJMGR1.PAS EditHelpOrCat
export function EditHelpOrCat(cc: number, kind: number, txt: string): void {
  const av = AccessVars;
  const pv = RunProjPriv;
  let FD: FileDPtr;
  let i: number, n: number;
  if (cc === _AltF2_) {
    FD = av.CRdb!.HelpFD;
    if (kind === 1) FD = av.CFile!.ChptPos.R!.HelpFD;
    if (FD === null) return;
    if (kind === 0) {
      i = pv.iHelp;
      n = pv.nHelp;
    } else {
      i = 3;
      n = FindHelpRecNr(FD, txt);
      if (n === 0) DriversVars.KbdBuffer = '\x00\x3c' + txt;
    }
  } else {
    FD = av.CatFD;
    i = pv.iCat;
    n = pv.nCat;
  }
  if (kind !== 2) WrEStatus();
  const EO: EditOptPtr = GetEditOpt();
  EO!.Flds = AllFldsList(FD, false);
  EO!.WFlags = EO!.WFlags | WPushPixel;
  if (kind === 0 || n !== 0) {
    // typed constants iFrml/nFrml: (Op:_const; R:...) used as formulas
    const iFrml = new FrmlElem();
    iFrml.Op = _const;
    iFrml.R = i;
    const nFrml = new FrmlElem();
    nFrml.Op = _const;
    nFrml.R = n;
    EO!.StartRecNoZ = nFrml;
    EO!.StartIRecZ = iFrml;
  }
  EditDataFile(FD, EO);
  ReleaseStore(EO);
  if (cc === _AltF2_) {
    pv.nHelp = av.EdRecNo;
    pv.iHelp = av.EdIRec;
  } else {
    ResetCatalog();
    pv.nCat = av.EdRecNo;
    pv.iCat = av.EdIRec;
  }
  if (kind !== 2) RdEStatus();
}

// PAS: PROJMGR1.PAS StoreChptTxt
export function StoreChptTxt(F: FieldDPtr, S: LongStrPtr, Del: boolean): void {
  const av = AccessVars;
  const tf = av.ChptTF!;
  const LicNr = tf.LicenseNr;
  const oldpos = _T(F);
  const p = ref<Pointer>(null);
  MarkStore(p);
  if (av.CRdb!.Encrypted) {
    if (LicNr !== 0) {
      const s2 = ref<LongStrPtr>(GetStore(0x8100)); // possibly longer
      XEncode(S, s2);
      S = s2.v;
    } else S = CodingLongStr(S);
  }
  if (Del) {
    if (LicNr === 0) tf.Delete(oldpos);
    else if (oldpos !== 0) tf.Delete(oldpos - LicNr);
  }
  const pos = tf.Store(S);
  if (LicNr === 0) T_(F, pos);
  else T_(F, pos + LicNr);
  ReleaseStore(p.v);
}
