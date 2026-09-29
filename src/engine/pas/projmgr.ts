// PAS: PROJMGR.PAS – include of RUNPROJ: opening/closing a task (CreateOpenChpt/CloseChpt), the
// compiler driver over all chapters (CompileRdb, CompRunChptRec), user identification (RdUserId),
// jumping to compile errors (GotoErrPos), EditExecRdb (run or edit a task) and InstallRdb.
//
// Porting notes:
// * State: RunProjPriv in runproj.ts (typed constant UserW). Routines not in the RUNPROJ interface
//   are marked unit-internal.
// * CreateOpenChpt: builds the RdbD chain (CRdb), opens <name>.RDB as Chpt (TopRdbDir, FANDDATA
//   data dir via SetRdbDir with DirectorySeparator), ResetRdOnly; BP7 compares ChptTF^.TimeStmp of
//   a reopened chapter file (FPC: `false`) - TimeStmp is Real48 (PORTING.md 1). We follow BP7 here:
//   the comparison only matters for nested tasks whose .RDB is older than the calling one.
// * CompileRdb: per chapter record by type ('F' RdFileD, 'E' RdEdit, 'R' ReadReport, 'P' RdProc,
//   'L' ReadProlog, 'D' dbf declaration via MakeDbfDcl, ...); MergeOldNew/MergAndReplace convert
//   a data file when its declaration changed (EquStoredF/EquKeys). Heap diagnostics
//   (Diagnostics, MaxHp) are FPC no-ops. Uses CompileMsgOn/Off (screen buffer save in Buf[1..40]).
//   FPC branch: RdFDSegment is always false (projmgr1.ts), so every 'F' chapter is compiled from
//   its text and MergeOldNew never merges; the old declaration text (OldTxt) is not deleted.
// * EditExecRdb: the project-manager loop (edit chapters with the data editor on Chpt, F9 compile,
//   Ctrl+F9 run 'main' or ProcNm, passwords via WWMIX.PassWord/HasPassword); FPC variant differs in
//   heap handling only. NewExit patterns: PORTING.md 11. The goto labels of the editor loop are a
//   state machine (`lbl`).
// * InstallRdb: menu (TMenuBoxS) for user texts/catalog; FPC uses MarkStore/Dispose (no-ops here).
// * ChDir/MkDir/RmDir ({$I-} + IOResult) are the TS-only helpers of runproj.ts.

import { resolve as nodePathResolve } from 'node:path';
import {
  GoExitSignal, ref, fref, getWord, ValI, StrI, FSplit, CopyRec, int16, TxtWrite, Output, StrToBytes, ToUnicode, FromUnicode,
  type Ref, type Pointer, type DirStr, DirectorySeparator, } from './pasrt.ts';
import {
  BaseVars, ExitRecord, RdMsg, SetMsgPar, Set2MsgPar, NewExit, RestoreExit, GoExit, MarkBoth, ReleaseBoth, MarkStore,
  MarkStore2, ReleaseStore, ReleaseStore2, StoreAvail, SEquUpcase, AddBackSlash, DelBackSlash, LastInChain, ChainLast,
  GetDLine, OpenH, ReadH, CloseH, DeleteFile, RenameFile56, SetUpdHandle, WHasFrame, WDoubleFrame, WShadow,
  _isoldfile, RdOnly, Exclusive, type LongStrPtr, type FileUseMode,
} from './base.ts';
import { DosView, DosFExpand, GetDirDos, HostToDos } from './handle.ts';
import {
  AccessVars, RdbD, RdbPos, FloppyDrives, GetRecSpace, ReadRec, WriteRec, _ShortS, _T, T_, _B, B_, R_, LongS_,
  _LongS, CExtToT, CExtToX, TestCPathError, ResetCompilePars, ForAllFDs, CodingLongStr, _quotedstr, f_Stored, f_Mask,
  type FileDPtr, type FieldDPtr, type KeyDPtr, type KeyFldDPtr, type FrmlPtr, type TFilePtr,
} from './access.ts';
import {
  DriversVars, ClrScr, GotoXY, ScrRdBuf, ScrWrBuf, ScrClr, ScrWrStr, ShowMouse, _EOF, _AltF9_, _CtrlF9_,
  _CtrlF10_, _CtrlF8_, _AltF2_,
} from './drivers.ts';
import { RdRunVars, SetCompileAll, type InstrPtr, type EditDPtr, type EditOptPtr } from './rdrun.ts';
import {
  OpenF, OpenCreateF, CloseFile, CloseFAfter, GetCatIRec, RdCatField, TestMountVol, SaveFiles, ReleaseDrive,
  SetCPathVol, RdCatPathVol,
} from './oaccess.ts';
import { PushW, PopW, PushWFramed, WrLLF10Msg, WrLLF10MsgLine, PromptYN, RunError, RunMsgClear } from './obaseww.ts';
import {
  SetInpStr, SetInpTT, SetInpTTPos, SetInpLongStr, RdLex, TestLex, Accept, RdInteger, RdStrFrml,
  GetEditOpt, AllFldsList, FindChpt, FldTypIdentity,
} from './compile.ts';
import { RdFileD, RdByteList } from './rdfildcl.ts';
import { ReadMerge } from './rdmerg.ts';
import { ReadReport } from './rdrprt.ts';
import { ReadProcHead, ReadProcBody, ReadDeclChpt } from './rdproc.ts';
import { PushEdit, RdFormOrDesign, NewEditD } from './rdedit.ts';
import { RunMerge } from './runmerg.ts';
import { RunReport } from './runrprt.ts';
import { SelGenRprt } from './genrprt.ts';
import {
  RunEdiVars, CRec, WrEStatus, RdEStatus, SetNewCRec, GotoRecFld, DisplEditWw, OpenEditWw, EditFreeTxt, RunEdit,
  EditDataFile, SelFldsForEO, SetSelectFalse, PopEdit,
} from './runedi.ts';
import { RunMainProc, CallProcedure } from './runproc.ts';
import { PromptCodeRdb, CodingCRdb } from './expimp.ts';
import { ViewPrinterTxt, ClearHelpStkForCRdb, SimpleEditText } from './editor.ts';
import { ReadProlog } from './rdprolg.ts';
import { RunProlog } from './runprolg.ts';
import { RunShortStr, TrailChar } from './runfrml.ts';
import { TMenuBoxS } from './wwmenu.ts';
import { PassWord, SetPassword, HasPassword, HasPasswordAuth } from './wwmix.ts';
import { ScrTextMode } from './runfand.ts';
import {
  RunProjPriv, RunProjE, ChDir, MkDir, RmDir, ExtToTyp, ReleaseFDLDAfterChpt, RdFDSegment, EditHelpOrCat,
  StoreChptTxt,
} from './runproj.ts';
import { WrFDSegment } from './projmgr1.ts';

