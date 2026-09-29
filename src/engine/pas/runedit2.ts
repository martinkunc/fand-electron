// PAS: RUNEDIT2.PAS – include of RUNEDI: access rights, insert/append, search (PromptAndSearch,
// PromptGotoRecNr), check/test conditions (CompChk, CheckFromHere), sorting/auto report/graph from
// the editor, dependent items, record switching, free-text (T) fields (EditFreeTxt), item editing
// (EditItemProc), switches (SetSwitchProc), selection prompts and SwitchRecs.
//
// Porting notes:
// * State: RunEdiVars/RunEdiPriv in runedi.ts. Routines not in the RUNEDI interface are marked
//   unit-internal; they are exported only for the other include modules.
// * UpwEdit is forward-declared here and defined in RUNEDIT3 (runedit3.ts).
// * EditFreeTxt: BreakKeys differ with FandRunV (off); edits a T field with EDITOR.EditText,
//   handles the chapter-help ^F1 / GetChpt ('Heslo' = help keyword search), UpdateTxtPos.
// * Sorting: NewExit around SortAndSubst (PORTING.md 11 pattern). AutoGraph: no graphics in the
//   FPC build (message only).
// * GoPrevNextRec: paging over the work index / subset; `Delta` may be +-page.

// * EditFreeTxt: EDITOR.EditText edits the text in place in the heap after S (up to MaxLStrLen); here
//   the text is copied into a MaxLStrLen buffer and the edited length is cut off afterwards.

import {
  ref, fref, GoExitSignal, TxtWrite, Output, Move, Trunc, int16, StrToBytes, BytesToStr, ShortStr, Pos, ValI,
  type Ref, type Pointer,
} from './pasrt.ts';
import {
  BaseVars, ExitRecord, NewExit, RestoreExit, MarkStore, ReleaseStore, SEquUpcase, EqualsMask, RdMsg, SetMsgPar,
  OverlapByteStr, MaxLStrLen, type LongStrPtr,
} from './base.ts';
import {
  DriversVars, GotoXY, WhereX, ClrEol, Window, KeyPressed, ReadKey, ConvToNoDiakr, beep, evKeyDown, _ESC_, _M_,
  _up_, _down_, _CtrlEnd_, _CtrlHome_, _PgDn_, _PgUp_, _ShiftF7_, _F1_, _F9_, _F10_,
  _CtrlF1_, _ShiftF1_, _AltF10_, _AltF1_, _AltF3_, _AltEqual_, _U_,
  _F1, _F9, _F10, _CtrlF1, _AltF1, _AltF2, _AltF3, _AltF9, _AltF10, _ShiftF1, _CtrlHome, _CtrlEnd, _CtrlF8, _CtrlF9,
} from './drivers.ts';
import {
  AccessVars, XString, f_Stored, NullMode, RdMode, WrMode, ExclMode, _field, _access, NewLMode,
  OldLMode, TryLMode, ReadRec, WriteRec, GetRecSpace, ZeroAllFlds, DeletedFlag, DelDifTFld, SearchKey, LinkUpw,
  _ShortS, _LongS, _R, S_, LongS_, R_, B_, _B,
  type ChkDPtr, type FieldDPtr, type FileDPtr, type StringList, type XStringPtr, type KeyDPtr, type KeyFldDPtr,
  type LinkDPtr, type FrmlPtr, type LockMode, type RdbDPtr, type DepDPtr, type KeyList,
} from './access.ts';
import type { EFldDPtr, EdExitDPtr, RprtOptPtr } from './rdrun.ts';
import { RdRunVars, SetCompileAll } from './rdrun.ts';
import { RunEdiVars, RunEdiPriv, RunEdiE } from './runedi.ts';
import {
  CRec, CNRecs, AbsRecNr, RdRec, LockRec, UnLockRec, SetWasUpdated, AssignFld, FieldEdit, IsFirstEmptyFld,
  FldRow, IVoff, IVon, DisplFld, SetRecAttr, DisplRec, DisplTabDupl, DisplRecNr, DisplBool, DisplAllWwRecs,
  SetNewWwRecAttr, MoveDispl, SetNewCRec, DisplEditWw, DisplWwRecsOrPage, DuplOwnerKey, TestDuplKey, DuplKeyMsg,
  GotoRecFld, WriteCRec, DuplFromPrevRec, WrEStatus, NewRecExit,
} from './runedit1.ts';
import { UpwEdit, StartExit } from './runedit3.ts';
import {
  RunBool, RunShortStr, RunLongStr, DecodeField, FieldInList, TrailChar,
} from './runfrml.ts';
import { WrLLF10Msg, PromptYN, PushW, PushW1, PopW } from './obaseww.ts';
import { SaveFiles } from './oaccess.ts';
import { SortAndSubst } from './sort.ts';
import { PromptSortKeys, GetRprtOpt } from './compile.ts';
import { SelForAutoRprt, RunAutoReport } from './genrprt.ts';
import { EditText, Help, ViewPrinterTxt, MemoT, MsgStr, type MsgStrPtr } from './editor.ts';
import { IsCurrChpt, ReleaseFDLDAfterChpt, EditHelpOrCat } from './projmgr1.ts';
import { Menu, HelpFDAsRdb } from './wwmenu.ts'; // HelpFDAsRdb: Pascal `RdbDPtr(HelpFD)`
import { PromptLL, PromptFilter } from './wwmix.ts';

/** TS-only: write(...) to the CRT (System.Output). */
function write(...S: string[]): void {
  TxtWrite(Output, ...S);
}
/** TS-only: the current editor E^. */
function CE(): NonNullable<ReturnType<typeof RunEdiE>> {
  return RunEdiE()!;
}
// PAS: RUNEDIT2.PAS TestAccRight – unit-internal
export function TestAccRight(S: StringList): boolean {
  if (AccessVars.UserCode === 0) return true;
  // the user codes (byte string) follow S^.S in the same block
  return OverlapByteStr(S!.After, AccessVars.AccRight);
}
// PAS: RUNEDIT2.PAS ForNavigate – unit-internal
export function ForNavigate(FD: FileDPtr): boolean {
  if (AccessVars.UserCode === 0) return true;
  let S = FD!.ViewNames;
  while (S !== null) {
    if (TestAccRight(S)) return true;
    S = S.Chain;
  }
  return false;
}

