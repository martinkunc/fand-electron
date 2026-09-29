// PAS: RUNFAND.PAS – FAND start-up: drivers, FAND.RES/FAND.CFG, work files, help and catalog
// declarations, the command line (task / text file / batch) and the FAND desktop menu.
//
// Porting notes:
// * asm/DOS (BP7 only, FPC replacements in brackets): ScrGraphMode/ScrTextMode (Hercules/EGA font
//   and graphics-mode switching; FPC: empty / returns 0), IsAT (true), OpenXMS (XMSCachePages := 0),
//   OpenCache (FPC: FormatCache of NCachePages, RunError(624) when none), DetectVideoCard (FPC:
//   80x25 or TermSize, env FAND_SIZE "COLSxROWS", clamped to MaxTxtCols/MaxTxtRows, InstallWinch,
//   VGA, 16 bytes/char - here the size comes from the bound Crt screen), InitDrivers (BreakIntrInit,
//   AssignCrt(Output)), GetIntVec($3f, FandInt3f) (overlay interrupt - ignore), StackLimit.
// * Private routines (implementation section): InitDrivers, InitAccess, RdCFG
//   (+ RdColors: 3 video/colors blocks, picks by StartMode/VideoCard - VGA = 3; RdPrinter: prMax
//   printers of up to 33 length-prefixed strings + 4 bytes Typ/TmOut; RdWDaysTab: NWDaysTab,
//   WDaysFirst/WDaysLast (Real48!), WDaysTab), CompileHelpCatDcl (RdMsg 56 -> FANDHLP declaration,
//   RdMsg 52 -> Catalog; sets HelpFD, CatFD, CatRdbName..CatVolume field pointers, AfterCatFD mark),
//   SetTopDir (FSplit of the task path, TopRdbDir/TopDataDir (env FANDDATA), ChDir, catalog path
//   length check, opens CatFD Exclusive under NewExit), DoBatch (FPC), RunRdb, SelectRunRdb,
//   CallInstallRdb, CallEditTxt, SelectEditTxt.
// * InitRunFand order matters: InitDrivers, InitAccess, InitDML, NewExit, env DMLADDR (refuse),
//   FANDWORK (WrkDir, FandWorkName .$$$/.X$$/.T$$), LANNODE, FAND.RES header (ResVersion, ResFile.A,
//   MsgIdx, FrstMsgPos), RdMsg(50) -> AbbrYes, RdCFG, colors/video, TWork/XWork zeroed, ss (WWMIX)
//   reset, TxtEdCtrl*Brk := false, InitMouseEvents, InitTxtEditor, OpenCache, CompileHelpCatDcl,
//   LoadVideoFont, OpenWorkH, OpenFandFiles(false); then FPC `if FandBatch then halt(DoBatch)`.
//   BP7 `NewExit(Ovr,er); exit;`: a GoExit nobody else catches ends InitRunFand (= the program).
// * Command line: ParamStr(1) = task path ('*.' = select from disk), ParamStr(2) = 'D' (test run,
//   then the menu), 'T' (edit text file ParamStr(1)); otherwise run the task and exit. Without a
//   task: the desktop (FandFace from FAND.RES, version line RdMsg 41 + "(LAN,~GRAPH,...)" flags,
//   licence RdMsg 40) and the main menu RdMsg(2) (TMenuBoxS): 1 test run, 2 run, 3 install,
//   4 edit text, 5 OS shell, 0/6 quit (CloseH(WorkHandle), CloseFandFiles).
// * Messages before FAND.CFG is read ('Invalid FAND.CFG', 'FAND.RES incorr. version', CPath +
//   ' not found') use writeln + wait + halt(1) -> throw HaltSignal(1) after showing them.
// * SetTopDir keeps the FPC catalogue path-length check (message 'cesta je příliš dlouhá pro
//   katalog'): a task directory longer than CatPathName^.L - 18 characters is refused.