/** TS-only: write(...) to the CRT (System.Output). */
function write(...S: string[]): void {
  TxtWrite(Output, ...S);
}
/** TS-only: Pascal `write(x:w)` – right-aligned in w columns. */
function PadL(s: string, w: number): string {
  return s.length < w ? ' '.repeat(w - s.length) + s : s;
}
/** TS-only: `E := X` for `E: EditDPtr absolute EditDRoot`. */
function SetE(X: EditDPtr): void {
  RdRunVars.EditDRoot = X;
}
/** TS-only: DOS.FExpand on an engine (host) path. */
function FExpand(Path: string): string {
  if (DosView.On) return DosFExpand(Path);
  const u = ToUnicode(Path);
  let r = nodePathResolve(u);
  if ((u === '' || u.endsWith('/')) && !r.endsWith('/')) r += '/';
  return FromUnicode(r);
}

// PAS: PROJMGR.PAS Ovr (overlay fix-up of RUNPROJ; FPC: empty)
function Ovr(): void {}

// PAS: PROJMGR.PAS SetChptFldDPtr – unit-internal
export function SetChptFldDPtr(): void {
  const av = AccessVars;
  av.ChptTF = av.Chpt!.TF;
  av.ChptTxtPos = av.Chpt!.FldD;
  av.ChptVerif = av.ChptTxtPos!.Chain;
  av.ChptOldTxt = av.ChptVerif!.Chain;
  av.ChptTyp = av.ChptOldTxt!.Chain;
  av.ChptName = av.ChptTyp!.Chain;
  av.ChptTxt = av.ChptName!.Chain;
}

// PAS: PROJMGR.PAS CreateOpenChpt
export function CreateOpenChpt(Nm: string, create: boolean): void {
  const av = AccessVars;
  const bv = BaseVars;

  function SetRdbDir(Typ: string, Nm: string): string {
    const r = av.CRdb!;
    let rb = r.ChainBack;
    if (rb === null) av.TopRdb = r;
    bv.CVol = '';
    if (Typ === '\\') {
      rb = av.TopRdb;
      av.CRdb = rb;
      av.CFile!.CatIRec = GetCatIRec(Nm, false);
      av.CRdb = r;
    }
    if (av.CFile!.CatIRec !== 0) {
      bv.CPath = RdCatField(av.CFile!.CatIRec, av.CatPathName);
      if (bv.CPath[1] !== ':') {
        const d = ref<DirStr>(rb !== null ? rb.RdbDir : ''); // TS: nil guard (BP7 reads garbage)
        // FPC tests DirectorySeparator, BP7 '\' (then prefixes the drive of d): a path starting
        // with either is absolute here (UnixPath maps a leading '\')
        if (bv.CPath[0] === '/' || bv.CPath[0] === '\\') {
          // absolute path; DOS view: a host path (stored by an older run) is converted, and
          // '\...' gets the drive of d as in BP7
          if (DosView.On && bv.CPath[0] === '/') bv.CPath = HostToDos(bv.CPath);
          else if (DosView.On && d.v.length >= 2 && d.v[1] === ':') bv.CPath = d.v.slice(0, 2) + bv.CPath;
        } else {
          AddBackSlash(d);
          bv.CPath = d.v + bv.CPath;
        }
      }
      const cd = ref(''), cn = ref(''), ce = ref('');
      FSplit(bv.CPath, cd, cn, ce);
      bv.CDir = cd.v;
      bv.CName = cn.v;
      bv.CExt = ce.v;
      const dd = ref(bv.CDir);
      DelBackSlash(dd);
      bv.CDir = dd.v;
    } else if (rb === null) bv.CDir = av.TopRdbDir;
    else {
      const d = ref(rb.RdbDir);
      AddBackSlash(d);
      bv.CDir = d.v + av.CFile!.Name;
    }
    r.RdbDir = bv.CDir;
    if (av.TopDataDir === '') r.DataDir = bv.CDir;
    else if (rb === null) r.DataDir = av.TopDataDir;
    else {
      const d = ref(rb.DataDir);
      AddBackSlash(d);
      r.DataDir = d.v + av.CFile!.Name;
    }
    bv.CDir = bv.CDir + DirectorySeparator; // FPC: DirectorySeparator
    return '';
  }
  function ResetRdOnly(): void {
    if (av.Chpt!.UMode === RdOnly) {
      CloseFile();
      av.IsInstallRun = true;
      OpenF(Exclusive);
      av.IsInstallRun = false;
    }
  }

  const top = av.CRdb === null;
  av.FileDRoot = null;
  const R = new RdbD();
  const oldChptTF: TFilePtr = av.ChptTF;
  R.ChainBack = av.CRdb;
  R.OldLDRoot = av.LinkDRoot;
  R.OldFCRoot = av.FuncDRoot;
  MarkStore2(fref(R, 'Mark2'));
  RdMsg(51);
  let s = bv.MsgLine;
  RdMsg(48);
  const n = ref(0), i = ref(0);
  ValI(bv.MsgLine, n, i);
  s = s + StrI(bv.TxtCols - n.v);
  SetInpStr(ref(s));
  const Nm1 = (Nm[0] === '\\' ? Nm.slice(1) : Nm).slice(0, 8);
  RdFileD(Nm1, '0', ''); // old CRdb for GetCatIRec
  R.FD = av.CFile;
  av.CRdb = R;
  av.CFile!.RecPtr = GetRecSpace();
  SetRdbDir(Nm[0] ?? '', Nm1);
  const p = bv.CDir + Nm1 + '.RDB';
  av.CFile!.Drive = TestMountVol(bv.CPath[0] ?? '\0');
  SetChptFldDPtr();
  if (!bv.Spec.RDBcomment) av.ChptTxt!.L = 1;
  SetMsgPar(p);
  if (top) {
    av.UserName = '';
    av.UserCode = 0;
    av.AccRight = '\0';
  } else {
    av.CRdb.HelpFD = av.CRdb.ChainBack!.HelpFD;
    for (;;) {
      // 1:
      if (ChDir(R.RdbDir) === 0) break;
      if (create && (av.IsTestRun || !top)) {
        if (MkDir(R.RdbDir) !== 0) RunError(620);
        continue;
      }
      RunError(631);
    }
  }
  // 2:
  const um: FileUseMode = av.IsTestRun || !create ? Exclusive : RdOnly;
  if (OpenF(um)) {
    if (av.ChptTF!.CompileAll) ResetRdOnly();
    else if (!top && oldChptTF !== null && av.ChptTF!.TimeStmp < oldChptTF.TimeStmp) {
      // BP7 (FPC: false)
      ResetRdOnly();
      SetCompileAll();
    }
  } else {
    if (!create || (top && !av.IsTestRun)) RunError(631);
    OpenCreateF(Exclusive);
    SetCompileAll();
  }
  // 3:
  av.CRdb.Encrypted = !HasPassword(av.Chpt, 1, '');
}