// PAS: RUNEDIT2.PAS InsertRecProc – unit-internal
export function InsertRecProc(RP: Uint8Array | null): void {
  const P = RunEdiPriv;
  const E = CE();
  const av = AccessVars;
  GotoRecFld(CRec(), E.FirstFld);
  P.IsNewRec = true;
  LockRec(false);
  if (RP !== null) Move(RP, av.CRecPtr!, av.CFile!.RecLen);
  else ZeroAllFlds();
  DuplOwnerKey();
  SetWasUpdated();
  IVoff();
  MoveDispl(E.NRecs - 1, E.NRecs, E.NRecs - P.IRec);
  P.FirstEmptyFld = RunEdiVars.CFld;
  DisplRec(P.IRec);
  IVon();
  P.NewDisplLL = true;
  NewRecExit();
}

// PAS: RUNEDIT2.PAS AppendRecord – unit-internal
export function AppendRecord(RP: Uint8Array | null): void {
  const P = RunEdiPriv;
  const E = CE();
  const av = AccessVars;
  IVoff();
  P.IsNewRec = true;
  const Max = E.NRecs;
  RunEdiVars.CFld = E.FirstFld;
  P.FirstEmptyFld = RunEdiVars.CFld;
  if (P.IRec < Max) {
    P.IRec++;
    MoveDispl(Max - 1, Max, Max - P.IRec);
    DisplRec(P.IRec);
    IVon();
  } else if (Max === 1) {
    P.BaseRec++;
    DisplWwRecsOrPage();
  } else {
    P.BaseRec += Max - 1;
    P.IRec = 2;
    DisplAllWwRecs();
  }
  if (RP !== null) Move(RP, av.CRecPtr!, av.CFile!.RecLen);
  else ZeroAllFlds();
  DuplOwnerKey();
  DisplRecNr(CRec());
  SetWasUpdated();
  LockRec(false);
  NewRecExit();
}

// PAS: RUNEDIT2.PAS GotoXRec – unit-internal
export function GotoXRec(PX: XStringPtr, N: Ref<number>): boolean {
  const P = RunEdiPriv;
  const md = NewLMode(RdMode);
  let k: KeyDPtr = P.VK;
  if (P.SubSet) k = P.WK;
  let result: boolean;
  if (P.SubSet || P.HasIndex) {
    result = k!.SearchIntvl(PX!, false, N);
    N.v = k!.PathToNr();
  } else result = SearchKey(PX!, k, N);
  RdRec(CRec());
  GotoRecFld(N.v, RunEdiVars.CFld);
  OldLMode(md);
  return result;
}

// PAS: RUNEDIT2.PAS PromptAndSearch – unit-internal
export function PromptAndSearch(Create: boolean): boolean {
  const P = RunEdiPriv;
  const av = AccessVars;
  const dv = DriversVars;
  let result = false;
  // PAS: RUNEDIT2.PAS PromptAndSearch.CreateOrErr
  const CreateOrErr = (RP: Uint8Array, N: number): void => {
    if (Create) {
      if (N > CNRecs()) AppendRecord(RP);
      else InsertRecProc(RP);
    } else if (!P.NoSrchMsg) WrLLF10Msg(118);
  };
  // PAS: RUNEDIT2.PAS PromptAndSearch.FindEFld
  const FindEFld = (F: FieldDPtr): EFldDPtr => {
    let D = CE().FirstFld;
    while (D !== null) {
      if (D.FldD === F) break;
      D = D.Chain;
    }
    return D;
  };
  // PAS: RUNEDIT2.PAS PromptAndSearch.PromptSearch
  const PromptSearch = (): void => {
    const E = CE();
    const FD = av.CFile;
    let K: KeyDPtr = P.VK;
    if (P.SubSet) K = P.WK;
    let KF: KeyFldDPtr = K!.KFlds;
    const RP = GetRecSpace();
    av.CRecPtr = RP;
    ZeroAllFlds();
    const x = new XString();
    x.Clear();
    const li = P.F3LeadIn && !P.IsNewRec;
    const w = PushW1(1, BaseVars.TxtRows, BaseVars.TxtCols, BaseVars.TxtRows, true, false);
    const n = ref(0);
    let found = false;
    const fin3 = (): void => {
      PopW(w);
      ReleaseStore(RP);
    };
    if (KF !== null) {
      if (P.HasIndex && E.DownSet && P.VK === E.DownKey) {
        const FD2 = E.DownLD!.ToFD;
        const RP2 = E.DownRecPtr;
        let KF2 = E.DownLD!.ToKey!.KFlds;
        av.CFile = FD2;
        av.CRecPtr = RP2;
        while (KF2 !== null) {
          av.CFile = FD2;
          av.CRecPtr = RP2;
          const F = KF!.FldD;
          const F2 = KF2.FldD;
          switch (F!.FrmlTyp) {
            case 'S': {
              const s = _ShortS(F2);
              x.StoreStr(s, KF);
              av.CFile = FD;
              av.CRecPtr = RP;
              S_(F, s);
              break;
            }
            case 'R': {
              const r = _R(F2);
              x.StoreReal(r, KF);
              av.CFile = FD;
              av.CRecPtr = RP;
              R_(F, r);
              break;
            }
            case 'B': {
              const b = _B(F2);
              x.StoreBool(b, KF);
              av.CFile = FD;
              av.CRecPtr = RP;
              B_(F, b);
              break;
            }
          }
          KF2 = KF2.Chain;
          KF = KF!.Chain;
        }
      }
    }
    if (KF === null) {
      // 1:
      result = true;
      av.CRecPtr = E.NewRecPtr;
      fin3();
      return;
    }
    while (KF !== null) {
      const F = KF.FldD!;
      if (li) {
        const D = FindEFld(F);
        if (D !== null) GotoRecFld(CRec(), D);
      }
      GotoXY(1, BaseVars.TxtRows);
      dv.TextAttr = BaseVars.Colors.pTxt;
      ClrEol();
      write(F.Name, ':');
      const s = ref('');
      let pos = 1;
      const Col = WhereX();
      let LWw: number;
      if (Col + F.L > BaseVars.TxtCols) LWw = BaseVars.TxtCols - Col;
      else LWw = F.L;
      const r = ref(0);
      for (;;) {
        // 2:
        dv.TextAttr = BaseVars.Colors.pNorm;
        GotoXY(Col, BaseVars.TxtRows);
        pos = FieldEdit(F, null, LWw, pos, s, r, false, true, li, E.WatchDelay);
        const xOld = x.S;
        if (dv.KbdChar === _ESC_ || dv.Event.What === evKeyDown) {
          av.CRecPtr = E.NewRecPtr;
          fin3();
          return;
        }
        switch (F.FrmlTyp) {
          case 'S':
            x.StoreStr(s.v, KF);
            S_(F, s.v);
            break;
          case 'R':
            x.StoreReal(r.v, KF);
            R_(F, r.v);
            break;
          case 'B': {
            const b = s.v.charAt(0) === BaseVars.AbbrYes;
            x.StoreBool(b, KF);
            B_(F, b);
            break;
          }
        }
        if (li) {
          av.CRecPtr = E.NewRecPtr;
          found = GotoXRec(x, n);
          if (pos === 0 && F.FrmlTyp === 'S') {
            x.S = xOld;
            x.StoreStr(_ShortS(F), KF);
          }
          av.CRecPtr = RP;
          if (pos !== 0) {
            x.S = xOld;
            continue; // goto 2
          }
        }
        break;
      }
      KF = KF.Chain;
    }
    av.CRecPtr = E.NewRecPtr;
    if (li) {
      if (!found) CreateOrErr(RP, n.v);
    } else if (P.IsNewRec) Move(RP, av.CRecPtr!, av.CFile!.RecLen);
    else if (!GotoXRec(x, n)) CreateOrErr(RP, n.v);
    result = true;
    fin3(); // 3:
  };
  if (P.VK === null) {
    WrLLF10Msg(111);
    return false;
  }
  PromptSearch();
  GotoRecFld(CRec(), CE().FirstFld);
  return result;
}

