// PAS: OACCESS.PAS – opening/closing/creating data files (with their .T/.X companions),
// catalog (.CAT) access, CPath/CVol resolution, floppy volume mounting, duplicate (temp) files.
//
// Porting notes:
// * No interface variables, no unit initialization. Works on BaseVars.CPath/CDir/CName/CExt/CVol,
//   AccessVars.CFile/CRecPtr/CatFD/Chpt/CRdb/HelpFD/MountedVol, AccessVars.XWork/TWork,
//   BaseVars.FandWorkXName/FandWorkTName/TopRdbDir/TopDataDir/WrkDir/FandDir.
// * Private routines (implementation section): OpenXWorkH, OpenTWorkH, SaveFD, SetCPathMountVolSetNet,
//   ReopenForUpdate (FPC only), CreateF, TruncF, ActiveRdbOnDrive, CloseFilesOnDrive, SetContextDir,
//   GetCPathForCat, SetTempCExt, CopyDuplF (+ nested CopyH), SubstDuplF.TestDelErr.
// * asm/DOS-specific: none as asm. DOS-flavoured: TestMountVol/ReleaseDrive/CloseFilesOnDrive
//   (floppy volume labels via FindFirst(VolumeID), prompts 808/809/810/817/818, RunError 812/813);
//   on a host only CVol='' or a net volume ('#','##','#R' → IsNetCVol) is realistic, so these
//   return 0 early; keep the code path for completeness. OpenF1/CloseFile toggle the DOS read-only
//   attribute (GetFileAttr/SetFileAttr, masks $26/$27, bit 1) of Chpt/CatFD in test/install runs.
//   SubstDuplF uses RenameFile56 (rename with overwrite).
// * FPC vs BP7:
//   - SaveFiles: BP7 does GoExit when SaveCache fails, FPC just exits. BP7 wins (observable).
//   - OpenF2: FPC adds ReopenForUpdate (a file opened RdOnly/RdShared is reopened Shared before
//     WrPrefix). Needed here too, since node fs handles opened read-only can't be written.
//   - GetCatIRec: FPC also checks CatFD=nil (harmless, keep).
//   - RdCatField/WrCatField: FPC passes the CatPathName field through UnixPath; GetCPathForCat
//     tests an absolute path by DirectorySeparator (BP7: '\' prefixes the drive of the context dir);
//     SetTxtPathVol passes Path^ through UnixPath. Follow FPC (host paths) when reading.
//     Decision: WrCatField writes Txt verbatim (BP7) – the .CAT is shared with UFAND.EXE, so no
//     host-style path may be stored; RdCatField maps whatever DOS path is there on every read.
// * Tricky parts:
//   - OpenF1/OpenF2/SetCPathVol are goto-heavy (labels 1..4); rewrite as loops/local functions.
//   - OpenF1: .DBT missing → retry as .FPT (DbtFormat→FptFormat); missing .X → create empty and
//     SetNotValid; X file < 512 bytes → SetNotValid.
//   - OpenF2 data-damage dialogs: 883/885/886 (record length mismatch, OldToNewCat from EXPIMP
//     converts an old 106-byte catalog), 882 (fewer records than NRecs), 616 (encrypted RDB without
//     password), 830 (X invalid; suppressed by env FANDMSG830=NO) → ChangeLMode(ExclMode) + SetNotValid.
//   - CloseFile DELETES the data file, its .T and .X when not shared and NRecs=0 (except Typ 'D'),
//     and the .X when NotValid. Observable: empty files disappear after close.
//   - OpenDuplF: `move(OldFD^,FD^,sizeof(FileD)-1+length(Name))` = shallow copy of FileD (CopyRec),
//     then a copy of the TFile record; SubstDuplF copies TempFD over PrimFD keeping Chain/XF/UMode
//     (`move(...,sizeof(FileD)-2)`: AssignRec, then restore those fields). Temp names: ext digit 2
//     replaced by '1' (data) / '2' (text), in WrkDir for net files.
//   - TurnCat rotates catalog records Frst..Frst+N-1 by I positions (used by the catalog editor).
// * SetIsSQLFile is {$ifdef FandSQL}: not ported (FandSQL is off).

// * TS-only helpers: FExpand (DOS.FExpand on host paths), FindFirstName (the volume-label search
//   of TestMountVol: labels do not exist on a host, VolumeID always ends with DosError 18).

import * as nodePath from 'node:path';
import * as fs from 'node:fs';
import {
  ref, fref, Div, ValI, FSplit, GetEnv, CopyRec, AssignRec, ToUnicode, FromUnicode, DirectorySeparator, word,
  type NameStr, type Ref, type Pointer,
} from './pasrt.ts';
import type { FileUseMode, StringPtr, DirStr, VolStr } from './base.ts';
import {
  BaseVars, OpenH, CloseH, CloseClearH, FileSizeH, TruncH, DeleteFile, RenameFile56, SetFileAttr, GetFileAttr,
  SetUpdHandle, ClearCacheH, SeekH, ReadH, WriteH, SaveCache, CacheExist, FlushHandles, GoExit, GetStore,
  ReleaseStore, SEquUpcase, SetMsgPar, Set2MsgPar, Set3MsgPar, AddBackSlash, IsNetCVol, UnixPath, RdMsg, RdWrCache,
  _isoldfile, _isoverwritefile, _isoldnewfile, RdOnly, RdShared, Shared, Exclusive,
} from './base.ts';
import { DosView, DosFExpand, GetDirDos, HostToDos } from './handle.ts';
import type { LockMode, FileDPtr, FieldDPtr, RdbDPtr, FileD } from './access.ts';
import {
  AccessVars, NullMode, RdMode, CrMode, ExclMode, DbtFormat, FptFormat, XPageShft, FloppyDrives, XFile,
  CExtToT, CExtToX, CloseClearHCFile, TestCFileError, TestCPathError, CloseGoExit, ChangeLMode, NewLMode, OldLMode,
  RdPrefix, RdPrefixes, WrPrefix, WrPrefixes, XFNotValid, SeekRec, ReadRec, WriteRec, _ShortS, S_, GetRecSpace,
  ForAllFDs, IsActiveRdb, TestXFExist,
} from './access.ts';
import { RunError, WrLLF10Msg, PromptYN, CFileMsg } from './obaseww.ts';
import { DriversVars, _ESC_ } from './drivers.ts';
import { TrailChar } from './runfrml.ts';
import { HasPassword } from './wwmix.ts';
import { OldToNewCat } from './expimp.ts';
import { FandMaskMatch } from './fanddos.ts';

