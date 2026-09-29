// PAS: RUNPROC.PAS – the procedure interpreter: RunInstr walks the Instr chain produced by RDPROC,
// CallProcedure compiles and runs a procedure chapter with its parameters and local variables.
//
// Porting notes:
// * asm/DOS: Ovr (overlay stack fix-up, no-op); ExecPgm reads the cursor with int $10 AH=3 in BP7
//   (FPC: WhereX/WhereY + WindMin) and runs OSShell (FANDDOS batch interpreter in FPC; it may leave
//   FandDosNotice to show in the last line); PortOut (`portout`: FPC no-op); MemDiagProc (FPC prints
//   XMSCachePages); graphics (DrawProc, WithGraphicsProc) are not in the FPC build ->
//   NoGraphicsProc message "grafika není v této verzi k dispozici"; SQL (SQLProc, StartLogIn,
//   SQLRdWrTxt) is off (no FandSQL). DrawProc exists only with FandGraph (off): not ported.
// * FPC-only debug traces: RvTrace (env FAND_RV_TRACE: record-variable allocation log) is dropped
//   (it prints host addresses); ITrc (env FAND_TRACE_INSTR: one PInstrCode ordinal per executed
//   instruction) is kept – handy to diff against the reference binary.
// * Key global state (none of its own): BaseVars.ExitP/BreakP (exit/break of loops and procedures),
//   BaseVars.MyBP/ProcMyBP (frames, PORTING.md 14), AccessVars.CFile/CRecPtr, LinkDRoot/FileDRoot
//   (restored after a call), RdRunVars (EditDRoot, PrintView, LVBD ...).
// * Variant overlays of Instr used here: `with PD^ do LVAssignFrml(LV,..)` of _asgnloc reads the
//   _readrec field LV, which overlays AssLV (same offset) -> PD.AssLV; HelpProc's PD^.HelpRdb
//   overlays HelpRdb0 (RDPROC sets HelpRdb). A `_display` of a help text named by an expression
//   keeps the formula in Pos.Frml (Pascal casts it into Pos.R). TypAndFrml 'f': Name<>nil is the
//   Pascal RecPtr<>nil test. ForAllProc COwnerTyp 'F': the record-number formula is stored in the
//   LocVarPtr CLV (a cast, as in RDPROC).
// * Tricky parts:
//   - CallProcedure *compiles the procedure at every call*: SetInpTT(PD^.Pos) + ReadProcHead,
//     PushProcStk, binds the arguments PD^.TArg[1..N] (FTyp 'r'/'i' records/indexes by pointer, 'f'
//     file parameters may compile a file declaration from a string via RdFileD('6','$'), else
//     LVAssignFrml with the caller frame), allocates 'r' record variables, ReadProcBody, runs it, then
//     copies back IsRetPar results ('R','S' swaps TWork positions,'B'), clears/closes local records
//     and indexes, PopProcStk, closes and unchains files declared inside (after lstFD).
//     Error 119 = parameter mismatch (goto 1).
//   - ReportProc: NewExit around ReadReport when SyntxChk; PrintView -> EditTxtFile of the
//     print file afterwards.
//   - ForAllProc: scans a file (key, KeyIn ranges, owner link, record variable 'lr'), locks per
//     record, supports `with` of a record variable and SQL cursors (off).
//   - WithLockedProc: LockD list, retries with a prompt; UnLck restores modes.
//   - RunInstr: case over PInstrCode (rdrun.ts PInstrCodeNames); _lproc -> RUNPROLG.RunProlog.
// * Private routines: UserHeadLine, ReportProc.PromptAutoRprt, AssignField, AssignRecVar,
//   AssignRecFld, SortProc, MergeProc, WritelnProc, DisplayProc, ClrWwProc, ExecPgm, CallRdbProc,
//   IndexfileProc, MountProc, EditProc, EditTxtProc (+ GetStr), PrintTxtProc, SrchXKey,
//   DeleteRecProc, RecallRecProc, AppendRecProc, UpdRec, ReadWriteRecProc, LinkRecProc, ForAllProc,
//   HeadLineProc, SetKeyBufProc, SetWwViewPort, WithWindowProc, WithLockedProc (+ UnLck), HelpProc,
//   OpenHForPutTxt, PutTxt, AssgnCatFld, AssgnAccRight, AssgnUserName, ReleaseDriveProc,
//   WithGraphicsProc, NoGraphicsProc, PortOut, WaitProc, MemDiagProc, ITrc.

