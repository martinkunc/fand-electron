// PAS: RDPROC.PAS – compiles procedure chapters (P) into Instr trees, declaration chapters (D:
// user FUNCTIONs), and the options of the EDIT/REPORT/SORT/COPYFILE/... instructions; also
// EVALuates string formulas at run time (GetEvalFrml).
//
// Porting notes:
// * No interface variables. Private global: IsRdUserFunc (compiling a FUNCTION body: 'name :=' is
//   a result assignment). Sets the COMPILE hooks AccessVars.RdFldNameFrml := RdFldNameFrmlP and
//   RdFunction := RdFunctionP; declares locals into RdRunVars.LVBD; FuncDRoot/CRdb^.OldFCRoot.
// * asm/DOS-specific: Ovr (BP7 overlay stack fix-up for the NewExit in GetEvalFrml; FPC empty) –
//   not needed. GetEvalFrml has the FPC NewExit macro expanded inline (SetJmp/KeepInMemory):
//   ported with the try/catch GoExitSignal pattern (PORTING.md section 11); on a compile error
//   LastExitCode<>0, LastTxtPos:=CurrPos, and a boolean EVAL yields the constant false.
// * GetPInstrN/GetPInstr: BP7 allocates Size+5 bytes (a variant-sized Instr), FPC the whole
//   record + Extra; here `new Instr(Kind)` (Size/Extra ignored; TArg etc. are JS arrays).
// * Record copies: `oldLVBD:=LVBD`, `fc^.LVB:=LVBD`, `LVBD:=oldLVBD` copy LocVarBlkD by value –
//   CopyRec/AssignRec. RdHeadLast(var AA) overlays a record of 5 FrmlPtrs (Head, Last, CtrlLast,
//   AltLast, ShiftLast) on EditOpt/Instr fields: the object is passed and the named fields set.
// * RdProcArg: TArg:array[1..31] of TypAndFrml (Instr.TArg is a 1-based JS array). 'PROC [expr]'
//   and REPORT '[expr]' store the string formula in RdbPos (Pos.Frml, see access.ts RdbPos).
//   Pascal writes PD^.Pos of a _proc instruction (Pos overlays PPos; rdrun.ts aliases them).
// * Pointer overlays kept as casts: RdOwner stores the '[recno]' formula in the LocVarPtr LLV
//   (OwnerTyp 'F'), INTTSR stores a record buffer in the FrmlPtr P3 (N31='r'). _recvarfld keeps
//   the record buffer in NewRP (Pascal LD), see access.ts FrmlElem.
// * Active switches: FandLProc (CALL of an LPROC: RdCallLProc), FandGraphParse (GRAPH is parsed,
//   RdGraphP; run time is notSupported). FandSQL branches (RdSqlRdWrTxt, typSQLFile errors) are off.
// * Tricky: RdPInstr is a long keyword dispatch (goto 0/2/3 labels share assignment tails);
//   RdAssign distinguishes field, locvar, record-var, FILE.field, role.field, system variables.
//   The nested routines of RdPInstr assign the RdPInstr result (GetPD): here they return the
//   instruction and RdPInstr returns it.
// * Private routines: TestCatError, IsRecVar, RdRecVar, RdIdxVar, RdRecVarFldFrml, RdOwner,
//   RdFldNameFrmlP, RdPath, RdFunctionP (+ RdViewKeyImpl, RdSelectStr), GetPInstrN,
//   RdPInstrAndChain, RdChoices, RdMenuAttr, RdMenuBox, RdMenuBar, RdIfThenElse, RdWhileDo, RdFor,
//   RdCase, RdRepeatUntil, RdForAll, RdBeginEnd, RdProcArg, RdKeyCode (+ NotCode), RdHeadLast,
//   RdViewOpt.RdKeyList, RdPInstr (+ GetPD, RdProcCall, RdFlds, RdSubFldList, RdSortCall,
//   RdEditCall/RdEditOpt, RdReportCall/RdRprtOpt, RdRDBCall, RdExec, RdCopyFile (+ RdCOpt, RdX,
//   TestFixVar, RdList), RdPrintTxt, RdEditTxt, RdPutTxt, RdTurnCat, RdWriteln, RdReleaseDrive,
//   RdIndexfile, RdGetIndex, RdGotoXY, RdClrWw, RdMount, RdDisplay, RdGraphP, RdMixRecAcc,
//   RdLinkRec, RdBackup, RdSetEditTxt, RdCallLProc), AdjustComma, MakeImplAssign, RdAssign,
//   RdWith, RdUserFuncAssign.

import {
  ref, fref, ord, Copy, ValI, BytesToStr, CopyRec, AssignRec, GoExitSignal, type Ref,
} from './pasrt.ts';
import type { StringPtr } from './base.ts';
import {
  BaseVars, ChainLast, SEquUpcase, SetMsgPar, StoreStr, NewExit, RestoreExit, ExitRecord, WNoPop,
} from './base.ts';
import {
  AccessVars, FrmlAt, LocVar, FuncD, RdbPos, FieldListEl, ResetCompilePars, f_Stored, f_Comma, Power10, LockModeTxt, NoExclMode, ExclMode,
  IsActiveRdb, EquKFlds, GetRecSpace, ReadRec, _ShortS,
  _assign, _number, _identifier, _quotedstr, _equ, _le,
  _const, _getlocvar, _recvarfld, _indexnrecs, _lastupdate, _catfield, _generation, _nrecsabs, _nrecs,
  _accrecno, _keypressed, _escprompt, _edupdated, _getpath, _eval, _prompt, _keyof, _recno, _recnoabs,
  _recnolog, _link, _lvdeleted, _isdeleted, _gettxt, _filesize, _inttsr, _selectstr, _promptyn, _mouseevent,
  _ismouse, _mousein, _portin, _compreal, _setmybp, _times, _divide,
  type FrmlPtr, type FileDPtr, type FieldDPtr, type KeyDPtr, type KeyFldDPtr, type LinkDPtr, type LocVarPtr,
  type FieldList, type XWKey,
} from './access.ts';
import {
  Instr, ChoiceD, EdExitD, EdExKeyD, CopyD, WrLnD, LockD, GraphD, GraphVD, GraphWD, GraphRGBD, WinG, TypAndFrml,
  RprtFDListEl, AssignD, RdRunVars, ResetLVBD, SetMyBP, _zero, _output, _ATotal, _AErrRecs, _ALstg, _ARprt,
  cpNo, cpFix, cpVar, cpTxt,
  _menubox, _menubar, _ifthenelseP, _whiledo, _repeatuntil, _break, _exit, _cancel, _save, _closefds, _window,
  _clrscr, _clrww, _clreol, _gotoxy, _display, _writeln, _setkeybuf, _clearkeybuf, _headline, _call, _exec,
  _copyfile, _proc, _lproc, _merge, _sort, _edit, _report, _edittxt, _printtxt, _puttxt, _asgnloc, _asgnpar,
  _asgnfield, _asgnedok, _asgnrand, _asgnusertoday, _randomize, _asgnusercode, _asgnusername, _asgnaccright,
  _asgnxnrecs, _asgnnrecs, _asgncatfield, _asgnrecfld, _asgnrecvar, _asgnclipbd, _turncat, _appendrec,
  _deleterec, _recallrec, _readrec, _writerec, _linkrec, _releasedrive, _mount, _indexfile, _getindex, _forall,
  _withshared, _withlocked, _withgraphics, _memdiag, _wait, _delay, _beep, _sound, _nosound, _help, _setprinter,
  _graph, _putpixel, _line, _rectangle, _ellipse, _floodfill, _outtextxy, _backup, _backupm, _resetcat,
  _setedittxt, _setmouse, _checkfile, _portout,
  type InstrPtr, type PInstrCode, type EditOptPtr, type RprtOptPtr, type CpOption,
  type AssignDPtr,
} from './rdrun.ts';
import {
  _F1_, _ShiftF1_, _CtrlF1_, _AltF1_, _Home_, _up_, _PgUp_, _left_, _right_, _End_, _down_, _PgDn_, _Ins_,
  _CtrlLeft_, _CtrlRight_, _CtrlEnd_, _CtrlPgDn_, _CtrlHome_, _CtrlPgUp_, _Tab_, _ShiftTab_, _N_, _Y_, _ESC_, _P_,
} from './drivers.ts';
import { GetCatIRec, RdCatField } from './oaccess.ts';
import { RdFldDescr, RdUserView, RdBegViewDcl } from './rdfildcl.ts';
import { RunLongStr, GetFromKey, TrailChar } from './runfrml.ts';
import {
  Error, OldError, SetInpLongStr, SkipBlank, RdLex, TestIdentif, TestLex, Accept, RdInteger, EquUpcase,
  TestKeyWord, IsKeyWord, AcceptKeyWord, IsOpt, IsDigitOpt, RdStrConst, RdQuotedChar, IsForwPoint,
  RdLocDcl, FindLocVar, FindChpt, RdChptName, AllFldsList, GetEditOpt, GetRprtOpt, RdHelpName, RdAttr, RdW,
  RdFrame, RdAssignFrml, RdNegFldList, EditModeToFlags, RdViewKey, IsKeyArg, RdKFList,
  RdFrml, RdBool, RdRealFrml, RdStrFrml, RdKeyInBool, TestString, TestReal,
  GetOp, FindFldName, RdFldName, FindFileD, RdFileName, FindLD, IsRoleName, RdFAccess, TryRdFldFrml,
  FrmlContxt, MakeFldFrml, RdFldNameFrmlF, SaveCompState, RestoreCompState,
} from './compile.ts';

const EOFChar = '\x1a'; // ^Z

let IsRdUserFunc = false;

/** TS-only: FrmlPtr(@LV^.Op) – the (Op, BPOfs) of a local variable as a _getlocvar formula. */
function LocVarFrml(LV: LocVar): FrmlPtr {
  return FrmlAt(LV, { Op: 'Op', BPOfs: 'BPOfs' });
}

// PAS: RDPROC.PAS TestCatError
function TestCatError(I: number, Nm: string, Old: boolean): void {
  if (I === 0) {
    SetMsgPar(Nm);
    if (Old) OldError(96);
    else Error(96);
  }
}
// PAS: RDPROC.PAS IsRecVar
function IsRecVar(LV: Ref<LocVarPtr>): boolean {
  if (!FindLocVar(RdRunVars.LVBD.Root, LV) || LV.v!.FTyp !== 'r') return false;
  RdLex();
  return true;
}
// PAS: RDPROC.PAS RdRecVar
function RdRecVar(): LocVarPtr {
  const LV = ref<LocVarPtr>(null);
  if (!IsRecVar(LV)) Error(141);
  return LV.v;
}
// PAS: RDPROC.PAS RdIdxVar
function RdIdxVar(): LocVarPtr {
  const lv = ref<LocVarPtr>(null);
  if (!FindLocVar(RdRunVars.LVBD.Root, lv) || lv.v!.FTyp !== 'i') Error(165);
  RdLex();
  return lv.v;
}
// PAS: RDPROC.PAS RdRecVarFldFrml
function RdRecVarFldFrml(LV: LocVar, FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  let Z: FrmlPtr = null;
  Accept('.');
  switch (LV.FTyp) {
    case 'r': {
      Z = GetOp(_recvarfld, 12)!;
      const cf = a.CFile;
      a.CFile = LV.FD;
      Z.File2 = a.CFile;
      Z.NewRP = LV.RecPtr as Uint8Array; // Pascal Z^.LD:=LV^.RecPtr
      const fa = a.FileVarsAllowed;
      a.FileVarsAllowed = true;
      Z.P1 = RdFldNameFrmlF(FTyp);
      a.FileVarsAllowed = fa;
      a.CFile = cf;
      break;
    }
    case 'i':
      Z = GetOp(_indexnrecs, 4)!;
      Z.WKey = LV.RecPtr as XWKey;
      AcceptKeyWord('nrecs');
      FTyp.v = 'R';
      break;
    default:
      OldError(177);
  }
  return Z;
}

// PAS: RDPROC.PAS RdOwner – 'r','i','F'
function RdOwner(LLD: Ref<LinkDPtr>, LLV: Ref<LocVarPtr> /* or FrmlPtr for 'F' */): string {
  const a = AccessVars;
  const lv = ref<LocVarPtr>(null);
  let ld: LinkDPtr;
  // shared tails of the labels 1 (index/record var), 2 ('[recno]'), 3 (result)
  const L1 = (): string => {
    if (lv.v!.FTyp === 'i') {
      const kf = (lv.v!.RecPtr as XWKey).KFlds;
      if (ld!.FromFD!.IsSQLFile || ld!.ToFD!.IsSQLFile) OldError(155);
      if (kf !== null && !EquKFlds(kf, ld!.ToKey!.KFlds)) OldError(181);
    }
    LLV.v = lv.v;
    LLD.v = ld; // 3:
    return lv.v!.FTyp;
  };
  const L2 = (): string => {
    Accept('[');
    LLV.v = RdRealFrml() as unknown as LocVarPtr; // Pascal LocVarPtr(RdRealFrml)
    Accept(']');
    LLD.v = ld; // 3:
    return 'F';
  };
  if (FindLocVar(RdRunVars.LVBD.Root, lv)) {
    if (!(lv.v!.FTyp === 'i' || lv.v!.FTyp === 'r' || lv.v!.FTyp === 'f')) Error(177);
    ld = null;
    let ld1 = a.LinkDRoot;
    while (ld1 !== null) {
      if (ld1.FromFD === a.CFile && ld1.IndexRoot !== 0 && ld1.ToFD === lv.v!.FD) ld = ld1;
      ld1 = ld1.Chain;
    }
    if (ld === null) Error(116);
    RdLex();
    if (lv.v!.FTyp === 'f') return L2();
    return L1();
  }
  TestIdentif();
  ld = a.LinkDRoot;
  while (ld !== null) {
    if (ld.FromFD === a.CFile && EquUpcase(ld.RoleName)) {
      if (ld.IndexRoot === 0) Error(116);
      RdLex();
      const fd = ld.ToFD;
      if (a.Lexem === '(') {
        RdLex();
        if (!FindLocVar(RdRunVars.LVBD.Root, lv) || !(lv.v!.FTyp === 'i' || lv.v!.FTyp === 'r')) Error(177);
        RdLex();
        Accept(')');
        if (lv.v!.FD !== fd) OldError(149);
        return L1();
      }
      return L2();
    }
    ld = ld.Chain;
  }
  return Error(9);
}