// TS-only: DOS.FExpand on a host path – absolute (relative to the current directory), '.' and '..'
// resolved, a trailing separator kept
function FExpand(Path: string): string {
  if (DosView.On) return DosFExpand(Path);
  const u = ToUnicode(Path);
  let r = nodePath.resolve(u);
  if ((u === '' || u.endsWith('/') || u.endsWith(nodePath.sep)) && !r.endsWith(nodePath.sep)) r += nodePath.sep;
  return FromUnicode(r);
}
// TS-only: CPath/CDir/CName/CExt := FSplit(CPath)
function FSplitCPath(): void {
  const d = ref(''), n = ref(''), e = ref('');
  FSplit(BaseVars.CPath, d, n, e);
  BaseVars.CDir = d.v;
  BaseVars.CName = n.v;
  BaseVars.CExt = e.v;
}
// TS-only: DOS.FindFirst(Path, Attr, S) for TestMountVol – DosError and the found name
function FindFirstName(Path: string, VolumeID: boolean): { DosError: number; Name: string } {
  if (VolumeID) return { DosError: 18, Name: '' }; // no volume labels on a host
  const hp = UnixPath(Path);
  let i = hp.length;
  while (i > 0 && hp[i - 1] !== '/' && hp[i - 1] !== '\\') i--;
  const dir = hp.slice(0, i);
  const mask = hp.slice(i);
  let names: string[];
  try {
    names = fs.readdirSync(dir === '' ? '.' : ToUnicode(dir));
  } catch {
    return { DosError: 3, Name: '' };
  }
  for (const n of names) {
    const b = FromUnicode(n);
    if (FandMaskMatch(b, mask)) return { DosError: 0, Name: b };
  }
  return { DosError: 18, Name: '' };
}

// PAS: OACCESS.PAS OpenXWorkH (private)
function OpenXWorkH(): void {
  const bv = BaseVars;
  const XWork = AccessVars.XWork;
  bv.CVol = '';
  let m = _isoldnewfile;
  if (XWork.MaxPage === 0) m = _isoverwritefile;
  bv.CPath = bv.FandWorkXName;
  XWork.Handle = OpenH(m, Exclusive);
  XWork.TestErr();
  if (FileSizeH(XWork.Handle) === 0) {
    XWork.FreeRoot = 0;
    XWork.MaxPage = 0;
  }
}
// PAS: OACCESS.PAS OpenTWorkH (private)
function OpenTWorkH(): void {
  const bv = BaseVars;
  const TWork = AccessVars.TWork;
  bv.CVol = '';
  if (TWork.MaxPage === 0) {
    bv.CPath = bv.FandWorkTName;
    TWork.IsWork = true;
    TWork.Create();
  } else {
    bv.CPath = bv.FandWorkTName;
    bv.CVol = '';
    TWork.Handle = OpenH(_isoldnewfile, Exclusive);
    TWork.TestErr();
  }
}
// PAS: OACCESS.PAS SaveFD (private)
function SaveFD(): void {
  WrPrefixes();
  const cf = AccessVars.CFile!;
  if (cf.Typ === 'X') cf.XF!.NoCreate = false;
}
// PAS: OACCESS.PAS SaveFiles – write prefixes of all open files and flush the cache
export function SaveFiles(): void {
  const av = AccessVars;
  if (!CacheExist()) return;
  const cf = av.CFile;
  av.CFile = av.CatFD;
  if (av.CatFD !== null) WrPrefixes(); // TS: Pascal dereferences a nil CatFD harmlessly
  ForAllFDs(SaveFD);
  const b = SaveCache(0);
  FlushHandles();
  av.CFile = cf;
  if (!b) GoExit(); // BP7 (FPC just exits)
}
// PAS: OACCESS.PAS ClosePassiveFD – close CFile if it is not locked (LMode=NullMode)
export function ClosePassiveFD(): void {
  const cf = AccessVars.CFile!;
  if (cf.Typ !== '0' && cf.LMode === NullMode) CloseFile();
}
// PAS: OACCESS.PAS CloseFANDFiles – close all files of the RDB chain, remembering ExLMode
export function CloseFANDFiles(FromDML: boolean): void {
  const av = AccessVars;
  let RD: RdbDPtr = av.CRdb;
  while (RD !== null) {
    av.CFile = RD.FD;
    while (av.CFile !== null) {
      if (!FromDML) av.CFile.ExLMode = av.CFile.LMode;
      CloseFile();
      av.CFile = av.CFile.Chain;
    }
    RD = RD.ChainBack;
  }
  if (av.CRdb !== null) {
    av.CFile = av.CatFD;
    CloseFile();
  }
  av.CFile = av.HelpFD;
  if (av.CFile !== null) CloseFile(); // TS: Pascal reads Handle of a nil HelpFD (garbage, <> $FF rarely)
  CloseH(av.TWork.Handle);
  CloseH(av.XWork.Handle);
}
// PAS: OACCESS.PAS OpenFANDFiles – reopen work files, help, catalog, RDBs and files with ExLMode
export function OpenFANDFiles(FromDML: boolean): void {
  const av = AccessVars;
  OpenXWorkH();
  OpenTWorkH();
  av.CFile = av.HelpFD;
  if (av.CFile !== null) OpenF(RdOnly); // TS: nil guard as in CloseFANDFiles
  if (av.CRdb === null) return;
  av.CFile = av.CatFD;
  OpenF(Exclusive);
  let RD: RdbDPtr = av.CRdb;
  while (RD !== null) {
    av.CFile = RD.FD;
    if (av.IsTestRun) OpenF(Exclusive);
    else OpenF(RdOnly);
    av.CFile = av.CFile!.Chain;
    while (!FromDML && av.CFile !== null) {
      if (av.CFile.ExLMode !== NullMode) {
        OpenF(Shared);
        NewLMode(av.CFile.ExLMode);
      }
      av.CFile = av.CFile.Chain;
    }
    RD = RD.ChainBack;
  }
}