import fs from 'node:fs';
import {
  ref, fref, chr, ord, word, byte, int16, ShortStr, StrR, UpCase, CopyRec, GoExitSignal, TxtWrite, TxtWriteln, Output,
  GetEnv, ToUnicode, type Ref,
} from './pasrt.ts';
import { WRect, type LongStrPtr } from './base.ts';
import {
  BaseVars, StrDate, Today, LenStyleStr, WrStyleStr, WrLongStyleStr, SetMsgPar, Set2MsgPar, NewExit,
  RestoreExit, ExitRecord, GoExit, OSshell, wait, LastInChain, SetCurrPrinter, OpenH, SeekH, FileSizeH, WriteH,
  CloseH, StoreStr, SaveCache, WNoClrScr, WNoPop, _isoverwritefile, _isoldnewfile, Exclusive, Shared,
  type ProcStkPtr,
} from './base.ts';
import {
  AccessVars, FloppyDrives, f_Stored, RdMode, WrMode, CrMode, DelMode, ExclMode, NullMode, LockModeTxt, XString,
  XScan, RunErrorM, GetRecSpace, SetUpdFlag, ClearUpdFlag, HasUpdFlag, DeletedFlag, SetDeletedFlag,
  ClearDeletedFlag, SetTWorkFlag, HasTWorkFlag, CodingLongStr, LocVarAd, ForAllFDs, NewLMode, OldLMode,
  TryLMode, TryLockN, UnLockN, CloseClearHCFile, XFNotValid, TestCPathError, TestXFExist, IncNRecs, PutRec,
  ReadRec, WriteRec, CreateRec, DeleteRec, AsgnParFldFrml, SearchKey, LinkUpw, AssignNRecs, ZeroAllFlds,
  DelTFlds, CopyRecWithT, ClearRecSpace, DelAllDifTFlds, RecallRec, DeleteXRec, OverwrXRec, S_, R_, B_, _T,
  _getlocvar,
  type FileDPtr, type FrmlPtr, type KeyDPtr, type KeyFldDPtr, type LocVarPtr, type RdbDPtr,
  type RdbPos, type LockMode, type XWKey,
} from './access.ts';
import {
  RdRunVars, SetMyBP, PushProcStk, PopProcStk, RunAddUpdte, _zero, _output,
  _menubox, _menubar, _ifthenelseP, _whiledo, _repeatuntil, _break, _exit, _cancel, _save, _closefds, _window,
  _clrscr, _clrww, _clreol, _gotoxy, _display, _writeln, _setkeybuf, _clearkeybuf, _headline, _call, _exec,
  _copyfile, _proc, _lproc, _merge, _sort, _edit, _report, _edittxt, _printtxt, _puttxt, _asgnloc, _asgnpar,
  _asgnfield, _asgnedok, _asgnrand, _asgnusertoday, _randomize, _asgnusercode, _asgnusername, _asgnaccright,
  _asgnxnrecs, _asgnnrecs, _asgncatfield, _asgnrecfld, _asgnrecvar, _asgnclipbd, _turncat, _appendrec,
  _deleterec, _recallrec, _readrec, _writerec, _linkrec, _releasedrive, _mount, _indexfile, _getindex, _forall,
  _withshared, _withlocked, _withgraphics, _memdiag, _wait, _delay, _beep, _sound, _nosound, _help, _setprinter,
  _graph, _putpixel, _line, _rectangle, _ellipse, _floodfill, _outtextxy, _backup, _backupm, _resetcat,
  _setedittxt, _setmouse, _checkfile, _portout,
  type InstrPtr, type Instr, type RprtOptPtr, type AssignDPtr, type EditOptPtr, type PInstrCode, type LockDPtr,
  type WrLnDPtr,
} from './rdrun.ts';
import {
  RunBool, RunReal, RunInt, RunShortStr, RunLongStr, RunWFrml, RunWordImpl, RunEvalFrml, AssgnFrml,
  LVAssignFrml, CanCopyT, Randomize, RunFrmlVars,
} from './runfrml.ts';
import {
  PushWParam, PopWParam, PushW, PopW, PopW2, PushWFramed, PushWrLLMsg, WrLLMsgTxt, WrLLF10MsgLine, WrLLF10Msg,
  RunMsgOn, RunMsgN, RunMsgOff,
} from './obaseww.ts';
import {
  SaveFiles, ClosePassiveFD, OpenF1, OpenF2, OpenCreateF, CloseFile, TestMountVol, ReleaseDrive, GetCatIRec,
  TurnCat, RdCatField, WrCatField, SetCPathVol, SetTxtPathVol, OpenDuplF, SubstDuplF, RdCatPathVol,
} from './oaccess.ts';
import { CopyTFStringToH } from './olongstr.ts';
import { SetPrintTxtPath } from './obase.ts';
import {
  DriversVars, GotoXY, WhereX, WhereY, Window, ClrScr, ClrEol, ScrClr, CrsGet, CrsSet, beep, Delay, Sound,
  NoSound, GetEvent, ClrEvent, SetMouse, KbdTimer, ClearKbdBuf, evKeyDown, evMouseDown, _F1_,
} from './drivers.ts';
import { MenuBoxProc, MenuBarProc, GetHlpText } from './wwmenu.ts';
import { SelMark, PutSelect, SelFieldList, PromptFilter } from './wwmix.ts';
import { SaveCompState, RestoreCompState, SetInpTT, SetInpLongStr, Error } from './compile.ts';
import { RdFileD } from './rdfildcl.ts';
import { ReadProcHead, ReadProcBody, GetPInstr } from './rdproc.ts';
import { ReadMerge } from './rdmerg.ts';
import { ReadReport } from './rdrprt.ts';
import { SortAndSubst, ScanSubstWIndex, GetIndex } from './sort.ts';
import { RunMerge } from './runmerg.ts';
import { RunReport } from './runrprt.ts';
import { SelForAutoRprt, RunAutoReport } from './genrprt.ts';
import { PrintArray, PrintTxtFile } from './printtxt.ts';
import { EditTxtFile, SetEditTxt, Help, MsgStr } from './editor.ts';
import { CopyFile, Backup, BackupM, CheckFile } from './expimp.ts';
import { SelFldsForEO, EditDataFile } from './runedi.ts';
import { EditExecRdb } from './projmgr.ts';
import { ScrGraphMode, ScrTextMode } from './runfand.ts';
import { RunProlog } from './runprolg.ts';
import { FandDosVars } from './fanddos.ts';

// PAS: RUNPROC.PAS Ovr – BP7 overlay stack fix-up for NewExit (FPC: empty)
function Ovr(): void {}

// PAS: RUNPROC.PAS UserHeadLine – the first screen line: centred header and today's date
function UserHeadLine(UserHeader: string): void {
  const bv = BaseVars;
  const dv = DriversVars;
  const p = PushWParam(1, 1, bv.TxtCols, 1, true);
  dv.TextAttr = bv.Colors.fNorm;
  ClrEol();
  const maxlen = bv.TxtCols - 10;
  let l = LenStyleStr(UserHeader);
  if (l >= maxlen) {
    UserHeader = UserHeader.slice(0, maxlen);
    l = LenStyleStr(UserHeader);
  }
  const n = Math.trunc((bv.TxtCols - l) / 2);
  if (n > 0) TxtWrite(Output, ' '.repeat(n));
  WrStyleStr(UserHeader, bv.Colors.fNorm);
  GotoXY(bv.TxtCols - 10, 1);
  TxtWrite(Output, StrDate(Today(), 'DD.MM.YYYY'));
  PopWParam(p);
}

// PAS: RUNPROC.PAS ReportProc.PromptAutoRprt – user field selection and filter of an auto report
function PromptAutoRprt(RO: RprtOptPtr): void {
  const ro = RO!;
  const RO2 = CopyRec(ro);
  RO2.FDL = CopyRec(ro.FDL);
  let FL = ro.Flds;
  while (FL !== null) {
    const F = FL.FldD!;
    if ((F.Flg & f_Stored) !== 0) PutSelect(F.Name);
    else PutSelect(SelMark + F.Name);
    FL = FL.Chain;
  }
  AccessVars.CFile = ro.FDL.FD;
  if (!SelFieldList(36, true, fref(RO2, 'Flds'))) return;
  if (ro.FDL.Cond === null && !PromptFilter('', fref(RO2.FDL, 'Cond'), fref(RO2, 'CondTxt'))) return;
  if (SelForAutoRprt(RO2)) RunAutoReport(RO2);
}
// PAS: RUNPROC.PAS ReportProc – the REPORT instruction / auto report; Save: SaveFiles afterwards
export function ReportProc(RO: RprtOptPtr, Save: boolean): void {
  const a = AccessVars;
  const bv = BaseVars;
  const ro = RO!;
  RdRunVars.PrintView = false;
  if (ro.Flds === null) {
    SetInpTT(ro.RprtPos, true);
    if (ro.SyntxChk) {
      a.IsCompileErr = false;
      const er = new ExitRecord();
      NewExit(Ovr, er);
      try {
        ReadReport(RO);
        bv.LastExitCode = 0;
      } catch (e) {
        if (!(e instanceof GoExitSignal)) throw e;
        // 1:
      } finally {
        RestoreExit(er);
      }
      a.IsCompileErr = false;
      return; // goto 2
    }
    ReadReport(RO);
    RunReport(RO);
  } else {
    if (ro.WidthFrml !== null) ro.Width = RunInt(ro.WidthFrml);
    if (ro.Head !== null) ro.HeadTxt = RunLongStr(ro.Head);
    if (ro.UserSelFlds) PromptAutoRprt(RO);
    else RunAutoReport(RO);
  }
  const md = ro.Edit ? 'T' : 'V';
  if (Save) SaveFiles();
  if (RdRunVars.PrintView) {
    const w = PushW(1, 1, bv.TxtCols, bv.TxtRows);
    SetPrintTxtPath();
    EditTxtFile(null, md, '', null, 0, 0, null, 0, '', 0, null);
    PopW(w);
  }
  // 2:
}