// PAS: RUNEDIT2.PAS PromptGotoRecNr – unit-internal
export function PromptGotoRecNr(): void {
  let I = 1;
  const Txt = ref('');
  let Del = true;
  const N = ref(0);
  do {
    PromptLL(122, Txt, I, Del);
    if (DriversVars.KbdChar === _ESC_) return;
    const code = ref(0);
    ValI(Txt.v, N, code);
    I = code.v;
    Del = false;
  } while (I !== 0);
  GotoRecFld(N.v, RunEdiVars.CFld);
}
// PAS: RUNEDIT2.PAS CompChk – unit-internal
export function CompChk(D: EFldDPtr, Typ: string): ChkDPtr {
  const w = RunEdiPriv.WarnSwitch && (Typ === 'W' || Typ === '?');
  const f = Typ === 'F' || Typ === '?';
  let C = D!.Chk;
  while (C !== null) {
    if (((w && C.Warning) || (f && !C.Warning)) && !RunBool(C.Bool)) return C;
    C = C.Chain;
  }
  return null;
}
// PAS: RUNEDIT2.PAS DisplChkErr – unit-internal
export function DisplChkErr(C: ChkDPtr): void {
  const av = AccessVars;
  const c = C!;
  // PAS: RUNEDIT2.PAS DisplChkErr.FindExistTest
  const FindExistTest = (Z: FrmlPtr, LD: Ref<LinkDPtr>): void => {
    LD.v = null;
    if (Z === null) return;
    const op = Z.Op.charCodeAt(0);
    if (Z.Op === _field) {
      if ((Z.Field!.Flg & f_Stored) === 0) FindExistTest(Z.Field!.Frml, LD);
    } else if (Z.Op === _access) {
      if (Z.P1 === null) LD.v = Z.LD; // file.exist
    } else if (op >= 0x60 && op <= 0xaf) FindExistTest(Z.P1, LD); // 1-ary
    else if (op >= 0xb0 && op <= 0xef) {
      // 2-ary
      FindExistTest(Z.P1, LD);
      if (LD.v === null) FindExistTest(Z.P2, LD);
    } else if (op >= 0xf0 && op <= 0xff) {
      // 3-ary
      FindExistTest(Z.P1, LD);
      if (LD.v === null) {
        FindExistTest(Z.P2, LD);
        if (LD.v === null) FindExistTest(Z.P3, LD);
      }
    }
  };
  const LD = ref<LinkDPtr>(null);
  FindExistTest(c.Bool, LD);
  let upw = false; // goto 1
  if (!c.Warning && LD.v !== null && ForNavigate(LD.v.ToFD) && RunEdiVars.CFld!.Ed(RunEdiPriv.IsNewRec)) {
    const cf = av.CFile;
    const cr = av.CRecPtr;
    const n = ref(0);
    const b = LinkUpw(LD.v, n, false);
    ReleaseStore(av.CRecPtr);
    av.CFile = cf;
    av.CRecPtr = cr;
    if (!b) {
      if (RunEdiPriv.NoShiftF7Msg) upw = true;
      else BaseVars.F10SpecKey = _ShiftF7_;
    }
  }
  if (!upw) {
    if (c.HelpName !== null) {
      if (BaseVars.F10SpecKey === _ShiftF7_) BaseVars.F10SpecKey = 0xfffe;
      else BaseVars.F10SpecKey = _F1_;
    }
    SetMsgPar(RunShortStr(c.TxtZ));
    WrLLF10Msg(110);
    if (DriversVars.KbdChar === _F1_) Help(av.CFile!.ChptPos.R, c.HelpName ?? '', false);
    else if (DriversVars.KbdChar === _ShiftF7_) upw = true;
  }
  if (upw) UpwEdit(LD.v); // 1:
}