import * as nodePath from 'node:path';
import {
  GoExitSignal, Halt, TxtWrite, TxtWriteln, TxtRewrite, Output, ref, fref, ValI, StrI, Copy, FSplit, GetEnv,
  ParamStr, ToUnicode, FromUnicode, BytesToStr, getWord, type Ref, type Pointer, type PathStr, type NameStr,
  type ExtStr,
} from './pasrt.ts';
import {
  BaseVars, ExitRecord, ResVersion, SizeOfResA, SizeOfMsgIdxItem, MsgIdxFromBytes, SizeOfSpec, SizeOfVideo,
  SizeOfColors, SizeOfFonts, LoadSpec, LoadVideo, LoadColors, LoadFonts, RdMsg, SetMsgPar, NewExit, RestoreExit,
  MarkStore, MarkStore2, ReleaseStore2, FormatCache, OpenWorkH, OpenH, ReadH, SeekH, PosH, CloseH, MyFExpand,
  AddBackSlash, DelBackSlash, SetCurrPrinter, SEquUpcase, OSshell, wait, UnixPath,
  WHasFrame, WDoubleFrame, Ega8x14K, Ega8x14L, Vga8x16K, Vga8x16L, FandFace, _isoldfile, RdOnly, Exclusive,
} from './base.ts';
import { DosView, DosFExpand, GetDirDos, HostToDos } from './handle.ts';
import { readReal48 } from '../fand/numbers.ts';
import { AccessVars, FloppyDrives, ResetCompilePars, TFile, XWFile } from './access.ts';
import {
  DriversVars, BreakIntrInit, TermSize, InstallWinch, AssignCrt, ClrEvent, InitMouseEvents, LoadVideoFont, Window,
  GotoXY, ScrClr, ScrWrStr, MaxTxtCols, MaxTxtRows, viVga, viEga, viHercules, foKamen,
} from './drivers.ts';
import { RdRunVars } from './rdrun.ts';
import { OpenF, CloseFile, OpenFANDFiles, CloseFANDFiles } from './oaccess.ts';
import { WrLLF10Msg, WrLLF10MsgLine, WriteWFrame, RunError, PushW, PopW } from './obaseww.ts';
import { IsIdentifStr, SetInpStr } from './compile.ts';
import { RdFileD } from './rdfildcl.ts';
import { InitTxtEditor, EditTxtFile } from './editor.ts';
import { RunEdiVars } from './runedi.ts';
import { TrailChar } from './runfrml.ts';
import { TMenuBoxS } from './wwmenu.ts';
import { WwMixVars, SelectDiskFile } from './wwmix.ts';
import { EditExecRdb, InstallRdb, ChDir } from './runproj.ts';
import { FandBatchRun } from './runbatch.ts';
import { InitDML } from './dml.ts';

/** TS-only: write(...) / writeln(...) to the CRT (System.Output). */
function write(...S: string[]): void {
  TxtWrite(Output, ...S);
}
function writeln(...S: string[]): void {
  TxtWriteln(Output, ...S);
}
/** TS-only: DOS.FExpand on an engine path (DOS-style input mapped by UnixPath). */
function FExpand(Path: string): string {
  if (DosView.On) return DosFExpand(Path);
  const u = ToUnicode(UnixPath(Path));
  let r = nodePath.resolve(u);
  if ((u === '' || u.endsWith('/') || u.endsWith(nodePath.sep)) && !r.endsWith(nodePath.sep)) r += nodePath.sep;
  return FromUnicode(r);
}

// PAS: RUNFAND.PAS Ovr (overlay fix-up; FPC: empty)
function Ovr(): void {}

// PAS: RUNFAND.PAS ScrGraphMode – FPC: no-op
export function ScrGraphMode(Redraw: boolean, OldScrSeg: number): void {}
// PAS: RUNFAND.PAS ScrTextMode – FPC: returns 0
export function ScrTextMode(Redraw: boolean, Switch: boolean): number {
  return 0;
}

// { ********* Init FAND ***************** }