// PAS: RDPROC.PAS RdFldNameFrmlP – the RdFldNameFrml hook of procedures
function RdFldNameFrmlP(FTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  const LV = ref<LocVarPtr>(null);
  let Z: FrmlPtr;
  let Op: string;
  if (IsForwPoint()) {
    if (FindLocVar(RdRunVars.LVBD.Root, LV) && (LV.v!.FTyp === 'i' || LV.v!.FTyp === 'r')) {
      RdLex();
      return RdRecVarFldFrml(LV.v!, FTyp);
    }
    let FName = a.LexWord;
    const FD = ref<FileDPtr>(null);
    const LD = ref<LinkDPtr>(null);
    const linked = IsRoleName(a.FileVarsAllowed, FD, LD);
    if (FD.v !== null) FName = FD.v.Name;
    if (!linked) RdLex();
    RdLex();
    FTyp.v = 'R';
    // 1: catalog field (F=nil: LASTUPDATE of a not declared file)
    const L1 = (F: FieldDPtr): FrmlPtr => {
      const Z1 = GetOp(_catfield, 6)!;
      Z1.CatFld = F;
      Z1.CatIRec = GetCatIRec(FName, true);
      TestCatError(Z1.CatIRec, FName, true);
      return Z1;
    };
    // 2: file function
    const L2 = (Op2: string): FrmlPtr => {
      const Z2 = GetOp(Op2, 4)!;
      Z2.FD = FD.v;
      return Z2;
    };
    if (IsKeyWord('LASTUPDATE')) {
      Op = _lastupdate;
      if (FD.v !== null) return L2(Op);
      return L1(null);
    }
    if (IsKeyWord('ARCHIVES')) {
      FTyp.v = 'S'; // 0:
      return L1(a.CatArchiv);
    }
    if (IsKeyWord('PATH')) {
      FTyp.v = 'S';
      return L1(a.CatPathName);
    }
    if (IsKeyWord('VOLUME')) {
      FTyp.v = 'S';
      return L1(a.CatVolume);
    }
    if (FD.v !== null) {
      if (IsKeyWord('GENERATION')) return L2(_generation);
      if (IsKeyWord('NRECSABS')) return L2(_nrecsabs);
      if (IsKeyWord('NRECS')) return L2(_nrecs);
    }
    if (linked) return RdFAccess(FD.v, LD.v, FTyp);
    if (a.FileVarsAllowed) OldError(9);
    else OldError(63);
  }
  if (a.ForwChar === '[') {
    Z = GetOp(_accrecno, 8)!;
    const FD = RdFileName();
    RdLex();
    Z.RecFD = FD;
    Z.P1 = RdRealFrml();
    Accept(']');
    Accept('.');
    const F = RdFldName(FD);
    Z.RecFldD = F;
    FTyp.v = F!.FrmlTyp;
    return Z;
  }
  Op = '\0';
  if (IsKeyWord('KEYPRESSED')) Op = _keypressed;
  else if (IsKeyWord('ESCPROMPT')) Op = _escprompt;
  else if (IsKeyWord('EDUPDATED')) Op = _edupdated;
  if (Op !== '\0') {
    FTyp.v = 'B'; // 3:
    return GetOp(Op, 0);
  }
  if (IsKeyWord('GETPATH')) {
    FTyp.v = 'S';
    return GetOp(_getpath, 0);
  }
  if (FindLocVar(RdRunVars.LVBD.Root, LV)) {
    if (LV.v!.FTyp === 'r' || LV.v!.FTyp === 'f' || LV.v!.FTyp === 'i') Error(143);
    RdLex();
    FTyp.v = LV.v!.FTyp;
    return LocVarFrml(LV.v!);
  }
  if (a.FileVarsAllowed) {
    const z = TryRdFldFrml(a.CFile, FTyp);
    if (z === null) Error(8);
    return z;
  }
  return Error(8);
}

// PAS: RDPROC.PAS RdPath – a quoted path, a catalog name, or (not NoFD) a declared file
function RdPath(NoFD: boolean, Path: Ref<StringPtr>, CatIRec: Ref<number>): FileDPtr {
  const a = AccessVars;
  let fd: FileDPtr;
  CatIRec.v = 0;
  if (a.Lexem === _quotedstr) {
    Path.v = RdStrConst();
    fd = null;
  } else {
    TestIdentif();
    fd = FindFileD();
    if (fd === null) {
      CatIRec.v = GetCatIRec(a.LexWord, true);
      TestCatError(CatIRec.v, a.LexWord, false);
    } else if (NoFD) Error(97);
    RdLex();
  }
  return fd;
}

// PAS: RDPROC.PAS RdFunctionP.RdViewKeyImpl
function RdViewKeyImpl(FD: FileDPtr): KeyDPtr {
  const a = AccessVars;
  let K = FD!.Keys;
  if (K === null) Error(24);
  if (a.Lexem === '/') {
    const cf = a.CFile;
    a.CFile = FD;
    K = RdViewKey();
    a.CFile = cf;
  }
  return K;
}
// PAS: RDPROC.PAS RdFunctionP.RdSelectStr
function RdSelectStr(Z: NonNullable<FrmlPtr>): void {
  const a = AccessVars;
  Z.Delim = '\r'; // ^m
  Z.P1 = RdRealFrml();
  Accept(',');
  Z.P2 = RdRealFrml();
  Accept(',');
  Z.P3 = RdStrFrml();
  while (a.Lexem === ',') {
    RdLex();
    if (IsOpt('HEAD')) Z.P4 = RdStrFrml();
    else if (IsOpt('FOOT')) Z.P5 = RdStrFrml();
    else if (IsOpt('MODE')) Z.P6 = RdStrFrml();
    else if (IsOpt('DELIM')) Z.Delim = RdQuotedChar();
    else Error(157);
  }
}
// PAS: RDPROC.PAS RdFunctionP – the RdFunction hook: procedure-only functions 'name('
function RdFunctionP(FFTyp: Ref<string>): FrmlPtr {
  const a = AccessVars;
  let Z: FrmlPtr = null;
  const Typ = ref('\0');
  let FTyp = '\0';
  const FD = ref<FileDPtr>(null);
  let K: KeyDPtr;
  const LV = ref<LocVarPtr>(null);
  const LD = ref<LinkDPtr>(null);
  let Op = '\0';
  // 11: RECNO(file/key, key fields...) and friends
  const L11 = (): void => {
    FD.v = RdFileName();
    K = RdViewKeyImpl(FD.v);
    const Arg: FrmlPtr[] = [null];
    let N: number;
    if (Op === _recno) {
      let KF: KeyFldDPtr = K!.KFlds;
      N = 0;
      if (KF === null) OldError(176);
      while (KF !== null) {
        Accept(',');
        N++;
        if (N > 30) Error(123);
        Arg[N] = RdFrml(Typ);
        if (Typ.v !== KF.FldD!.FrmlTyp) OldError(12);
        KF = KF.Chain;
      }
    } else {
      Accept(',');
      N = 1;
      Arg[1] = RdRealFrml();
    }
    Z = GetOp(Op, (N + 2) * 4)!;
    Z.FD = FD.v;
    Z.Key = K;
    Z.Arg = Arg; // Move(Arg,Z^.Arg,sizeof(FrmlPtr)*N): 1-based
    // if FTyp='R' then goto 2 (a FandSQL test only)
  };
  // 1:
  const L1 = (): void => {
    RdLex();
    FTyp = 'R';
    L11();
  };
  // 3: GETTXT(path[,pos[,len]]), FILESIZE(path)
  const L3 = (): void => {
    const z = Z!;
    RdPath(true, fref(z, 'TxtPath'), fref(z, 'TxtCatIRec'));
    if (z.Op === _gettxt && a.Lexem === ',') {
      RdLex();
      z.P1 = RdRealFrml();
      if (a.Lexem === ',') {
        RdLex();
        z.P2 = RdRealFrml();
      }
    }
  };
  let evalTyp = '\0';
  if (IsKeyWord('EVALB')) evalTyp = 'B';
  else if (IsKeyWord('EVALS')) evalTyp = 'S';
  else if (IsKeyWord('EVALR')) evalTyp = 'R';
  if (evalTyp !== '\0') {
    FTyp = evalTyp; // 4:
    RdLex();
    Z = GetOp(_eval, 5)!;
    Z.EvalTyp = FTyp;
    Z.P1 = RdStrFrml();
  } else if (a.FileVarsAllowed) Error(75);
  else if (IsKeyWord('PROMPT')) {
    RdLex();
    Z = GetOp(_prompt, 4)!;
    Z.P1 = RdStrFrml();
    const F = RdFldDescr('', true)!;
    Z.FldD = F;
    FTyp = F.FrmlTyp;
    if (F.Typ === 'T') OldError(65);
    if (a.Lexem === _assign) {
      RdLex();
      Z.P2 = RdFrml(Typ);
      if (Typ.v !== FTyp) OldError(12);
    }
  } else if (IsKeyWord('KEYOF')) {
    RdLex();
    FTyp = 'S';
    if (!IsRecVar(LV)) {
      Op = _recno;
      L11();
    } else {
      Z = GetOp(_keyof, 8)!;
      Z.LV = LV.v;
      Z.PackKey = RdViewKeyImpl(Z.LV!.FD);
      FTyp = 'S';
    }
  } else if (IsKeyWord('RECNO')) {
    Op = _recno;
    L1();
  } else if (IsKeyWord('RECNOABS')) {
    Op = _recnoabs;
    L1();
  } else if (IsKeyWord('RECNOLOG')) {
    Op = _recnolog;
    L1();
  } else if (IsKeyWord('LINK')) {
    RdLex();
    Z = GetOp(_link, 5)!;
    if (IsRecVar(LV)) {
      Z.LinkFromRec = true;
      Z.LinkLV = LV.v;
      FD.v = LV.v!.FD;
    } else {
      FD.v = RdFileName();
      Accept('[');
      Z.LinkRecFrml = RdRealFrml();
      Accept(']');
    }
    Accept(',');
    const cf = a.CFile;
    a.CFile = FD.v;
    if (!IsRoleName(true, FD, LD) || LD.v === null) Error(9);
    a.CFile = cf;
    Z.LinkLD = LD.v;
    FTyp = 'R'; // goto 2
  } else if (IsKeyWord('ISDELETED')) {
    RdLex();
    FTyp = 'B';
    if (IsRecVar(LV)) {
      Z = GetOp(_lvdeleted, 4)!;
      Z.LV = LV.v;
    } else {
      Z = GetOp(_isdeleted, 4)!;
      FD.v = RdFileName();
      Z.RecFD = FD.v;
      Accept(',');
      Z.P1 = RdRealFrml();
      // 2: (FandSQL test only)
    }
  } else if (IsKeyWord('GETPATH')) {
    RdLex();
    Z = GetOp(_getpath, 0)!;
    Z.P1 = RdStrFrml();
    FTyp = 'S';
  } else if (IsKeyWord('GETTXT')) {
    RdLex();
    Z = GetOp(_gettxt, 6)!;
    FTyp = 'S';
    L3();
  } else if (IsKeyWord('FILESIZE')) {
    RdLex();
    Z = GetOp(_filesize, 14)!;
    FTyp = 'R';
    L3();
  } else if (IsKeyWord('INTTSR')) {
    RdLex();
    Z = GetOp(_inttsr, 5)!;
    Z.P1 = RdRealFrml();
    Accept(',');
    Z.P2 = RdRealFrml();
    Accept(',');
    Typ.v = 'r';
    if (IsRecVar(LV)) Z.P3 = LV.v!.RecPtr as unknown as FrmlPtr; // Pascal Z^.P3:=LV^.RecPtr
    else Z.P3 = RdFrml(Typ);
    Z.N31 = ord(Typ.v);
    FTyp = 'R';
  } else if (IsKeyWord('SELECTSTR')) {
    RdLex();
    Z = GetOp(_selectstr, 13)!;
    FTyp = 'S';
    RdSelectStr(Z);
  } else if (IsKeyWord('PROMPTYN')) {
    RdLex();
    Z = GetOp(_promptyn, 0)!;
    Z.P1 = RdStrFrml();
    FTyp = 'B';
  } else if (IsKeyWord('MOUSEEVENT')) {
    RdLex();
    Z = GetOp(_mouseevent, 2)!;
    Z.W01 = RdInteger();
    FTyp = 'B';
  } else if (IsKeyWord('ISMOUSE')) {
    RdLex();
    Z = GetOp(_ismouse, 4)!;
    Z.W01 = RdInteger();
    Accept(',');
    Z.W02 = RdInteger();
    FTyp = 'B';
  } else if (IsKeyWord('MOUSEIN')) {
    RdLex();
    Z = GetOp(_mousein, 4)!;
    Z.P1 = RdRealFrml();
    Accept(',');
    Z.P2 = RdRealFrml();
    Accept(',');
    Z.P3 = RdRealFrml();
    Accept(',');
    Z.P4 = RdRealFrml();
    FTyp = 'B';
  } else if (IsKeyWord('PORTIN')) {
    RdLex();
    Z = GetOp(_portin, 0)!;
    Z.P1 = RdBool();
    Accept(',');
    Z.P2 = RdRealFrml();
    FTyp = 'R';
  } else Error(75);
  Accept(')');
  FFTyp.v = FTyp;
  return Z;
}