// PAS: RUNEDIT2.PAS CheckFromHere – unit-internal
export function CheckFromHere(): void {
  const P = RunEdiPriv;
  const E = CE();
  let D: EFldDPtr = RunEdiVars.CFld;
  let N = CRec();
  const md = NewLMode(RdMode);
  for (;;) {
    // 1:
    if (!DeletedFlag()) {
      while (D !== null) {
        const C = CompChk(D, '?');
        if (C !== null) {
          if (P.BaseRec + E.NRecs - 1 < N) P.BaseRec = N;
          P.IRec = N - P.BaseRec + 1;
          RunEdiVars.CFld = D;
          DisplWwRecsOrPage();
          OldLMode(md);
          DisplChkErr(C);
          return;
        }
        D = D.Chain;
      }
    }
    if (N < CNRecs()) {
      N++;
      DisplRecNr(N);
      RdRec(N);
      D = E.FirstFld;
      continue;
    }
    break;
  }
  RdRec(CRec());
  DisplRecNr(CRec());
  OldLMode(md);
  WrLLF10Msg(120);
}

// PAS: RUNEDIT2.PAS Sorting – unit-internal
export function Sorting(): void {
  const av = AccessVars;
  const E = CE();
  SaveFiles();
  const p = ref<Pointer>(null);
  MarkStore(p);
  const SKRoot = ref<KeyFldDPtr>(null);
  sort: {
    if (!PromptSortKeys(E.Flds, SKRoot) || SKRoot.v === null) break sort; // goto 2
    const md = ref<LockMode>(NullMode);
    if (!TryLMode(ExclMode, md, 1)) break sort;
    const er = new ExitRecord();
    NewExit(null, er);
    try {
      SortAndSubst(SKRoot.v);
      E.EdUpdated = true;
    } catch (e) {
      if (!(e instanceof GoExitSignal)) throw e;
    } finally {
      // 1:
      RestoreExit(er);
    }
    av.CFile = E.FD;
    OldLMode(md.v);
  }
  // 2:
  ReleaseStore(p.v);
  av.CRecPtr = E.NewRecPtr;
  DisplAllWwRecs();
}

// PAS: RUNEDIT2.PAS AutoReport – unit-internal
export function AutoReport(): void {
  const P = RunEdiPriv;
  const av = AccessVars;
  const E = CE();
  const p = ref<Pointer>(null);
  MarkStore(p);
  const RO: RprtOptPtr = GetRprtOpt();
  const ro = RO!;
  ro.FDL.FD = av.CFile;
  ro.Flds = E.Flds;
  if (P.Select) {
    ro.FDL.Cond = E.Bool;
    ro.CondTxt = E.BoolTxt;
  }
  if (P.SubSet) ro.FDL.ViewKey = P.WK;
  else if (P.HasIndex) ro.FDL.ViewKey = P.VK;
  RdRunVars.PrintView = false;
  if (SelForAutoRprt(RO)) {
    av.SpecFDNameAllowed = IsCurrChpt();
    RunAutoReport(RO);
    av.SpecFDNameAllowed = false;
  }
  ReleaseStore(p.v);
  ViewPrinterTxt();
  av.CRecPtr = E.NewRecPtr;
}

// PAS: RUNEDIT2.PAS AutoGraph – unit-internal (FandGraph is off: only restores CFile/CRecPtr)
export function AutoGraph(): void {
  const E = CE();
  AccessVars.CFile = E.FD;
  AccessVars.CRecPtr = E.NewRecPtr;
}

// PAS: RUNEDIT2.PAS IsDependItem – unit-internal
export function IsDependItem(): boolean {
  if (!RunEdiPriv.IsNewRec && CE().NEdSet === 0) return false;
  let Dp: DepDPtr = RunEdiVars.CFld!.Dep;
  while (Dp !== null) {
    if (RunBool(Dp.Bool)) return true;
    Dp = Dp.Chain;
  }
  return false;
}
// PAS: RUNEDIT2.PAS SetDependItem – unit-internal
export function SetDependItem(): void {
  const CFld = RunEdiVars.CFld!;
  let Dp: DepDPtr = CFld.Dep;
  while (Dp !== null) {
    if (RunBool(Dp.Bool)) {
      AssignFld(CFld.FldD, Dp.Frml);
      return;
    }
    Dp = Dp.Chain;
  }
}

// PAS: RUNEDIT2.PAS SwitchToAppend – unit-internal
export function SwitchToAppend(): void {
  GotoRecFld(CNRecs(), RunEdiVars.CFld);
  RunEdiPriv.Append = true;
  AppendRecord(null);
  RunEdiPriv.NewDisplLL = true;
}