// PAS: RUNPROC.PAS AssignField – FILE[recno].field := frml
function AssignField(PD: Instr): void {
  const a = AccessVars;
  a.CFile = PD.FD;
  const md = NewLMode(WrMode);
  const F = PD.FldD!;
  const N = RunInt(PD.RecFrml);
  let msg = 0;
  if (N <= 0 || N > a.CFile!.NRecs) msg = 640;
  else {
    a.CRecPtr = GetRecSpace();
    ReadRec(N);
    if (PD.Indexarg && !DeletedFlag()) msg = 627;
  }
  if (msg !== 0) {
    // 1:
    Set2MsgPar(a.CFile!.Name, F.Name);
    RunErrorM(md, msg);
  }
  AssgnFrml(F, PD.Frml, true, PD.Add);
  WriteRec(N);
  OldLMode(md);
}
// PAS: RUNPROC.PAS AssignRecVar – recvar1 := recvar2 (field by field, A = the assignment list)
function AssignRecVar(LV1: LocVarPtr, LV2: LocVarPtr, A: AssignDPtr): void {
  const a = AccessVars;
  const FD1 = LV1!.FD;
  const RP1 = LV1!.RecPtr as Uint8Array;
  const RP2 = LV2!.RecPtr as Uint8Array;
  while (A !== null) {
    switch (A.Kind) {
      case _zero: {
        const F = A.FldD!;
        a.CFile = FD1;
        a.CRecPtr = RP1;
        switch (F.FrmlTyp) {
          case 'S':
            S_(F, '');
            break;
          case 'R':
            R_(F, 0.0);
            break;
          default:
            B_(F, false);
        }
        break;
      }
      case _output:
        a.CFile = FD1;
        a.CRecPtr = RP1;
        A.Frml!.NewRP = RP2;
        AssgnFrml(A.OFldD, A.Frml, false, false);
        break;
    }
    A = A.Chain;
  }
  a.CFile = FD1;
  a.CRecPtr = RP1;
  SetUpdFlag();
}
// PAS: RUNPROC.PAS AssignRecFld – recvar.field := frml
function AssignRecFld(PD: Instr): void {
  const a = AccessVars;
  const F = PD.RecFldD;
  a.CFile = PD.AssLV!.FD;
  a.CRecPtr = PD.AssLV!.RecPtr as Uint8Array;
  SetUpdFlag();
  AssgnFrml(F, PD.Frml, HasTWorkFlag(), PD.Add);
}
// PAS: RUNPROC.PAS SortProc
function SortProc(FD: FileDPtr, SK: KeyFldDPtr): void {
  AccessVars.CFile = FD;
  const md = NewLMode(ExclMode);
  SortAndSubst(SK);
  AccessVars.CFile = FD;
  OldLMode(md);
  SaveFiles();
}
// PAS: RUNPROC.PAS MergeProc
function MergeProc(PD: Instr): void {
  SetInpTT(PD.Pos, true);
  ReadMerge();
  RunMerge();
  SaveFiles();
}
// PAS: RUNPROC.PAS WritelnProc – WRITE / WRITELN / MESSAGE
function WritelnProc(PD: Instr): void {
  const bv = BaseVars;
  let W: WrLnDPtr = PD.WD;
  const LF = PD.LF;
  let t = '';
  DriversVars.TextAttr = bv.ProcAttr;
  while (W !== null) {
    let x = '';
    let skip = false;
    switch (W.Typ) {
      case 'S':
        if (LF >= 2) t = ShortStr(t + RunShortStr(W.Frml));
        else {
          const S = RunLongStr(W.Frml);
          WrLongStyleStr(S, bv.ProcAttr);
        }
        skip = true; // goto 1
        break;
      case 'B':
        if (RunBool(W.Frml)) x = bv.AbbrYes;
        else x = bv.AbbrNo;
        break;
      case 'F': {
        const r = RunReal(W.Frml);
        if (byte(W.M) === 255) x = ShortStr(StrR(r, int16(W.N)));
        else x = ShortStr(StrR(r, int16(W.N), byte(W.M)));
        break;
      }
      case 'D':
        x = StrDate(RunReal(W.Frml), W.Mask ?? '');
        break;
    }
    if (!skip) {
      if (LF >= 2) t = ShortStr(t + x);
      else TxtWrite(Output, x);
    }
    // 1:
    W = W.Chain;
  }
  for (;;) {
    // 2:
    switch (LF) {
      case 1:
        TxtWriteln(Output);
        return;
      case 3:
        bv.F10SpecKey = _F1_;
      // 3: (falls through)
      case 2:
        SetMsgPar(t);
        WrLLF10Msg(110);
        if (DriversVars.KbdChar === _F1_) {
          Help(PD.mHlpRdb, RunShortStr(PD.mHlpFrml), false);
          continue; // goto 2
        }
        return;
      default:
        return;
    }
  }
}
// PAS: RUNPROC.PAS DisplayProc – DISPLAY of a help chapter (IRec) or a help text by name (Frml)
function DisplayProc(R: RdbDPtr, IRec: number, Frml: FrmlPtr): void {
  const a = AccessVars;
  let S: LongStrPtr | null;
  if (IRec === 0) {
    const i = ref(0);
    S = GetHlpText(a.CRdb, RunShortStr(Frml), true, i);
    if (S === null) return; // goto 1
  } else {
    a.CFile = R!.FD;
    a.CRecPtr = a.Chpt!.RecPtr;
    ReadRec(IRec);
    S = a.CFile!.TF!.Read(1, _T(a.ChptTxt));
    if (R!.Encrypted) S = CodingLongStr(S);
  }
  WrLongStyleStr(S, BaseVars.ProcAttr);
}
// PAS: RUNPROC.PAS ClrWwProc – CLRWW(window, attr, fill char)
function ClrWwProc(PD: Instr): void {
  const v = new WRect();
  RunWFrml(PD.W, 0, v);
  const a = RunWordImpl(PD.Attr, BaseVars.Colors.uNorm);
  let c = ' ';
  if (PD.FillC !== null) {
    const s = RunShortStr(PD.FillC);
    if (s.length > 0) c = s[0];
  }
  ScrClr(v.C1 - 1, v.R1 - 1, v.C2 - v.C1 + 1, v.R2 - v.R1 + 1, c, a);
}
// PAS: RUNPROC.PAS ExecPgm – EXEC(program, parameters, options)
function ExecPgm(PD: Instr): void {
  const bv = BaseVars;
  const dv = DriversVars;
  const wmin = { X: dv.WindMin.X, Y: dv.WindMin.Y };
  const wmax = { X: dv.WindMax.X, Y: dv.WindMax.Y };
  const crs = CrsGet();
  const w = PushW(1, 1, bv.TxtCols, 1);
  dv.WindMin.X = wmin.X;
  dv.WindMin.Y = wmin.Y;
  dv.WindMax.X = wmax.X;
  dv.WindMax.Y = wmax.Y;
  CrsSet(crs);
  const s = RunShortStr(PD.Param);
  const i = PD.ProgCatIRec;
  bv.CVol = '';
  let Prog: string;
  if (i !== 0) Prog = RdCatField(i, AccessVars.CatPathName);
  else Prog = PD.ProgPath ?? '';
  const b = OSshell(Prog, s, PD.NoCancel, PD.FreeMm, PD.LdFont, PD.TextMd);
  const x = byte(WhereX() + dv.WindMin.X - 1);
  const y = byte(WhereY() + dv.WindMin.Y - 1);
  PopW(w);
  GotoXY(x - dv.WindMin.X + 1, y - dv.WindMin.Y + 1);
  const fdv = FandDosVars;
  if (fdv.FandDosNotice !== '') {
    bv.MsgLine = fdv.FandDosNotice.slice(0, 255);
    fdv.FandDosNotice = '';
    WrLLF10MsgLine();
  }
  if (!b) GoExit();
}
// PAS: RUNPROC.PAS CallRdbProc – CALL(rdb, proc)
function CallRdbProc(PD: Instr): void {
  const bp = BaseVars.MyBP;
  const b = EditExecRdb(PD.RdbNm ?? '', PD.ProcNm ?? '', PD.ProcCall);
  SetMyBP(bp);
  if (!b) GoExit();
}
// PAS: RUNPROC.PAS IndexfileProc – INDEXFILE(file[, compress])
function IndexfileProc(FD: FileDPtr, Compress: boolean): void {
  const a = AccessVars;
  const cf = a.CFile;
  a.CFile = FD;
  const md = NewLMode(ExclMode);
  XFNotValid();
  a.CRecPtr = GetRecSpace();
  if (Compress) {
    const FD2 = OpenDuplF(false);
    for (let I = 1; I <= FD!.NRecs; I++) {
      a.CFile = FD;
      ReadRec(I);
      if (!DeletedFlag()) {
        a.CFile = FD2;
        PutRec();
      }
    }
    if (!SaveCache(0)) GoExit();
    a.CFile = FD;
    SubstDuplF(FD2, false);
  }
  a.CFile!.XF!.NoCreate = false;
  TestXFExist();
  OldLMode(md);
  SaveFiles();
  a.CFile = cf;
}
// PAS: RUNPROC.PAS MountProc – MOUNT(catalog entry[, NoCancel])
function MountProc(CatIRec: number, NoCancel: boolean): void {
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    SaveFiles();
    RdCatPathVol(CatIRec);
    TestMountVol(BaseVars.CPath[0] ?? '\0');
  } catch (e) {
    RestoreExit(er);
    if (!(e instanceof GoExitSignal)) throw e;
    // 1:
    if (NoCancel) BaseVars.LastExitCode = 1;
    else GoExit();
    return;
  }
  BaseVars.LastExitCode = 0;
  RestoreExit(er);
}
// PAS: RUNPROC.PAS EditProc – EDIT(file, options)
function EditProc(PD: Instr): void {
  const a = AccessVars;
  a.EdUpdated = false;
  SaveFiles();
  a.CFile = PD.EditFD;
  const EO: EditOptPtr = CopyRec(PD.EO!);
  EO.FormPos = CopyRec(PD.EO!.FormPos); // embedded records are copied by value in Pascal
  EO.W = CopyRec(PD.EO!.W);
  if (!EO.UserSelFlds || SelFldsForEO(EO, null)) EditDataFile(a.CFile, EO);
  SaveFiles();
}
// PAS: RUNPROC.PAS EditTxtProc.GetStr
function GetStr(Z: FrmlPtr): string | null {
  if (Z === null) return null;
  return StoreStr(RunShortStr(Z));
}
// PAS: RUNPROC.PAS EditTxtProc – EDITTXT(path / text variable, options)
function EditTxtProc(PD: Instr): void {
  let i = 1;
  if (PD.TxtPos !== null) i = RunInt(PD.TxtPos);
  AccessVars.EdUpdated = false;
  const a = byte(RunWordImpl(PD.Atr, 0));
  let pv: WRect | null = null;
  const v = new WRect();
  if (PD.Ww.C1 !== null) {
    RunWFrml(PD.Ww, PD.WFlags, v);
    pv = v;
  }
  const MsgS = new MsgStr();
  MsgS.Head = GetStr(PD.Head);
  MsgS.Last = GetStr(PD.Last);
  MsgS.CtrlLast = GetStr(PD.CtrlLast);
  MsgS.ShiftLast = GetStr(PD.ShiftLast);
  MsgS.AltLast = GetStr(PD.AltLast);
  let lp: Ref<number> | null;
  if (PD.TxtLV !== null) lp = LocVarAd(PD.TxtLV) as Ref<number>;
  else {
    SetTxtPathVol(PD.TxtPath, PD.TxtCatIRec);
    lp = null;
  }
  let msg = '';
  if (PD.ErrMsg !== null) msg = RunShortStr(PD.ErrMsg);
  EditTxtFile(lp, PD.EdTxtMode, msg, PD.ExD, i, RunInt(PD.TxtXY), pv, a, RunShortStr(PD.Hd), PD.WFlags, MsgS);
}
// PAS: RUNPROC.PAS PrintTxtProc – PRINTTXT(path / text variable)
function PrintTxtProc(PD: Instr): void {
  if (PD.TxtLV !== null) {
    const s = AccessVars.TWork.Read(1, LocVarAd(PD.TxtLV).v as number);
    PrintArray(s, s.length, false);
  } else {
    SetTxtPathVol(PD.TxtPath, PD.TxtCatIRec);
    PrintTxtFile(0);
  }
}