// PAS: PROJMGR.PAS CloseChpt
export function CloseChpt(): void {
  const av = AccessVars;
  if (av.CRdb === null) return;
  ClearHelpStkForCRdb();
  SaveFiles();
  const del = av.Chpt!.NRecs === 0;
  const d = av.CRdb.RdbDir;
  CloseFAfter(av.FileDRoot);
  av.LinkDRoot = av.CRdb.OldLDRoot;
  av.FuncDRoot = av.CRdb.OldFCRoot;
  const p: Pointer = av.CRdb, p2 = av.CRdb.Mark2;
  av.CRdb = av.CRdb.ChainBack;
  ReleaseBoth(p, p2);
  if (av.CRdb !== null) {
    av.FileDRoot = av.CRdb.FD;
    SetChptFldDPtr();
    if (ChDir(av.CRdb.RdbDir) !== 0) RunError(2); // {$I+}
    if (del) {
      if (RmDir(d) !== 0) {
        SetMsgPar(d);
        WrLLF10Msg(621);
      }
    }
  } else {
    ChDir(BaseVars.OldDir);
    for (let i = 1; i <= FloppyDrives; i++) ReleaseDrive(i);
  }
}

// PAS: PROJMGR.PAS GoCompileErr – unit-internal
export function GoCompileErr(IRec: number, N: number): void {
  const av = AccessVars;
  av.IsCompileErr = true;
  av.InpRdbPos.R = av.CRdb;
  av.InpRdbPos.IRec = IRec;
  av.CurrPos = 0;
  RdMsg(N);
  GoExit();
}

// PAS: PROJMGR.PAS ClearXFUpdLock – unit-internal
export function ClearXFUpdLock(): void {
  const cf = AccessVars.CFile!;
  if (cf.XF !== null) cf.XF.UpdLockCnt = 0;
}

// PAS: PROJMGR.PAS CompRunChptRec – unit-internal
export function CompRunChptRec(CC: number): boolean {
  const av = AccessVars;
  const dv = DriversVars;
  const pv = RunProjPriv;

  // PAS: PROJMGR.PAS Diagnostics – FPC: empty
  function Diagnostics(MaxHp: Pointer, Free: number, FD: FileDPtr): void {}
  function FindFD(): FileDPtr {
    const FName = TrailChar(' ', _ShortS(av.ChptName)).slice(0, 12);
    const d = ref(''), name = ref(''), ext = ref('');
    FSplit(FName, d, name, ext);
    let FD = av.FileDRoot;
    while (FD !== null) {
      if (SEquUpcase(FD.Name, name.v)) break;
      FD = FD.Chain;
    }
    return FD;
  }

  const OldE = RunProjE();
  const p = ref<Pointer>(null), p2 = ref<Pointer>(null);
  MarkBoth(p, p2);
  WrEStatus();
  const er = new ExitRecord();
  NewExit(Ovr, er);
  av.IsCompileErr = false;
  let uw = false;
  const mv = dv.MausVisible;
  let lstFD = LastInChain(fref(av, 'FileDRoot'));
  const oldLd = av.LinkDRoot;
  let WasError = true;
  const WasGraph = dv.IsGraphMode;
  let FD: FileDPtr = null;
  const STyp = _ShortS(av.ChptTyp);
  const RP = new RdbPos();
  RP.R = av.CRdb;
  RP.IRec = CRec();
  try {
    const RunMain = (): void => {
      // 1:
      if (pv.UserW !== 0) {
        PopW(pv.UserW);
        uw = true;
      }
      RunMainProc(RP, av.CRdb!.ChainBack === null);
    };
    if (CC === _AltF9_) {
      if (FindChpt('P', 'MAIN', true, RP)) RunMain();
      else WrLLF10Msg(58);
    } else {
      switch (STyp[0]) {
        case 'F':
          FD = FindFD();
          if (FD !== null && CC === _CtrlF9_) {
            const EO = GetEditOpt();
            av.CFile = FD;
            EO!.Flds = AllFldsList(av.CFile, false);
            if (SelFldsForEO(EO, null)) EditDataFile(FD, EO);
          }
          break;
        case 'E':
          if (CC === _CtrlF9_) {
            const EO = GetEditOpt();
            EO!.FormPos = CopyRec(RP);
            EditDataFile(null, EO);
          } else {
            PushEdit();
            RdFormOrDesign(null, null, RP);
          }
          break;
        case 'M':
          SetInpTT(RP, true);
          ReadMerge();
          if (CC === _CtrlF9_) RunMerge();
          break;
        case 'R':
          SetInpTT(RP, true);
          ReadReport(null);
          if (CC === _CtrlF9_) {
            RunReport(null);
            SaveFiles();
            ViewPrinterTxt();
          }
          break;
        case 'P':
          if (CC === _CtrlF9_) RunMain();
          else {
            lstFD = LastInChain(fref(av, 'FileDRoot'));
            const ld = av.LinkDRoot;
            SetInpTT(RP, true);
            ReadProcHead();
            ReadProcBody();
            lstFD.Chain = null;
            av.LinkDRoot = ld;
          }
          break;
        // {$ifdef FandProlog}
        case 'L':
          if (CC === _CtrlF9_) {
            dv.TextAttr = BaseVars.ProcAttr;
            ClrScr();
            RunProlog(RP, null);
          }
          break;
      }
    }
    WasError = false;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) {
      RestoreExit(er);
      throw e;
    }
  }
  // 2:
  const MaxHp: Pointer = null; // FPC
  ReleaseStore2(p2.v);
  const Free = StoreAvail();
  RestoreExit(er);
  RunMsgClear();
  if (WasError) {
    dv.TextAttr = BaseVars.Colors.uNorm;
    if (dv.IsGraphMode && !WasGraph) ScrTextMode(false, false);
    else ClrScr();
  }
  if (uw) {
    pv.UserW = 0; // mem overflow
    pv.UserW = PushW(1, 1, BaseVars.TxtCols, BaseVars.TxtRows);
  }
  SaveFiles();
  if (mv) ShowMouse();
  if (WasError) ForAllFDs(ClearXFUpdLock);
  av.CFile = lstFD.Chain;
  while (av.CFile !== null) {
    CloseFile();
    av.CFile = av.CFile.Chain;
  }
  lstFD.Chain = null;
  av.LinkDRoot = oldLd;
  ReleaseBoth(p.v, p2.v);
  SetE(OldE);
  RdEStatus();
  av.CRdb = RP.R;
  av.PrevCompInp = null;
  ReadRec(CRec());
  if (av.IsCompileErr) return false;
  if (WasError) return true;
  B_(av.ChptVerif, false);
  WriteRec(CRec());
  if (CC === _CtrlF8_) Diagnostics(MaxHp, Free, FD);
  return true;
}