// PAS: RUNEDIT2.PAS CtrlMProc – unit-internal
export function CtrlMProc(Mode: number): boolean {
  const P = RunEdiPriv;
  const av = AccessVars;
  const dv = DriversVars;
  const E = CE();
  // PAS: RUNEDIT2.PAS CtrlMProc.FldInModeF3Key
  const FldInModeF3Key = (F: FieldDPtr): boolean => {
    if ((F!.Flg & f_Stored) === 0) return false;
    let KF = P.VK!.KFlds;
    while (KF !== null) {
      if (KF.FldD === F) return true;
      KF = KF.Chain;
    }
    return false;
  };
  // PAS: RUNEDIT2.PAS CtrlMProc.IsSkipFld
  const IsSkipFld = (D: EFldDPtr): boolean => {
    const d = D!;
    return !d.Tab && (E.NTabsSet > 0 || (d.FldD!.Flg & f_Stored) === 0 || (P.OnlySearch && FldInModeF3Key(d.FldD)));
  };
  // PAS: RUNEDIT2.PAS CtrlMProc.ExNotSkipFld
  const ExNotSkipFld = (): boolean => {
    if (E.NFlds === 1) return false;
    let D = E.FirstFld;
    while (D !== null) {
      if (D !== RunEdiVars.CFld && !IsSkipFld(D)) return true;
      D = D.Chain;
    }
    return false;
  };
  // PAS: RUNEDIT2.PAS CtrlMProc.CheckForExit
  const CheckForExit = (Quit: Ref<boolean>): boolean => {
    let X: EdExitDPtr = E.ExD;
    while (X !== null) {
      let b = FieldInList(RunEdiVars.CFld!.FldD, X.Flds);
      if (X.NegFlds) b = !b;
      if (b) {
        if (X.Typ === 'Q') Quit.v = true;
        else {
          av.EdBreak = 12;
          av.LastTxtPos = -1;
          if (!StartExit(X, true)) return false;
        }
      }
      X = X.Chain;
    }
    return true;
  };

  const OldCRec = CRec();
  const OldCFld = RunEdiVars.CFld;
  let NR = 0;
  const displ = ref(false);
  let lbl = Mode === 0 ? 2 : 1; // Mode=0: only bypass unrelevant fields
  for (;;) {
    if (lbl === 1) {
      // 1:
      if (IsFirstEmptyFld()) P.FirstEmptyFld = P.FirstEmptyFld!.Chain;
      const Quit = ref(false);
      if (!CheckForExit(Quit)) return true;
      dv.TextAttr = E.dHiLi;
      DisplFld(RunEdiVars.CFld, P.IRec);
      if (P.ChkSwitch) {
        const typ = Mode === 1 || Mode === 3 ? '?' : 'F';
        const C = CompChk(RunEdiVars.CFld, typ);
        if (C !== null) {
          DisplChkErr(C);
          if (!C.Warning) return true;
        }
      }
      if (P.WasUpdated && !P.EdRecVar && P.HasIndex) {
        let KL: KeyList = RunEdiVars.CFld!.KL;
        while (KL !== null) {
          const md = NewLMode(RdMode);
          const b = TestDuplKey(KL.Key);
          OldLMode(md);
          if (b) {
            DuplKeyMsg(KL.Key);
            return true;
          }
          KL = KL.Chain;
        }
      }
      if (Quit.v && !P.IsNewRec && (Mode === 1 || Mode === 3)) {
        av.EdBreak = 12;
        return false;
      }
      const CFld = RunEdiVars.CFld!;
      if (CFld.Chain !== null) {
        GotoRecFld(CRec(), CFld.Chain);
        if (Mode === 1 || Mode === 3) Mode = 0;
      } else {
        const WasNewRec = P.IsNewRec;
        Mode = 0;
        NR++;
        if (!WriteCRec(true, displ)) return true;
        if (displ.v) DisplAllWwRecs();
        else SetRecAttr(P.IRec);
        let lbl3 = false;
        if (P.Only1Record) {
          if (P.NoESCPrompt) {
            av.EdBreak = 0;
            return false;
          }
          P.Append = false;
          lbl3 = true;
        } else if (P.OnlySearch) {
          P.Append = false;
          lbl3 = true;
        } else if (P.Append) AppendRecord(null);
        else {
          if (WasNewRec) P.NewDisplLL = true;
          if (CRec() < CNRecs()) {
            if (P.Select) {
              let lbl4 = true;
              const n = CNRecs();
              for (let i = CRec() + 1; i <= n; i++) {
                if (KeyPressed() && ReadKey() !== _M_ && PromptYN(23)) break; // goto 4
                RdRec(i);
                DisplRecNr(i);
                if (!DeletedFlag() && RunBool(E.Bool)) {
                  RdRec(CRec());
                  GotoRecFld(i, E.FirstFld);
                  lbl4 = false; // goto 2
                  break;
                }
              }
              if (lbl4) {
                // 4:
                RdRec(CRec());
                DisplRecNr(CRec());
                GotoRecFld(OldCRec, OldCFld);
                beep();
                beep();
                return true;
              }
            } else GotoRecFld(CRec() + 1, E.FirstFld);
          } else lbl3 = true;
        }
        if (lbl3) {
          // 3:
          GotoRecFld(CRec(), OldCFld);
          beep();
          beep();
          return true;
        }
      }
    }
    // 2:
    let skip = false;
    displ.v = false;
    const CFld = RunEdiVars.CFld!;
    if (IsFirstEmptyFld()) {
      if (CFld.Impl !== null && LockRec(true)) {
        AssignFld(CFld.FldD, CFld.Impl);
        displ.v = true;
      }
      if (CFld.Dupl && CRec() > 1 && LockRec(true)) {
        DuplFromPrevRec();
        displ.v = true;
        skip = true;
      }
    }
    if (IsDependItem() && LockRec(true)) {
      SetDependItem();
      displ.v = true;
      skip = true;
    }
    if (IsSkipFld(CFld)) skip = true;
    if (CFld.Tab) skip = false;
    if (displ.v) {
      dv.TextAttr = E.dHiLi;
      DisplFld(CFld, P.IRec);
    }
    if (Mode === 2) {
      // bypass all remaining fields of the record
      lbl = 1;
      continue;
    }
    if (skip && ExNotSkipFld() && NR <= 1) {
      lbl = 1;
      continue;
    }
    return true;
  }
}