// PAS: RUNPROC.PAS SrchXKey – search key X in CFile (index or sorted file)
function SrchXKey(K: KeyDPtr, X: XString, N: Ref<number>): boolean {
  const a = AccessVars;
  if (a.CFile!.Typ === 'X') {
    TestXFExist();
    return K!.SearchIntvl(X, false, N);
  }
  const cr = a.CRecPtr;
  a.CRecPtr = GetRecSpace();
  const result = SearchKey(X, K, N);
  a.CRecPtr = cr;
  return result;
}
// PAS: RUNPROC.PAS DeleteRecProc – DELETEREC(file[recno / key])
function DeleteRecProc(PD: Instr): void {
  const a = AccessVars;
  a.CFile = PD.RecFD;
  a.CRecPtr = GetRecSpace();
  const x = new XString();
  if (PD.ByKey) x.S = RunShortStr(PD.RecNr);
  const md = NewLMode(DelMode);
  body: {
    const n = ref(0);
    if (PD.ByKey) {
      if (!SrchXKey(PD.Key, x, n)) break body;
    } else {
      n.v = RunInt(PD.RecNr);
      if (n.v <= 0 || n.v > a.CFile!.NRecs) break body;
    }
    ReadRec(n.v);
    if (PD.AdUpd && !DeletedFlag()) BaseVars.LastExitCode = Number(!RunAddUpdte('-', null, null));
    if (a.CFile!.Typ === 'X') {
      if (!DeletedFlag()) DeleteXRec(n.v, true);
    } else DeleteRec(n.v);
  }
  // 1:
  OldLMode(md);
  // 2:
}
// PAS: RUNPROC.PAS RecallRecProc – RECALLREC(file[recno])
function RecallRecProc(PD: Instr): void {
  const a = AccessVars;
  a.CFile = PD.RecFD;
  if (a.CFile!.Typ !== 'X') return;
  const N = RunInt(PD.RecNr);
  a.CRecPtr = GetRecSpace();
  const md = NewLMode(CrMode);
  if (N > 0 && N <= a.CFile!.NRecs) {
    ReadRec(N);
    if (DeletedFlag()) {
      RecallRec(N);
      if (PD.AdUpd) BaseVars.LastExitCode = Number(!RunAddUpdte('+', null, null));
    }
  }
  OldLMode(md);
}
// PAS: RUNPROC.PAS AppendRecProc – APPENDREC(file): a new deleted record
function AppendRecProc(): void {
  const a = AccessVars;
  const md = NewLMode(CrMode);
  a.CRecPtr = GetRecSpace();
  ZeroAllFlds();
  SetDeletedFlag();
  CreateRec(a.CFile!.NRecs + 1);
  OldLMode(md);
}
// PAS: RUNPROC.PAS UpdRec – write CR as record N (with the implicit updates, texts of the old record)
function UpdRec(CR: Uint8Array, N: number, AdUpd: boolean): void {
  const a = AccessVars;
  const cr2 = GetRecSpace();
  a.CRecPtr = cr2;
  ReadRec(N);
  const del = DeletedFlag();
  a.CRecPtr = CR;
  if (AdUpd) {
    if (del) BaseVars.LastExitCode = Number(!RunAddUpdte('+', null, null));
    else BaseVars.LastExitCode = Number(!RunAddUpdte('d', cr2, null));
  }
  if (a.CFile!.Typ === 'X') OverwrXRec(N, cr2, CR);
  else WriteRec(N);
  if (!del) DelAllDifTFlds(cr2, null);
}
// PAS: RUNPROC.PAS ReadWriteRecProc – READREC / WRITEREC of a record variable
function ReadWriteRecProc(IsRead: boolean, PD: Instr): void {
  const a = AccessVars;
  const lv = PD.LV!;
  const RecPtr = lv.RecPtr as Uint8Array;
  a.CFile = lv.FD;
  a.CRecPtr = RecPtr;
  const N = ref(1);
  const k = PD.Key;
  const ad = PD.AdUpd;
  const md = a.CFile!.LMode;
  let app = false;
  const cr = GetRecSpace();
  const x = new XString();
  if (PD.ByKey) x.S = RunShortStr(PD.RecNr);
  else N.v = RunInt(PD.RecNr);
  // the Pascal labels: 0 = empty record (read), 1 = append (write), 2 = key not found, 3 = error
  const L0 = (): void => {
    DelTFlds();
    ZeroAllFlds();
  };
  const L1 = (): void => {
    NewLMode(CrMode);
    TestXFExist();
    IncNRecs(1);
    app = true;
  };
  const L3 = (msg: number): never => {
    SetMsgPar(lv.Name);
    return RunErrorM(md, msg);
  };
  body: {
    let append = false; // goto 1
    if (IsRead) {
      if (N.v === 0) {
        L0(); // goto 0
        break body; // goto 4
      }
      NewLMode(RdMode);
    } else if (N.v === 0) append = true;
    else NewLMode(WrMode);
    if (append) {
      L1();
      N.v = a.CFile!.NRecs;
    } else if (PD.ByKey) {
      if (k === null /* IsParFile */) {
        if (a.CFile!.NRecs === 0) {
          if (IsRead) {
            L0();
            break body;
          }
          L1();
        }
        N.v = a.CFile!.NRecs;
      } else if (!SrchXKey(k, x, N)) {
        // 2:
        if (IsRead) {
          DelTFlds();
          ZeroAllFlds();
          SetDeletedFlag();
          break body;
        }
        L3(613);
      }
    } else if (N.v <= 0 || N.v > a.CFile!.NRecs) L3(641);
    if (IsRead) {
      a.CRecPtr = cr;
      ReadRec(N.v);
      a.CRecPtr = RecPtr;
      DelTFlds();
      CopyRecWithT(cr, RecPtr);
    } else {
      CopyRecWithT(RecPtr, cr);
      if (app) {
        a.CRecPtr = cr;
        if (a.CFile!.Typ === 'X') RecallRec(N.v);
        else WriteRec(N.v);
        if (ad) BaseVars.LastExitCode = Number(!RunAddUpdte('+', null, null));
      } else UpdRec(cr, N.v, ad);
    }
  }
  // 4:
  OldLMode(md);
}
// PAS: RUNPROC.PAS LinkRecProc – LINKREC(recvar1, role, recvar2)
function LinkRecProc(PD: Instr): void {
  const a = AccessVars;
  const cf = a.CFile;
  const cr = a.CRecPtr;
  const ld = PD.LinkLD!;
  a.CRecPtr = PD.RecLV1!.RecPtr as Uint8Array;
  const lr2 = PD.RecLV2!.RecPtr as Uint8Array;
  a.CFile = ld.ToFD;
  ClearRecSpace(lr2);
  a.CFile = ld.FromFD;
  const n = ref(0);
  if (LinkUpw(ld, n, true)) BaseVars.LastExitCode = 0;
  else BaseVars.LastExitCode = 1;
  const r2 = a.CRecPtr!;
  a.CRecPtr = lr2;
  DelTFlds();
  CopyRecWithT(r2, lr2);
  a.CFile = cf;
  a.CRecPtr = cr;
}
// PAS: RUNPROC.PAS ForAllProc – FORALL loop over a file
function ForAllProc(PD: Instr): void {
  const a = AccessVars;
  const bv = BaseVars;
  const FD = PD.CFD;
  const Key = PD.CKey;
  const LVi = PD.CVar;
  const LVr = PD.CRecVar;
  const LD = PD.CLD;
  const KI = PD.CKIRoot;
  const Bool = RunEvalFrml(PD.CBool);
  let lk = false;
  const xx = new XString();
  if (LD !== null) {
    a.CFile = LD.ToFD;
    const KF = LD.ToKey!.KFlds;
    switch (PD.COwnerTyp) {
      case 'r':
        a.CRecPtr = PD.CLV!.RecPtr as Uint8Array;
        xx.PackKF(KF);
        break;
      case 'F': {
        const md = NewLMode(RdMode);
        a.CRecPtr = GetRecSpace();
        ReadRec(RunInt(PD.CLV as unknown as FrmlPtr));
        xx.PackKF(KF);
        OldLMode(md);
        break;
      }
    }
  }
  a.CFile = FD;
  const md = NewLMode(RdMode);
  const cr = GetRecSpace();
  a.CRecPtr = cr;
  let lr = cr;
  const Scan = new XScan().Init(a.CFile, Key, KI, true);
  if (LD !== null) {
    if (PD.COwnerTyp === 'i') Scan.ResetOwnerIndex(LD, PD.CLV, Bool);
    else Scan.ResetOwner(xx, Bool);
  } else Scan.Reset(Bool, PD.CSQLFilter);
  if (Key !== null) {
    if (PD.CWIdx) ScanSubstWIndex(Scan, Key.KFlds, 'W');
    else {
      a.CFile!.XF!.UpdLockCnt++;
      lk = true;
    }
  }
  if (LVr !== null) lr = LVr.RecPtr as Uint8Array;
  const b = PD.CProcent;
  if (b) RunMsgOn('F', Scan.NRecs);
  for (;;) {
    // 1:
    a.CRecPtr = cr;
    Scan.GetRec();
    if (b) RunMsgN(Scan.IRec);
    if (Scan.EOF) break;
    if (LVr !== null) {
      a.CRecPtr = lr;
      ClearUpdFlag();
      DelTFlds();
      CopyRecWithT(cr, lr);
    }
    if (LVi !== null) LocVarAd(LVi).v = Scan.RecNr;
    RunInstr(PD.CInstr);
    a.CFile = FD;
    a.CRecPtr = lr;
    OpenCreateF(Shared);
    if (LVr !== null && LVi === null && HasUpdFlag()) {
      const md1 = NewLMode(WrMode);
      CopyRecWithT(lr, cr);
      UpdRec(cr, Scan.RecNr, true);
      OldLMode(md1);
    }
    if (bv.ExitP || bv.BreakP) break;
    if (Key === null && Scan.NRecs > a.CFile!.NRecs) {
      Scan.IRec--;
      Scan.NRecs--;
    }
  }
  if (lk) a.CFile!.XF!.UpdLockCnt--;
  Scan.Close();
  OldLMode(md);
  if (b) RunMsgOff();
  bv.BreakP = false;
}