// PAS: RUNFAND.PAS IsAT (FPC)
function IsAT(): boolean {
  return true;
}
// PAS: RUNFAND.PAS OpenXMS (FPC)
function OpenXMS(): void {
  BaseVars.XMSCachePages = 0;
}
// PAS: RUNFAND.PAS OpenCache (FPC)
function OpenCache(): void {
  const bv = BaseVars;
  bv.CachePageSize = 1 << bv.CachePageShft;
  bv.CachePageSz = Math.trunc(bv.CachePageSize / 16) + 1;
  bv.InitStackSz = 2 * bv.CachePageSz;
  bv.MinStackSz = 4 * bv.CachePageSz;
  bv.InitStack2Sz = bv.CachePageSz;
  bv.MinStack2Sz = bv.CachePageSz;
  bv.XMSCacheRoot = null;
  bv.XMSCachePages = 0;
  bv.MyHeapOrg = null;
  bv.MemEnd = null;
  FormatCache();
  if (bv.NCachePages === 0) RunError(624);
}
// PAS: RUNFAND.PAS DetectVideoCard (FPC)
function DetectVideoCard(): void {
  const dv = DriversVars;
  const bv = BaseVars;
  dv.StartAttr = 0x07;
  dv.TextAttr = 0x07;
  dv.StartMode = 3;
  const c = ref(80), r = ref(25);
  TermSize(c, r);
  const s = GetEnv('FAND_SIZE');
  if (s !== '') {
    let v = 0;
    let i = 0;
    while (i < s.length && s[i] >= '0' && s[i] <= '9') {
      v = v * 10 + (s.charCodeAt(i) - 48);
      i++;
    }
    if (v >= 80) c.v = v;
    if (i < s.length && (s[i] === 'x' || s[i] === 'X')) {
      i++;
      v = 0;
      while (i < s.length && s[i] >= '0' && s[i] <= '9') {
        v = v * 10 + (s.charCodeAt(i) - 48);
        i++;
      }
      if (v >= 25) r.v = v;
    }
  }
  if (c.v > MaxTxtCols) c.v = MaxTxtCols;
  if (r.v > MaxTxtRows) r.v = MaxTxtRows;
  bv.TxtCols = c.v;
  bv.TxtRows = r.v;
  InstallWinch();
  dv.VideoCard = viVga;
  dv.BytesPerChar = 16;
  dv.WindMin.X = 0;
  dv.WindMin.Y = 0;
  dv.WindMax.X = c.v - 1;
  dv.WindMax.Y = r.v - 1;
  dv.NrVFont = 0;
  dv.IsGraphMode = false;
  dv.Crs.X = 0;
  dv.Crs.Y = 0;
  dv.ScrSeg = 0;
  dv.ChkSnow = false;
}

// PAS: RUNFAND.PAS InitDrivers
function InitDrivers(): void {
  BreakIntrInit();
  DetectVideoCard();
  AssignCrt(Output);
  TxtRewrite(Output);
  ClrEvent();
}
// PAS: RUNFAND.PAS InitAccess
function InitAccess(): void {
  ResetCompilePars();
  AccessVars.SpecFDNameAllowed = false;
  AccessVars.XWork = new XWFile();
}

// { ================================================================== }