// PAS: RUNEDIT2.PAS GoPrevNextRec – unit-internal
export function GoPrevNextRec(Delta: number, Displ: boolean): boolean {
  const P = RunEdiPriv;
  const E = CE();
  if (P.EdRecVar) return false;
  let result = false;
  const md = NewLMode(RdMode);
  let i = CRec();
  if (Displ) IVoff();
  let found = false;
  for (;;) {
    // 0:
    i += Delta;
    if (i > 0 && i <= CNRecs()) {
      RdRec(i);
      if (Displ) DisplRecNr(i);
      if (!P.Select || (!DeletedFlag() && RunBool(E.Bool))) {
        found = true; // goto 2
        break;
      }
      if (KeyPressed()) {
        const w = ReadKey();
        if (((Delta > 0 && w !== _down_ && w !== _CtrlEnd_ && w !== _PgDn_) ||
          (Delta < 0 && w !== _up_ && w !== _CtrlHome_ && w !== _PgUp_)) && PromptYN(23)) break; // goto 1
      }
      continue;
    }
    if (P.Select) WrLLF10Msg(16);
    break;
  }
  if (!found) {
    // 1:
    RdRec(CRec());
    if (Displ) {
      DisplRecNr(CRec());
      IVon();
    }
  } else {
    // 2:
    result = true;
    const OldBaseRec = P.BaseRec;
    SetNewCRec(i, false);
    if (Displ) {
      const Max = E.NRecs;
      let D = P.BaseRec - OldBaseRec;
      if (Math.abs(D) >= Max) DisplWwRecsOrPage(); // goto 3
      else if (D > 0) {
        MoveDispl(D + 1, 1, Max - D);
        for (let j = Max - D + 1; j <= Max; j++) DisplRec(j);
      } else if (D < 0) {
        D = -D;
        MoveDispl(Max - D, Max, Max - D);
        for (let j = 1; j <= D; j++) DisplRec(j);
      }
    }
    // 3:
    if (Displ) IVon();
  }
  // 4:
  OldLMode(md);
  return result;
}

// PAS: RUNEDIT2.PAS GetChpt – unit-internal
export function GetChpt(Heslo: string, NN: Ref<number>): boolean {
  const av = AccessVars;
  const n = av.CFile!.NRecs;
  for (let j = 1; j <= n; j++) {
    ReadRec(j);
    if (IsCurrChpt()) {
      let s = ShortStr(TrailChar(' ', _ShortS(av.ChptName)), 12);
      const i = Pos('.', s);
      if (i > 0) s = s.slice(0, i - 1);
      if (SEquUpcase(Heslo, s)) {
        NN.v = j;
        return true;
      }
    } else {
      const s = ShortStr(TrailChar(' ', _ShortS(av.CFile!.FldD)), 12);
      const b = StrToBytes(s);
      ConvToNoDiakr(b, b.length, BaseVars.Fonts.VFont);
      if (EqualsMask(StrToBytes(Heslo), Heslo.length, BytesToStr(b))) {
        NN.v = j;
        return true;
      }
    }
  }
  RdRec(CRec());
  return false;
}

// PAS: RUNEDIT2.PAS SetCRec – unit-internal
export function SetCRec(I: number): void {
  const P = RunEdiPriv;
  const E = CE();
  if (I > P.BaseRec + E.NRecs - 1) P.BaseRec = I - E.NRecs + 1;
  else if (I < P.BaseRec) P.BaseRec = I;
  P.IRec = I - P.BaseRec + 1;
  RdRec(CRec());
}

// PAS: RUNEDIT2.PAS UpdateEdTFld
export function UpdateEdTFld(S: LongStrPtr): void {
  const P = RunEdiPriv;
  const E = CE();
  AccessVars.CRecPtr = E.NewRecPtr;
  let md: LockMode = NullMode;
  if (!P.EdRecVar) md = NewLMode(WrMode);
  SetWasUpdated();
  DelDifTFld(E.NewRecPtr!, E.OldRecPtr, RunEdiVars.CFld!.FldD);
  LongS_(RunEdiVars.CFld!.FldD, S);
  if (!P.EdRecVar) OldLMode(md);
}
// PAS: RUNEDIT2.PAS UpdateTxtPos – unit-internal
export function UpdateTxtPos(TxtPos: number): void {
  if (IsCurrChpt()) {
    const md = NewLMode(WrMode);
    SetWasUpdated();
    R_(AccessVars.ChptTxtPos, int16(TxtPos));
    OldLMode(md);
  }
}