// PAS: RUNPROC.PAS HeadLineProc
function HeadLineProc(Z: FrmlPtr): void {
  UserHeadLine(RunShortStr(Z));
}
// PAS: RUNPROC.PAS SetKeyBufProc
function SetKeyBufProc(Z: FrmlPtr): void {
  DriversVars.KbdBuffer = RunShortStr(Z);
}
// PAS: RUNPROC.PAS SetWwViewPort (graphics only: FandGraph off)
function SetWwViewPort(): void {}
// PAS: RUNPROC.PAS WithWindowProc – WITH WINDOW(...) DO
function WithWindowProc(PD: Instr): void {
  const bv = BaseVars;
  const PAttr = bv.ProcAttr;
  bv.ProcAttr = byte(RunWordImpl(PD.Attr, bv.Colors.uNorm));
  const v = new WRect();
  RunWFrml(PD.W, PD.WithWFlags, v);
  const w1 = PushWFramed(v.C1, v.R1, v.C2, v.R2, bv.ProcAttr, RunShortStr(PD.Top), '', PD.WithWFlags);
  if ((PD.WithWFlags & WNoClrScr) === 0) ClrScr();
  SetWwViewPort();
  RunInstr(PD.WwInstr);
  PopW2(w1, (PD.WithWFlags & WNoPop) === 0);
  SetWwViewPort();
  bv.ProcAttr = PAttr;
}
// PAS: RUNPROC.PAS WithLockedProc.UnLck – release the locks of PD^.WLD up to (excluding) Ld1
function UnLck(PD: Instr, Ld1: LockDPtr, Op: PInstrCode): void {
  const a = AccessVars;
  let ld: LockDPtr = PD.WLD;
  while (ld !== Ld1 && ld !== null) {
    a.CFile = ld.FD;
    if (a.CFile!.IsShared()) {
      if (Op === _withlocked) UnLockN(ld.N);
      OldLMode(ld.OldMd);
    }
    ld = ld.Chain;
  }
}
// PAS: RUNPROC.PAS WithLockedProc – WITH SHARED / WITH LOCKED ... DO ... ELSE
function WithLockedProc(PD: Instr): void {
  const a = AccessVars;
  const op = PD.Kind;
  if (op === _withlocked) {
    let ld: LockDPtr = PD.WLD;
    while (ld !== null) {
      ld.N = RunInt(ld.Frml);
      ld = ld.Chain;
    }
  }
  let w = 0;
  const md = ref<LockMode>(NullMode);
  outer: for (;;) {
    // 1:
    let ld: LockDPtr = PD.WLD;
    while (ld !== null) {
      a.CFile = ld.FD;
      let fail = false;
      if (a.CFile!.Handle === 0xff) {
        if (OpenF1(Shared)) {
          if (TryLMode(RdMode, md, 2)) {
            OpenF2();
            OldLMode(NullMode);
          } else {
            CloseClearHCFile();
            fail = true; // goto 2
          }
        } else OpenCreateF(Shared);
      }
      if (!fail) {
        if (!a.CFile!.IsShared()) {
          ld = ld.Chain; // 3:
          continue;
        }
        if (op === _withlocked) {
          if (TryLockN(ld.N, 2)) {
            ld = ld.Chain;
            continue;
          }
        } else if (TryLMode(ld.Md, fref(ld, 'OldMd'), 2)) {
          ld = ld.Chain;
          continue;
        }
      }
      // 2:
      UnLck(PD, ld, op);
      if (PD.WasElse) {
        RunInstr(PD.WElseInstr);
        return;
      }
      a.CFile = ld.FD;
      SetCPathVol();
      let msg: number;
      if (op === _withlocked) {
        msg = 839;
        Set2MsgPar(ShortStr(String(ld.N), 10), BaseVars.CPath);
      } else {
        msg = 825;
        Set2MsgPar(BaseVars.CPath, LockModeTxt[ld.Md]);
      }
      const w1 = PushWrLLMsg(msg, false);
      if (w === 0) w = w1;
      else a.TWork.Delete(w1);
      beep();
      KbdTimer(BaseVars.Spec.NetDelay, 0);
      continue outer; // goto 1
    }
    break;
  }
  if (w !== 0) PopW(w);
  RunInstr(PD.WDoInstr);
  UnLck(PD, null, op);
}
// PAS: RUNPROC.PAS HelpProc – HELP(name)
function HelpProc(PD: Instr): void {
  Help(PD.HelpRdb, RunShortStr(PD.Frml), true);
}
// PAS: RUNPROC.PAS OpenHForPutTxt
function OpenHForPutTxt(PD: Instr): number {
  SetTxtPathVol(PD.TxtPath, PD.TxtCatIRec);
  TestMountVol(BaseVars.CPath[0] ?? '\0');
  let m = _isoverwritefile;
  if (PD.App) m = _isoldnewfile;
  const h = OpenH(m, Exclusive);
  TestCPathError();
  if (PD.App) SeekH(h, FileSizeH(h));
  return h;
}
// PAS: RUNPROC.PAS PutTxt – PUTTXT(path, text[, append])
function PutTxt(PD: Instr): void {
  const bv = BaseVars;
  const z = PD.Txt;
  let h: number;
  let pth: string;
  if (CanCopyT(null, z)) {
    h = OpenHForPutTxt(PD);
    pth = bv.CPath;
    CopyTFStringToH(h);
    bv.CPath = pth;
  } else {
    const s = RunLongStr(z);
    h = OpenHForPutTxt(PD);
    pth = bv.CPath; // Pascal leaves pth undefined on this path
    WriteH(h, s.length, s);
  }
  bv.CPath = pth;
  TestCPathError();
  WriteH(h, 0, new Uint8Array(0)); // trunc
  CloseH(h);
}
// PAS: RUNPROC.PAS AssgnCatFld – catalog field := frml
function AssgnCatFld(PD: Instr): void {
  const a = AccessVars;
  a.CFile = PD.FD3;
  if (a.CFile !== null) CloseFile();
  WrCatField(PD.CatIRec, PD.CatFld, RunShortStr(PD.Frml3));
}
// PAS: RUNPROC.PAS AssgnAccRight
function AssgnAccRight(PD: Instr): void {
  AccessVars.AccRight = RunShortStr(PD.Frml);
}
// PAS: RUNPROC.PAS AssgnUserName
function AssgnUserName(PD: Instr): void {
  AccessVars.UserName = RunShortStr(PD.Frml);
}
// PAS: RUNPROC.PAS ReleaseDriveProc – RELEASEDRIVE(drive)
function ReleaseDriveProc(Z: FrmlPtr): void {
  SaveFiles();
  const s = RunShortStr(Z);
  const c = UpCase(s.length > 0 ? s[0] : '\0');
  if (c === BaseVars.Spec.CPMdrive) ReleaseDrive(FloppyDrives);
  else if (c === 'A' || c === 'B') ReleaseDrive(ord(c) - ord('@'));
}
// PAS: RUNPROC.PAS WithGraphicsProc – WITH GRAPHICS DO (switches to the graphics mode)
function WithGraphicsProc(PD: InstrPtr): void {
  if (DriversVars.IsGraphMode) RunInstr(PD);
  else {
    ScrGraphMode(true, 0);
    SetWwViewPort();
    RunInstr(PD);
    ScrTextMode(true, false);
  }
}
// PAS: RUNPROC.PAS NoGraphicsProc (FandGraphParse without FandGraph)
function NoGraphicsProc(): void {
  BaseVars.MsgLine = 'grafika nen\xa1 v t\x82to verzi k dispozici'; // CP852 bytes of RUNPROC.PAS
  WrLLMsgTxt();
}
// PAS: RUNPROC.PAS PortOut (FPC: no-op)
function PortOut(IsWord: boolean, Port: number, What: number): void {}
// PAS: RUNPROC.PAS WaitProc – WAIT: a key or a mouse click
function WaitProc(): void {
  let w: number;
  do {
    GetEvent();
    w = DriversVars.Event.What;
    ClrEvent();
  } while (w !== evKeyDown && w !== evMouseDown);
}
// PAS: RUNPROC.PAS MemDiagProc (FPC)
function MemDiagProc(): void {
  TxtWriteln(Output, 'MemDiag: XMSCachePages=', String(BaseVars.XMSCachePages));
  wait();
}