// PAS: RUNFAND.PAS RdCFG
function RdCFG(): void {
  const bv = BaseVars;
  let CfgHandle = 0;
  const rd = (n: number): Uint8Array => {
    const b = new Uint8Array(n);
    ReadH(CfgHandle, n, b);
    return b;
  };
  function RdColors(): void {
    let typ: number;
    if (DriversVars.StartMode === 7) typ = 1;
    else if (DriversVars.VideoCard >= viEga) typ = 3;
    else typ = 2;
    SeekH(CfgHandle, PosH(CfgHandle) + (SizeOfVideo + SizeOfColors) * (typ - 1));
    LoadVideo(rd(SizeOfVideo));
    LoadColors(rd(SizeOfColors));
    SeekH(CfgHandle, PosH(CfgHandle) + (SizeOfVideo + SizeOfColors) * (3 - typ));
  }
  function Invalid(): never {
    writeln('Invalid FAND.CFG');
    wait();
    return Halt(1);
  }
  function RdPrinter(): void {
    const NPrintStrg = 32;
    bv.prMax = rd(1)[0];
    for (let j = 1; j <= bv.prMax; j++) {
      const A: number[] = [];
      let n = 0;
      for (let i = 0; i <= NPrintStrg; i++) {
        const l = rd(1)[0];
        if (l === 0xff) Invalid();
        A.push(l);
        const b = rd(l);
        for (let k = 0; k < l; k++) A.push(b[k]);
        n += l + 1;
      }
      const l = rd(1)[0];
      if (l !== 0xff) Invalid();
      const pr = bv.printer[j - 1];
      pr.Strg = Uint8Array.from(A.slice(0, n));
      const t = rd(4);
      pr.Typ = String.fromCharCode(t[0]);
      pr.Kod = String.fromCharCode(t[1]);
      pr.Lpti = t[2];
      pr.TmOut = t[3];
      pr.Handle = 0xff;
      pr.OpCls = false;
      pr.ToHandle = false;
      pr.ToMgr = false;
      if (pr.TmOut === 255) {
        pr.OpCls = true;
        pr.TmOut = 0;
      } else if (pr.TmOut === 254) {
        pr.ToHandle = true;
        pr.TmOut = 0;
      } else if (pr.TmOut === 253) {
        pr.ToMgr = true;
        pr.TmOut = 0;
      }
    }
    SetCurrPrinter(0);
  }
  function RdWDaysTab(): void {
    bv.NWDaysTab = getWord(rd(2), 0);
    bv.WDaysFirst = readReal48(rd(6), 0); // BP7 Real48
    bv.WDaysLast = readReal48(rd(6), 0);
    const t = rd(bv.NWDaysTab * 3);
    bv.WDaysTab = [{ Typ: 0, Nr: 0 }];
    for (let i = 0; i < bv.NWDaysTab; i++) bv.WDaysTab.push({ Typ: t[i * 3], Nr: getWord(t, i * 3 + 1) });
  }

  bv.CVol = '';
  bv.CPath = MyFExpand('FAND.CFG', 'FANDCFG');
  CfgHandle = OpenH(_isoldfile, RdOnly);
  if (bv.HandleError !== 0) {
    write(bv.CPath + ' not found');
    wait();
    Halt(1);
  }
  const ver = BytesToStr(rd(4));
  if (ver !== bv.CfgVersion) {
    write('Invalid version of FAND.CFG');
    wait();
    Halt(1);
  }
  LoadSpec(rd(SizeOfSpec));
  RdColors();
  LoadFonts(rd(SizeOfFonts));
  bv.CharOrdTab.set(rd(256));
  bv.UpcCharTab.set(rd(256));
  RdPrinter();
  RdWDaysTab();
  CloseH(CfgHandle);
}

// PAS: RUNFAND.PAS CompileHelpCatDcl
function CompileHelpCatDcl(): void {
  const av = AccessVars;
  av.FileDRoot = null;
  av.CRdb = null;
  const p2 = ref<Pointer>(null);
  MarkStore2(p2);
  RdMsg(56);
  SetInpStr(ref(BaseVars.MsgLine));
  RdFileD('FANDHLP', '6', '');
  av.HelpFD = av.CFile;
  RdMsg(52);
  SetInpStr(ref(BaseVars.MsgLine));
  RdFileD('Catalog', 'C', '');
  av.CatFD = av.CFile;
  av.FileDRoot = null;
  av.CatRdbName = av.CatFD!.FldD;
  av.CatFileName = av.CatRdbName!.Chain;
  av.CatArchiv = av.CatFileName!.Chain;
  av.CatPathName = av.CatArchiv!.Chain;
  av.CatVolume = av.CatPathName!.Chain;
  MarkStore(fref(BaseVars, 'AfterCatFD'));
  ReleaseStore2(p2.v);
}

// { **************  Run FAND  ************************************** }