// PAS: PROJMGR.PAS RdUserId – unit-internal
export function RdUserId(Chk: boolean): void {
  const av = AccessVars;
  let pw = '';
  av.RdFldNameFrml = null;
  RdLex();
  if (av.Lexem === _EOF) return;
  if (Chk) pw = PassWord(false);
  for (;;) {
    // 1:
    TestLex(_quotedstr);
    const name = av.LexWord.slice(0, 20);
    RdLex();
    Accept(',');
    const code = RdInteger();
    Accept(',');
    const Z: FrmlPtr = RdStrFrml();
    const pw2 = RunShortStr(Z).slice(0, 20);
    ReleaseStore(Z);
    const acc = ref('');
    if (av.Lexem === ',') {
      RdLex();
      RdByteList(acc);
    } else acc.v = String.fromCharCode(code & 0xff);
    if (Chk) {
      if (SEquUpcase(pw, pw2)) {
        av.UserName = name;
        av.UserCode = code & 0xffff;
        av.UserPassword = pw2;
        av.AccRight = acc.v;
        return;
      }
    } else if (code === 0) {
      av.UserName = name;
      av.UserCode = code;
      av.UserPassword = pw2;
    }
    if (av.Lexem !== _EOF) {
      Accept(';');
      if (av.Lexem !== _EOF) continue;
    }
    break;
  }
  if (Chk) RunError(629);
}