// PAS: RUNPROC.PAS ITrc (FPC) – env FAND_TRACE_INSTR: log each executed PInstrCode ordinal
let ITrcState = 0; // itUnknown, itOff, itOn
let ITrcF = -1;
function ITrc(k: number): void {
  if (ITrcState === 1) return;
  if (ITrcState === 0) {
    const fn = GetEnv('FAND_TRACE_INSTR');
    if (fn === '') {
      ITrcState = 1;
      return;
    }
    try {
      ITrcF = fs.openSync(ToUnicode(fn), 'w');
    } catch {
      ITrcState = 1;
      return;
    }
    ITrcState = 2;
  }
  fs.writeSync(ITrcF, `${k}\n`);
}

// PAS: RUNPROC.PAS ResetCatalog – close and forget the files of all open RDBs (catalog changed)
export function ResetCatalog(): void {
  const a = AccessVars;
  const cf = a.CFile;
  const r = a.CRdb;
  while (a.CRdb !== null) {
    a.CFile = a.CRdb.FD!.Chain;
    while (a.CFile !== null) {
      CloseFile();
      const f = a.CFile;
      f.CatIRec = GetCatIRec(f.Name, f.Typ === '0');
      a.CFile = a.CFile.Chain;
    }
    a.CRdb = a.CRdb.ChainBack;
  }
  a.CFile = cf;
  a.CRdb = r;
}