// PAS: RUNEDIT2.PAS EditFreeTxt
export function EditFreeTxt(F: FieldDPtr, ErrMsg: string, Ed: boolean, Brk: Ref<number>): boolean {
  const P = RunEdiPriv;
  const av = AccessVars;
  const dv = DriversVars;
  const E = CE();
  const BreakKeys = _CtrlF1 + _F1 + _CtrlHome + _CtrlEnd + _F9 + _AltF10; // FandRunV off: with _CtrlF1
  const BreakKeys1 = _CtrlF1 + _F1 + _CtrlHome + _CtrlEnd + _F9 + _AltF10 + _ShiftF1 + _F10;
  const BreakKeys2 = _F1 + _CtrlHome + _CtrlEnd + _F9 + _F10 + _AltF10 +
    _CtrlF1 + _AltF1 + _ShiftF1 + _AltF2 + _AltF3 + _CtrlF8 + _CtrlF9 + _AltF9;
  const maxStk = 10;
  const p = ref<Pointer>(null);
  MarkStore(p);
  const Srch = ref(false);
  Brk.v = 0;
  const TxtPos = ref(1);
  let iStk = 0;
  const Stk: { N: number; I: number }[] = Array.from({ length: maxStk + 1 }, () => ({ N: 0, I: 0 }));
  const TxtXY = ref(0);
  let result = true;
  let w = 0;
  if ((E.Head ?? '') === '') w = PushW(1, 1, BaseVars.TxtCols, 1);
  let PTxtMsgS: MsgStrPtr = null;
  if (E.TTExit) {
    const TxtMsgS = new MsgStr();
    TxtMsgS.Head = null;
    TxtMsgS.Last = E.Last;
    TxtMsgS.CtrlLast = E.CtrlLast;
    TxtMsgS.AltLast = E.AltLast;
    TxtMsgS.ShiftLast = E.ShiftLast;
    PTxtMsgS = TxtMsgS;
  }
  let HdTxt = '';
  let WasUpd = false;
  let Breaks = '';
  let CtrlMsgNr = 0;
  let Kind = 'V';
  let OldTxtPos = 0;
  let S: LongStrPtr = new Uint8Array(0);
  let heslo = '';
  let LastLen = 0;
  let C = 0;
  const Displ = ref(false);
  let lbl = 1;
  for (;;) {
    if (lbl === 1) {
      // 1:
      HdTxt = '    ';
      WasUpd = false;
      if (CRec() > 1) HdTxt = HdTxt.slice(0, 2) + '\x18' + HdTxt.slice(3);
      if (CRec() < CNRecs()) HdTxt = HdTxt.slice(0, 3) + '\x19';
      if (IsCurrChpt()) {
        HdTxt = ShortStr(_ShortS(av.ChptTyp) + ':' + _ShortS(av.ChptName) + HdTxt, 22);
        TxtPos.v = Trunc(_R(av.ChptTxtPos));
        Breaks = BreakKeys2;
        CtrlMsgNr = 131;
      } else {
        CtrlMsgNr = 151;
        if (av.CFile === av.CRdb!.HelpFD) Breaks = BreakKeys1;
        else Breaks = BreakKeys;
      }
      let R1 = E.FrstRow;
      if (R1 === 3 && P.WithBoolDispl) R1 = 2;
      Window(E.FrstCol, R1, E.LastCol, E.LastRow);
      dv.TextAttr = BaseVars.Colors.tNorm;
      Kind = 'V';
      OldTxtPos = TxtPos.v;
      if (Ed) LockRec(false);
      if ((F!.Flg & f_Stored) !== 0) {
        S = _LongS(F);
        if (Ed) Kind = 'T';
      } else S = RunLongStr(F!.Frml);
      lbl = 2;
    }
    if (lbl === 2) {
      // 2:
      let X: EdExitDPtr = null;
      if (P.TTExit) X = E.ExD;
      const Upd = ref(false);
      const buf = new Uint8Array(Math.max(MaxLStrLen, S.length));
      buf.set(S);
      const LL = ref(S.length);
      result = EditText(Kind, MemoT, HdTxt, ErrMsg, buf, MaxLStrLen, LL, TxtPos, TxtXY, Breaks, X, Srch, Upd, 141,
        CtrlMsgNr, PTxtMsgS);
      S = buf.slice(0, LL.v);
      ErrMsg = '';
      heslo = ShortStr(av.LexWord, 80);
      LastLen = S.length;
      if (av.EdBreak === 0xffff) C = dv.KbdChar;
      else C = 0;
      if (C === _AltEqual_) C = _ESC_;
      else WasUpd = WasUpd || Upd.v;
      if (C === _AltF3_) {
        EditHelpOrCat(C, 0, '');
        continue; // goto 2
      }
      if (C === _U_) {
        ReleaseStore(S);
        TxtXY.v = 0;
        lbl = 1;
        continue;
      }
      Window(1, 1, BaseVars.TxtCols, BaseVars.TxtRows);
      if (WasUpd) UpdateEdTFld(S);
      if (OldTxtPos !== TxtPos.v && !Srch.v) UpdateTxtPos(TxtPos.v);
      ReleaseStore(S);
      if (Ed && !P.WasUpdated) UnLockRec(E);
      lbl = 0;
      if (Srch.v && WriteCRec(false, Displ)) lbl = 31;
      else {
        switch (C) {
          case _F9_:
            if (WriteCRec(false, Displ)) {
              SaveFiles();
              P.UpdCount = 0;
            }
            lbl = 4;
            break;
          case _F1_:
            RdMsg(6);
            heslo = ShortStr(BaseVars.MsgLine, 80);
            lbl = 3;
            break;
          case _CtrlF1_:
            lbl = 3;
            break;
          case _ShiftF1_:
            if (IsCurrChpt() || av.CFile === av.CRdb!.HelpFD) {
              const i = ref(0);
              if (iStk < maxStk && WriteCRec(false, Displ) && GetChpt(heslo, i)) {
                P.Append = false;
                iStk++;
                Stk[iStk].N = CRec();
                Stk[iStk].I = TxtPos.v;
                SetCRec(i.v);
              }
              TxtXY.v = 0;
              lbl = 4;
            }
            break;
          case _F10_:
            if (iStk > 0 && WriteCRec(false, Displ)) {
              P.Append = false;
              SetCRec(Stk[iStk].N);
              TxtPos.v = Stk[iStk].I;
              iStk--;
            }
            TxtXY.v = 0;
            lbl = 4;
            break;
          case _AltF10_:
            Help(null, '', false);
            lbl = 4;
            break;
          case _AltF1_:
            heslo = ShortStr(_ShortS(av.ChptTyp), 80);
            lbl = 3;
            break;
        }
        if (lbl === 0 && C > 0xff && WriteCRec(false, Displ)) {
          P.Append = false;
          if (C === _CtrlHome_) {
            GoPrevNextRec(-1, false);
            TxtXY.v = 0;
            lbl = 4;
          } else if (C === _CtrlEnd_) lbl = 31;
          else {
            WrEStatus();
            Brk.v = 1;
            dv.KbdChar = C;
            lbl = 6;
          }
        }
        if (lbl === 0) lbl = 5;
      }
    }
    if (lbl === 3) {
      // 3:
      Help(HelpFDAsRdb(), heslo, false);
      lbl = 4;
    }
    if (lbl === 31) {
      // 31:
      if (!GoPrevNextRec(+1, false) && Srch.v) {
        UpdateTxtPos(LastLen);
        Srch.v = false;
      }
      TxtXY.v = 0;
      lbl = 4;
    }
    if (lbl === 4) {
      // 4:
      if (!Ed || LockRec(false)) {
        lbl = 1;
        continue;
      }
      lbl = 5;
    }
    if (lbl === 5) {
      // 5:
      ReleaseStore(p.v);
      DisplEditWw();
    }
    // 6:
    if (w !== 0) PopW(w);
    return result;
  }
}