// PAS: PROJMGR.PAS CompileRdb
export function CompileRdb(Displ: boolean, Run: boolean, FromCtrlF10: boolean): boolean {
  const av = AccessVars;
  const bv = BaseVars;
  const rv = RdRunVars;

  function RdF(FileName: string): Pointer {
    const d = ref(''), name = ref(''), ext = ref('');
    FSplit(FileName, d, name, ext);
    const FDTyp = ExtToTyp(ext.v);
    if (FDTyp === '0') {
      RdMsg(51);
      let s = bv.MsgLine;
      RdMsg(49);
      const n = ref(0), i = ref(0);
      ValI(bv.MsgLine, n, i);
      s = s + StrI(bv.TxtCols - n.v);
      SetInpStr(ref(s));
    } else SetInpTTPos(_T(av.ChptTxt), av.CRdb!.Encrypted);
    return RdFileD(name.v, FDTyp, ext.v);
  }
  function MakeDbfDcl(Nm: string): number {
    bv.CPath = FExpand(Nm + '.DBF');
    bv.CVol = '';
    let i = GetCatIRec(Nm, true);
    if (i !== 0) RdCatPathVol(i);
    const h = OpenH(_isoldfile, RdOnly);
    TestCPathError();
    const Hd = new Uint8Array(32);
    ReadH(h, 32, Hd);
    const n = Math.trunc((getWord(Hd, 8) - 1) / 32) - 1;
    let t = '';
    let c = 'A';
    const Fd = new Uint8Array(32);
    for (i = 1; i <= n; i++) {
      ReadH(h, 32, Fd);
      let e = 0;
      while (e < 11 && Fd[e] !== 0) e++;
      let s = String.fromCharCode(...Fd.subarray(0, e));
      switch (String.fromCharCode(Fd[11])) {
        case 'C':
          c = 'A';
          break;
        case 'D':
          c = 'D';
          break;
        case 'L':
          c = 'B';
          break;
        case 'M':
          c = 'T';
          break;
        case 'N':
        case 'F':
          c = 'F';
          break;
      }
      s = s + ':' + c;
      let Len = Fd[16];
      const Dec = Fd[17];
      switch (c) {
        case 'A':
          s = s + ',' + StrI(Len);
          break;
        case 'F':
          Len = (Len - Dec) & 0xff;
          if (Dec !== 0) Len = (Len - 1) & 0xff;
          s = s + ',' + StrI(Len);
          s = s + '.' + StrI(Dec);
          break;
      }
      s = s + ';\r\n';
      t += s.slice(0, 80);
    }
    LongS_(av.ChptTxt, StrToBytes(t));
    CloseH(h);
    return 0;
  }

  function MergeOldNew(Verif: boolean, Pos: number): boolean {
    function EquStoredF(F1: FieldDPtr, F2: FieldDPtr): boolean {
      for (;;) {
        // 1:
        while (F1 !== null && (F1.Flg & f_Stored) === 0) F1 = F1.Chain;
        while (F2 !== null && (F2.Flg & f_Stored) === 0) F2 = F2.Chain;
        if (F1 === null) return F2 === null;
        if (F2 === null || !FldTypIdentity(F1, F2) || (F1.Flg & ~f_Mask) !== (F2.Flg & ~f_Mask)) return false;
        F1 = F1.Chain;
        F2 = F2.Chain;
      }
    }
    function EquKeys(K1: KeyDPtr, K2: KeyDPtr): boolean {
      while (K1 !== null) {
        if (K2 === null || K1.Duplic !== K2.Duplic) return false;
        let KF1: KeyFldDPtr = K1.KFlds, KF2: KeyFldDPtr = K2.KFlds;
        while (KF1 !== null) {
          if (KF2 === null || KF1.CompLex !== KF2.CompLex || KF1.Descend !== KF2.Descend || KF1.FldD!.Name !== KF2.FldD!.Name)
            return false;
          KF1 = KF1.Chain;
          KF2 = KF2.Chain;
        }
        if (KF2 !== null) return false;
        K1 = K1.Chain;
        K2 = K2.Chain;
      }
      if (K2 !== null) return false;
      return true;
    }
    function DeleteF(): void {
      CloseFile();
      SetCPathVol();
      DeleteFile(bv.CPath);
      CExtToX();
      if (av.CFile!.XF !== null) DeleteFile(bv.CPath);
      CExtToT();
      if (av.CFile!.TF !== null) DeleteFile(bv.CPath);
    }
    function MergAndReplace(FDOld: FileDPtr, FDNew: FileDPtr): boolean {
      const er = new ExitRecord();
      NewExit(Ovr, er);
      try {
        const s = '#I1_' + FDOld!.Name + ' #O1_@';
        SetInpStr(ref(s));
        av.SpecFDNameAllowed = true;
        ReadMerge();
        av.SpecFDNameAllowed = false;
        RunMerge();
        SaveFiles();
      } catch (e) {
        if (!(e instanceof GoExitSignal)) {
          RestoreExit(er);
          throw e;
        }
        // 1:
        RestoreExit(er);
        av.CFile = FDOld;
        CloseFile();
        av.CFile = FDNew;
        DeleteF();
        av.SpecFDNameAllowed = false;
        return false;
      }
      RestoreExit(er);
      av.CFile = FDOld;
      DeleteF();
      av.CFile = FDNew;
      CloseFile();
      FDOld!.Typ = FDNew!.Typ;
      SetCPathVol();
      let p = bv.CPath;
      av.CFile = FDOld;
      SetCPathVol();
      RenameFile56(p, bv.CPath, false);
      av.CFile = FDNew; // TF^.Format used
      CExtToT();
      p = bv.CPath;
      SetCPathVol();
      CExtToT();
      RenameFile56(bv.CPath, p, false);
      return true;
    }

    const ld = av.LinkDRoot;
    let result = false;
    const FDNew = av.CFile!;
    SetCPathVol();
    const Name = FDNew.Name.slice(0, 20);
    FDNew.Name = '@';
    av.CFile = av.Chpt;
    if (RdFDSegment(0, Pos)) {
      ChainLast(fref(av, 'FileDRoot'), av.CFile!);
      const FDOld = av.CFile!;
      FDOld.Name = Name;
      if (FDNew.Typ !== FDOld.Typ || !EquStoredF(FDNew.FldD, FDOld.FldD)) {
        MergAndReplace(FDOld, FDNew);
        result = true;
      } else if (FDOld.Typ === 'X' && !EquKeys(FDOld.Keys, FDNew.Keys)) {
        SetCPathVol();
        CExtToX();
        DeleteFile(bv.CPath);
      }
    }
    // 1:
    FDNew.Chain = null;
    av.LinkDRoot = ld;
    FDNew.Name = Name;
    av.CFile = FDNew;
    av.CRecPtr = av.Chpt!.RecPtr;
    void Verif;
    return result;
  }

  const Buf = new Uint16Array(40);
  let w = 0;
  function CompileMsgOn(): number {
    RdMsg(15);
    if (av.IsTestRun) {
      w = PushWFramed(0, 0, 30, 4, bv.Colors.sNorm, bv.MsgLine, '', WHasFrame + WDoubleFrame + WShadow);
      RdMsg(117);
      const ml = StrToBytes(bv.MsgLine);
      const s = GetDLine(ml, ml.length, '/', 1).slice(0, 12);
      GotoXY(3, 2);
      write(s);
      GotoXY(3, 3);
      write(GetDLine(ml, ml.length, '/', 2));
      return s.length;
    }
    ScrRdBuf(0, bv.TxtRows - 1, Buf, 40);
    w = 0;
    ScrClr(0, bv.TxtRows - 1, bv.MsgLine.length + 2, 1, ' ', bv.Colors.zNorm);
    ScrWrStr(1, bv.TxtRows - 1, bv.MsgLine, bv.Colors.zNorm);
    return 0;
  }
  function CompileMsgOff(): void {
    if (w !== 0) PopW(w);
    else ScrWrBuf(0, bv.TxtRows - 1, Buf, 40);
  }

  // CompileRdb - body
  const OldE = RunProjE();
  const p = ref<Pointer>(null), p2 = ref<Pointer>(null);
  MarkBoth(p, p2);
  const p1 = ref<Pointer>(p.v);
  const er = new ExitRecord();
  NewExit(Ovr, er);
  let I = 0;
  let lmsg = 0;
  try {
    av.IsCompileErr = false;
    let FDCompiled = false;
    const OldCRec = CRec();
    void OldCRec;
    void FDCompiled;
    const RP = new RdbPos();
    RP.R = av.CRdb;
    const top = av.CRdb!.ChainBack === null;
    if (top) {
      av.UserName = '';
      av.UserCode = 0;
      av.UserPassword = '';
      av.AccRight = '';
      if (av.ChptTF!.CompileAll || rv.CompileFD) av.Switches = '';
    }
    lmsg = CompileMsgOn();
    av.CRecPtr = av.Chpt!.RecPtr;
    const Encryp = av.CRdb!.Encrypted;
    for (I = 1; I <= av.Chpt!.NRecs; I++) {
      ReadRec(I);
      RP.IRec = I;
      const Verif = _B(av.ChptVerif);
      const STyp = _ShortS(av.ChptTyp).slice(0, 1);
      const Typ = STyp.length > 0 ? STyp[0] : '\0';
      const Name = TrailChar(' ', _ShortS(av.ChptName)).slice(0, 12);
      let Txt = _T(av.ChptTxt);
      const tf = av.ChptTF!;
      if (Verif && (tf.LicenseNr !== 0 || Encryp || av.Chpt!.UMode === RdOnly)) GoCompileErr(I, 647);
      if (Verif || tf.CompileAll || FromCtrlF10 || Typ === 'U' || ((Typ === 'F' || Typ === 'D') && rv.CompileFD) ||
        (Typ === 'P' && tf.CompileProc)) {
        let OldTxt = _T(av.ChptOldTxt);
        av.InpRdbPos = CopyRec(RP);
        if (av.IsTestRun) {
          ClrScr();
          GotoXY(3 + lmsg, 2);
          write(PadL(StrI(I), 4));
          GotoXY(3 + lmsg, 3);
          write(PadL(STyp, 4), PadL(_ShortS(av.ChptName), 14));
          if (!(Typ === ' ' || Typ === 'D' || Typ === 'U')) {
            // duplicate name checking
            for (let J = 1; J <= I - 1; J++) {
              ReadRec(J);
              if (STyp === _ShortS(av.ChptTyp) && SEquUpcase(Name, TrailChar(' ', _ShortS(av.ChptName)))) GoCompileErr(I, 649);
            }
            ReadRec(I);
          }
        }
        switch (Typ) {
          case 'F': {
            FDCompiled = true;
            const ld = av.LinkDRoot;
            MarkStore(p1);
            const dir = ref(''), nm = ref(''), ext = ref('');
            FSplit(Name, dir, nm, ext);
            if (Txt === 0 && av.IsTestRun) {
              SetMsgPar(Name);
              if (SEquUpcase(ext.v, '.DBF') && PromptYN(39)) {
                T_(av.ChptOldTxt, 0);
                OldTxt = 0;
                MakeDbfDcl(nm.v);
                Txt = _T(av.ChptTxt);
                WriteRec(I);
              }
            }
            // {$ifndef FandSQL}
            if (SEquUpcase(ext.v, '.SQL')) GoCompileErr(I, 654);
            let compile = Verif || tf.CompileAll || OldTxt === 0;
            if (!compile) {
              if (!RdFDSegment(I, OldTxt)) {
                av.LinkDRoot = ld;
                ReleaseStore(p1.v);
                av.CFile = av.Chpt;
                compile = true; // goto 2
              } else {
                ChainLast(fref(av, 'FileDRoot'), av.CFile!);
                MarkStore(p1);
                if (av.CFile!.IsHlpFile) av.CRdb!.HelpFD = av.CFile;
              }
            }
            if (compile) {
              // 2:
              p1.v = RdF(Name);
              WrFDSegment(I);
              if (av.CFile!.IsHlpFile) av.CRdb!.HelpFD = av.CFile;
              if (OldTxt > 0) MergeOldNew(Verif, OldTxt);
              ReleaseStore(p1.v);
              av.CFile = av.Chpt;
              // FPC: the old segment text (OldTxt) is not deleted
            }
            break;
          }
          case 'M':
            SetInpTTPos(Txt, Encryp);
            ReadMerge();
            break;
          case 'R':
            if (Txt === 0 && av.IsTestRun) {
              const RprtTxt: LongStrPtr | null = SelGenRprt(Name);
              av.CFile = av.Chpt;
              if (RprtTxt === null) GoCompileErr(I, 1145);
              LongS_(av.ChptTxt, RprtTxt!);
              WriteRec(I);
            } else {
              SetInpTTPos(Txt, Encryp);
              ReadReport(null);
            }
            break;
          case 'P': {
            const lstFD = LastInChain(fref(av, 'FileDRoot'));
            const ld = av.LinkDRoot;
            SetInpTTPos(Txt, Encryp);
            if (av.InpArrLen > 0) {
              // FPC: an empty chapter is skipped
              ReadProcHead();
              ReadProcBody();
            }
            lstFD.Chain = null;
            av.LinkDRoot = ld;
            break;
          }
          case 'E':
            PushEdit();
            RdFormOrDesign(null, null, RP);
            SetE(OldE);
            break;
          case 'U':
            if (!top || I > 1) GoCompileErr(I, 623);
            if (Txt !== 0) {
              ResetCompilePars();
              SetInpTTPos(Txt, Encryp);
              RdUserId(!av.IsTestRun || tf.LicenseNr !== 0);
              MarkStore(p1);
            }
            break;
          case 'D':
            ResetCompilePars();
            SetInpTTPos(Txt, Encryp);
            ReadDeclChpt();
            MarkStore(p1);
            break;
          // {$ifdef FandProlog}
          case 'L':
            SetInpTTPos(Txt, Encryp);
            ReadProlog(0); // FPC: 0 (BP7: I)
            break;
        }
      }
      ReleaseStore(p1.v);
      ReleaseStore2(p2.v);
      av.CFile = av.Chpt;
      av.CRecPtr = av.Chpt!.RecPtr;
      if (Verif) {
        ReadRec(I);
        B_(av.ChptVerif, false);
        WriteRec(I);
      }
    }
    const tf = av.ChptTF!;
    if (tf.CompileAll || tf.CompileProc) {
      tf.CompileAll = false;
      tf.CompileProc = false;
      SetUpdHandle(tf.Handle);
    }
    rv.CompileFD = false;
    RestoreExit(er);
    if (!Run) {
      av.CRecPtr = RunProjE()!.NewRecPtr;
      ReadRec(CRec());
    }
    CompileMsgOff();
    void Displ;
    return true;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) {
      RestoreExit(er);
      throw e;
    }
  }
  // 1:
  RestoreExit(er);
  CompileMsgOff();
  ReleaseFDLDAfterChpt();
  av.PrevCompInp = null;
  ReleaseBoth(p.v, p2.v);
  SetE(OldE);
  av.CFile = av.Chpt;
  if (!Run) av.CRecPtr = RunProjE()!.NewRecPtr;
  if (!av.IsCompileErr) av.InpRdbPos.IRec = I;
  return false;
}