// PAS: RUNPROC.PAS RunInstr – execute the instruction chain PD until ExitP/BreakP
export function RunInstr(PD: InstrPtr): void {
  const a = AccessVars;
  const bv = BaseVars;
  while (!bv.ExitP && !bv.BreakP && PD !== null) {
    ITrc(PD.Kind);
    switch (PD.Kind) {
      case _ifthenelseP:
        if (RunBool(PD.Bool)) RunInstr(PD.Instr);
        else RunInstr(PD.ElseInstr);
        break;
      case _whiledo:
        while (!bv.ExitP && !bv.BreakP && RunBool(PD.Bool)) RunInstr(PD.Instr);
        bv.BreakP = false;
        break;
      case _repeatuntil:
        do RunInstr(PD.Instr);
        while (!(bv.ExitP || bv.BreakP || RunBool(PD.Bool)));
        bv.BreakP = false;
        break;
      case _menubox:
        MenuBoxProc(PD);
        break;
      case _menubar:
        MenuBarProc(PD);
        break;
      case _forall:
        ForAllProc(PD);
        break;
      case _window:
        WithWindowProc(PD);
        break;
      case _break:
        bv.BreakP = true;
        break;
      case _exit:
        bv.ExitP = true;
        break;
      case _cancel:
        GoExit();
      // unreachable
      case _save:
        SaveFiles();
        break;
      case _clrscr:
        DriversVars.TextAttr = bv.ProcAttr;
        ClrScr();
        break;
      case _clrww:
        ClrWwProc(PD);
        break;
      case _clreol:
        DriversVars.TextAttr = bv.ProcAttr;
        ClrEol();
        break;
      case _exec:
        ExecPgm(PD);
        break;
      case _proc:
        CallProcedure(PD);
        break;
      case _call:
        CallRdbProc(PD);
        break;
      case _copyfile:
        CopyFile(PD.CD);
        break;
      case _headline:
        HeadLineProc(PD.Frml);
        break;
      case _setkeybuf:
        SetKeyBufProc(PD.Frml);
        break;
      case _writeln:
        WritelnProc(PD);
        break;
      case _gotoxy:
        GotoXY(RunInt(PD.GoX), RunInt(PD.GoY));
        break;
      case _merge:
        MergeProc(PD);
        break;
      case _lproc:
        RunProlog(PD.lpPos, PD.lpName);
        break;
      case _report:
        ReportProc(PD.RO, true);
        break;
      case _sort:
        SortProc(PD.SortFD, PD.SK);
        break;
      case _edit:
        EditProc(PD);
        break;
      case _asgnloc:
        LVAssignFrml(PD.AssLV, bv.MyBP, PD.Add, PD.Frml);
        break;
      case _asgnrecfld:
        AssignRecFld(PD);
        break;
      case _asgnrecvar:
        AssignRecVar(PD.RecLV1, PD.RecLV2, PD.Ass);
        break;
      case _asgnpar:
        AsgnParFldFrml(PD.FD, PD.FldD, PD.Frml, PD.Add);
        break;
      case _asgnfield:
        AssignField(PD);
        break;
      case _asgnnrecs:
        a.CFile = PD.FD;
        AssignNRecs(PD.Add, RunInt(PD.Frml));
        break;
      case _appendrec:
        a.CFile = PD.RecFD;
        AppendRecProc();
        break;
      case _deleterec:
        DeleteRecProc(PD);
        break;
      case _recallrec:
        RecallRecProc(PD);
        break;
      case _readrec:
        ReadWriteRecProc(true, PD);
        break;
      case _writerec:
        ReadWriteRecProc(false, PD);
        break;
      case _linkrec:
        LinkRecProc(PD);
        break;
      case _withshared:
      case _withlocked:
        WithLockedProc(PD);
        break;
      case _edittxt:
        EditTxtProc(PD);
        break;
      case _printtxt:
        PrintTxtProc(PD);
        break;
      case _puttxt:
        PutTxt(PD);
        break;
      case _asgncatfield:
        AssgnCatFld(PD);
        break;
      case _asgnusercode:
        a.UserCode = word(RunInt(PD.Frml));
        a.AccRight = chr(a.UserCode);
        break;
      case _asgnaccright:
        AssgnAccRight(PD);
        break;
      case _asgnusername:
        AssgnUserName(PD);
        break;
      case _asgnusertoday:
        bv.userToday = RunReal(PD.Frml);
        break;
      case _asgnclipbd: {
        const s = RunLongStr(PD.Frml);
        a.TWork.Delete(a.ClpBdPos);
        a.ClpBdPos = a.TWork.Store(s);
        break;
      }
      case _asgnedok:
        a.EdOk = RunBool(PD.Frml);
        break;
      case _turncat:
        a.CFile = PD.NextGenFD;
        TurnCat(PD.FrstCatIRec, PD.NCatIRecs, RunInt(PD.TCFrml));
        break;
      case _releasedrive:
        ReleaseDriveProc(PD.Drive);
        break;
      case _setprinter:
        SetCurrPrinter(Math.abs(RunInt(PD.Frml)));
        break;
      case _indexfile:
        IndexfileProc(PD.IndexFD, PD.Compress);
        break;
      case _display:
        DisplayProc(PD.Pos.R, PD.Pos.IRec, PD.Pos.Frml);
        break;
      case _mount:
        MountProc(PD.MountCatIRec, PD.MountNoCancel);
        break;
      case _clearkeybuf:
        ClearKbdBuf();
        break;
      case _help:
        HelpProc(PD);
        break;
      case _wait:
        WaitProc();
        break;
      case _beep:
        beep();
        break;
      case _delay:
        Delay(Math.trunc((RunInt(PD.Frml) + 27) / 55));
        break;
      case _sound:
        Sound(RunInt(PD.Frml));
        break;
      case _nosound:
        NoSound();
        break;
      case _graph:
      case _putpixel:
      case _line:
      case _rectangle:
      case _ellipse:
      case _floodfill:
      case _outtextxy:
        NoGraphicsProc();
        break;
      case _withgraphics:
        WithGraphicsProc(PD.WDoInstr);
        break;
      case _memdiag:
        MemDiagProc();
        break;
      case _closefds:
        a.CFile = PD.clFD;
        if (a.CFile === null) ForAllFDs(ClosePassiveFD);
        else if (!a.CFile.IsShared() || a.CFile.LMode === NullMode) CloseFile();
        break;
      case _backup:
        Backup(PD.IsBackup, PD.NoCompress, PD.BrCatIRec, PD.BrNoCancel);
        break;
      case _backupm:
        BackupM(PD);
        break;
      case _resetcat:
        ResetCatalog();
        break;
      case _setedittxt:
        SetEditTxt(PD);
        break;
      case _getindex:
        GetIndex(PD);
        break;
      case _setmouse:
        SetMouse(RunInt(PD.MouseX), RunInt(PD.MouseY), RunBool(PD.Show));
        break;
      case _checkfile:
        SetTxtPathVol(PD.cfPath, PD.cfCatIRec);
        CheckFile(PD.cfFD);
        break;
      case _asgnrand:
        RunFrmlVars.RandSeed = RunInt(PD.Frml) | 0;
        break;
      case _randomize:
        Randomize();
        break;
      case _asgnxnrecs:
        PD.xnrIdx!.Release();
        break;
      case _portout:
        PortOut(RunBool(PD.IsWord), word(RunInt(PD.Port)), word(RunInt(PD.PortWhat)));
        break;
    }
    PD = PD.Chain;
  }
}