const CatPathTail = 18;
// PAS: RUNFAND.PAS SetTopDir (exported TS-only, for InitFandSession users)
export function SetTopDir(p: PathStr, n: Ref<NameStr>): boolean {
  const av = AccessVars;
  const bv = BaseVars;
  const d = ref(''), e = ref<ExtStr>('');
  FSplit(FExpand(p), d, n, e);
  av.TopRdbDir = d.v;
  if (!IsIdentifStr(n.v)) {
    WrLLF10Msg(881);
    return false;
  }
  RdRunVars.EditDRoot = null;
  av.LinkDRoot = null;
  av.FuncDRoot = null;
  av.TopDataDir = GetEnv('FANDDATA');
  const t1 = ref(av.TopRdbDir), t2 = ref(av.TopDataDir);
  DelBackSlash(t1);
  DelBackSlash(t2);
  av.TopRdbDir = t1.v;
  av.TopDataDir = t2.v;
  if (av.TopDataDir !== '') av.TopDataDir = FExpand(av.TopDataDir);
  if (ChDir(av.TopRdbDir) !== 0) {
    SetMsgPar(p);
    WrLLF10Msg(703);
    return false;
  }
  if (av.CatPathName !== null && av.TopRdbDir.length + CatPathTail > av.CatPathName.L) {
    const s1 = StrI(av.TopRdbDir.length + CatPathTail);
    const s2 = StrI(av.CatPathName.L);
    bv.MsgLine = 'cesta je p\xfd\xa1li\xe7 dlouh\xa0 pro katalog: ' + s1 + ' > ' + s2 + ' znak\x85';
    WrLLF10MsgLine();
    return false;
  }
  av.CatFDName = n.v;
  let result = false;
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    av.CFile = av.CatFD;
    OpenF(Exclusive);
    result = true;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) {
      RestoreExit(er);
      throw e;
    }
  }
  // 1:
  RestoreExit(er);
  return result;
}
// PAS: RUNFAND.PAS DoBatch (FPC)
function DoBatch(): number {
  if (ParamStr(1) === '--help' || ParamStr(3) === '') return FandBatchRun('--help', '', '');
  const n = ref<NameStr>('');
  if (!SetTopDir(ParamStr(1), n)) return 1;
  const rc = FandBatchRun(n.v, ParamStr(2), ParamStr(3));
  AccessVars.CFile = AccessVars.CatFD;
  CloseFile();
  return rc;
}
// PAS: RUNFAND.PAS RunRdb
function RunRdb(p: PathStr): void {
  const n = ref<NameStr>('');
  if (p !== '' && SetTopDir(p, n)) {
    EditExecRdb(n.v, 'main', null);
    AccessVars.CFile = AccessVars.CatFD;
    CloseFile();
  }
}
// PAS: RUNFAND.PAS SelectRunRdb
function SelectRunRdb(OnFace: boolean): void {
  const p = SelectDiskFile('.RDB', 34, OnFace);
  RunRdb(p);
}
// PAS: RUNFAND.PAS CallInstallRdb
function CallInstallRdb(): void {
  const p = SelectDiskFile('.RDB', 35, true);
  const n = ref<NameStr>('');
  if (p !== '' && SetTopDir(p, n)) {
    InstallRdb(n.v);
    AccessVars.CFile = AccessVars.CatFD;
    CloseFile();
  }
}
// PAS: RUNFAND.PAS CallEditTxt
function CallEditTxt(): void {
  BaseVars.CPath = FExpand(BaseVars.CPath);
  BaseVars.CVol = '';
  EditTxtFile(null, 'T', '', null, 1, 0, null, 0, '', 0, null);
}
// PAS: RUNFAND.PAS SelectEditTxt
function SelectEditTxt(E: ExtStr, OnFace: boolean): void {
  BaseVars.CPath = SelectDiskFile(E, 35, OnFace);
  if (BaseVars.CPath === '') return;
  CallEditTxt();
}

// PAS: RUNFAND.PAS InitRunFand – the whole FAND session (returns when the user quits)
export function InitRunFand(): void {
  InitDrivers();
  BaseVars.WasInitDrivers = true;
  InitAccess();
  InitDML(); // {$ifdef FandDML}
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    RunFandBody();
  } catch (e) {
    // BP7 `NewExit(Ovr,er); exit;`: an uncaught GoExit ends InitRunFand
    if (!(e instanceof GoExitSignal)) throw e;
  }
}

/** TS-only: the part of InitRunFand after its NewExit. */
function RunFandBody(): void {
  InitFandBody();
  RunFandCmdLine();
}

/**
 * TS-only: InitRunFand up to the command line – drivers, FAND.RES, FAND.CFG, work files, cache, help
 * and catalog declarations – without running a task or the desktop. For tests and tools that drive
 * the project manager themselves (SetTopDir, CreateOpenChpt, CompileRdb); the caller provides the
 * NewExit frame.
 */
export function InitFandSession(): void {
  InitDrivers();
  BaseVars.WasInitDrivers = true;
  InitAccess();
  InitDML(); // {$ifdef FandDML}
  InitFandBody();
}