// PAS: PROJMGR.PAS GotoErrPos – unit-internal
export function GotoErrPos(Brk: Ref<number>): void {
  const av = AccessVars;
  const E = RunProjE()!;
  av.IsCompileErr = false;
  const s = BaseVars.MsgLine;
  if (av.InpRdbPos.R !== av.CRdb) {
    DisplEditWw();
    SetMsgPar(s);
    WrLLF10Msg(110);
    if (av.InpRdbPos.IRec === 0) SetMsgPar('');
    else SetMsgPar(av.InpRdbPos.R!.FD!.Name);
    WrLLF10Msg(622);
    Brk.v = 0;
    return;
  }
  if (av.CurrPos === 0) {
    DisplEditWw();
    GotoRecFld(av.InpRdbPos.IRec, E.FirstFld!.Chain);
    SetMsgPar(s);
    WrLLF10Msg(110);
    Brk.v = 0;
    return;
  }
  RunEdiVars.CFld = E.LastFld;
  SetNewCRec(av.InpRdbPos.IRec, true);
  R_(av.ChptTxtPos, int16(av.CurrPos));
  WriteRec(CRec());
  EditFreeTxt(av.ChptTxt, s, true, Brk);
}

// PAS: PROJMGR.PAS EditExecRdb
export function EditExecRdb(Nm: string, ProcNm: string, ProcCall: InstrPtr): boolean {
  const av = AccessVars;
  const dv = DriversVars;
  const pv = RunProjPriv;

  function WrErrMsg630(): void {
    av.IsCompileErr = false;
    SetMsgPar(BaseVars.MsgLine);
    WrLLF10Msg(110);
    SetMsgPar(Nm);
    WrLLF10Msg(630);
  }

  let result = false;
  const top = av.CRdb === null;
  const w = pv.UserW;
  pv.UserW = 0;
  const wasGraph = dv.IsGraphMode;
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    CreateOpenChpt(Nm, true);
    RdRunVars.CompileFD = true;
    let goto9 = false;
    // {$ifdef FPC}
    if (!av.IsTestRun || (!top && av.CRdb!.Encrypted)) {
      const p = ref<Pointer>(null);
      MarkStore(p);
      RdRunVars.EditRdbMode = false;
      if (CompileRdb(false, true, false)) {
        const RP = new RdbPos();
        if (FindChpt('P', ProcNm, true, RP)) {
          const er2 = new ExitRecord();
          NewExit(Ovr, er2);
          try {
            av.IsCompileErr = false;
            if (ProcCall !== null) {
              ProcCall.Pos = RP;
              CallProcedure(ProcCall);
            } else RunMainProc(RP, top);
            result = true;
          } catch (e) {
            if (!(e instanceof GoExitSignal)) throw e;
            // 0:
            if (av.IsCompileErr) WrErrMsg630();
          }
          goto9 = true;
        } else {
          Set2MsgPar(Nm, ProcNm);
          WrLLF10Msg(632);
        }
      } else if (av.IsCompileErr) WrErrMsg630();
      if (!goto9) {
        if (av.ChptTF!.LicenseNr !== 0 || av.CRdb!.Encrypted || av.Chpt!.UMode === RdOnly) goto9 = true;
        else {
          ReleaseFDLDAfterChpt();
          ReleaseStore(p.v);
        }
      }
    } else if (!top) pv.UserW = PushW(1, 1, BaseVars.TxtCols, BaseVars.TxtRows);
    if (!goto9) result = EditRdb(top, ProcNm, result);
  } catch (e) {
    if (!(e instanceof GoExitSignal)) {
      RestoreExit(er);
      throw e;
    }
  }
  // 9:
  RestoreExit(er);
  if (!wasGraph && dv.IsGraphMode) ScrTextMode(false, false);
  if (pv.UserW !== 0) PopW(pv.UserW);
  pv.UserW = w;
  RunMsgClear();
  CloseChpt();
  return result;
}