// PAS: RUNPROC.PAS RunProcedure – RunInstr with fresh ExitP/BreakP (PDRoot: pointer = InstrPtr)
export function RunProcedure(PDRoot: InstrPtr): void {
  const bv = BaseVars;
  const ExP = bv.ExitP;
  const BrkP = bv.BreakP;
  bv.ExitP = false;
  bv.BreakP = false;
  RunInstr(PDRoot);
  bv.ExitP = ExP;
  bv.BreakP = BrkP;
}

// PAS: RUNPROC.PAS CallProcedure – compile + run the procedure PD^.Pos with arguments PD^.TArg
export function CallProcedure(PD: InstrPtr): void {
  const a = AccessVars;
  const bv = BaseVars;
  if (PD === null) return;
  const oldprocbp = bv.ProcMyBP;
  const ld = a.LinkDRoot;
  const lstFD = LastInChain(fref(a, 'FileDRoot'));
  SetInpTT(PD.Pos, true);
  ReadProcHead();
  const n = RdRunVars.LVBD.NParam;
  const lvroot = RdRunVars.LVBD.Root;
  const oldbp: ProcStkPtr = bv.MyBP;
  PushProcStk();
  const L1 = (): never => {
    // 1:
    a.CurrPos = 1;
    return Error(119);
  };
  if (n !== PD.N && !(n === PD.N - 1 && PD.ExPar)) L1();
  let lv = lvroot;
  for (let i = 1; i <= n; i++) {
    const ta = PD.TArg[i];
    const v = lv!;
    if (ta.FTyp !== v.FTyp) L1();
    switch (ta.FTyp) {
      case 'r':
      case 'i':
        if (v.FD !== ta.FD) L1();
        v.RecPtr = ta.RecPtr;
        break;
      case 'f': {
        if (ta.Name !== null) {
          const p = SaveCompState();
          SetInpLongStr(RunLongStr(ta.TxtFrml), true);
          RdFileD(ta.Name, '6', '$');
          RestoreCompState(p);
        } else a.CFile = ta.FD;
        let lv1: LocVarPtr = v;
        while (lv1 !== null) {
          if ((lv1.FTyp === 'i' || lv1.FTyp === 'r') && lv1.FD === v.FD) lv1.FD = a.CFile;
          lv1 = lv1.Chain;
        }
        v.FD = a.CFile;
        a.FDLocVarAllowed = true;
        break;
      }
      default: {
        const z = ta.Frml!;
        if ((v.IsRetPar && z.Op !== _getlocvar) || (ta.FromProlog && ta.IsRetPar !== v.IsRetPar)) L1();
        LVAssignFrml(v, oldbp, false, ta.Frml);
      }
    }
    lv = v.Chain;
  }
  const lv1 = lv;
  while (lv !== null) {
    if (lv.FTyp === 'r') {
      a.CFile = lv.FD;
      a.CRecPtr = GetRecSpace();
      SetTWorkFlag();
      ZeroAllFlds();
      ClearDeletedFlag();
      lv.RecPtr = a.CRecPtr;
    }
    lv = lv.Chain;
  }
  bv.ProcMyBP = bv.MyBP;
  const pd1 = ReadProcBody();
  a.FDLocVarAllowed = false;
  lv = lv1;
  while (lv !== null) {
    if (lv.FTyp === 'i') {
      const wk = lv.RecPtr as XWKey;
      if (wk.KFlds === null) wk.KFlds = lv.FD!.Keys!.KFlds;
      wk.Open(wk.KFlds, true, false);
    }
    lv = lv.Chain;
  }
  RunProcedure(pd1);
  lv = lvroot;
  let i = 1;
  while (lv !== null) {
    if (lv.IsRetPar) {
      const z = PD.TArg[i].Frml!;
      const ob = oldbp!;
      const mb = bv.MyBP!;
      switch (lv.FTyp) {
        case 'R':
          ob.V[z.BPOfs] = mb.V[lv.BPOfs];
          break;
        case 'S': {
          const l = ob.V[z.BPOfs];
          ob.V[z.BPOfs] = mb.V[lv.BPOfs];
          mb.V[lv.BPOfs] = l;
          break;
        }
        case 'B':
          ob.V[z.BPOfs] = mb.V[lv.BPOfs];
          break;
      }
    }
    if (i > n) {
      switch (lv.FTyp) {
        case 'r':
          a.CFile = lv.FD;
          ClearRecSpace(lv.RecPtr as Uint8Array);
          break;
        case 'i':
          a.CFile = lv.FD;
          (lv.RecPtr as XWKey).Close();
          break;
      }
    }
    i++;
    lv = lv.Chain;
  }
  PopProcStk();
  bv.ProcMyBP = oldprocbp;
  a.LinkDRoot = ld;
  a.CFile = lstFD.Chain;
  while (a.CFile !== null) {
    CloseFile();
    a.CFile = a.CFile.Chain;
  }
  lstFD.Chain = null;
}

// PAS: RUNPROC.PAS RunMainProc – run procedure RP (NewWw: clear the desktop and draw the head line)
export function RunMainProc(RP: RdbPos, NewWw: boolean): void {
  const bv = BaseVars;
  const dv = DriversVars;
  if (NewWw) {
    bv.ProcAttr = bv.Colors.uNorm;
    Window(1, 2, bv.TxtCols, bv.TxtRows);
    dv.TextAttr = bv.ProcAttr;
    ClrScr();
    UserHeadLine('');
    AccessVars.MenuX = 1;
    AccessVars.MenuY = 2;
  }
  const PD = GetPInstr(_proc, 6 + 2)!; // sizeof(RdbPos)+2
  PD.Pos = CopyRec(RP);
  CallProcedure(PD);
  if (NewWw) Window(1, 1, bv.TxtCols, bv.TxtRows);
}