/** TS-only: RunFandBody up to OpenFANDFiles. */
function InitFandBody(): void {
  const bv = BaseVars;
  const av = AccessVars;
  const dv = DriversVars;
  bv.OldPrTimeOut = [...bv.PrTimeOut];
  bv.CallOpenFandFiles = OpenFANDFiles;
  bv.CallCloseFandFiles = CloseFANDFiles;
  bv.Video.cursOn = 0x0607; // if exit before reading .CFG
  dv.KbdBuffer = '';
  bv.F10SpecKey = 0;
  if (GetEnv('DMLADDR') !== '') {
    writeln("type 'exit' to return to FAND");
    wait();
    Halt(1);
  }
  const wd = ref(GetEnv('FANDWORK'));
  if (wd.v === '') wd.v = bv.FandDir;
  AddBackSlash(wd);
  bv.WrkDir = wd.v;
  const s0 = bv.WrkDir + 'FANDWORK';
  bv.FandWorkName = s0 + '.$$$';
  bv.FandWorkXName = s0 + '.X$$';
  bv.FandWorkTName = s0 + '.T$$';
  bv.LANNode = 0;
  let s = GetEnv('LANNODE');
  s = TrailChar(' ', s);
  if (s !== '') {
    const nb = ref(0), err = ref(0);
    ValI(s, nb, err);
    nb.v &= 0xff;
    if (nb.v <= 3) if (err.v === 0) bv.LANNode = nb.v;
  }
  const h = bv.ResFile.Handle;
  const b2 = new Uint8Array(2);
  ReadH(h, 2, b2);
  if (getWord(b2, 0) !== ResVersion) {
    writeln('FAND.RES incorr. version');
    wait();
    Halt(1);
  }
  bv.OvrHandle = h - 1;
  const ba = new Uint8Array(SizeOfResA);
  ReadH(h, SizeOfResA, ba);
  bv.ResFile.SetA(ba);
  ReadH(h, 2, b2);
  bv.MsgIdxN = getWord(b2, 0);
  const l = SizeOfMsgIdxItem * bv.MsgIdxN;
  const bi = new Uint8Array(l);
  ReadH(h, l, bi);
  bv.MsgIdx = MsgIdxFromBytes(bi, bv.MsgIdxN);
  bv.FrstMsgPos = PosH(h);
  RdMsg(50);
  bv.AbbrYes = bv.MsgLine[0] ?? bv.AbbrYes;
  bv.AbbrNo = bv.MsgLine[1] ?? bv.AbbrNo;
  RdCFG();
  bv.ProcAttr = bv.Colors.uNorm;
  dv.ScrSeg = bv.Video.address;
  if (bv.Video.TxtRows !== 0) bv.TxtRows = bv.Video.TxtRows;
  if (bv.Fonts.LoadVideoAllowed && dv.VideoCard >= viEga) {
    switch (dv.BytesPerChar) {
      case 14:
        dv.NrVFont = bv.Fonts.VFont === foKamen ? Ega8x14K : Ega8x14L;
        break;
      case 16:
        dv.NrVFont = bv.Fonts.VFont === foKamen ? Vga8x16K : Vga8x16L;
        break;
    }
  }

  // Access
  // GetIntVec($3f,FandInt3f): overlay interrupt, not needed
  av.XWork = new XWFile();
  av.TWork = new TFile();
  av.CRdb = null;
  for (let i = 1; i <= FloppyDrives; i++) av.MountedVol[i] = '';
  // Ww
  WwMixVars.ss.Empty = true;
  WwMixVars.ss.PointTo = null;
  RunEdiVars.TxtEdCtrlUBrk = false;
  RunEdiVars.TxtEdCtrlF4Brk = false;
  InitMouseEvents();
  // Editor
  InitTxtEditor();
  //
  OpenCache();

  bv.WasInitPgm = true;
  CompileHelpCatDcl();
  LoadVideoFont();
  if (dv.VideoCard === viHercules && bv.Fonts.LoadVideoAllowed) {
    ScrGraphMode(false, 0);
    dv.BGIReload = false;
  }

  OpenWorkH();
  OpenFANDFiles(false);
}