// ===========================================================================

// PAS: OACCESS.PAS SetCPathMountVolSetNet (private)
function SetCPathMountVolSetNet(UM: FileUseMode): void {
  SetCPathVol();
  const cf = AccessVars.CFile!;
  cf.UMode = UM;
  cf.Drive = TestMountVol(BaseVars.CPath[0] ?? '\0');
  if (!IsNetCVol() || cf === AccessVars.Chpt) {
    switch (UM) {
      case RdShared:
        cf.UMode = RdOnly;
        break;
      case Shared:
        cf.UMode = Exclusive;
        break;
    }
  } else if (UM === Shared && SEquUpcase(BaseVars.CVol, '#R')) cf.UMode = RdShared;
}
// PAS: OACCESS.PAS OpenF1 – open the handles of CFile (+ .T, .X); false if the data file is missing
export function OpenF1(UM: FileUseMode): boolean {
  const bv = BaseVars;
  const av = AccessVars;
  const cf = av.CFile!;
  cf.LMode = NullMode;
  SetCPathMountVolSetNet(UM);
  const b = cf === av.Chpt || cf === av.CatFD;
  if (b && (av.IsTestRun || av.IsInstallRun) && (GetFileAttr() & 1) /* RdOnly */ !== 0) {
    SetFileAttr(GetFileAttr() & 0x26);
    if (bv.HandleError === 5) bv.HandleError = 79;
    TestCFileError();
    cf.WasRdOnly = true;
  }
  // 1:
  for (;;) {
    cf.Handle = OpenH(_isoldfile, cf.UMode);
    if (bv.HandleError !== 0 && cf.WasRdOnly) {
      SetFileAttr((GetFileAttr() & 0x27) | 0x1 /* RdOnly */);
      TestCFileError();
    }
    if (bv.HandleError === 5 && cf.UMode === Exclusive) {
      cf.UMode = RdOnly;
      continue;
    }
    break;
  }
  if (bv.HandleError === 2) return false;
  TestCFileError();
  // 4: (a .T/.X open error)
  const Err4 = (): void => {
    const n = bv.HandleError;
    CloseClearHCFile();
    bv.HandleError = n;
    TestCPathError();
  };
  const TF = cf.TF;
  if (TF !== null) {
    CExtToT();
    if (cf.WasRdOnly) SetFileAttr(GetFileAttr() & 0x26);
    // 2:
    for (;;) {
      TF.Handle = OpenH(_isoldfile, cf.UMode);
      if (bv.HandleError === 2) {
        if (TF.Format === DbtFormat) {
          TF.Format = FptFormat;
          bv.CExt = '.FPT';
          bv.CPath = bv.CDir + bv.CName + bv.CExt;
          continue;
        }
        if (cf.IsDynFile) {
          CloseClearH(fref(cf, 'Handle'));
          return false;
        }
      }
      break;
    }
    if (bv.HandleError !== 0) {
      Err4();
      return true;
    }
  }
  if (cf.Typ === 'X') {
    const XF = cf.XF!;
    CExtToX();
    // 3:
    for (;;) {
      XF.Handle = OpenH(_isoldfile, cf.UMode);
      if (bv.HandleError === 2) {
        XF.Handle = OpenH(_isoverwritefile, Exclusive);
        if ((bv.HandleError as number) !== 0) break; // goto 4
        XF.SetNotValid();
        CloseH(XF.Handle);
        continue;
      }
      break;
    }
    if (bv.HandleError !== 0) {
      Err4();
      return true;
    }
    if (FileSizeH(XF.Handle) < 512) XF.SetNotValid();
  }
  return true;
}
// PAS: OACCESS.PAS ReopenForUpdate (private, FPC) – a file opened RdOnly/RdShared is reopened Shared
function ReopenForUpdate(): boolean {
  const bv = BaseVars;
  const cf = AccessVars.CFile!;
  if (!(cf.UMode === RdOnly || cf.UMode === RdShared)) return true;
  const old = cf.UMode;
  CloseClearH(fref(cf, 'Handle'));
  cf.UMode = Shared;
  cf.Handle = OpenH(_isoldfile, cf.UMode);
  if (bv.HandleError !== 0) {
    const e = bv.HandleError;
    cf.UMode = old;
    cf.Handle = OpenH(_isoldfile, cf.UMode);
    bv.HandleError = e;
    return false;
  }
  return true;
}
// PAS: OACCESS.PAS OpenF2 – read and check the prefixes after OpenF1
export function OpenF2(): boolean {
  const bv = BaseVars;
  const av = AccessVars;
  const cf = av.CFile!;
  let FS = FileSizeH(cf.Handle);
  cf.NRecs = 0;
  let lab = 0; // the Pascal label to continue at (1, 2, 3; 0 = straight on)
  if (FS < cf.FrstDispl) lab = 1;
  else {
    const rLen = RdPrefix();
    const n = Div(FS - cf.FrstDispl, cf.RecLen);
    if (rLen !== 0xffff) {
      if (cf.IsDynFile) {
        CloseClearHCFile();
        return false;
      }
      const fs2 = ref(FS);
      const conv = OldToNewCat(fs2);
      FS = fs2.v;
      if (conv) lab = 3;
      else {
        CFileMsg(883, ' ');
        const l = cf.NRecs * rLen + cf.FrstDispl;
        if (l === FS || !PromptYN(885)) CloseGoExit();
        if (cf.NRecs === 0 || Math.floor(l / 2 ** bv.CachePageShft) !== Math.floor(FS / 2 ** bv.CachePageShft)) {
          WrLLF10Msg(886);
          cf.NRecs = n;
        }
        lab = 2;
      }
    } else if (n < cf.NRecs) {
      SetCPathVol();
      SetMsgPar(bv.CPath);
      if (PromptYN(882)) {
        cf.NRecs = n;
        lab = 1;
      } else CloseGoExit();
    }
  }
  if (lab === 1) {
    if (cf.IsShared() && cf.LMode < ExclMode) ChangeLMode(ExclMode, 0, false);
    cf.LMode = ExclMode;
    lab = 2;
  }
  if (lab === 2) {
    if (!ReopenForUpdate()) {
      TestCFileError();
      CloseGoExit();
    }
    SetUpdHandle(cf.Handle);
    WrPrefix();
  }
  // 3:
  if (cf.TF !== null) {
    if (FS < cf.FrstDispl) cf.TF.SetEmpty();
    else {
      cf.TF.RdPrefix(true);
      if (cf.Typ === '0' && !IsActiveRdb(cf) && !HasPassword(cf, 1, '')) {
        CFileMsg(616, ' ');
        CloseGoExit();
      }
    }
  }
  if (cf.Typ === 'X') {
    const XF = cf.XF!;
    if (FS < cf.FrstDispl) XF.SetNotValid();
    else {
      const sg = new Uint8Array(2);
      RdWrCache(true, XF.Handle, XF.NotCached(), 0, 2, sg);
      const Signum = sg[0] | (sg[1] << 8);
      XF.RdPrefix();
      if (
        (!XF.NotValid &&
          (Signum !== 0x04ff ||
            XF.NRecsAbs !== cf.NRecs ||
            XF.FreeRoot > XF.MaxPage ||
            (XF.MaxPage + 1) * 2 ** XPageShft > FileSizeH(XF.Handle))) ||
        (XF.NrKeys !== 0 && XF.NrKeys !== cf.GetNrKeys())
      ) {
        if (!SEquUpcase(GetEnv('FANDMSG830'), 'NO')) CFileMsg(830, 'X');
        if (cf.IsShared() && cf.LMode < ExclMode) ChangeLMode(ExclMode, 0, false);
        cf.LMode = ExclMode;
        XF.SetNotValid();
      }
    }
  }
  SeekRec(0);
  return true;
}
// PAS: OACCESS.PAS OpenF – OpenF1 + OpenF2 (no-op when already open)
export function OpenF(UM: FileUseMode): boolean {
  const cf = AccessVars.CFile!;
  if (cf.Handle !== 0xff) return true;
  if (OpenF1(UM)) {
    if (cf.IsShared()) {
      ChangeLMode(RdMode, 0, false);
      cf.LMode = RdMode;
    }
    const result = OpenF2();
    OldLMode(NullMode);
    return result;
  }
  return false;
}
// PAS: OACCESS.PAS CreateF (private)
function CreateF(): void {
  const cf = AccessVars.CFile!;
  SetCPathMountVolSetNet(Exclusive);
  cf.Handle = OpenH(_isoverwritefile, Exclusive);
  TestCFileError();
  cf.NRecs = 0;
  if (cf.TF !== null) {
    CExtToT();
    cf.TF.Create();
  }
  if (cf.Typ === 'X') {
    const XF = cf.XF!;
    CExtToX();
    XF.Handle = OpenH(_isoverwritefile, Exclusive);
    XF.TestErr();
    XF.SetEmpty(); // {SetNotValid}
  }
  SeekRec(0);
  SetUpdHandle(cf.Handle);
}
// PAS: OACCESS.PAS OpenCreateF – open CFile, creating it when missing
export function OpenCreateF(UM: FileUseMode): void {
  const cf = AccessVars.CFile!;
  if (!OpenF(UM)) {
    CreateF();
    if (UM === Shared || UM === RdShared) {
      WrPrefixes();
      SaveCache(0);
      CloseClearH(fref(cf, 'Handle'));
      if (cf.Typ === 'X') CloseClearH(fref(cf.XF!, 'Handle'));
      if (cf.TF !== null) CloseClearH(fref(cf.TF, 'Handle'));
      OpenF(UM);
    }
  }
}
// PAS: OACCESS.PAS RewriteF – prepare CFile for append (CrMode) or rewrite (ExclMode); returns the old lock mode
export function RewriteF(Append: boolean): LockMode {
  const cf = AccessVars.CFile!;
  if (Append) {
    const result = NewLMode(CrMode);
    SeekRec(cf.NRecs);
    if (cf.XF !== null) {
      cf.XF.FirstDupl = true;
      TestXFExist();
    }
    return result;
  }
  const result = NewLMode(ExclMode);
  cf.NRecs = 0;
  SeekRec(0);
  SetUpdHandle(cf.Handle);
  XFNotValid();
  if (cf.Typ === 'X') cf.XF!.NoCreate = true;
  if (cf.TF !== null) cf.TF.SetEmpty();
  return result;
}
// PAS: OACCESS.PAS TruncF (private)
function TruncF(): void {
  const bv = BaseVars;
  const cf = AccessVars.CFile!;
  if (cf.UMode === RdOnly) return;
  const md = NewLMode(RdMode);
  TruncH(cf.Handle, cf.UsedFileSize());
  if (bv.HandleError !== 0) CFileMsg(700 + bv.HandleError, '0');
  if (cf.TF !== null) {
    TruncH(cf.TF.Handle, cf.TF.UsedFileSize());
    cf.TF.TestErr();
  }
  if (cf.Typ === 'X') {
    const XF = cf.XF!;
    let sz = XF.UsedFileSize();
    if (XF.NotValid) sz = 0;
    TruncH(XF.Handle, sz);
    XF.TestErr();
  }
  OldLMode(md);
}
// PAS: OACCESS.PAS CloseFile – close CFile; deletes empty non-shared files
export function CloseFile(): void {
  const bv = BaseVars;
  const cf = AccessVars.CFile!;
  if (cf.Handle === 0xff) return;
  if (cf.IsShared()) OldLMode(NullMode);
  else WrPrefixes();
  SaveCache(0);
  TruncF();
  if (cf.Typ === 'X') {
    const XF = cf.XF!;
    if (XF.Handle !== 0xff) {
      CloseClearH(fref(XF, 'Handle'));
      if (!cf.IsShared()) {
        let del = false;
        if (XF.NotValid) del = true; // goto 1
        else if (XF.NRecs === 0 || cf.NRecs === 0) {
          cf.NRecs = 0;
          del = true;
        }
        if (del) {
          // 1:
          SetCPathVol();
          CExtToX();
          DeleteFile(bv.CPath);
        }
      }
    }
  }
  if (cf.TF !== null && cf.TF.Handle !== 0xff) {
    CloseClearH(fref(cf.TF, 'Handle'));
    if (!cf.IsShared() && cf.NRecs === 0 && cf.Typ !== 'D') {
      SetCPathVol();
      CExtToT();
      DeleteFile(bv.CPath);
    }
  }
  CloseClearH(fref(cf, 'Handle'));
  cf.LMode = NullMode;
  if (!cf.IsShared() && cf.NRecs === 0 && cf.Typ !== 'D') {
    SetCPathVol();
    DeleteFile(bv.CPath);
  }
  if (cf.WasRdOnly) {
    cf.WasRdOnly = false;
    SetCPathVol();
    SetFileAttr((GetFileAttr() & 0x27) | 0x1 /* RdOnly */);
    if (cf.TF !== null) {
      CExtToT();
      SetFileAttr((GetFileAttr() & 0x27) | 0x1 /* RdOnly */);
    }
  }
}
// PAS: OACCESS.PAS CloseFAfter – close FD and all files chained after it
export function CloseFAfter(FD: FileDPtr): void {
  const av = AccessVars;
  av.CFile = FD;
  while (av.CFile !== null) {
    CloseFile();
    av.CFile = av.CFile.Chain;
  }
}