/** TS-only: the chapter-editor part of EditExecRdb (Pascal labels 1..8, `goto 9` = return). */
function EditRdb(top: boolean, ProcNm: string, result: boolean): boolean {
  const av = AccessVars;
  const dv = DriversVars;
  let passw = '';
  RdRunVars.EditRdbMode = true;
  if (av.CRdb!.Encrypted) passw = PassWord(false);
  av.IsTestRun = true;
  const EO: EditOptPtr = GetEditOpt();
  EO!.Flds = AllFldsList(av.Chpt, true);
  EO!.Flds = EO!.Flds!.Chain!.Chain!.Chain;
  NewEditD(av.Chpt, EO);
  const E = (): NonNullable<EditDPtr> => RunProjE()!;
  E().MustCheck = true; // ChptTyp
  if (av.CRdb!.Encrypted) {
    if (HasPasswordAuth(av.Chpt, 1, passw)) {
      av.CRdb!.Encrypted = false;
      SetPassword(av.Chpt, 1, '');
      CodingCRdb(false);
    } else {
      WrLLF10Msg(629);
      return result; // goto 9
    }
  }
  const Brk = ref(0);
  let cc = 0;
  let lbl: 1 | 2 | 3 | 4 | 41 | 5 | 6 | 8;
  if (!OpenEditWw()) lbl = 8;
  else {
    result = true;
    av.Chpt!.WasRdOnly = false;
    lbl = 1;
    if (!top && av.Chpt!.NRecs > 0) {
      if (CompileRdb(true, false, false)) {
        const RP = new RdbPos();
        if (FindChpt('P', ProcNm, true, RP)) GotoRecFld(RP.IRec, RunEdiVars.CFld);
      } else lbl = 4;
    } else if (av.ChptTF!.IRec <= av.Chpt!.NRecs) GotoRecFld(av.ChptTF!.IRec, RunEdiVars.CFld);
  }
  for (;;) {
    switch (lbl) {
      case 1:
        RunEdit(null, Brk);
        lbl = 2;
        break;
      case 2:
        cc = dv.KbdChar;
        SaveFiles();
        if (cc === _CtrlF10_ || av.ChptTF!.CompileAll || RdRunVars.CompileFD) {
          ReleaseFDLDAfterChpt();
          SetSelectFalse();
          E().Bool = null;
          ReleaseStore(E().AfterE);
        }
        if (cc === _CtrlF10_) {
          SetUpdHandle(av.ChptTF!.Handle);
          if (!CompileRdb(true, false, true)) {
            lbl = 3;
            break;
          }
          if (!PromptCodeRdb()) {
            lbl = 6;
            break;
          }
          av.Chpt!.WasRdOnly = true;
          lbl = 8;
          break;
        }
        if (Brk.v !== 0) {
          if (!CompileRdb(Brk.v === 2, false, false)) {
            lbl = 3;
            break;
          }
          if (cc === _AltF2_) {
            EditHelpOrCat(cc, 0, '');
            lbl = 41;
            break;
          }
          if (!CompRunChptRec(cc)) {
            lbl = 4;
            break;
          }
          lbl = 41;
          break;
        }
        av.ChptTF!.IRec = CRec();
        SetUpdHandle(av.ChptTF!.Handle);
        lbl = 8;
        break;
      case 3:
        if (av.IsCompileErr) {
          lbl = 4;
          break;
        }
        if (Brk.v === 1) DisplEditWw();
        GotoRecFld(av.InpRdbPos.IRec, E().FirstFld!.Chain);
        lbl = 1;
        break;
      case 4:
        GotoErrPos(Brk);
        lbl = 5;
        break;
      case 41:
        if (Brk.v === 1) {
          EditFreeTxt(av.ChptTxt, '', true, Brk);
          lbl = 5;
        } else lbl = 6;
        break;
      case 5:
        lbl = Brk.v !== 0 ? 2 : 1;
        break;
      case 6:
        DisplEditWw();
        lbl = 1;
        break;
      case 8:
        PopEdit();
        return result; // falls into 9
    }
  }
}