/** TS-only: RunFandBody from the FPC batch test on: the command line, then the desktop menu. */
function RunFandCmdLine(): void {
  const bv = BaseVars;
  const av = AccessVars;
  const dv = DriversVars;
  // {$ifdef FPC}
  if (dv.FandBatch) Halt(DoBatch());

  if (ParamStr(1) !== '' && ParamStr(1) !== '?') {
    let runIt = false;
    if (SEquUpcase(ParamStr(2), 'D')) {
      av.IsTestRun = true;
      runIt = true; // goto 0
    } else if (SEquUpcase(ParamStr(2), 'T')) {
      bv.CPath = ParamStr(1);
      if (Copy(bv.CPath, 1, 2) === '*.') SelectEditTxt(Copy(bv.CPath, 2, 4), false);
      else CallEditTxt();
      return;
    } else runIt = true;
    if (runIt) {
      // 0:
      if (Copy(ParamStr(1), 1, 2) === '*.') SelectRunRdb(false);
      else RunRdb(ParamStr(1));
      if (av.IsTestRun) av.IsTestRun = false;
      else return;
    }
  }

  dv.TextAttr = bv.Colors.DesktopColor;
  Window(1, 1, bv.TxtCols, bv.TxtRows - 1);
  WriteWFrame(WHasFrame + WDoubleFrame, '', '');
  ScrClr(1, 1, bv.TxtCols - 2, bv.TxtRows - 13, '\xb1', dv.TextAttr);
  ScrClr(1, bv.TxtRows - 12, bv.TxtCols - 2, 10, '\xb2', dv.TextAttr);
  const pf = ref<Uint8Array | null>(null);
  bv.ResFile.Get(FandFace, pf);
  const face = pf.v!;
  let xofs = 1; // inc(PByte(x))
  for (let i = -11; i <= -6; i++) {
    // x^[0] := char(TxtCols-2): the row is the TxtCols-2 bytes after x
    const len = bv.TxtCols - 2;
    let row = '';
    for (let k = 1; k <= len; k++) row += String.fromCharCode(face[xofs + k] ?? 0x20);
    ScrWrStr(1, bv.TxtRows + i, row, dv.TextAttr);
    xofs += 82;
  }
  dv.TextAttr = bv.Colors.mHili;
  ScrClr(3, bv.TxtRows - 4, bv.TxtCols - 6, 1, ' ', dv.TextAttr);
  RdMsg(41);
  let txt = '';
  txt = 'LAN,'; // {$ifdef FandNetV}
  txt = txt + '~GRAPH,'; // {$ifndef FandGraph}
  if (txt !== '') {
    txt = txt.slice(0, -1) + ')';
    bv.MsgLine = bv.MsgLine + 'x (' + txt;
  } else bv.MsgLine = bv.MsgLine + 'x';
  GotoXY(5, bv.TxtRows - 3);
  write(bv.MsgLine);
  if (bv.TxtCols >= 80) {
    RdMsg(40);
    GotoXY(51, bv.TxtRows - 3);
    const lic = StrI(bv.UserLicNrShow);
    write(bv.MsgLine, lic.length < 7 ? ' '.repeat(7 - lic.length) + lic : lic);
  }
  // 2: FreeMem(p,faceLen)
  const MsgNr = 2;

  RdMsg(MsgNr);
  const mb = new TMenuBoxS().Init(4, 3, bv.MsgLine);
  let i = 1;
  for (;;) {
    // 1:
    i = mb.Exec(i);
    const j = i;
    const w = PushW(1, 1, bv.TxtCols, bv.TxtRows);
    switch (j) {
      case 1:
        av.IsTestRun = true;
        SelectRunRdb(true);
        av.IsTestRun = false;
        break;
      case 2:
        SelectRunRdb(true);
        av.IsTestRun = false;
        break;
      case 3:
        av.IsInstallRun = true;
        CallInstallRdb();
        av.IsInstallRun = false;
        break;
      case 4:
        SelectEditTxt('.TXT', true);
        break;
      case 5:
        OSshell('', '', false, true, true, true);
        break;
      case 0:
      case 6:
        CloseH(bv.WorkHandle);
        CloseFANDFiles(false);
        return;
    }
    PopW(w);
  }
}

void IsAT;
void OpenXMS;