// PAS: RDPROC.PAS GetPInstrN
function GetPInstrN(Kind: PInstrCode, Size: number, Extra: number): InstrPtr {
  return new Instr(Kind); // GetZStore(sizeof(Instr)+Extra); PD^.Kind:=Kind
}
// PAS: RDPROC.PAS GetPInstr
export function GetPInstr(Kind: PInstrCode, Size: number): InstrPtr {
  return GetPInstrN(Kind, Size, 0);
}

// PAS: RDPROC.PAS RdPInstrAndChain – appends RdPInstr (may be a chain itself) to PD
function RdPInstrAndChain(PD: Ref<InstrPtr>): void {
  const PD1 = RdPInstr();
  if (PD.v === null) {
    PD.v = PD1;
    return;
  }
  let PD2 = PD.v;
  while (PD2.Chain !== null) PD2 = PD2.Chain;
  PD2.Chain = PD1;
}
// PAS: RDPROC.PAS RdChoices – 'OF txt[,help[,bool[!]]]: instr; ... [ESCAPE: instr] END'
function RdChoices(PD: Instr): void {
  const a = AccessVars;
  AcceptKeyWord('OF');
  let N = 0;
  for (;;) {
    // 1:
    if (IsKeyWord('ESCAPE')) {
      Accept(':');
      PD.WasESCBranch = true;
      PD.ESCInstr = RdPInstr();
    } else {
      const CD = new ChoiceD();
      ChainLast(fref(PD, 'Choices'), CD);
      N++;
      if (PD.Kind === _menubar && N > 30) Error(102);
      CD.TxtFrml = RdStrFrml();
      if (a.Lexem === ',') {
        RdLex();
        if (a.Lexem !== ',') {
          CD.HelpName = RdHelpName();
          PD.HelpRdb = a.CRdb;
        }
        if (a.Lexem === ',') {
          RdLex();
          if (a.Lexem !== ',') {
            CD.Bool = RdBool();
            if (a.Lexem === '!') {
              CD.DisplEver = true;
              RdLex();
            }
          }
        }
      }
      Accept(':');
      CD.Instr = RdPInstr();
    }
    if (a.Lexem === ';') {
      RdLex();
      if (IsKeyWord('END')) return;
      continue;
    }
    AcceptKeyWord('END');
    return;
  }
}
// PAS: RDPROC.PAS RdMenuAttr – ';attr,attr,attr[,attr]'
function RdMenuAttr(PD: Instr): void {
  const a = AccessVars;
  if (a.Lexem !== ';') return;
  RdLex();
  PD.mAttr[0] = RdAttr();
  Accept(',');
  PD.mAttr[1] = RdAttr();
  Accept(',');
  PD.mAttr[2] = RdAttr();
  if ((a.Lexem as string) === ',') {
    RdLex();
    PD.mAttr[3] = RdAttr();
  }
}
// PAS: RDPROC.PAS RdMenuBox – MENU / MENULOOP
function RdMenuBox(Loop: boolean): InstrPtr {
  const a = AccessVars;
  const PD = GetPInstr(_menubox, 48)!;
  PD.Loop = Loop;
  if (a.Lexem === '(') {
    RdLex();
    if ((a.Lexem as string) !== ';') {
      PD.X = RdRealFrml();
      Accept(',');
      PD.Y = RdRealFrml();
    }
    RdMenuAttr(PD);
    Accept(')');
  }
  if (a.Lexem === '!') {
    RdLex();
    PD.Shdw = true;
  }
  if (IsKeyWord('PULLDOWN')) PD.PullDown = true;
  if (!TestKeyWord('OF')) PD.HdLine = RdStrFrml();
  RdChoices(PD);
  return PD;
}
// PAS: RDPROC.PAS RdMenuBar
function RdMenuBar(): InstrPtr {
  const a = AccessVars;
  const PD = GetPInstr(_menubar, 48)!;
  if (a.Lexem === '(') {
    RdLex();
    if ((a.Lexem as string) !== ';') {
      PD.Y = RdRealFrml();
      if ((a.Lexem as string) === ',') {
        RdLex();
        PD.X = RdRealFrml();
        Accept(',');
        PD.XSz = RdRealFrml();
      }
    }
    RdMenuAttr(PD);
    Accept(')');
  }
  RdChoices(PD);
  return PD;
}
// PAS: RDPROC.PAS RdIfThenElse
function RdIfThenElse(): InstrPtr {
  const PD = GetPInstr(_ifthenelseP, 12)!;
  PD.Bool = RdBool();
  AcceptKeyWord('THEN');
  PD.Instr = RdPInstr();
  if (IsKeyWord('ELSE')) PD.ElseInstr = RdPInstr();
  return PD;
}
// PAS: RDPROC.PAS RdWhileDo
function RdWhileDo(): InstrPtr {
  const PD = GetPInstr(_whiledo, 8)!;
  PD.Bool = RdBool();
  AcceptKeyWord('DO');
  PD.Instr = RdPInstr();
  return PD;
}
// PAS: RDPROC.PAS RdFor – 'FOR v:=a TO b DO i' = v:=a; while v<=b do begin i; v+=1 end
function RdFor(): InstrPtr {
  const LV = ref<LocVarPtr>(null);
  if (!FindLocVar(RdRunVars.LVBD.Root, LV) || LV.v!.FTyp !== 'R') Error(146);
  RdLex();
  let PD = GetPInstr(_asgnloc, 9)!;
  const result = PD;
  PD.AssLV = LV.v;
  Accept(_assign);
  PD.Frml = RdRealFrml();
  AcceptKeyWord('TO');
  PD.Chain = GetPInstr(_whiledo, 8);
  PD = PD.Chain!;
  let Z = GetOp(_compreal, 2)!;
  Z.P1 = LocVarFrml(LV.v!);
  Z.N21 = ord(_le);
  Z.N22 = 5;
  Z.P2 = RdRealFrml();
  PD.Bool = Z;
  AcceptKeyWord('DO');
  let PD1 = RdPInstr();
  PD.Instr = PD1;
  PD1 = GetPInstr(_asgnloc, 9)!;
  ChainLast(fref(PD, 'Instr'), PD1);
  PD1.Add = true;
  PD1.AssLV = LV.v;
  Z = GetOp(_const, 6)!;
  Z.R = 1;
  PD1.Frml = Z;
  return result;
}
// PAS: RDPROC.PAS RdCase – 'CASE b1: i1; b2: i2; ... [ELSE ...] END' = nested if-then-else
function RdCase(): InstrPtr {
  const a = AccessVars;
  let first = true;
  let result: InstrPtr = null;
  let PD: Instr | null = null;
  for (;;) {
    // 1:
    const PD1 = GetPInstr(_ifthenelseP, 12)!;
    if (first) result = PD1;
    else PD!.ElseInstr = PD1;
    PD = PD1;
    first = false;
    PD.Bool = RdBool();
    Accept(':');
    PD.Instr = RdPInstr();
    const b = a.Lexem === ';';
    if (b) RdLex();
    if (!IsKeyWord('END')) {
      if (IsKeyWord('ELSE')) {
        while (!IsKeyWord('END')) {
          RdPInstrAndChain(fref(PD, 'ElseInstr'));
          if (a.Lexem === ';') RdLex();
          else {
            AcceptKeyWord('END'); // goto 2
            break;
          }
        }
      } else if (b) continue;
      else AcceptKeyWord('END'); // 2:
    }
    return result;
  }
}
// PAS: RDPROC.PAS RdRepeatUntil
function RdRepeatUntil(): InstrPtr {
  const a = AccessVars;
  const PD = GetPInstr(_repeatuntil, 8)!;
  while (!IsKeyWord('UNTIL')) {
    RdPInstrAndChain(fref(PD, 'Instr'));
    if (a.Lexem === ';') RdLex();
    else {
      AcceptKeyWord('UNTIL');
      break; // goto 1
    }
  }
  PD.Bool = RdBool(); // 1:
  return PD;
}
// PAS: RDPROC.PAS RdForAll – 'FORALL [v IN] file|recvar [/key|OWNER ...] [(cond)] [!] [%] DO i'
function RdForAll(): InstrPtr {
  const a = AccessVars;
  const LVi = ref<LocVarPtr>(null);
  const LVr = ref<LocVarPtr>(null);
  if (!FindLocVar(RdRunVars.LVBD.Root, LVi)) Error(122);
  RdLex();
  if (LVi.v!.FTyp === 'r') {
    LVr.v = LVi.v;
    LVi.v = null;
    a.CFile = LVr.v!.FD;
  } else {
    TestReal(LVi.v!.FTyp);
    AcceptKeyWord('IN');
    if (FindLocVar(RdRunVars.LVBD.Root, LVr)) {
      if (LVr.v!.FTyp === 'f') {
        a.CFile = LVr.v!.FD;
        RdLex();
        LVr.v = null; // goto 1
      } else {
        if (LVr.v!.FTyp !== 'r') Error(141);
        a.CFile = LVr.v!.FD;
        RdLex();
      }
    } else {
      a.CFile = RdFileName();
      LVr.v = null; // 1:
    }
  }
  const PD = GetPInstr(_forall, 41)!;
  PD.CFD = a.CFile;
  PD.CVar = LVi.v;
  PD.CRecVar = LVr.v;
  if (IsKeyWord('OWNER')) {
    PD.COwnerTyp = RdOwner(fref(PD, 'CLD'), fref(PD, 'CLV'));
    a.CViewKey = GetFromKey(PD.CLD);
  } else a.CViewKey = RdViewKey();
  if (a.Lexem === '(') {
    RdLex();
    PD.CBool = RdKeyInBool(fref(PD, 'CKIRoot'), false, true, fref(PD, 'CSQLFilter'));
    if (PD.CKIRoot !== null && PD.CLV !== null) OldError(118);
    Accept(')');
  }
  if (a.Lexem === '!') {
    RdLex();
    PD.CWIdx = true;
  }
  if (a.Lexem === '%') {
    RdLex();
    PD.CProcent = true;
  }
  PD.CKey = a.CViewKey;
  AcceptKeyWord('DO'); // 2:
  PD.CInstr = RdPInstr();
  return PD;
}
// PAS: RDPROC.PAS RdBeginEnd – 'i1; i2; ... END' (after BEGIN)
function RdBeginEnd(): InstrPtr {
  const a = AccessVars;
  const PD = ref<InstrPtr>(null);
  if (!IsKeyWord('END')) {
    for (;;) {
      // 1:
      RdPInstrAndChain(PD);
      if (a.Lexem === ';') {
        RdLex();
        if (!IsKeyWord('END')) continue;
      } else AcceptKeyWord('END');
      break;
    }
  }
  return PD.v;
}

// PAS: RDPROC.PAS RdProcArg – Caller 'P' PROC, 'C' CALL, 'E' edit EXIT, 'T' edittxt EXIT
function RdProcArg(Caller: string): InstrPtr {
  const a = AccessVars;
  const Pos = new RdbPos();
  const TArg: TypAndFrml[] = [new TypAndFrml()]; // [1..31], index 0 unused
  const LV = ref<LocVarPtr>(null);
  if (Caller !== 'C') RdChptName('P', Pos, Caller === 'P' || Caller === 'E' || Caller === 'T');
  let N = 0;
  let args = false;
  if (Caller !== 'P') {
    if (a.Lexem === '(') {
      RdLex();
      args = true; // goto 1
    }
  } else if (a.Lexem === ',') {
    RdLex();
    Accept('(');
    args = true;
  }
  if (args) {
    for (;;) {
      // 1:
      N++;
      if (N > 30) Error(123);
      const T = new TypAndFrml(); // fillchar(FTyp,sizeof(TypAndFrml),0)
      TArg[N] = T;
      if (a.ForwChar !== '.' && FindLocVar(RdRunVars.LVBD.Root, LV) && (LV.v!.FTyp === 'i' || LV.v!.FTyp === 'r')) {
        RdLex();
        T.FTyp = LV.v!.FTyp;
        T.FD = LV.v!.FD;
        T.RecPtr = LV.v!.RecPtr;
      } else if (a.Lexem === '@') {
        RdLex();
        if ((a.Lexem as string) === '[') {
          RdLex();
          T.Name = StoreStr(a.LexWord);
          Accept(_identifier);
          Accept(',');
          const z = GetOp(_setmybp, 0)!;
          z.P1 = RdStrFrml();
          T.TxtFrml = z;
          Accept(']');
        } else T.FD = RdFileName();
        T.FTyp = 'f';
      } else T.Frml = RdFrml(fref(T, 'FTyp'));
      if (a.Lexem === ',') {
        RdLex();
        continue;
      }
      break;
    }
    Accept(')');
  }
  if (Caller === 'E') {
    N++;
    TArg[N] = new TypAndFrml();
    TArg[N].FTyp = 'r';
  }
  const L = N; // N*sizeof(TypAndFrml)
  const PD = GetPInstrN(_proc, 0, L)!;
  PD.Pos = Pos;
  PD.N = N;
  PD.TArg = TArg; // Move(TArg,PD^.TArg,L)
  PD.ExPar = Caller === 'E';
  return PD;
}