// PAS: PROJMGR.PAS InstallRdb
export function InstallRdb(n: string): void {
  const av = AccessVars;
  const bv = BaseVars;
  const dv = DriversVars;

  function UpdateUTxt(): void {
    av.CFile = av.Chpt;
    av.CRecPtr = av.Chpt!.RecPtr;
    const LicNr = av.ChptTF!.LicenseNr;
    void LicNr;
    const p1 = ref<Pointer>(null);
    MarkStore(p1);
    if (av.CFile!.NRecs === 0) WrLLF10Msg(9); // 1: {exit}
    else {
      ReadRec(1);
      if (_ShortS(av.ChptTyp) !== 'U') WrLLF10Msg(9); // 1: {exit}
    }
    const w = PushW(1, 1, bv.TxtCols, bv.TxtRows - 1);
    const TxtPos = ref(1);
    dv.TextAttr = bv.Colors.tNorm;
    const OldPos = _T(av.ChptTxt);
    void OldPos;
    let S: LongStrPtr = _LongS(av.ChptTxt);
    let b = false;
    if (av.CRdb!.Encrypted) S = CodingLongStr(S);
    const p = ref<Pointer>(null);
    const Upd = ref(false);
    const er = new ExitRecord();
    NewExit(Ovr, er);
    try {
      let first = true;
      for (;;) {
        try {
          if (first) {
            SetInpLongStr(S, false);
            MarkStore(p);
            RdUserId(false);
            ReleaseStore(p.v);
            b = true;
            first = false;
          }
          // 2:
          const buf = new Uint8Array(0x7fff);
          buf.set(S.subarray(0, Math.min(S.length, buf.length)));
          const Len = ref(S.length);
          SimpleEditText('T', '', '', buf, 0x7fff, Len, TxtPos, Upd);
          S = buf.slice(0, Len.v);
          SetInpLongStr(S, false);
          MarkStore(p);
          RdUserId(false);
          ReleaseStore(p.v);
          b = false;
          if (Upd.v) {
            StoreChptTxt(av.ChptTxt, S, true);
            WriteRec(1);
          }
          break; // 3
        } catch (e) {
          if (!(e instanceof GoExitSignal)) throw e;
          // 4:
          if (b) {
            WrLLF10MsgLine();
            ReleaseStore(p.v);
            if (PromptYN(59)) continue; // goto 2
            break; // goto 3
          }
          WrLLF10Msg(9);
          break; // goto 3
        }
      }
    } finally {
      // TS: Pascal exits at label 3 without RestoreExit (a dangling jump buffer); restore it
      RestoreExit(er);
    }
    // 3:
    PopW(w);
    ReleaseStore(p1.v);
  }
  function UpdateCat(): void {
    av.CFile = av.CatFD;
    if (av.CatFD!.Handle === 0xff) OpenCreateF(Exclusive);
    const EO = GetEditOpt();
    EO!.Flds = AllFldsList(av.CatFD, true);
    EditDataFile(av.CatFD, EO);
    ChDir(bv.OldDir);
    ReleaseStore(EO);
  }

  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    CreateOpenChpt(n, false);
    let skip = false;
    if (!HasPassword(av.Chpt, 1, '') && !HasPassword(av.Chpt, 2, '')) {
      const passw = PassWord(false);
      if (!HasPasswordAuth(av.Chpt, 2, passw)) {
        WrLLF10Msg(629);
        skip = true;
      }
    }
    if (!skip) {
      if (av.Chpt!.UMode === RdOnly) UpdateCat();
      else {
        RdMsg(8);
        const w = new TMenuBoxS().Init(43, 6, bv.MsgLine);
        let i = 1;
        for (;;) {
          // 0:
          i = w.Exec(i);
          if (i === 0) {
            w.Done();
            break;
          }
          switch (i) {
            case 1:
              UpdateCat();
              continue;
            case 2:
              UpdateUTxt();
              break;
            case 3:
              SetPassword(av.Chpt, 2, PassWord(true));
              break;
          }
          SetUpdHandle(av.ChptTF!.Handle);
        }
      }
    }
  } catch (e) {
    if (!(e instanceof GoExitSignal)) {
      RestoreExit(er);
      throw e;
    }
  }
  // 1:
  RestoreExit(er);
  CloseChpt();
}