// ===========================================================================

// PAS: OACCESS.PAS ActiveRdbOnDrive (private)
function ActiveRdbOnDrive(D: number): boolean {
  let R = AccessVars.CRdb;
  while (R !== null) {
    if (R.FD!.Drive === D) return true;
    R = R.ChainBack;
  }
  return false;
}
// PAS: OACCESS.PAS CloseFilesOnDrive (private)
function CloseFilesOnDrive(D: number): void {
  const av = AccessVars;
  let R = av.CRdb;
  const CF = av.CFile;
  while (R !== null) {
    av.CFile = R.FD;
    while (av.CFile !== null) {
      if (av.CFile.Drive === D) CloseFile();
      av.CFile = av.CFile.Chain;
    }
    R = R.ChainBack;
  }
  av.CFile = CF;
}
// PAS: OACCESS.PAS TestMountVol – ensure volume CVol is mounted in drive DriveC; returns the drive number (0 = none)
export function TestMountVol(DriveC: string): number {
  const bv = BaseVars;
  const MountedVol = AccessVars.MountedVol;
  if (IsNetCVol()) return 0;
  const up = (c: string): string => (c >= 'a' && c <= 'z' ? c.toUpperCase() : c);
  let D = word(up(DriveC || '\0').charCodeAt(0) - 0x40);
  if (D >= FloppyDrives) {
    if (up(bv.CDir[0] ?? '\0') === bv.Spec.CPMdrive) D = FloppyDrives;
    else return 0;
  }
  if (bv.CVol === '' || SEquUpcase(MountedVol[D], bv.CVol)) return D; // goto 3
  const Drive = DriveC;
  if (ActiveRdbOnDrive(D)) {
    Set3MsgPar(Drive, bv.CVol, MountedVol[D]);
    RunError(812);
  }
  const Vol: VolStr = bv.CVol;
  CloseFilesOnDrive(D);
  bv.CVol = Vol;
  // 1:
  for (;;) {
    bv.F10SpecKey = _ESC_;
    Set2MsgPar(Drive, bv.CVol);
    WrLLF10Msg(808);
    if (DriversVars.KbdChar === _ESC_) {
      if (PromptYN(21)) GoExit();
      else continue;
    }
    const S = D === FloppyDrives ? FindFirstName(Drive + ':\\*.VOL', false) : FindFirstName(Drive + ':\\*.*', true);
    if (S.DosError === 18) {
      // label missing
      WrLLF10Msg(809);
      continue;
    } else if (S.DosError !== 0) {
      WrLLF10Msg(810);
      continue;
    }
    let Name = S.Name;
    const i = Name.indexOf('.') + 1;
    if (D === FloppyDrives) {
      if (i > 0) Name = Name.slice(0, i - 1);
    } else if (i !== 0) Name = Name.slice(0, i - 1) + Name.slice(i);
    if (!SEquUpcase(Name, bv.CVol)) {
      SetMsgPar(Name);
      WrLLF10Msg(817);
      continue;
    }
    break;
  }
  // 2:
  MountedVol[D] = bv.CVol;
  // 3:
  return D;
}
// PAS: OACCESS.PAS ReleaseDrive
export function ReleaseDrive(D: number): void {
  const MountedVol = AccessVars.MountedVol;
  if (MountedVol[D] === '') return;
  const Drive = D === FloppyDrives ? BaseVars.Spec.CPMdrive : String.fromCharCode(D + 0x40);
  if (ActiveRdbOnDrive(D)) {
    SetMsgPar(Drive);
    RunError(813);
  }
  CloseFilesOnDrive(D);
  Set2MsgPar(MountedVol[D], Drive);
  WrLLF10Msg(818);
  MountedVol[D] = '';
}