// PAS: RUNEDIT2.PAS EditItemProc – unit-internal
export function EditItemProc(del: boolean, ed: boolean, Brk: Ref<number>): boolean {
  const P = RunEdiPriv;
  const av = AccessVars;
  const E = CE();
  const CFld = RunEdiVars.CFld!;
  const F = CFld.FldD!;
  if (F.Typ === 'T') {
    if (!EditFreeTxt(F, '', ed, Brk)) return false;
  } else {
    DriversVars.TextAttr = E.dHiLi;
    const Txt = ref('');
    DecodeField(F, F.L, Txt);
    GotoXY(CFld.Col, FldRow(CFld, P.IRec));
    let wd = 0;
    if (av.CFile!.NotCached()) wd = E.WatchDelay;
    const R = ref(0);
    FieldEdit(F, CFld.Impl, CFld.L, 1, Txt, R, del, ed, false, wd);
    if (DriversVars.KbdChar === _ESC_ || !ed) {
      DisplFld(CFld, P.IRec);
      if (ed && !P.WasUpdated) UnLockRec(E);
      return true;
    }
    SetWasUpdated();
    switch (F.FrmlTyp) {
      case 'B':
        B_(F, UpCaseCh(Txt.v.charAt(0)) === BaseVars.AbbrYes);
        break;
      case 'S':
        S_(F, Txt.v);
        break;
      case 'R':
        R_(F, R.v);
        break;
    }
  }
  if (Brk.v === 0) return CtrlMProc(1);
  return true;
}
/** TS-only: System.UpCase (ASCII only). */
function UpCaseCh(c: string): string {
  const b = c.charCodeAt(0);
  return b >= 0x61 && b <= 0x7a ? String.fromCharCode(b - 32) : c;
}

// PAS: RUNEDIT2.PAS SetSwitchProc – unit-internal
export function SetSwitchProc(): void {
  const P = RunEdiPriv;
  const E = CE();
  let iMsg: number;
  if (P.EdRecVar) iMsg = 104;
  else if (P.MustCheck) iMsg = P.MustAdd ? 101 : 102;
  else if (P.MustAdd) iMsg = 103;
  else iMsg = 100;
  // 1:
  let N = Menu(iMsg, 1);
  if (N === 0) return;
  switch (iMsg) {
    case 101:
      if (N === 4) N = 6;
      break;
    case 102:
      if (N === 5) N = 6;
      break;
    case 103:
      if (N >= 4) N++;
      break;
    case 104:
      N += 2;
      break;
  }
  const CFld = RunEdiVars.CFld!;
  switch (N) {
    case 1:
      if (P.Select) P.Select = false;
      else if (E.Bool !== null) P.Select = true;
      DisplBool();
      P.NewDisplLL = true;
      SetNewWwRecAttr();
      break;
    case 2:
      if ((CFld.FldD!.Flg & f_Stored) !== 0) {
        const B = CFld.Dupl;
        CFld.Dupl = !B;
        DisplTabDupl();
        if (B) E.NDuplSet--;
        else E.NDuplSet++;
      }
      break;
    case 3: {
      const B = CFld.Tab;
      CFld.Tab = !B;
      DisplTabDupl();
      if (B) E.NTabsSet--;
      else E.NTabsSet++;
      break;
    }
    case 4:
      P.AddSwitch = !P.AddSwitch;
      P.NewDisplLL = true;
      break;
    case 5:
      if (!P.MustCheck) {
        P.ChkSwitch = !P.ChkSwitch;
        P.NewDisplLL = true;
      }
      break;
    case 6:
      P.WarnSwitch = !P.WarnSwitch;
      P.NewDisplLL = true;
      break;
  }
}
// PAS: RUNEDIT2.PAS PromptSelect – unit-internal
export function PromptSelect(): void {
  const P = RunEdiPriv;
  const E = CE();
  let Txt: string;
  if (P.Select) Txt = E.BoolTxt ?? '';
  else Txt = '';
  if (IsCurrChpt()) ReleaseFDLDAfterChpt();
  ReleaseStore(E.AfterE);
  PromptFilter(Txt, fref(E, 'Bool'), fref(E, 'BoolTxt'));
  if (E.Bool === null) P.Select = false;
  else P.Select = true;
  DisplBool();
  SetNewWwRecAttr();
  P.NewDisplLL = true;
}

// PAS: RUNEDIT2.PAS SwitchRecs – unit-internal
export function SwitchRecs(Delta: number): void {
  const P = RunEdiPriv;
  const av = AccessVars;
  const E = CE();
  if ((P.NoCreate && P.NoDelete) || P.WasWK) return;
  const md = ref<LockMode>(NullMode);
  if (!TryLMode(WrMode, md, 1)) return;
  const p1 = GetRecSpace();
  const p2 = GetRecSpace();
  av.CRecPtr = p1;
  const n1 = AbsRecNr(CRec());
  ReadRec(n1);
  const x1 = new XString();
  const x2 = new XString();
  if (P.HasIndex) x1.PackKF(P.VK!.KFlds);
  av.CRecPtr = p2;
  const n2 = AbsRecNr(CRec() + Delta);
  ReadRec(n2);
  sw: {
    if (P.HasIndex) {
      x2.PackKF(P.VK!.KFlds);
      if (x1.S !== x2.S) break sw; // goto 1
    }
    WriteRec(n1);
    av.CRecPtr = p1;
    WriteRec(n2);
    if (P.HasIndex) {
      let k = av.CFile!.Keys;
      while (k !== null) {
        if (k !== P.VK) {
          av.CRecPtr = p1;
          k.Delete(n1);
          av.CRecPtr = p2;
          k.Delete(n2);
          av.CRecPtr = p1;
          k.Insert(n2, true);
          av.CRecPtr = p2;
          k.Insert(n1, true);
        }
        k = k.Chain;
      }
    }
    SetNewCRec(CRec() + Delta, true);
    DisplAllWwRecs();
    DisplRecNr(CRec());
    E.EdUpdated = true;
    if (IsCurrChpt()) SetCompileAll();
  }
  // 1:
  OldLMode(md.v);
  ReleaseStore(p1);
  av.CRecPtr = E.NewRecPtr;
}