const NKeyNames = 20;
// TS: built on first use - DRIVERS' key constants are not initialised yet at module load when the
// import cycle enters here first (PORTING.md 5)
let KeyNamesTab: readonly { Nm: string; Brk: number; Code: number }[] | null = null;
const KeyNamesInit = (): readonly { Nm: string; Brk: number; Code: number }[] => [
  { Nm: 'HOME', Brk: 51, Code: _Home_ },
  { Nm: 'UP', Brk: 52, Code: _up_ },
  { Nm: 'PGUP', Brk: 53, Code: _PgUp_ },
  { Nm: 'LEFT', Brk: 55, Code: _left_ },
  { Nm: 'RIGHT', Brk: 57, Code: _right_ },
  { Nm: 'END', Brk: 59, Code: _End_ },
  { Nm: 'DOWN', Brk: 60, Code: _down_ },
  { Nm: 'PGDN', Brk: 61, Code: _PgDn_ },
  { Nm: 'INS', Brk: 62, Code: _Ins_ },
  { Nm: 'CTRLLEFT', Brk: 71, Code: _CtrlLeft_ },
  { Nm: 'CTRLRIGHT', Brk: 72, Code: _CtrlRight_ },
  { Nm: 'CTRLEND', Brk: 73, Code: _CtrlEnd_ },
  { Nm: 'CTRLPGDN', Brk: 74, Code: _CtrlPgDn_ },
  { Nm: 'CTRLHOME', Brk: 75, Code: _CtrlHome_ },
  { Nm: 'CTRLPGUP', Brk: 76, Code: _CtrlPgUp_ },
  { Nm: 'TAB', Brk: 77, Code: _Tab_ },
  { Nm: 'SHIFTTAB', Brk: 78, Code: _ShiftTab_ },
  { Nm: 'CTRLN', Brk: 79, Code: _N_ },
  { Nm: 'CTRLY', Brk: 80, Code: _Y_ },
  { Nm: 'ESC', Brk: 81, Code: _ESC_ },
  { Nm: 'CTRLP', Brk: 82, Code: _P_ },
]; // [0..NKeyNames]

// PAS: RDPROC.PAS RdKeyCode.NotCode – 'F1'..'F10' style names (true = not this kind)
function NotCode(Nm: string, CodeBase: number, BrkBase: number, E: EdExKeyD): boolean {
  const a = AccessVars;
  if (a.Lexem !== _identifier) return true;
  if (!SEquUpcase(Copy(a.LexWord, 1, Nm.length), Nm)) return true;
  const i = ref(0);
  const k = ref(0);
  ValI(Copy(a.LexWord, Nm.length + 1, 2), i, k);
  if (k.v !== 0 || i.v <= 0 || i.v > 10) return true;
  i.v--;
  RdLex();
  E.KeyCode = (CodeBase + (i.v << 8)) & 0xffff;
  E.Break = BrkBase + i.v;
  return false;
}
// PAS: RDPROC.PAS RdKeyCode – one exit key name
function RdKeyCode(X: EdExitD): void {
  const E = new EdExKeyD();
  E.Chain = X.Keys;
  X.Keys = E;
  if (
    NotCode('F', _F1_, 21, E) &&
    NotCode('ShiftF', _ShiftF1_, 1, E) &&
    NotCode('CtrlF', _CtrlF1_, 31, E) &&
    NotCode('AltF', _AltF1_, 41, E)
  ) {
    for (let i = 0; i <= NKeyNames; i++) {
      const kn = (KeyNamesTab ??= KeyNamesInit())[i];
      if (EquUpcase(kn.Nm)) {
        E.KeyCode = kn.Code;
        E.Break = kn.Brk;
        RdLex();
        return;
      }
    }
    Error(129);
  }
}
/** TS-only: the record of 5 FrmlPtrs RdHeadLast overlays (EditOpt, Instr of _edittxt). */
interface HeadLastRec {
  Head: FrmlPtr;
  Last: FrmlPtr;
  CtrlLast: FrmlPtr;
  AltLast: FrmlPtr;
  ShiftLast: FrmlPtr;
}
// PAS: RDPROC.PAS RdHeadLast – HEAD=, LAST=, CTRL=, ALT=, SHIFT=
function RdHeadLast(A: HeadLastRec): boolean {
  if (IsOpt('HEAD')) A.Head = RdStrFrml();
  else if (IsOpt('LAST')) A.Last = RdStrFrml();
  else if (IsOpt('CTRL')) A.CtrlLast = RdStrFrml();
  else if (IsOpt('ALT')) A.AltLast = RdStrFrml();
  else if (IsOpt('SHIFT')) A.ShiftLast = RdStrFrml();
  else return false;
  return true;
}

// PAS: RDPROC.PAS RdViewOpt.RdKeyList – 'key,key,(flds),RECORD,NEWREC:'
function RdKeyList(X: EdExitD): void {
  const a = AccessVars;
  for (;;) {
    // 1:
    if (a.Lexem === '(' || a.Lexem === '^') RdNegFldList(fref(X, 'NegFlds'), fref(X, 'Flds'));
    else if (IsKeyWord('RECORD')) X.AtWrRec = true;
    else if (IsKeyWord('NEWREC')) X.AtNewRec = true;
    else RdKeyCode(X);
    if (a.Lexem === ',') {
      RdLex();
      continue;
    }
    break;
  }
  Accept(':');
}
// PAS: RDPROC.PAS RdViewOpt – one ',option' of EDIT/view; false when not a view option
export function RdViewOpt(EO: EditOptPtr): boolean {
  const a = AccessVars;
  const eo = EO!;
  RdLex();
  a.CViewKey = eo.ViewKey;
  if (IsOpt('TAB')) RdNegFldList(fref(eo, 'NegTab'), fref(eo, 'Tab'));
  else if (IsOpt('DUPL')) RdNegFldList(fref(eo, 'NegDupl'), fref(eo, 'Dupl'));
  else if (IsOpt('NOED')) RdNegFldList(fref(eo, 'NegNoEd'), fref(eo, 'NoEd'));
  else if (IsOpt('MODE')) {
    SkipBlank(false);
    if (a.Lexem === _quotedstr && (a.ForwChar === ',' || a.ForwChar === ')')) {
      const Flgs: boolean[] = new Array(25).fill(false); // [1..23] (EditModeToFlags writes 1..24)
      EditModeToFlags(a.LexWord, Flgs, true);
      eo.Mode = GetOp(_const, a.LexWord.length + 1);
      eo.Mode!.S = a.LexWord;
      RdLex();
    } else eo.Mode = RdStrFrml();
  } else if (RdHeadLast(eo)) return true;
  else if (IsOpt('WATCH')) eo.WatchDelayZ = RdRealFrml();
  else if (IsOpt('WW')) {
    Accept('(');
    eo.WFlags = 0;
    if (a.Lexem === '(') {
      RdLex();
      eo.WFlags = WNoPop;
    }
    RdW(eo.W);
    RdFrame(fref(eo, 'Top'), fref(eo, 'WFlags'));
    if (a.Lexem === ',') {
      RdLex();
      eo.ZAttr = RdAttr();
      Accept(',');
      eo.ZdNorm = RdAttr();
      Accept(',');
      eo.ZdHiLi = RdAttr();
      if (a.Lexem === ',') {
        RdLex();
        eo.ZdSubset = RdAttr();
        if (a.Lexem === ',') {
          RdLex();
          eo.ZdDel = RdAttr();
          if (a.Lexem === ',') {
            RdLex();
            eo.ZdTab = RdAttr();
            if (a.Lexem === ',') {
              RdLex();
              eo.ZdSelect = RdAttr();
            }
          }
        }
      }
    }
    Accept(')');
    if ((eo.WFlags & WNoPop) !== 0) Accept(')');
  } else if (IsOpt('EXIT')) {
    Accept('(');
    for (;;) {
      // 1:
      const X = new EdExitD();
      ChainLast(fref(eo, 'ExD'), X);
      RdKeyList(X);
      if (IsKeyWord('QUIT')) X.Typ = 'Q';
      else if (IsKeyWord('REPORT')) {
        if (X.AtWrRec || eo.LVRecPtr !== null) OldError(144);
        Accept('(');
        X.Typ = 'R';
        const RO = GetRprtOpt()!;
        RdChptName('R', RO.RprtPos, true);
        while (a.Lexem === ',') {
          RdLex();
          if (IsOpt('ASSIGN')) RdPath(true, fref(RO, 'Path'), fref(RO, 'CatIRec'));
          else if (IsKeyWord('EDIT')) RO.Edit = true;
          else Error(130);
        }
        X.RO = RO;
        Accept(')');
      } else if (!(a.Lexem === ',' || a.Lexem === ')')) {
        X.Typ = 'P';
        X.Proc = RdProcArg('E');
      }
      if (a.Lexem === ',') {
        RdLex();
        continue;
      }
      break;
    }
    Accept(')');
  } else if (eo.LVRecPtr !== null) return false;
  else if (IsOpt('COND')) {
    if (a.Lexem === '(') {
      RdLex();
      eo.Cond = RdKeyInBool(fref(eo, 'KIRoot'), false, true, fref(eo, 'SQLFilter'));
      Accept(')');
    } else eo.Cond = RdKeyInBool(fref(eo, 'KIRoot'), false, true, fref(eo, 'SQLFilter'));
  } else if (IsOpt('JOURNAL')) {
    eo.Journal = RdFileName();
    let l = eo.Journal!.RecLen - 13;
    if (a.CFile!.Typ === 'X') l++;
    if (a.CFile!.RecLen !== l) OldError(111);
  } else if (IsOpt('SAVEAFTER')) eo.SaveAfterZ = RdRealFrml();
  else if (IsOpt('REFRESH')) eo.RefreshDelayZ = RdRealFrml();
  else return false;
  return true;
}

// ---------------------------------------------------------------- RdPInstr and its nested routines