// ===========================================================================

// PAS: OACCESS.PAS SetCPathForH – CPath := path of the file owning handle (for error messages)
export function SetCPathForH(handle: number): void {
  const av = AccessVars;
  const cf = av.CFile;
  let RD = av.CRdb;
  try {
    while (RD !== null) {
      av.CFile = RD.FD;
      while (av.CFile !== null) {
        const f: FileD = av.CFile;
        if (f.Handle === handle) {
          SetCPathVol();
          return; // goto 1
        }
        if (f.XF !== null && f.XF.Handle === handle) {
          SetCPathVol();
          CExtToX();
          return;
        }
        if (f.TF !== null && f.TF.Handle === handle) {
          SetCPathVol();
          CExtToT();
          return;
        }
        av.CFile = f.Chain;
      }
      RD = RD.ChainBack;
    }
    RdMsg(799);
    BaseVars.CPath = BaseVars.MsgLine;
  } finally {
    // 1:
    av.CFile = cf;
  }
}
// PAS: OACCESS.PAS GetCatIRec – catalog record of file Name in CRdb (and parents when MultiLevel); 0 = none
export function GetCatIRec(Name: NameStr, MultiLevel: boolean): number {
  const av = AccessVars;
  if (av.CatFD === null || av.CatFD.Handle === 0xff) return 0;
  if (av.CRdb === null) return 0;
  const CF = av.CFile;
  const CR = av.CRecPtr;
  av.CFile = av.CatFD;
  av.CRecPtr = GetRecSpace();
  let result = 0;
  let R: RdbDPtr = av.CRdb;
  // 1:
  search: for (;;) {
    for (let i = 1; i <= av.CatFD.NRecs; i++) {
      ReadRec(i);
      if (
        SEquUpcase(TrailChar(' ', _ShortS(av.CatRdbName)), R!.FD!.Name) &&
        SEquUpcase(TrailChar(' ', _ShortS(av.CatFileName)), Name)
      ) {
        result = i;
        break search; // goto 2
      }
    }
    R = R!.ChainBack;
    if (R !== null && MultiLevel) continue;
    break;
  }
  // 2:
  av.CFile = CF;
  ReleaseStore(av.CRecPtr);
  av.CRecPtr = CR;
  return result;
}
// PAS: OACCESS.PAS Generation – numeric generation from the catalog extension (.Xnn); 0 = none
export function Generation(): number {
  const cf = AccessVars.CFile!;
  if (cf.CatIRec === 0) return 0;
  RdCatPathVol(cf.CatIRec);
  const s = BaseVars.CExt.slice(2, 4);
  const i = ref(0), j = ref(0);
  ValI(s, i, j);
  if (j.v === 0) return word(i.v);
  return 0;
}
// PAS: OACCESS.PAS TurnCat – rotate catalog records Frst..Frst+N-1 by I
export function TurnCat(Frst: number, N: number, I: number): void {
  const av = AccessVars;
  if (av.CFile !== null) CloseFile();
  av.CFile = av.CatFD;
  const p = GetRecSpace();
  const q = GetRecSpace();
  av.CRecPtr = q;
  const last = Frst + N - 1;
  if (I > 0) {
    while (I > 0) {
      ReadRec(Frst);
      av.CRecPtr = p;
      for (let j = 1; j <= N - 1; j++) {
        ReadRec(Frst + j);
        WriteRec(Frst + j - 1);
      }
      av.CRecPtr = q;
      WriteRec(last);
      I--;
    }
  } else {
    while (I < 0) {
      ReadRec(last);
      av.CRecPtr = p;
      for (let j = 1; j <= N - 1; j++) {
        ReadRec(last - j);
        WriteRec(last - j + 1);
      }
      av.CRecPtr = q;
      WriteRec(Frst);
      I++;
    }
  }
  ReleaseStore(p);
}
// PAS: OACCESS.PAS RdCatField – trimmed value of catalog field CatF in record CatIRec
export function RdCatField(CatIRec: number, CatF: FieldDPtr): string {
  const av = AccessVars;
  const CF = av.CFile;
  const CR = av.CRecPtr;
  av.CFile = av.CatFD;
  av.CRecPtr = GetRecSpace();
  ReadRec(CatIRec);
  let result = TrailChar(' ', _ShortS(CatF));
  if (CatF === av.CatPathName) result = UnixPath(result); // FPC: DOS path -> host path
  ReleaseStore(av.CRecPtr);
  av.CFile = CF;
  av.CRecPtr = CR;
  return result;
}
// PAS: OACCESS.PAS WrCatField – BP7: Txt is stored verbatim (FPC: UnixPath(Txt) for CatPathName,
// which would put host paths into the catalog UFAND.EXE shares)
export function WrCatField(CatIRec: number, CatF: FieldDPtr, Txt: string): void {
  const av = AccessVars;
  const CF = av.CFile;
  const CR = av.CRecPtr;
  av.CFile = av.CatFD;
  av.CRecPtr = GetRecSpace();
  ReadRec(CatIRec);
  S_(CatF, Txt);
  WriteRec(CatIRec);
  ReleaseStore(av.CRecPtr);
  av.CFile = CF;
  av.CRecPtr = CR;
}
// PAS: OACCESS.PAS RdCatPathVol – CPath/CDir/CName/CExt/CVol from catalog record CatIRec
export function RdCatPathVol(CatIRec: number): void {
  const av = AccessVars;
  BaseVars.CPath = FExpand(RdCatField(CatIRec, av.CatPathName));
  FSplitCPath();
  BaseVars.CVol = RdCatField(CatIRec, av.CatVolume);
}
// PAS: OACCESS.PAS SetContextDir (private) – the RDB or data directory of CFile's RDB
function SetContextDir(D: Ref<DirStr>, IsRdb: Ref<boolean>): boolean {
  const CFile = AccessVars.CFile;
  let R = AccessVars.CRdb;
  IsRdb.v = false;
  while (R !== null) {
    let F = R.FD;
    if (CFile === F && CFile!.CatIRec !== 0) {
      D.v = R.RdbDir;
      IsRdb.v = true;
      return true;
    }
    while (F !== null) {
      if (CFile === F) {
        if (CFile === R.HelpFD || CFile.Typ === '0' /* .RDB */) D.v = R.RdbDir;
        else D.v = R.DataDir;
        return true;
      }
      F = F.Chain;
    }
    R = R.ChainBack;
  }
  return false;
}
// PAS: OACCESS.PAS GetCPathForCat (private)
function GetCPathForCat(I: number): void {
  const bv = BaseVars;
  const av = AccessVars;
  const d = ref(''), isRdb = ref(false);
  bv.CVol = RdCatField(I, av.CatVolume);
  bv.CPath = RdCatField(I, av.CatPathName);
  if (bv.CPath[1] !== ':' && SetContextDir(d, isRdb)) {
    if (isRdb.v) {
      FSplitCPath();
      AddBackSlash(d);
      bv.CDir = d.v;
      bv.CPath = bv.CDir + bv.CName + bv.CExt;
      return;
    }
    // FPC: an absolute host path stays (BP7: '\...' gets the drive of the context directory)
    if (DosView.On && bv.CPath[0] === '/') bv.CPath = HostToDos(bv.CPath); // stored by an older run
    else if (DosView.On && bv.CPath[0] === '\\') {
      if (d.v.length >= 2 && d.v[1] === ':') bv.CPath = d.v.slice(0, 2) + bv.CPath; // BP7
    } else if (bv.CPath[0] !== DirectorySeparator) {
      AddBackSlash(d);
      bv.CPath = d.v + bv.CPath;
    }
  } else bv.CPath = FExpand(bv.CPath);
  FSplitCPath();
}
// PAS: OACCESS.PAS SetCPathVol – CPath/CDir/CName/CExt/CVol of CFile
export function SetCPathVol(): void {
  const bv = BaseVars;
  const av = AccessVars;
  const cf = av.CFile!;
  const isRdb = ref(false);
  bv.CVol = '';
  let lab: number;
  if (cf.Typ === 'C') {
    bv.CDir = GetEnv('FANDCAT');
    if (bv.CDir === '') bv.CDir = av.TopDataDir === '' ? av.TopRdbDir : av.TopDataDir;
    const d = ref(bv.CDir);
    AddBackSlash(d);
    bv.CDir = d.v;
    bv.CName = av.CatFDName;
    bv.CExt = '.CAT';
    lab = 4;
  } else if (cf.CatIRec !== 0) {
    GetCPathForCat(cf.CatIRec);
    lab = cf.Name === '@' ? 3 : 4;
  } else {
    switch (cf.Typ) {
      case '0':
        bv.CExt = '.RDB';
        break;
      case '8':
        bv.CExt = '.DTA';
        break;
      case 'D':
        bv.CExt = '.DBF';
        break;
      default:
        bv.CExt = '.000';
    }
    const d = ref(bv.CDir);
    if (SetContextDir(d, isRdb)) {
      bv.CDir = d.v;
      lab = 2;
    } else if (cf === av.HelpFD) {
      bv.CDir = bv.FandDir;
      bv.CName = 'FANDHLP'; // FandRunV: 'UFANDHLP'
      lab = 4;
    } else {
      bv.CExt = '.100';
      bv.CDir = av.CRdb!.DataDir;
      lab = 2;
    }
  }
  if (lab === 2) {
    const d = ref(bv.CDir);
    AddBackSlash(d);
    bv.CDir = d.v;
    lab = 3;
  }
  if (lab === 3) bv.CName = cf.Name;
  // 4:
  bv.CPath = bv.CDir + bv.CName + bv.CExt;
}
// PAS: OACCESS.PAS SetTxtPathVol – CPath/CVol of a text file given by path or catalog record
export function SetTxtPathVol(Path: StringPtr, CatIRec: number): void {
  if (CatIRec !== 0) RdCatPathVol(CatIRec);
  else {
    BaseVars.CPath = FExpand(UnixPath(Path ?? '')); // FPC: UnixPath
    BaseVars.CVol = '';
  }
}