// PAS: RDPROC.PAS RdPInstr.GetPD – new instruction, then skip the '(' after its keyword
function GetPD(Kind: PInstrCode, Size: number): Instr {
  const PD = GetPInstr(Kind, Size)!;
  RdLex();
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdFlds
function RdFlds(): FieldList {
  const FLRoot = ref<FieldList>(null);
  for (;;) {
    // 1:
    const FL = new FieldListEl();
    ChainLast(FLRoot, FL);
    FL.FldD = RdFldName(AccessVars.CFile);
    if (AccessVars.Lexem === ',') {
      RdLex();
      continue;
    }
    return FLRoot.v;
  }
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdSubFldList – '(f1,f2,...)' out of InFL (Opt 'S': real only)
function RdSubFldList(InFL: FieldList, Opt: string): FieldList {
  const a = AccessVars;
  Accept('(');
  const FLRoot = ref<FieldList>(null);
  for (;;) {
    // 1:
    const FL = new FieldListEl();
    ChainLast(FLRoot, FL);
    let F: FieldDPtr;
    if (InFL === null) F = RdFldName(a.CFile);
    else {
      TestIdentif();
      let FL1: FieldList = InFL;
      while (FL1 !== null) {
        if (EquUpcase(FL1.FldD!.Name)) break; // goto 2
        FL1 = FL1.Chain;
      }
      if (FL1 === null) Error(43);
      F = FL1.FldD; // 2:
      RdLex();
    }
    FL.FldD = F;
    if (Opt === 'S' && F!.FrmlTyp !== 'R') OldError(20);
    if (a.Lexem === ',') {
      RdLex();
      continue;
    }
    break;
  }
  Accept(')');
  return FLRoot.v;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdSortCall – SORT(file,(keys))
function RdSortCall(): InstrPtr {
  const PD = GetPD(_sort, 8);
  const FD = RdFileName();
  PD.SortFD = FD;
  Accept(',');
  Accept('(');
  RdKFList(fref(PD, 'SK'), PD.SortFD);
  Accept(')');
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdEditCall.RdEditOpt
function RdEditOpt(EO: NonNullable<EditOptPtr>): void {
  const a = AccessVars;
  if (IsOpt('FIELD')) EO.StartFieldZ = RdStrFrml();
  else if (EO.LVRecPtr !== null) Error(125);
  else if (IsOpt('OWNER')) {
    if (EO.SQLFilter || EO.KIRoot !== null) OldError(179);
    EO.OwnerTyp = RdOwner(fref(EO, 'DownLD'), fref(EO, 'DownLV'));
  } else if (IsOpt('RECKEY')) EO.StartRecKeyZ = RdStrFrml();
  else if (IsOpt('RECNO')) EO.StartRecNoZ = RdRealFrml();
  else if (IsOpt('IREC')) EO.StartIRecZ = RdRealFrml();
  else if (IsKeyWord('CHECK')) EO.SyntxChk = true;
  else if (IsOpt('SEL')) {
    const lv = RdIdxVar()!;
    EO.SelKey = lv.RecPtr as XWKey;
    if (EO.ViewKey === null) OldError(108);
    if (EO.ViewKey === EO.SelKey) OldError(184);
    if (EO.ViewKey!.KFlds !== null && EO.SelKey.KFlds !== null && !EquKFlds(EO.SelKey.KFlds, EO.ViewKey!.KFlds)) {
      OldError(178);
    }
  } else Error(125);
  void a;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdEditCall – EDIT(file[/key]|recvar, view, options)
function RdEditCall(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_edit, 8);
  const EO = GetEditOpt()!;
  PD.EO = EO;
  const lv = ref<LocVarPtr>(null);
  if (IsRecVar(lv)) {
    EO.LVRecPtr = lv.v!.RecPtr as Uint8Array;
    a.CFile = lv.v!.FD;
  } else {
    a.CFile = RdFileName();
    let K = RdViewKey();
    if (K === null) K = a.CFile!.Keys;
    EO.ViewKey = K;
  }
  PD.EditFD = a.CFile;
  Accept(',');
  if (IsOpt('U')) {
    TestIdentif();
    if (a.CFile!.ViewNames === null) Error(114);
    const p = SaveCompState();
    const b = RdUserView(a.LexWord, EO);
    RestoreCompState(p);
    if (!b) Error(114);
    RdLex();
  } else RdBegViewDcl(EO);
  while (a.Lexem === ',') {
    const b = RdViewOpt(EO);
    if (!b) RdEditOpt(EO);
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdReportCall.RdRprtOpt
function RdRprtOpt(RO: NonNullable<RprtOptPtr>, HasFrst: boolean): void {
  const a = AccessVars;
  if (IsOpt('ASSIGN')) RdPath(true, fref(RO, 'Path'), fref(RO, 'CatIRec'));
  else if (IsOpt('TIMES')) RO.Times = RdRealFrml();
  else if (IsOpt('MODE')) {
    if (IsKeyWord('ONLYSUM')) RO.Mode = _ATotal;
    else if (IsKeyWord('ERRCHECK')) RO.Mode = _AErrRecs;
    else Error(49);
  } else if (IsKeyWord('COND')) {
    if (!HasFrst) OldError(51); // goto 2
    let Low = a.CurrPos;
    Accept(_equ);
    let br = false;
    let quest = false;
    if (a.Lexem === '(') {
      Low = a.CurrPos;
      RdLex();
      br = true;
      if ((a.Lexem as string) === '?') {
        RdLex();
        RO.UserCondQuest = true;
        quest = true; // goto 1
      }
    }
    if (!quest) {
      const FDL = RO.FDL;
      FDL.Cond = RdKeyInBool(fref(FDL, 'KeyIn'), true, true, fref(FDL, 'SQLFilter'));
      const N = (a.OldErrPos - Low) & 0xffff;
      // CondTxt:=GetStore(N+1); Move(InpArrPtr^[Low],CondTxt^[1],N); CondTxt^[0]:=char(N)
      RO.CondTxt = BytesToStr(a.InpArrPtr!, Low - 1, N).slice(0, N & 0xff);
    }
    if (br) Accept(')'); // 1:
  } else if (IsOpt('CTRL')) {
    if (!HasFrst) OldError(51);
    RO.Ctrl = RdSubFldList(RO.Flds, 'C');
  } else if (IsOpt('SUM')) {
    if (!HasFrst) OldError(51);
    RO.Sum = RdSubFldList(RO.Flds, 'S');
  } else if (IsOpt('WIDTH')) RO.WidthFrml = RdRealFrml();
  else if (IsOpt('STYLE')) {
    if (IsKeyWord('COMPRESSED')) RO.Style = 'C';
    else if (IsKeyWord('NORMAL')) RO.Style = 'N';
    else Error(50);
  } else if (IsKeyWord('EDIT')) RO.Edit = true;
  else if (IsKeyWord('PRINTCTRL')) RO.PrintCtrl = true;
  else if (IsKeyWord('CHECK')) RO.SyntxChk = true;
  else if (IsOpt('SORT')) {
    if (!HasFrst) OldError(51); // 2:
    Accept('(');
    RdKFList(fref(RO, 'SK'), a.CFile);
    Accept(')');
  } else if (IsOpt('HEAD')) RO.Head = RdStrFrml();
  else Error(45);
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdReportCall – REPORT([(]file[/key][(cond)],...[)], rprt|(flds), options)
function RdReportCall(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_report, 4);
  const RO = GetRprtOpt()!;
  PD.RO = RO;
  let hasfrst = false;
  let FDL: RprtFDListEl | null = null;
  const lv = ref<LocVarPtr>(null);
  if (a.Lexem !== ',') {
    hasfrst = true;
    FDL = RO.FDL;
    let b = false;
    if (a.Lexem === '(') {
      RdLex();
      b = true;
    }
    for (;;) {
      // 1:
      if (IsRecVar(lv)) {
        FDL.LVRecPtr = lv.v!.RecPtr as Uint8Array;
        FDL.FD = lv.v!.FD;
      } else {
        a.CFile = RdFileName();
        FDL.FD = a.CFile;
        a.CViewKey = RdViewKey();
        FDL.ViewKey = a.CViewKey;
        if (a.Lexem === '(') {
          RdLex();
          FDL.Cond = RdKeyInBool(fref(FDL, 'KeyIn'), true, true, fref(FDL, 'SQLFilter'));
          Accept(')');
        }
      }
      if (b && a.Lexem === ',') {
        RdLex();
        FDL.Chain = new RprtFDListEl();
        FDL = FDL.Chain;
        continue;
      }
      break;
    }
    if (b) Accept(')');
    a.CFile = RO.FDL.FD;
    a.CViewKey = RO.FDL.ViewKey;
  }
  Accept(','); // 2:
  if (a.Lexem === '[') {
    RdLex();
    RO.RprtPos.R = null;
    RO.RprtPos.Frml = RdStrFrml(); // Pascal RprtPos.R:=RdbDPtr(RdStrFrml)
    RO.RprtPos.IRec = 0;
    RO.FromStr = true;
    Accept(']');
  } else if (!hasfrst || a.Lexem === _identifier) {
    TestIdentif();
    if (!FindChpt('R', a.LexWord, false, RO.RprtPos)) Error(37);
    RdLex();
  } else {
    Accept('(');
    switch (a.Lexem as string) {
      case '?':
        RO.Flds = AllFldsList(a.CFile, false);
        RdLex();
        RO.UserSelFlds = true;
        break;
      case ')':
        RO.Flds = AllFldsList(a.CFile, true);
        break;
      default:
        RO.Flds = RdFlds();
        if ((a.Lexem as string) === '?') {
          RdLex();
          RO.UserSelFlds = true;
        }
    }
    Accept(')');
  }
  while (a.Lexem === ',') {
    RdLex();
    RdRprtOpt(RO, hasfrst && FDL!.LVRecPtr === null);
  }
  if (RO.Mode === _ALstg && (RO.Ctrl !== null || RO.Sum !== null)) RO.Mode = _ARprt;
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdRDBCall – CALL([\]rdb[,proc(args)])
function RdRDBCall(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_call, 12);
  let s = '';
  if (a.Lexem === '\\') {
    s = a.Lexem;
    RdLex();
  }
  TestIdentif();
  if (a.LexWord.length > 8) Error(2);
  PD.RdbNm = StoreStr(s + a.LexWord);
  RdLex();
  if (a.Lexem === ',') {
    RdLex();
    TestIdentif();
    if (a.LexWord.length > 12) Error(2);
    PD.ProcNm = StoreStr(a.LexWord);
    RdLex();
    PD.ProcCall = RdProcArg('C');
  } else PD.ProcNm = StoreStr('main');
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdExec – EXEC(path,param[,NOCANCEL|FREEMEM|LOADFONT|TEXTMODE])
function RdExec(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_exec, 14);
  RdPath(true, fref(PD, 'ProgPath'), fref(PD, 'ProgCatIRec'));
  Accept(',');
  PD.Param = RdStrFrml();
  while (a.Lexem === ',') {
    RdLex();
    if (IsKeyWord('NOCANCEL')) PD.NoCancel = true;
    else if (IsKeyWord('FREEMEM')) PD.FreeMm = true;
    else if (IsKeyWord('LOADFONT')) PD.LdFont = true;
    else if (IsKeyWord('TEXTMODE')) PD.TextMd = true;
    else Error(101);
  }
  return PD;
}
const OptArr = ['', 'FIX', 'VAR', 'TXT']; // [1..3]
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdCopyFile.RdCOpt – '/FIX', '/VAR', '/TXT'
function RdCOpt(): CpOption {
  RdLex();
  TestIdentif();
  for (let i = 1; i <= 3; i++) {
    if (EquUpcase(OptArr[i])) {
      RdLex();
      return i;
    }
  }
  return Error(53);
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdCopyFile.RdX – '.X' (copy the index file too)
function RdX(FD: FileDPtr): boolean {
  if (AccessVars.Lexem === '.' && FD !== null) {
    RdLex();
    AcceptKeyWord('X');
    if (FD.Typ !== 'X') OldError(108);
    return true;
  }
  return false;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdCopyFile.TestFixVar
function TestFixVar(Opt: CpOption, FD1: FileDPtr, FD2: FileDPtr): boolean {
  if (Opt !== cpNo && FD1 !== null) OldError(139);
  if (Opt === cpFix || Opt === cpVar) {
    if (FD2 === null) OldError(139);
    return true;
  }
  return false;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdCopyFile.RdList (declared, never called)
export function RdList(S: Ref<StringPtr | FrmlPtr>): boolean {
  if (AccessVars.Lexem !== '(') return false;
  RdLex();
  S.v = RdStrFrml(); // S:=StringPtr(RdStrFrml)
  Accept(')');
  return true;
}
const ModeTxt = ['', 'KL', 'LK', 'KN', 'LN', 'LW', 'KW', 'WL']; // [1..7]
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdCopyFile – COPYFILE(src[.X][/opt],dst[.X][/opt],options)
function RdCopyFile(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_copyfile, 4);
  let noapp = false;
  const D = new CopyD();
  PD.CD = D;
  D.FD1 = RdPath(false, fref(D, 'Path1'), fref(D, 'CatIRec1'));
  D.WithX1 = RdX(D.FD1);
  if (a.Lexem === '/') {
    if (D.FD1 !== null) {
      a.CFile = D.FD1;
      D.ViewKey = RdViewKey();
    } else D.Opt1 = RdCOpt();
  }
  Accept(',');
  D.FD2 = RdPath(false, fref(D, 'Path2'), fref(D, 'CatIRec2'));
  D.WithX2 = RdX(D.FD2);
  if (a.Lexem === '/') {
    if (D.FD2 !== null) Error(139);
    else D.Opt2 = RdCOpt();
  }
  if (!TestFixVar(D.Opt1, D.FD1, D.FD2) && !TestFixVar(D.Opt2, D.FD2, D.FD1)) {
    if (D.Opt1 === cpTxt && D.FD2 !== null) OldError(139);
    noapp = (D.FD1 === null) !== (D.FD2 === null);
  }
  while (a.Lexem === ',') {
    RdLex();
    if (IsOpt('HEAD')) {
      D.HdFD = RdFileName();
      Accept('.');
      D.HdF = RdFldName(D.HdFD);
      if (
        D.HdF!.FrmlTyp !== 'S' ||
        !D.HdFD!.IsParFile ||
        ((D.Opt1 === cpFix || D.Opt1 === cpVar) && (D.HdF!.Flg & f_Stored) === 0)
      ) {
        Error(52);
      }
    } else if (IsOpt('MODE')) {
      TestLex(_quotedstr);
      let found = false;
      for (let i = 1; i <= 7; i++) {
        if (SEquUpcase(a.LexWord, ModeTxt[i])) {
          D.Mode = i;
          found = true; // goto 1
          break;
        }
      }
      if (!found) Error(142);
      RdLex(); // 1:
    } else if (IsKeyWord('NOCANCEL')) D.NoCancel = true;
    else if (IsKeyWord('APPEND')) {
      if (noapp) OldError(139);
      D.Append = true;
    } else Error(52);
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdPrintTxt – PRINTTXT(locvar|path)
function RdPrintTxt(): InstrPtr {
  const PD = GetPD(_printtxt, 10);
  if (FindLocVar(RdRunVars.LVBD.Root, fref(PD, 'TxtLV'))) {
    RdLex();
    TestString(PD.TxtLV!.FTyp);
  } else RdPath(true, fref(PD, 'TxtPath'), fref(PD, 'TxtCatIRec'));
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdEditTxt – EDITTXT(locvar|path, options)
function RdEditTxt(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_edittxt, 73);
  if (FindLocVar(RdRunVars.LVBD.Root, fref(PD, 'TxtLV'))) {
    RdLex();
    TestString(PD.TxtLV!.FTyp);
  } else RdPath(true, fref(PD, 'TxtPath'), fref(PD, 'TxtCatIRec'));
  PD.EdTxtMode = 'T';
  while (a.Lexem === ',') {
    RdLex();
    if (IsOpt('WW')) {
      Accept('(');
      if ((a.Lexem as string) === '(') {
        RdLex();
        PD.WFlags = WNoPop;
      }
      RdW(PD.Ww);
      RdFrame(fref(PD, 'Hd'), fref(PD, 'WFlags'));
      if (a.Lexem === ',') {
        RdLex();
        PD.Atr = RdAttr();
      }
      Accept(')');
      if ((PD.WFlags & WNoPop) !== 0) Accept(')');
    } else if (IsOpt('TXTPOS')) PD.TxtPos = RdRealFrml();
    else if (IsOpt('TXTXY')) PD.TxtXY = RdRealFrml();
    else if (IsOpt('ERRMSG')) PD.ErrMsg = RdStrFrml();
    else if (IsOpt('EXIT')) {
      Accept('(');
      for (;;) {
        // 1:
        const pX = new EdExitD();
        ChainLast(fref(PD, 'ExD'), pX);
        for (;;) {
          // 2:
          RdKeyCode(pX);
          if (a.Lexem === ',') {
            RdLex();
            continue;
          }
          break;
        }
        Accept(':');
        if (IsKeyWord('QUIT')) pX.Typ = 'Q';
        else if (!(a.Lexem === ',' || a.Lexem === ')')) {
          pX.Typ = 'P';
          pX.Proc = RdProcArg('T');
        }
        if (a.Lexem === ',') {
          RdLex();
          continue;
        }
        break;
      }
      Accept(')');
    } else if (RdHeadLast(PD)) {
      // HEAD=, LAST=, ...
    } else if (IsKeyWord('NOEDIT')) PD.EdTxtMode = 'V';
    else Error(161);
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdPutTxt – PUTTXT(path,txt[,APPEND])
function RdPutTxt(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_puttxt, 11);
  RdPath(true, fref(PD, 'TxtPath'), fref(PD, 'TxtCatIRec'));
  Accept(',');
  PD.Txt = RdStrFrml();
  if (a.Lexem === ',') {
    RdLex();
    AcceptKeyWord('APPEND');
    PD.App = true;
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdTurnCat – TURNCAT(catname,n)
function RdTurnCat(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_turncat, 12);
  TestIdentif();
  PD.NextGenFD = FindFileD();
  const Frst = GetCatIRec(a.LexWord, true);
  TestCatError(Frst, a.LexWord, true);
  RdLex();
  PD.FrstCatIRec = Frst;
  const RN = RdCatField(Frst, a.CatRdbName);
  const FN = RdCatField(Frst, a.CatFileName);
  let I = Frst + 1;
  while (
    a.CatFD!.NRecs >= I &&
    SEquUpcase(RN, RdCatField(I, a.CatRdbName)) &&
    SEquUpcase(FN, RdCatField(I, a.CatFileName))
  ) {
    I++;
  }
  if (I === Frst + 1) OldError(98);
  PD.NCatIRecs = I - Frst;
  Accept(',');
  PD.TCFrml = RdRealFrml();
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdWriteln – OpKind 0 write, 1 writeln, 2 message (3 +help)
function RdWriteln(OpKind: number): InstrPtr {
  const a = AccessVars;
  RdLex();
  let z: FrmlPtr = null;
  const d = new WrLnD(); // fillchar(d,sizeof(d),0)
  let w: WrLnD = d;
  for (;;) {
    // 1:
    w.Frml = RdFrml(fref(w, 'Typ'));
    if (w.Typ === 'R') {
      w.Typ = 'F';
      if (a.Lexem === ':') {
        RdLex();
        if ((a.Lexem as string) === _quotedstr) {
          w.Typ = 'D';
          w.Mask = StoreStr(a.LexWord);
          RdLex();
        } else {
          w.N = RdInteger();
          if (a.Lexem === ':') {
            RdLex();
            if ((a.Lexem as string) === '-') {
              RdLex();
              w.M = -RdInteger();
            } else w.M = RdInteger();
          }
        }
      }
    }
    if (a.Lexem === ',') {
      RdLex();
      if (OpKind === 2 && IsOpt('HELP')) z = RdStrFrml();
      else {
        w = new WrLnD();
        ChainLast(fref(d, 'Chain'), w);
        continue;
      }
    }
    break;
  }
  let n = 1 + 20; // 1+sizeof(d)
  if (z !== null) {
    OpKind = 3;
    n += 8;
  }
  const pd = GetPInstr(_writeln, n)!;
  pd.LF = OpKind;
  pd.WD = d;
  if (OpKind === 3) {
    pd.mHlpRdb = a.CRdb;
    pd.mHlpFrml = z;
  }
  return pd;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdReleaseDrive
function RdReleaseDrive(): InstrPtr {
  const PD = GetPD(_releasedrive, 4);
  PD.Drive = RdStrFrml();
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdIndexfile – INDEXFILE(file[,COMPRESS])
function RdIndexfile(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_indexfile, 5);
  PD.IndexFD = RdFileName();
  if (PD.IndexFD!.Typ !== 'X') OldError(108);
  if (a.Lexem === ',') {
    RdLex();
    AcceptKeyWord('COMPRESS');
    PD.Compress = true;
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdGetIndex – GETINDEX(idxvar, +|-,recnr | file[/key], options)
function RdGetIndex(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_getindex, 31);
  const lv = RdIdxVar()!;
  PD.giLV = lv;
  Accept(',');
  PD.giMode = ' ';
  if (a.Lexem === '+' || a.Lexem === '-') {
    PD.giMode = a.Lexem;
    RdLex();
    Accept(',');
    PD.giCond = RdRealFrml(); // RecNr
    return PD;
  }
  a.CFile = RdFileName();
  if (lv.FD !== a.CFile) OldError(164);
  a.CViewKey = RdViewKey();
  PD.giKD = a.CViewKey;
  while (a.Lexem === ',') {
    RdLex();
    if (IsOpt('SORT')) {
      if ((lv.RecPtr as XWKey).KFlds !== null) OldError(175);
      Accept('(');
      RdKFList(fref(PD, 'giKFlds'), a.CFile);
      Accept(')');
    } else if (IsOpt('COND')) {
      Accept('(');
      PD.giCond = RdKeyInBool(fref(PD, 'giKIRoot'), false, true, fref(PD, 'giSQLFilter'));
      Accept(')');
    } else if (IsOpt('OWNER')) {
      PD.giOwnerTyp = RdOwner(fref(PD, 'giLD'), fref(PD, 'giLV2'));
      const k = GetFromKey(PD.giLD);
      if (a.CViewKey === null) PD.giKD = k;
      else if (a.CViewKey !== k) OldError(178);
    } else Error(167);
    if (PD.giOwnerTyp !== '\0' && (PD.giSQLFilter || PD.giKIRoot !== null)) Error(179);
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdGotoXY
function RdGotoXY(): InstrPtr {
  const PD = GetPD(_gotoxy, 8);
  PD.GoX = RdRealFrml();
  Accept(',');
  PD.GoY = RdRealFrml();
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdClrWw – CLRSCR(c1,r1,c2,r2[,attr[,fillchar]])
function RdClrWw(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_clrww, 24);
  RdW(PD.W);
  if (a.Lexem === ',') {
    RdLex();
    if (a.Lexem !== ',') PD.Attr = RdAttr();
    if (a.Lexem === ',') {
      RdLex();
      PD.FillC = RdStrFrml();
    }
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdMount – MOUNT(file|catname[,NOCANCEL])
function RdMount(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_mount, 3);
  TestIdentif();
  const FD = FindFileD();
  let I: number;
  if (FD === null) I = GetCatIRec(a.LexWord, true);
  else I = FD.CatIRec;
  TestCatError(I, a.LexWord, false);
  RdLex();
  PD.MountCatIRec = I;
  if (a.Lexem === ',') {
    RdLex();
    AcceptKeyWord('NOCANCEL');
    PD.MountNoCancel = true;
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdDisplay – DISPLAY(helpchapter|string)
function RdDisplay(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_display, 6);
  if (a.Lexem === _identifier && FindChpt('H', a.LexWord, false, PD.Pos)) RdLex();
  else {
    PD.Pos.R = null;
    PD.Pos.Frml = RdStrFrml(); // Pascal R:=RdbDPtr(RdStrFrml)
    PD.Pos.IRec = 0;
  }
  return PD;
}
const Nm1 = ['', 'TYPE', 'HEAD', 'HEADX', 'HEADY', 'HEADZ', 'FILL', 'DIRX', 'GRID', 'PRINT', 'PALETTE', 'ASSIGN'];
const Nm1Fld = ['', 'T', 'H', 'HX', 'HY', 'HZ', 'C', 'D', 'R', 'P', 'CO', 'Assign'] as const; // FrmlArrPtr(@T)^[i]
const Nm2 = ['', 'WIDTH', 'RECNO', 'NRECS', 'MAX', 'MIN', 'GRPOLY'];
const Nm2Fld = ['', 'S', 'RS', 'RN', 'Max', 'Min', 'SP'] as const; // FrmlArrPtr(@S)^[i]
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdGraphP – GRAPH(...) is parsed (FandGraphParse), never run
function RdGraphP(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_graph, 4);
  const GD = new GraphD();
  PD.GD = GD;
  if (IsOpt('GF')) GD.GF = RdStrFrml();
  else {
    GD.FD = RdFileName();
    a.CFile = GD.FD;
    a.CViewKey = RdViewKey();
    GD.ViewKey = a.CViewKey;
    Accept(',');
    Accept('(');
    GD.X = RdFldName(GD.FD);
    let i = 0;
    do {
      Accept(',');
      GD.ZA[i] = RdFldName(GD.FD);
      i++;
    } while (!(i > 9 || a.Lexem !== ','));
    Accept(')');
  }
  const di = ref(0);
  outer: while (a.Lexem === ',') {
    RdLex();
    for (let i = 1; i <= 11; i++) {
      if (IsOpt(Nm1[i])) {
        (GD as unknown as Record<string, FrmlPtr>)[Nm1Fld[i]] = RdStrFrml();
        continue outer; // goto 1
      }
    }
    for (let i = 1; i <= 6; i++) {
      if (IsOpt(Nm2[i])) {
        (GD as unknown as Record<string, FrmlPtr>)[Nm2Fld[i]] = RdRealFrml();
        continue outer;
      }
    }
    if (IsDigitOpt('HEADZ', di)) GD.HZA[di.v] = RdStrFrml();
    else if (IsKeyWord('INTERACT')) GD.Interact = true;
    else if (IsOpt('COND')) {
      if ((a.Lexem as string) === '(') {
        RdLex();
        GD.Cond = RdKeyInBool(fref(GD, 'KeyIn'), false, true, fref(GD, 'SQLFilter'));
        Accept(')');
      } else GD.Cond = RdKeyInBool(fref(GD, 'KeyIn'), false, true, fref(GD, 'SQLFilter'));
    } else if (IsOpt('TXT')) {
      const VD = new GraphVD();
      ChainLast(fref(GD, 'V'), VD);
      Accept('(');
      VD.XZ = RdRealFrml();
      Accept(',');
      VD.YZ = RdRealFrml();
      Accept(',');
      VD.Velikost = RdRealFrml();
      Accept(',');
      VD.BarPis = RdStrFrml();
      Accept(',');
      VD.Text = RdStrFrml();
      Accept(')');
    } else if (IsOpt('TXTWIN')) {
      const WD = new GraphWD();
      ChainLast(fref(GD, 'W'), WD);
      Accept('(');
      WD.XZ = RdRealFrml();
      Accept(',');
      WD.YZ = RdRealFrml();
      Accept(',');
      WD.XK = RdRealFrml();
      Accept(',');
      WD.YK = RdRealFrml();
      Accept(',');
      WD.BarPoz = RdStrFrml();
      Accept(',');
      WD.BarPis = RdStrFrml();
      Accept(',');
      WD.Text = RdStrFrml();
      Accept(')');
    } else if (IsOpt('RGB')) {
      const RGBD = new GraphRGBD();
      ChainLast(fref(GD, 'RGB'), RGBD);
      Accept('(');
      RGBD.Barva = RdStrFrml();
      Accept(',');
      RGBD.R = RdRealFrml();
      Accept(',');
      RGBD.G = RdRealFrml();
      Accept(',');
      RGBD.B = RdRealFrml();
      Accept(')');
    } else if (IsOpt('WW')) {
      const Ww = new WinG(); // (Pascal never stores it into GD^.WW)
      Accept('(');
      if ((a.Lexem as string) === '(') {
        RdLex();
        Ww.WFlags = WNoPop;
      }
      RdW(Ww.W);
      RdFrame(fref(Ww, 'Top'), fref(Ww, 'WFlags'));
      if (a.Lexem === ',') {
        RdLex();
        Ww.ColBack = RdStrFrml();
        Accept(',');
        Ww.ColFor = RdStrFrml();
        Accept(',');
        Ww.ColFrame = RdStrFrml();
      }
      Accept(')');
      if ((Ww.WFlags & WNoPop) !== 0) Accept(')');
    } else Error(44);
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdMixRecAcc – APPENDREC/DELETEREC/RECALLREC/READREC/WRITEREC
function RdMixRecAcc(Op: PInstrCode): InstrPtr {
  const a = AccessVars;
  const cf = a.CFile;
  let PD: Instr;
  if (Op === _appendrec || Op === _recallrec) {
    PD = GetPD(Op, 9);
    a.CFile = RdFileName();
    PD.RecFD = a.CFile;
    if (Op === _recallrec) {
      Accept(',');
      PD.RecNr = RdRealFrml();
    }
  } else {
    PD = GetPD(Op, 15);
    if (Op === _deleterec) {
      a.CFile = RdFileName();
      PD.RecFD = a.CFile;
    } else {
      // _readrec, _writerec
      if (!IsRecVar(fref(PD, 'LV'))) Error(141);
      a.CFile = PD.LV!.FD;
    }
    let K = RdViewKey();
    Accept(',');
    const FTyp = ref('\0');
    const Z = RdFrml(FTyp)!;
    PD.RecNr = Z;
    switch (FTyp.v) {
      case 'B':
        OldError(12);
        break;
      case 'S':
        PD.ByKey = true;
        if (PD.CompOp === '\0') PD.CompOp = _equ;
        if (K === null) K = a.CFile!.Keys;
        PD.Key = K;
        if (K === null && (!a.CFile!.IsParFile || Z.Op !== _const || Z.S !== '')) OldError(24);
        break;
    }
  }
  if (a.Lexem === ',' && (Op === _writerec || Op === _deleterec || Op === _recallrec)) {
    RdLex();
    Accept('+');
    PD.AdUpd = true;
  }
  a.CFile = cf;
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdLinkRec – LINKREC(recvar, recvar|role(recvar))
function RdLinkRec(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_linkrec, 12);
  if (!IsRecVar(fref(PD, 'RecLV1'))) Error(141);
  Accept(',');
  a.CFile = PD.RecLV1!.FD;
  const LV = ref<LocVarPtr>(null);
  let LD: LinkDPtr;
  if (IsRecVar(LV)) {
    LD = FindLD(LV.v!.FD!.Name);
    if (LD === null) OldError(154);
  } else {
    TestIdentif();
    LD = FindLD(a.LexWord);
    if (LD === null) Error(9);
    RdLex();
    Accept('(');
    LV.v = RdRecVar();
    if (LD.ToFD !== LV.v!.FD) OldError(141);
    Accept(')');
  }
  PD.RecLV2 = LV.v;
  PD.LinkLD = LD;
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdBackup – BACKUP/RESTORE[M](archive[,dir[,masks]],options)
function RdBackup(MTyp: string, IsBackup: boolean): InstrPtr {
  const a = AccessVars;
  let PD: Instr;
  if (MTyp === 'M') PD = GetPD(_backupm, 15);
  else PD = GetPD(_backup, 5);
  PD.IsBackup = IsBackup;
  TestIdentif();
  const cf = a.CFile;
  const cr = a.CRecPtr;
  a.CFile = a.CatFD;
  a.CRecPtr = GetRecSpace();
  let found = false;
  for (let i = 1; i <= a.CatFD!.NRecs; i++) {
    ReadRec(i);
    if (
      SEquUpcase(TrailChar(' ', _ShortS(a.CatRdbName)), 'ARCHIVES') &&
      SEquUpcase(TrailChar(' ', _ShortS(a.CatFileName)), a.LexWord)
    ) {
      RdLex();
      PD.BrCatIRec = i;
      a.CFile = cf;
      a.CRecPtr = cr;
      found = true; // goto 1
      break;
    }
  }
  if (!found) Error(88);
  if (MTyp === 'M') {
    // 1:
    Accept(',');
    PD.bmDir = RdStrFrml();
    if (IsBackup) {
      Accept(',');
      PD.bmMasks = RdStrFrml();
    }
  }
  while (a.Lexem === ',') {
    RdLex();
    if (MTyp === 'M') {
      if (!IsBackup && IsKeyWord('OVERWRITE')) {
        PD.bmOverwr = true;
        continue; // goto 2
      }
      if (IsKeyWord('SUBDIR')) {
        PD.bmSubDir = true;
        continue;
      }
    }
    if (IsKeyWord('NOCOMPRESS')) PD.NoCompress = true;
    else {
      AcceptKeyWord('NOCANCEL');
      PD.BrNoCancel = true;
    }
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdSetEditTxt – SETEDITTXT(OVERWR=b,INDENT=b,...)
function RdSetEditTxt(): InstrPtr {
  const a = AccessVars;
  const PD = GetPD(_setedittxt, 7 * 4);
  for (;;) {
    // 1:
    if (IsOpt('OVERWR')) PD.Insert = RdBool();
    else if (IsOpt('INDENT')) PD.Indent = RdBool();
    else if (IsOpt('WRAP')) PD.Wrap = RdBool();
    else if (IsOpt('ALIGN')) PD.Just = RdBool();
    else if (IsOpt('COLBLK')) PD.ColBlk = RdBool();
    else if (IsOpt('LEFT')) PD.Left = RdRealFrml();
    else if (IsOpt('RIGHT')) PD.Right = RdRealFrml();
    else Error(160);
    if (a.Lexem === ',') {
      RdLex();
      continue;
    }
    return PD;
  }
}
// PAS: RDPROC.PAS RdPInstr.RdProcCall.RdCallLProc – LPROC(chapter[,predicate])
function RdCallLProc(): InstrPtr {
  const a = AccessVars;
  const pd = GetPD(_lproc, 10);
  RdChptName('L', pd.lpPos, true);
  if (a.Lexem === ',') {
    RdLex();
    TestIdentif();
    pd.lpName = StoreStr(a.LexWord);
    RdLex();
  }
  return pd;
}

// PAS: RDPROC.PAS RdPInstr.RdProcCall – 'name(' instructions
function RdProcCall(): InstrPtr {
  const a = AccessVars;
  let PD: InstrPtr = null;
  // label tails: 1 string argument, 2 real argument, 3 graphics primitives
  const L1 = (P: Instr): void => {
    P.Frml = RdStrFrml();
  };
  const L2 = (P: Instr): void => {
    P.Frml = RdRealFrml();
  };
  const L3 = (P: Instr): void => {
    P.Par1 = RdRealFrml();
    Accept(',');
    P.Par2 = RdRealFrml();
    Accept(',');
    if (P.Kind === _outtextxy) {
      P.Par3 = RdStrFrml();
      Accept(',');
      P.Par4 = RdRealFrml();
      Accept(',');
      P.Par5 = RdAttr();
      if (a.Lexem === ',') {
        RdLex();
        P.Par6 = RdRealFrml();
        if (a.Lexem === ',') {
          RdLex();
          P.Par7 = RdRealFrml();
          if (a.Lexem === ',') {
            RdLex();
            P.Par8 = RdRealFrml();
            Accept(',');
            P.Par9 = RdRealFrml();
            Accept(',');
            P.Par10 = RdRealFrml();
            Accept(',');
            P.Par11 = RdRealFrml();
          }
        }
      }
    } else if (P.Kind === _putpixel) P.Par3 = RdAttr();
    else {
      P.Par3 = RdRealFrml();
      Accept(',');
      if (P.Kind === _floodfill) P.Par4 = RdAttr();
      else P.Par4 = RdRealFrml();
      Accept(',');
      P.Par5 = RdAttr();
      if (P.Kind === _ellipse && a.Lexem === ',') {
        RdLex();
        P.Par6 = RdRealFrml();
        Accept(',');
        P.Par7 = RdRealFrml();
      }
    }
  };
  let P: Instr;
  if (IsKeyWord('EXEC')) PD = RdExec();
  else if (IsKeyWord('COPYFILE')) PD = RdCopyFile();
  else if (IsKeyWord('PROC')) {
    RdLex();
    PD = RdProcArg('P');
  } else if (IsKeyWord('DISPLAY')) PD = RdDisplay();
  else if (IsKeyWord('CALL')) PD = RdRDBCall();
  else if (IsKeyWord('WRITELN')) PD = RdWriteln(1);
  else if (IsKeyWord('WRITE')) PD = RdWriteln(0);
  else if (IsKeyWord('HEADLINE')) {
    PD = P = GetPD(_headline, 4);
    L1(P);
  } else if (IsKeyWord('SETKEYBUF')) {
    PD = P = GetPD(_setkeybuf, 4);
    L1(P);
  } else if (IsKeyWord('HELP')) {
    PD = P = GetPD(_help, 8);
    if (a.CRdb!.HelpFD === null) OldError(132);
    P.HelpRdb = a.CRdb;
    L1(P);
  } else if (IsKeyWord('MESSAGE')) PD = RdWriteln(2);
  else if (IsKeyWord('GOTOXY')) PD = RdGotoXY();
  else if (IsKeyWord('MERGE')) {
    PD = P = GetPD(_merge, 6);
    RdChptName('M', P.Pos, true);
  } else if (IsKeyWord('SORT')) PD = RdSortCall();
  else if (IsKeyWord('EDIT')) PD = RdEditCall();
  else if (IsKeyWord('REPORT')) PD = RdReportCall();
  else if (IsKeyWord('EDITTXT')) PD = RdEditTxt();
  else if (IsKeyWord('PRINTTXT')) PD = RdPrintTxt();
  else if (IsKeyWord('PUTTXT')) PD = RdPutTxt();
  else if (IsKeyWord('TURNCAT')) PD = RdTurnCat();
  else if (IsKeyWord('RELEASEDRIVE')) PD = RdReleaseDrive();
  else if (IsKeyWord('SETPRINTER')) {
    PD = P = GetPD(_setprinter, 4);
    L2(P);
  } else if (IsKeyWord('INDEXFILE')) PD = RdIndexfile();
  else if (IsKeyWord('GETINDEX')) PD = RdGetIndex();
  else if (IsKeyWord('MOUNT')) PD = RdMount();
  else if (IsKeyWord('CLRSCR')) PD = RdClrWw();
  else if (IsKeyWord('APPENDREC')) PD = RdMixRecAcc(_appendrec);
  else if (IsKeyWord('DELETEREC')) PD = RdMixRecAcc(_deleterec);
  else if (IsKeyWord('RECALLREC')) PD = RdMixRecAcc(_recallrec);
  else if (IsKeyWord('READREC')) PD = RdMixRecAcc(_readrec);
  else if (IsKeyWord('WRITEREC')) PD = RdMixRecAcc(_writerec);
  else if (IsKeyWord('LINKREC')) PD = RdLinkRec();
  else if (IsKeyWord('DELAY')) {
    PD = P = GetPD(_delay, 4);
    L2(P);
  } else if (IsKeyWord('SOUND')) {
    PD = P = GetPD(_sound, 4);
    L2(P);
  } else if (IsKeyWord('LPROC')) PD = RdCallLProc(); // FandLProc
  else if (IsKeyWord('GRAPH')) PD = RdGraphP(); // FandGraphParse
  else if (IsKeyWord('PUTPIXEL')) {
    PD = P = GetPD(_putpixel, 3 * 4);
    L3(P);
  } else if (IsKeyWord('LINE')) {
    PD = P = GetPD(_line, 5 * 4);
    L3(P);
  } else if (IsKeyWord('RECTANGLE')) {
    PD = P = GetPD(_rectangle, 5 * 4);
    L3(P);
  } else if (IsKeyWord('ELLIPSE')) {
    PD = P = GetPD(_ellipse, 7 * 4);
    L3(P);
  } else if (IsKeyWord('FLOODFILL')) {
    PD = P = GetPD(_floodfill, 5 * 4);
    L3(P);
  } else if (IsKeyWord('OUTTEXTXY')) {
    PD = P = GetPD(_outtextxy, 11 * 4);
    L3(P);
  } else if (IsKeyWord('CLOSE')) {
    PD = P = GetPD(_closefds, 4);
    P.clFD = RdFileName();
  } else if (IsKeyWord('BACKUP')) PD = RdBackup(' ', true);
  else if (IsKeyWord('BACKUPM')) PD = RdBackup('M', true);
  else if (IsKeyWord('RESTORE')) PD = RdBackup(' ', false);
  else if (IsKeyWord('RESTOREM')) PD = RdBackup('M', false);
  else if (IsKeyWord('SETEDITTXT')) PD = RdSetEditTxt();
  else if (IsKeyWord('SETMOUSE')) {
    PD = P = GetPD(_setmouse, 12);
    P.MouseX = RdRealFrml();
    Accept(',');
    P.MouseY = RdRealFrml();
    Accept(',');
    P.Show = RdBool();
  } else if (IsKeyWord('CHECKFILE')) {
    PD = P = GetPD(_checkfile, 10);
    P.cfFD = RdFileName();
    if (P.cfFD!.Typ === '8' || P.cfFD!.Typ === 'D') OldError(169);
    Accept(',');
    RdPath(true, fref(P, 'cfPath'), fref(P, 'cfCatIRec'));
  } else if (IsKeyWord('PORTOUT')) {
    PD = P = GetPD(_portout, 12);
    P.IsWord = RdBool();
    Accept(',');
    P.Port = RdRealFrml();
    Accept(',');
    P.PortWhat = RdRealFrml();
  } else Error(34);
  Accept(')');
  return PD;
}

// PAS: RDPROC.PAS AdjustComma – F,n.m fields with a decimal comma ('F' with f_Comma) are scaled
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
// PAS: RDPROC.PAS MakeImplAssign – recvar1 := recvar2: same-named stored fields
function MakeImplAssign(FD1: FileDPtr, FD2: FileDPtr): AssignDPtr {
  const a = AccessVars;
  const S = a.LexWord;
  const ARoot = ref<AssignDPtr>(null);
  const FTyp = ref('\0');
  let F1 = FD1!.FldD;
  while (F1 !== null) {
    if ((F1.Flg & f_Stored) !== 0) {
      a.LexWord = F1.Name;
      const F2 = FindFldName(FD2);
      if (F2 !== null) {
        const A = new AssignD();
        ChainLast(ARoot, A);
        if (F2.FrmlTyp !== F1.FrmlTyp || (F1.FrmlTyp === 'R' && F1.Typ !== F2.Typ)) {
          A.Kind = _zero;
          A.FldD = F1;
        } else {
          A.Kind = _output;
          A.OFldD = F1;
          let Z = MakeFldFrml(F2, FTyp);
          Z = AdjustComma(Z, F2, _divide);
          A.Frml = FrmlContxt(AdjustComma(Z, F1, _times), FD2, null);
        }
      }
    }
    F1 = F1.Chain;
  }
  a.LexWord = S;
  return ARoot.v;
}
// PAS: RDPROC.PAS RdPInstr.RdAssign – assignment statements
function RdAssign(): InstrPtr {
  const a = AccessVars;
  const lv = ref<LocVarPtr>(null);
  const LV2 = ref<LocVarPtr>(null);
  let PD: Instr;
  let F: FieldDPtr;
  let FTyp: string;
  // 0: the assignment formula
  const L0 = (P: Instr, Typ: string): void => {
    RdAssignFrml(Typ, fref(P, 'Add'), fref(P, 'Frml'));
  };
  if (a.ForwChar === '.') {
    if (FindLocVar(RdRunVars.LVBD.Root, lv) && (lv.v!.FTyp === 'r' || lv.v!.FTyp === 'i')) {
      FTyp = lv.v!.FTyp;
      RdLex();
      RdLex();
      if (FTyp === 'i') {
        AcceptKeyWord('NRECS');
        Accept(_assign);
        if (a.Lexem !== _number || a.LexWord !== '0') Error(183);
        RdLex();
        PD = GetPInstr(_asgnxnrecs, 4)!;
        PD.xnrIdx = lv.v!.RecPtr as XWKey;
      } else {
        PD = GetPInstr(_asgnrecfld, 13)!;
        PD.AssLV = lv.v;
        F = RdFldName(lv.v!.FD);
        PD.RecFldD = F;
        if ((F!.Flg & f_Stored) === 0) OldError(14);
        FTyp = F!.FrmlTyp;
        L0(PD, FTyp);
      }
    } else {
      const FName = a.LexWord;
      const FD = FindFileD();
      if (IsActiveRdb(FD)) Error(121);
      RdLex();
      RdLex();
      let CF: FieldDPtr = null;
      let cat = true;
      if (IsKeyWord('ARCHIVES')) CF = a.CatArchiv;
      else if (IsKeyWord('PATH')) CF = a.CatPathName;
      else if (IsKeyWord('VOLUME')) CF = a.CatVolume;
      else cat = false;
      if (cat) {
        // 1:
        PD = GetPInstr(_asgncatfield, 16)!;
        PD.FD3 = FD;
        PD.CatIRec = GetCatIRec(FName, true);
        PD.CatFld = CF;
        TestCatError(PD.CatIRec, FName, true);
        Accept(_assign);
        PD.Frml3 = RdStrFrml();
      } else if (FD === null) return OldError(9);
      else if (IsKeyWord('NRECS')) {
        if (FD.Typ === '0') OldError(127);
        PD = GetPInstr(_asgnnrecs, 9)!;
        PD.FD = FD;
        L0(PD, 'R');
      } else {
        if (!FD.IsParFile) OldError(64);
        PD = GetPInstr(_asgnpar, 13)!;
        PD.FD = FD;
        F = RdFldName(FD);
        PD.FldD = F;
        if ((F!.Flg & f_Stored) === 0) OldError(14);
        L0(PD, F!.FrmlTyp);
      }
    }
  } else if (a.ForwChar === '[') {
    PD = GetPInstr(_asgnfield, 18)!;
    const FD = RdFileName();
    PD.FD = FD;
    RdLex();
    PD.RecFrml = RdRealFrml();
    Accept(']');
    Accept('.');
    F = RdFldName(FD);
    PD.FldD = F;
    if ((F!.Flg & f_Stored) === 0) OldError(14);
    PD.Indexarg = FD!.Typ === 'X' && IsKeyArg(F, FD);
    RdAssignFrml(F!.FrmlTyp, fref(PD, 'Add'), fref(PD, 'Frml'));
  } else if (FindLocVar(RdRunVars.LVBD.Root, lv)) {
    RdLex();
    FTyp = lv.v!.FTyp;
    switch (FTyp) {
      case 'f':
      case 'i':
        return OldError(140);
      case 'r':
        Accept(_assign);
        if (!IsRecVar(LV2)) Error(141);
        PD = GetPInstr(_asgnrecvar, 12)!;
        PD.RecLV1 = lv.v;
        PD.RecLV2 = LV2.v;
        PD.Ass = MakeImplAssign(lv.v!.FD, LV2.v!.FD);
        break;
      default:
        PD = GetPInstr(_asgnloc, 9)!;
        PD.AssLV = lv.v;
        L0(PD, FTyp);
    }
  } else {
    let k: PInstrCode = -1;
    let kind = 0; // 2: string, 3: real
    if (IsKeyWord('USERNAME')) (k = _asgnusername), (kind = 2);
    else if (IsKeyWord('CLIPBD')) (k = _asgnclipbd), (kind = 2);
    else if (IsKeyWord('ACCRIGHT')) (k = _asgnaccright), (kind = 2);
    else if (IsKeyWord('EDOK')) (k = _asgnedok), (kind = 1);
    else if (IsKeyWord('RANDSEED')) (k = _asgnrand), (kind = 3);
    else if (IsKeyWord('TODAY')) (k = _asgnusertoday), (kind = 3);
    else if (IsKeyWord('USERCODE')) (k = _asgnusercode), (kind = 3);
    if (kind === 0) {
      RdLex();
      if (a.Lexem === _assign) return OldError(8);
      return OldError(34);
    }
    PD = GetPInstr(k, 4)!;
    Accept(_assign);
    if (kind === 2) PD.Frml = RdStrFrml(); // 2:
    else if (kind === 1) PD.Frml = RdBool();
    else PD.Frml = RdRealFrml(); // 3:
  }
  return PD;
}
// PAS: RDPROC.PAS RdPInstr.RdWith – WITH WINDOW/SHARED/LOCKED/GRAPHICS ... DO
function RdWith(): InstrPtr {
  const a = AccessVars;
  let P: Instr;
  if (IsKeyWord('WINDOW')) {
    P = GetPInstr(_window, 29)!;
    Accept('(');
    if (a.Lexem === '(') {
      RdLex();
      P.WithWFlags = WNoPop;
    }
    RdW(P.W);
    RdFrame(fref(P, 'Top'), fref(P, 'WithWFlags'));
    if (a.Lexem === ',') {
      RdLex();
      P.Attr = RdAttr();
    }
    Accept(')');
    if ((P.WithWFlags & WNoPop) !== 0) Accept(')');
    AcceptKeyWord('DO');
    P.WwInstr = RdPInstr();
  } else if (TestKeyWord('SHARED') || TestKeyWord('LOCKED')) {
    const Op = IsKeyWord('SHARED') ? _withshared : (AcceptKeyWord('LOCKED'), _withlocked);
    // 1:
    P = GetPInstr(Op, 9 + 16)!;
    let ld: LockD = P.WLD;
    for (;;) {
      // 2:
      ld.FD = RdFileName();
      if (Op === _withlocked) {
        Accept('[');
        ld.Frml = RdRealFrml();
        Accept(']');
      } else {
        Accept('(');
        let found = false;
        for (let i = NoExclMode; i <= ExclMode; i++) {
          if (IsKeyWord(LockModeTxt[i])) {
            ld.Md = i;
            found = true; // goto 3
            break;
          }
        }
        if (!found) Error(100);
        Accept(')'); // 3:
      }
      if (a.Lexem === ',') {
        RdLex();
        ld.Chain = new LockD();
        ld = ld.Chain;
        continue;
      }
      break;
    }
    AcceptKeyWord('DO');
    P.WDoInstr = RdPInstr();
    if (IsKeyWord('ELSE')) {
      P.WasElse = true;
      P.WElseInstr = RdPInstr();
    }
  } else if (IsKeyWord('GRAPHICS')) {
    P = GetPInstr(_withgraphics, 4)!;
    AcceptKeyWord('DO');
    P.WDoInstr = RdPInstr();
  } else return Error(131);
  return P;
}
// PAS: RDPROC.PAS RdPInstr.RdUserFuncAssign – 'v := x' inside a FUNCTION body
function RdUserFuncAssign(): InstrPtr {
  const lv = ref<LocVarPtr>(null);
  if (!FindLocVar(RdRunVars.LVBD.Root, lv)) Error(34);
  RdLex();
  const pd = GetPInstr(_asgnloc, 9)!;
  pd.AssLV = lv.v;
  RdAssignFrml(lv.v!.FTyp, fref(pd, 'Add'), fref(pd, 'Frml'));
  return pd;
}
// PAS: RDPROC.PAS RdPInstr – one statement (nil for an empty one)
function RdPInstr(): InstrPtr {
  const a = AccessVars;
  if (IsKeyWord('IF')) return RdIfThenElse();
  if (IsKeyWord('WHILE')) return RdWhileDo();
  if (IsKeyWord('REPEAT')) return RdRepeatUntil();
  if (IsKeyWord('CASE')) return RdCase();
  if (IsKeyWord('FOR')) return RdFor();
  if (IsKeyWord('BEGIN')) return RdBeginEnd();
  if (IsKeyWord('BREAK')) return GetPInstr(_break, 0);
  if (IsKeyWord('EXIT')) return GetPInstr(_exit, 0);
  if (IsKeyWord('CANCEL')) return GetPInstr(_cancel, 0);
  if (a.Lexem === ';') return null;
  if (IsRdUserFunc) return RdUserFuncAssign();
  if (IsKeyWord('MENULOOP')) return RdMenuBox(true);
  if (IsKeyWord('MENU')) return RdMenuBox(false);
  if (IsKeyWord('MENUBAR')) return RdMenuBar();
  if (IsKeyWord('WITH')) return RdWith();
  if (IsKeyWord('SAVE')) return GetPInstr(_save, 0);
  if (IsKeyWord('CLREOL')) return GetPInstr(_clreol, 0);
  if (IsKeyWord('FORALL')) return RdForAll();
  if (IsKeyWord('CLEARKEYBUF')) return GetPInstr(_clearkeybuf, 0);
  if (IsKeyWord('WAIT')) return GetPInstr(_wait, 0);
  if (IsKeyWord('BEEP')) return GetPInstr(_beep, 0);
  if (IsKeyWord('NOSOUND')) return GetPInstr(_nosound, 0);
  if (IsKeyWord('MEMDIAG')) return GetPInstr(_memdiag, 0); // not FandRunV
  if (IsKeyWord('RESETCATALOG')) return GetPInstr(_resetcat, 0);
  if (IsKeyWord('RANDOMIZE')) return GetPInstr(_randomize, 0);
  if (a.Lexem === _identifier) {
    SkipBlank(false);
    if (a.ForwChar === '(') return RdProcCall();
    if (IsKeyWord('CLRSCR')) return GetPInstr(_clrscr, 0);
    if (IsKeyWord('GRAPH')) return GetPInstr(_graph, 4);
    if (IsKeyWord('CLOSE')) return GetPInstr(_closefds, 4);
    return RdAssign();
  }
  return Error(34);
}

// PAS: RDPROC.PAS ReadProcHead – '(params)' and 'var' of a procedure chapter
export function ReadProcHead(): void {
  const a = AccessVars;
  ResetCompilePars();
  a.RdFldNameFrml = RdFldNameFrmlP;
  a.RdFunction = RdFunctionP;
  a.FileVarsAllowed = false;
  a.IdxLocVarAllowed = true;
  IsRdUserFunc = false;
  RdLex();
  ResetLVBD();
  if (a.Lexem === '(') {
    RdLex();
    RdLocDcl(RdRunVars.LVBD, true, true, 'P');
    Accept(')');
  }
  if (IsKeyWord('VAR')) RdLocDcl(RdRunVars.LVBD, false, true, 'P');
}
// PAS: RDPROC.PAS ReadProcBody – 'begin ... end;'
export function ReadProcBody(): InstrPtr {
  AcceptKeyWord('BEGIN');
  const result = RdBeginEnd();
  Accept(';');
  if (AccessVars.Lexem !== EOFChar) Error(40);
  return result;
}
// PAS: RDPROC.PAS ReadDeclChpt – FUNCTION declarations of a D chapter
export function ReadDeclChpt(): void {
  const a = AccessVars;
  RdLex();
  for (;;) {
    // 1:
    if (IsKeyWord('FUNCTION')) {
      TestIdentif();
      let fc = a.FuncDRoot;
      while (fc !== a.CRdb!.OldFCRoot) {
        if (EquUpcase(fc!.Name)) Error(26);
        fc = fc!.Chain;
      }
      const nfc = new FuncD(); // GetStore(sizeof(FuncD)-1+length(LexWord))
      nfc.Chain = a.FuncDRoot;
      a.FuncDRoot = nfc;
      nfc.Name = a.LexWord;
      a.RdFldNameFrml = RdFldNameFrmlP;
      a.RdFunction = RdFunctionP;
      a.ChainSumEl = null;
      a.FileVarsAllowed = false;
      IsRdUserFunc = true;
      RdLex();
      ResetLVBD();
      const LVBD = RdRunVars.LVBD;
      Accept('(');
      if (a.Lexem !== ')') RdLocDcl(LVBD, true, false, 'D');
      Accept(')');
      Accept(':');
      let typ: string;
      let n: number;
      if (IsKeyWord('REAL')) {
        typ = 'R';
        n = 6; // sizeof(float) in BP7 (RdLocDcl keeps 6, see PORTING.md section 14)
      } else if (IsKeyWord('STRING')) {
        typ = 'S';
        n = 4; // sizeof(longint)
      } else if (IsKeyWord('BOOLEAN')) {
        typ = 'B';
        n = 1;
      } else return Error(39);
      const lv = new LocVar(); // the result variable, named as the function
      ChainLast(fref(LVBD, 'Root'), lv);
      lv.Name = nfc.Name;
      lv.FTyp = typ;
      lv.Op = _getlocvar;
      lv.BPOfs = LVBD.Size;
      nfc.FTyp = typ;
      LVBD.Size += n;
      Accept(';');
      if (IsKeyWord('VAR')) RdLocDcl(LVBD, false, false, 'D');
      nfc.LVB = CopyRec(LVBD);
      AcceptKeyWord('BEGIN');
      nfc.Instr = RdBeginEnd();
      Accept(';');
    } else if (a.Lexem === EOFChar) return;
    else Error(40);
  }
}

// PAS: RDPROC.PAS GetEvalFrml – compiles the string of an _eval node at run time
export function GetEvalFrml(X: FrmlPtr): FrmlPtr {
  const a = AccessVars;
  const bv = BaseVars;
  const x = X!;
  const oldLVBD = CopyRec(RdRunVars.LVBD);
  const oldbp = bv.MyBP;
  SetMyBP(bv.ProcMyBP);
  let z: FrmlPtr = null;
  const cf = a.CFile;
  const cr = a.CRecPtr;
  const s = RunLongStr(x.P1)!;
  if (s.length === 0) bv.LastExitCode = 0; // goto 2
  else {
    bv.LastExitCode = 1;
    const p = SaveCompState();
    ResetCompilePars();
    a.RdFldNameFrml = RdFldNameFrmlP;
    a.RdFunction = RdFunctionP;
    if (x.EvalFD === null) a.FileVarsAllowed = false;
    else {
      a.CFile = x.EvalFD;
      a.FileVarsAllowed = true;
    }
    const er = new ExitRecord();
    NewExit(null, er); // Ovr
    try {
      SetInpLongStr(s, false);
      RdLex();
      const fTyp = ref('\0');
      z = RdFrml(fTyp);
      if (fTyp.v !== x.EvalTyp || a.Lexem !== EOFChar) z = null;
      else bv.LastExitCode = 0;
    } catch (e) {
      if (!(e instanceof GoExitSignal)) {
        RestoreExit(er);
        throw e;
      }
      // 1: (GoExitFired)
    }
    const cpos = a.CurrPos; // 1:
    RestoreExit(er);
    RestoreCompState(p);
    if (bv.LastExitCode !== 0) {
      a.LastTxtPos = cpos;
      if (x.EvalTyp === 'B') {
        z = GetOp(_const, 1)!;
        z.B = false;
      }
    }
    if (z !== null) {
      const z1 = z;
      z = GetOp(_setmybp, 0)!;
      z.P1 = z1;
    }
  }
  // 2:
  a.CFile = cf;
  a.CRecPtr = cr;
  SetMyBP(oldbp);
  AssignRec(RdRunVars.LVBD, oldLVBD); // for cond before cycle called when PushProcStk is not ready
  return z;
}