// ===========================================================================

// PAS: OACCESS.PAS SetTempCExt (private) – the temporary data ('.1..') / text ('.2..') extension
function SetTempCExt(Typ: string, IsNet: boolean): void {
  const bv = BaseVars;
  const cf = AccessVars.CFile!;
  let Nr: string;
  if (Typ === 'T') {
    Nr = '2';
    switch (cf.Typ) {
      case '0':
        bv.CExt = '.TTT';
        break;
      case 'D':
        bv.CExt = '.DBT';
        break;
    }
  } else {
    Nr = '1';
    switch (cf.Typ) {
      case '0':
        bv.CExt = '.RDB';
        break;
      case 'D':
        bv.CExt = '.DBF';
        break;
    }
  }
  if (bv.CExt.length < 2) bv.CExt = '.0';
  bv.CExt = bv.CExt[0] + Nr + bv.CExt.slice(2);
  if (IsNet) bv.CPath = bv.WrkDir + bv.CName + bv.CExt; // work files are local
  else bv.CPath = bv.CDir + bv.CName + bv.CExt;
}
// PAS: OACCESS.PAS OpenDuplF – create a temporary copy of CFile's descriptor with new empty files; CFile := the copy
export function OpenDuplF(CrTF: boolean): FileDPtr {
  const bv = BaseVars;
  const av = AccessVars;
  SetCPathVol();
  const net = IsNetCVol();
  const OldFD = av.CFile!;
  const FD = CopyRec(OldFD); // move(OldFD^,FD^,sizeof(FileD)-1+length(Name))
  FD.ChptPos = CopyRec(OldFD.ChptPos);
  av.CFile = FD;
  SetTempCExt('0', net);
  bv.CVol = '';
  FD.Handle = OpenH(_isoverwritefile, Exclusive);
  TestCFileError();
  FD.NRecs = 0;
  FD.IRec = 0;
  FD.EOF = true;
  FD.UMode = Exclusive;
  if (FD.Typ === 'X') {
    FD.XF = new XFile();
    FD.XF.Handle = 0xff;
    FD.XF.NoCreate = true;
    // else xfile name identical with orig file
  }
  if (CrTF && FD.TF !== null) {
    FD.TF = CopyRec(OldFD.TF!);
    const TF = FD.TF;
    SetTempCExt('T', net);
    TF.Handle = OpenH(_isoverwritefile, Exclusive);
    TF.TestErr();
    TF.CompileAll = true;
    TF.SetEmpty();
  }
  return FD;
}
// PAS: OACCESS.PAS CopyDuplF (private) – copy the temporary files back over CFile's (net volumes)
function CopyDuplF(TempFD: FileDPtr, DelTF: boolean): void {
  const av = AccessVars;
  const temp = TempFD!;
  // PAS: CopyDuplF.CopyH
  const CopyH = (h1: number, h2: number): void => {
    const BufSize = 32768;
    ClearCacheH(h1);
    ClearCacheH(h2);
    const p = GetStore(BufSize);
    let sz = FileSizeH(h1);
    SeekH(h1, 0);
    SeekH(h2, 0);
    while (sz > BufSize) {
      ReadH(h1, BufSize, p);
      WriteH(h2, BufSize, p);
      sz -= BufSize;
    }
    ReadH(h1, sz, p);
    WriteH(h2, sz, p);
    CloseH(h1);
    DeleteFile(BaseVars.CPath);
    ReleaseStore(p);
  };
  const cf = av.CFile!;
  av.CFile = temp;
  WrPrefixes();
  av.CFile = cf;
  SaveCache(0);
  SetTempCExt('0', true);
  CopyH(temp.Handle, cf.Handle);
  if (cf.TF !== null && DelTF) {
    const h1 = temp.TF!.Handle;
    const h2 = cf.TF.Handle;
    SetTempCExt('T', true);
    AssignRec(cf.TF, temp.TF!);
    cf.TF.Handle = h2;
    CopyH(h1, h2);
  }
  RdPrefixes();
}
// PAS: OACCESS.PAS SubstDuplF – replace CFile's files by those of TempFD (rename, or copy on net volumes)
export function SubstDuplF(TempFD: FileDPtr, DelTF: boolean): void {
  const bv = BaseVars;
  const av = AccessVars;
  // PAS: SubstDuplF.TestDelErr
  const TestDelErr = (P: string): void => {
    if (bv.HandleError !== 0) {
      SetMsgPar(P);
      RunError(827);
    }
  };
  XFNotValid();
  SetCPathVol();
  if (IsNetCVol()) {
    CopyDuplF(TempFD, DelTF);
    return;
  }
  SaveCache(0);
  const PrimFD = av.CFile!;
  const p = bv.CPath;
  CExtToT();
  const pt = bv.CPath;
  CloseClearH(fref(PrimFD, 'Handle'));
  DeleteFile(p);
  TestDelErr(p);
  const FD = PrimFD.Chain;
  const MD = PrimFD.TF;
  const xf2 = PrimFD.XF;
  const um = PrimFD.UMode;
  // move(TempFD^,PrimFD^,sizeof(FileD)-2): everything but Name
  const Name = PrimFD.Name;
  AssignRec(PrimFD, TempFD!);
  PrimFD.ChptPos = CopyRec(TempFD!.ChptPos);
  PrimFD.Name = Name;
  PrimFD.Chain = FD;
  PrimFD.XF = xf2;
  PrimFD.UMode = um;
  CloseClearH(fref(PrimFD, 'Handle'));
  SetTempCExt('0', false);
  const ptmp = bv.CPath;
  RenameFile56(ptmp, p, true);
  bv.CPath = p;
  PrimFD.Handle = OpenH(_isoldfile, PrimFD.UMode);
  SetUpdHandle(PrimFD.Handle);
  if (MD !== null && DelTF) {
    CloseClearH(fref(MD, 'Handle'));
    DeleteFile(pt);
    TestDelErr(pt);
    AssignRec(MD, PrimFD.TF!);
    PrimFD.TF = MD;
    CloseClearH(fref(MD, 'Handle'));
    bv.CPath = ptmp;
    SetTempCExt('T', false);
    RenameFile56(bv.CPath, pt, true);
    bv.CPath = pt;
    MD.Handle = OpenH(_isoldfile, PrimFD.UMode);
    SetUpdHandle(MD.Handle);
  }
  PrimFD.TF = MD;
}
// PAS: OACCESS.PAS DelDuplF
export function DelDuplF(TempFD: FileDPtr): void {
  CloseClearH(fref(TempFD!, 'Handle'));
  SetCPathVol();
  SetTempCExt('0', AccessVars.CFile!.IsShared());
  DeleteFile(BaseVars.CPath);
}
