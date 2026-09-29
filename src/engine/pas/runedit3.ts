// PAS: RUNEDIT3.PAS – include of RUNEDI: field selection for EditOpt (SelFldsForEO), view names,
// up/down/imbedded edits (UpwEdit, DownEdit, ImbeddEdit), Shift+F7 duplication, Calculate (F6
// menu), edit exits (StartExit/StartProc/StartRprt/ExitKeyProc), last-line help, mouse, record
// selection toggles, the RunEdit main loop and EditDataFile.
//
// Porting notes:
// * State: RunEdiVars/RunEdiPriv in runedi.ts. Routines not in the RUNEDI interface are marked
//   unit-internal; they are exported only for the other include modules.
// * RunEdit: BP7 `Timer: longint absolute 0:$46C` (BIOS ticks); FPC declares a plain local, so the
//   timed features (WatchDelay, RefreshDelay, `exit` with a timeout) do not work there - use host
//   time in ticks (18.2/s). CtrlReadKbd shows the Ctrl/Alt/Shift last lines after a delay while a
//   modifier is held (needs modifier state from the key queue).
// * StartProc: runs an exit procedure with the edited record as parameter; saves/restores
//   the editor state (WrEStatus/RdEStatus), may re-read the record and redisplay (`upd`, `lkd`).
// * EditDataFile: NewExit (PORTING.md 11); pix = graphics mode switch (off).
// * SetEdRecNoEtc: `x: XString absolute EdRecKey` - EdRecKey is a string holding a packed key;
//   use XString over the byte string.

// * RunEdit's goto net is a state machine over the Pascal labels (`lbl`).

import {
  ref, GoExitSignal, StrR, getLongint, Move, type Ref, type Pointer,
} from './pasrt.ts';
import {
  BaseVars, ExitRecord, NewExit, RestoreExit, MarkStore, ReleaseStore, SetMsgPar, RdMsg, MinW, MouseInRect, WPushPixel,
  WNoPop,
} from './base.ts';
import {
  DriversVars, TestEvent, WaitEvent, ClrEvent, AddCtrlAltShift, ScrWrStr, ReadKbd, ClearKeyBuf, beep,
  evKeyDown, evMouseDown, mbDoubleClick, _ESC_, _M_, _Ins_, _F1_, _CtrlF1_, _AltF10_, _AltEqual_, _U_, _F2_, _up_,
  _down_, _left_, _S_, _right_, _D_, _Home_, _End_, _F4_, _F5_, _F7_, _CtrlF5_, _Y_, _F9_, _N_, _E_, _CtrlHome_,
  _X_, _CtrlEnd_, _PgUp_, _R_, _PgDn_, _C_, _Q_, _CtrlPgUp_, _CtrlPgDn_, _CtrlLeft_, _CtrlRight_, _F3_, _CtrlF2_,
  _AltF2_, _AltF3_, _CtrlF3_, _F6_, _CtrlF4_, _CtrlF7_, _F8_, _ShiftF8_, _CtrlF8_, _CtrlF10_, _AltF9_, _AltF7_,
  _ShiftF7_,
} from './drivers.ts';
import {
  AccessVars, XString, XWKey, f_Stored, f_Comma, Power10, _const, _unminus, ForAllFDs, SetUpdFlag, HasUpdFlag,
  ClearUpdFlag, GetRecSpace, ClearRecSpace, NewLMode, OldLMode, ResetCompilePars, DelAllDifTFlds, R_, _T,
  type FileDPtr, type LinkDPtr, type StringList, type XStringPtr, type FieldDPtr, type FieldList, type KeyFldDPtr,
  type KeyDPtr, type RdbDPtr,
} from './access.ts';
import type { EFldDPtr, EdExitDPtr, EditOptPtr, InstrPtr, RprtOptPtr } from './rdrun.ts';
import { RdRunVars, TestExitKey } from './rdrun.ts';
import { RunEdiVars, RunEdiPriv, RunEdiE, PopEdit } from './runedi.ts';
import {
  CRec, CNRecs, AbsRecNr, RdRec, ELockRec, LockRec, UnLockRec, SetWasUpdated, WrEStatus, RdEStatus, AssignFld,
  DuplFld, IsFirstEmptyFld, FldRow, IVoff, IVon, DisplFld, SetRecAttr, DisplAllWwRecs, DisplEditWw,
  DisplWwRecsOrPage, OpenEditWw, RefreshSubset, GotoRecFld, WriteCRec, UndoRecord, DuplFromPrevRec, EquOldNewRec,
  DeleteRecProc,
} from './runedit1.ts';
import {
  TestAccRight, ForNavigate, InsertRecProc, GotoXRec, PromptAndSearch, PromptGotoRecNr, CheckFromHere,
  Sorting, AutoReport, AutoGraph, SwitchToAppend, CtrlMProc, GoPrevNextRec, EditItemProc, SetSwitchProc,
  PromptSelect, SwitchRecs,
} from './runedit2.ts';
import { RunBool, RunReal, RunShortStr, LeadChar, TrailChar, GetFromKey } from './runfrml.ts';
import { WrLLF10Msg, WrLLMsg, WrLLMsgTxt, PromptYN, PushW1, PopW } from './obaseww.ts';
import { SaveFiles, ClosePassiveFD } from './oaccess.ts';
import { CopyIndex } from './sort.ts';
import {
  GetEditOpt, AllFldsList, SetInpStr, RdLex, RdFrml, Error as CompError, // COMPILE Error (JS Error stays usable)
} from './compile.ts';
import { RdUserView } from './rdfildcl.ts';
import { NewEditD } from './rdedit.ts';
import { CallProcedure, ReportProc } from './runproc.ts';
import { Help } from './editor.ts';
import { IsCurrChpt, PromptHelpName, EditHelpOrCat } from './projmgr1.ts';
import { Menu, DisplLLHelp, HelpFDAsRdb } from './wwmenu.ts';
import { WwMixVars, PutSelect, SelectStr, GetSelect, SelFieldList, PromptLL, SelMark } from './wwmix.ts';

/** TS-only: the current editor E^. */
function CE(): NonNullable<ReturnType<typeof RunEdiE>> {
  return RunEdiE()!;
}

// PAS: RUNEDIT3.PAS SelFldsForEO
export function SelFldsForEO(EO: EditOptPtr, LD: LinkDPtr): boolean {
  const eo = EO!;
  // PAS: RUNEDIT3.PAS SelFldsForEO.FinArgs
  const FinArgs = (F: FieldDPtr): boolean => {
    let KF = LD!.Args;
    while (KF !== null) {
      if (KF.FldD === F) return true;
      KF = KF.Chain;
    }
    return false;
  };
  if (eo.Flds === null) return true;
  let FL: FieldList = eo.Flds;
  if (!eo.UserSelFlds) {
    if (LD !== null) {
      // FL1:=FieldList(@EO^.Flds): relink the kept elements from the list head
      let head: FieldList = null;
      let FL1: FieldList = null;
      while (FL !== null) {
        if (!FinArgs(FL.FldD)) {
          if (FL1 === null) head = FL;
          else FL1.Chain = FL;
          FL1 = FL;
        }
        FL = FL.Chain;
      }
      if (FL1 !== null) FL1.Chain = null;
      eo.Flds = head;
    }
    return true;
  }
  const p = ref<Pointer>(null);
  MarkStore(p);
  while (FL !== null) {
    const F = FL.FldD!;
    if (LD === null || !FinArgs(F)) {
      let s = F.Name;
      if ((F.Flg & f_Stored) === 0) s = SelMark + s;
      PutSelect(s);
    }
    FL = FL.Chain;
  }
  const ref_ = { v: eo.Flds } as Ref<FieldList>;
  if (eo.Flds === null) WrLLF10Msg(156);
  else {
    SelFieldList(36, true, ref_);
    eo.Flds = ref_.v;
  }
  if (eo.Flds === null) {
    ReleaseStore(p.v);
    return false;
  }
  return true;
}

// PAS: RUNEDIT3.PAS GetFileViewName – unit-internal
export function GetFileViewName(FD: FileDPtr, SL: Ref<StringList>): string {
  if (SL.v === null) return FD!.Name;
  while (!TestAccRight(SL.v)) SL.v = SL.v!.Chain;
  const result = '\x01' + SL.v!.S;
  do SL.v = SL.v!.Chain;
  while (!(SL.v === null || TestAccRight(SL.v)));
  return result;
}

// PAS: RUNEDIT3.PAS EquFileViewName – unit-internal
export function EquFileViewName(FD: FileDPtr, S: string, EO: Ref<EditOptPtr>): boolean {
  const av = AccessVars;
  const cf = av.CFile;
  av.CFile = FD;
  if (S.charAt(0) === '\x01') {
    S = S.slice(1);
    let SL = av.CFile!.ViewNames;
    while (SL !== null) {
      if (SL.S === S) {
        EO.v = GetEditOpt();
        RdUserView(S, EO.v);
        av.CFile = cf; // 1:
        return true;
      }
      SL = SL.Chain;
    }
  } else if (S === av.CFile!.Name) {
    EO.v = GetEditOpt();
    EO.v!.Flds = AllFldsList(av.CFile, false);
    return true; // Pascal exits without restoring CFile
  }
  av.CFile = cf; // 1:
  return false;
}

// PAS: RUNEDIT3.PAS EquRoleName – unit-internal
export function EquRoleName(S: string, LD: LinkDPtr): boolean {
  if (S === '') return LD!.ToFD!.Name === LD!.RoleName;
  return S === LD!.RoleName;
}

// PAS: RUNEDIT3.PAS GetSel2S – unit-internal
export function GetSel2S(s: Ref<string>, s2: Ref<string>, C: string, wh: number): void {
  s.v = GetSelect();
  s2.v = '';
  const i = s.v.indexOf(C) + 1;
  if (i > 0) {
    if (wh === 1) {
      const s1 = s.v.slice(i);
      s2.v = s.v.slice(0, i - 1);
      s.v = s1;
    } else {
      s2.v = s.v.slice(i);
      s.v = s.v.slice(0, i - 1);
    }
  }
}

// PAS: RUNEDIT3.PAS UpwEdit – unit-internal
export function UpwEdit(LkD: LinkDPtr): void {
  const av = AccessVars;
  const ss = WwMixVars.ss;
  const p = ref<Pointer>(null);
  MarkStore(p);
  const w = PushW1(1, 1, BaseVars.TxtCols, BaseVars.TxtRows, true, true);
  av.CFile!.IRec = AbsRecNr(CRec());
  WrEStatus();
  const EO = ref<EditOptPtr>(null);
  let LD: LinkDPtr;
  let esc = false;
  if (LkD === null) {
    const CFld = RunEdiVars.CFld!;
    // PAS: RUNEDIT3.PAS UpwEdit.SetPointTo – ss.PointTo:=@s2 (s2 := s1 when LD has CFld as an argument)
    const SetPointTo = (ld: LinkDPtr, s1: string): void => {
      let KF = ld!.Args;
      while (KF !== null) {
        if (KF.FldD === CFld.FldD) ss.PointTo = s1;
        KF = KF.Chain;
      }
    };
    LD = av.LinkDRoot;
    while (LD !== null) {
      const ToFD = LD.ToFD!;
      if (LD.FromFD === av.CFile && ForNavigate(ToFD)) {
        let s = '';
        if (ToFD.Name !== LD.RoleName) s = '.' + LD.RoleName;
        const SL = ref<StringList>(ToFD.ViewNames);
        do {
          const s1 = GetFileViewName(ToFD, SL) + s;
          PutSelect(s1);
          SetPointTo(LD, s1);
        } while (SL.v !== null);
      }
      LD = LD.Chain;
    }
    ss.Abcd = true;
    SelectStr(0, 0, 35, '');
    if (DriversVars.KbdChar === _ESC_) esc = true;
    else {
      const s1 = ref('');
      const s2 = ref('');
      GetSel2S(s1, s2, '.', 2);
      LD = av.LinkDRoot;
      while (!(LD!.FromFD === av.CFile && EquRoleName(s2.v, LD) && EquFileViewName(LD!.ToFD, s1.v, EO))) {
        LD = LD!.Chain;
      }
    }
  } else {
    LD = LkD;
    EO.v = GetEditOpt();
    EO.v!.UserSelFlds = false;
    av.CFile = LD.ToFD;
    let SL = av.CFile!.ViewNames;
    let SL1: StringList = null;
    while (SL !== null) {
      if (TestAccRight(SL)) SL1 = SL;
      SL = SL.Chain;
    }
    if (SL1 === null) EO.v!.Flds = AllFldsList(av.CFile, false);
    else RdUserView(SL1.S, EO.v);
    EO.v!.SetOnlyView = true;
  }
  if (!esc) {
    const E = CE();
    av.CFile = E.FD;
    const x = new XString();
    x.PackKF(LD!.Args);
    let px: XStringPtr = x;
    const K = LD!.ToKey;
    av.CFile = LD!.ToFD;
    const eo = EO.v!;
    if (eo.ViewKey === null) eo.ViewKey = K;
    else if (eo.ViewKey !== K) px = null; // AbsAdr(EO^.ViewKey)<>AbsAdr(K)
    if (SelFldsForEO(EO.v, null)) {
      NewEditD(av.CFile, EO.v);
      CE().ShiftF7LD = LkD;
      const Brk = ref(0);
      if (OpenEditWw()) RunEdit(px, Brk);
      SaveFiles();
      PopEdit();
    }
  }
  // 1:
  PopW(w);
  ReleaseStore(p.v);
  RdEStatus();
  DisplEditWw();
}

// PAS: RUNEDIT3.PAS ImbeddEdit – unit-internal
export function ImbeddEdit(): void {
  const av = AccessVars;
  const p = ref<Pointer>(null);
  MarkStore(p);
  const w = PushW1(1, 1, BaseVars.TxtCols, BaseVars.TxtRows, true, true);
  av.CFile!.IRec = AbsRecNr(CRec());
  WrEStatus();
  let R: RdbDPtr = av.CRdb;
  while (R !== null) {
    let FD = R.FD!.Chain;
    while (FD !== null) {
      if (ForNavigate(FD)) {
        const SL = ref<StringList>(FD.ViewNames);
        do {
          let s = GetFileViewName(FD, SL);
          if (R !== av.CRdb) s = R.FD!.Name + '.' + s;
          PutSelect(s);
        } while (SL.v !== null);
      }
      FD = FD.Chain;
    }
    R = R.ChainBack;
  }
  WwMixVars.ss.Abcd = true;
  SelectStr(0, 0, 35, '');
  if (DriversVars.KbdChar !== _ESC_) {
    const s1 = ref('');
    const s2 = ref('');
    GetSel2S(s1, s2, '.', 1);
    R = av.CRdb;
    if (s2.v !== '') {
      do R = R!.ChainBack;
      while (R!.FD!.Name !== s2.v);
    }
    av.CFile = R!.FD;
    const EO = ref<EditOptPtr>(null);
    while (!EquFileViewName(av.CFile, s1.v, EO)) av.CFile = av.CFile!.Chain;
    if (SelFldsForEO(EO.v, null)) {
      NewEditD(av.CFile, EO.v);
      const Brk = ref(0);
      if (OpenEditWw()) RunEdit(null, Brk);
      SaveFiles();
      PopEdit();
    }
  }
  // 1:
  PopW(w);
  ReleaseStore(p.v);
  RdEStatus();
  DisplEditWw();
}

// PAS: RUNEDIT3.PAS DownEdit – unit-internal
export function DownEdit(): void {
  const av = AccessVars;
  const p = ref<Pointer>(null);
  MarkStore(p);
  const w = PushW1(1, 1, BaseVars.TxtCols, BaseVars.TxtRows, true, true);
  av.CFile!.IRec = AbsRecNr(CRec());
  WrEStatus();
  let LD = av.LinkDRoot;
  while (LD !== null) {
    const FD = LD.FromFD;
    if (LD.ToFD === av.CFile && ForNavigate(FD) && LD.IndexRoot !== 0) {
      // own key with equal beginning
      const SL = ref<StringList>(FD!.ViewNames);
      const K = GetFromKey(LD);
      do {
        let s = GetFileViewName(FD, SL);
        if ((K!.Alias ?? '') !== '') s = s + '/' + K!.Alias;
        PutSelect(s);
      } while (SL.v !== null);
    }
    LD = LD.Chain;
  }
  WwMixVars.ss.Abcd = true;
  SelectStr(0, 0, 35, '');
  if (DriversVars.KbdChar !== _ESC_) {
    const E = CE();
    const s1 = ref('');
    const s2 = ref('');
    GetSel2S(s1, s2, '/', 2);
    LD = av.LinkDRoot;
    const EO = ref<EditOptPtr>(null);
    while (LD!.ToFD !== E.FD || LD!.IndexRoot === 0 || s2.v !== (GetFromKey(LD)!.Alias ?? '') ||
      !EquFileViewName(LD!.FromFD, s1.v, EO)) LD = LD!.Chain;
    av.CFile = LD!.FromFD;
    if (SelFldsForEO(EO.v, LD)) {
      EO.v!.DownLD = LD;
      EO.v!.DownRecPtr = av.CRecPtr;
      NewEditD(av.CFile, EO.v);
      const Brk = ref(0);
      if (OpenEditWw()) RunEdit(null, Brk);
      SaveFiles();
      PopEdit();
    }
  }
  // 1:
  PopW(w);
  ReleaseStore(p.v);
  RdEStatus();
  DisplEditWw();
}

// PAS: RUNEDIT3.PAS ShiftF7Proc – unit-internal
export function ShiftF7Proc(): void {
  // find last (first decl.) foreign key link with CFld as an argument
  const F = RunEdiVars.CFld!.FldD;
  let LD = AccessVars.LinkDRoot;
  let LD1: LinkDPtr = null;
  while (LD !== null) {
    let KF = LD.Args;
    while (KF !== null) {
      if (KF.FldD === F && ForNavigate(LD.ToFD)) LD1 = LD;
      KF = KF.Chain;
    }
    LD = LD.Chain;
  }
  if (LD1 !== null) UpwEdit(LD1);
}

// PAS: RUNEDIT3.PAS ShiftF7Duplicate – unit-internal
export function ShiftF7Duplicate(): boolean {
  const av = AccessVars;
  const E = CE();
  const ee = E.PrevE!;
  // with ee^ do
  av.CFile = ee.FD;
  av.CRecPtr = ee.NewRecPtr;
  if (!ELockRec(ee, av.CFile!.IRec, ee.IsNewRec, ee.SubSet)) return false;
  if (!ee.WasUpdated) {
    Move(av.CRecPtr!, ee.OldRecPtr!, av.CFile!.RecLen);
    ee.WasUpdated = true;
  }
  let kf = E.ShiftF7LD!.Args;
  let kf2 = E.ShiftF7LD!.ToKey!.KFlds;
  while (kf !== null) {
    DuplFld(E.FD, av.CFile, E.NewRecPtr, av.CRecPtr, ee.OldRecPtr, kf2!.FldD, kf.FldD);
    kf = kf.Chain;
    kf2 = kf2!.Chain;
  }
  SetUpdFlag();
  av.CFile = E.FD;
  av.CRecPtr = E.NewRecPtr;
  DriversVars.KbdBuffer = '\r' + DriversVars.KbdBuffer;
  return true;
}

// PAS: RUNEDIT3.PAS DuplToPrevEdit – unit-internal
export function DuplToPrevEdit(): boolean {
  const av = AccessVars;
  const E = CE();
  const ee = E.PrevE;
  if (ee === null) return false;
  const f1 = RunEdiVars.CFld!.FldD!;
  // with ee^ do
  const f2 = ee.CFld!.FldD!;
  if ((f2.Flg & f_Stored) === 0 || f1.Typ !== f2.Typ || f1.L !== f2.L || f1.M !== f2.M ||
    !ee.CFld!.Ed(ee.IsNewRec)) {
    WrLLF10Msg(140);
    return false;
  }
  av.CFile = ee.FD;
  av.CRecPtr = ee.NewRecPtr;
  if (!ELockRec(ee, av.CFile!.IRec, ee.IsNewRec, ee.SubSet)) return false;
  if (!ee.WasUpdated) {
    Move(av.CRecPtr!, ee.OldRecPtr!, av.CFile!.RecLen);
    ee.WasUpdated = true;
  }
  DuplFld(E.FD, av.CFile, E.NewRecPtr, av.CRecPtr, ee.OldRecPtr, f1, f2);
  SetUpdFlag();
  av.CFile = E.FD;
  av.CRecPtr = E.NewRecPtr;
  DriversVars.KbdBuffer = '\r' + DriversVars.KbdBuffer;
  return true;
}

// PAS: RUNEDIT3.PAS Calculate – unit-internal
export function Calculate(): void {
  const av = AccessVars;
  const dv = DriversVars;
  const p = ref<Pointer>(null);
  MarkStore(p);
  const er = new ExitRecord();
  NewExit(null, er);
  const Txt = ref('');
  let I = 1;
  let Del = true;
  let lbl = 0; // 0, 4 or 1
  try {
    let first = true;
    for (;;) {
      try {
        if (first) {
          first = false;
          ResetCompilePars();
        }
        if (lbl === 0) {
          // 0:
          Txt.v = RdRunVars.CalcTxt;
          lbl = 4;
        }
        if (lbl === 4) {
          // 4:
          I = 1;
          Del = true;
          lbl = 1;
        }
        // 1:
        RunEdiVars.TxtEdCtrlUBrk = true;
        RunEdiVars.TxtEdCtrlF4Brk = true;
        PromptLL(114, Txt, I, Del);
        if (dv.KbdChar === _U_) {
          lbl = 0;
          continue;
        }
        if (dv.KbdChar === _ESC_ || Txt.v.length === 0) break; // goto 3
        RdRunVars.CalcTxt = Txt.v;
        const inp = ref(Txt.v);
        SetInpStr(inp);
        RdLex();
        const FTyp = ref('');
        const Z = RdFrml(FTyp);
        if (av.Lexem !== '\x1a') CompError(21);
        if (dv.KbdChar === _CtrlF4_) {
          const CFld = RunEdiVars.CFld!;
          const F = CFld.FldD!;
          if (CFld.Ed(RunEdiPriv.IsNewRec) && F.FrmlTyp === FTyp.v) {
            if (LockRec(true)) {
              let r = 0;
              let assign = true; // 5:
              if (F.Typ === 'F' && (F.Flg & f_Comma) !== 0) {
                assign = false;
                const z = Z!;
                if (z.Op === _const) r = z.R;
                else if (z.Op === _unminus && z.P1!.Op === _const) r = -z.P1!.R;
                else assign = true;
                if (!assign) {
                  SetWasUpdated();
                  R_(F, r * Power10[F.M]);
                }
              }
              if (assign) AssignFld(F, Z);
              DisplFld(CFld, RunEdiPriv.IRec);
              IVon();
              break; // goto 3
            }
          } else WrLLF10Msg(140);
        }
        switch (FTyp.v) {
          case 'R': {
            const R = RunReal(Z);
            let t = LeadChar(' ', TrailChar('0', StrR(R, 30, 10)));
            if (t[t.length - 1] === '.') t = t.slice(0, -1);
            Txt.v = t;
            break;
          }
          case 'S':
            Txt.v = RunShortStr(Z); // wie RdMode fuer T ??
            break;
          case 'B':
            Txt.v = RunBool(Z) ? BaseVars.AbbrYes : BaseVars.AbbrNo;
            break;
        }
        lbl = 4;
      } catch (e) {
        if (!(e instanceof GoExitSignal)) throw e;
        // 2:
        const Msg = BaseVars.MsgLine;
        I = av.CurrPos;
        SetMsgPar(Msg);
        WrLLF10Msg(110);
        av.IsCompileErr = false;
        Del = false;
        av.CFile = CE().FD;
        ReleaseStore(p.v);
        lbl = 1;
      }
    }
    // 3:
    ReleaseStore(p.v);
  } finally {
    RestoreExit(er);
  }
}

// PAS: RUNEDIT3.PAS DelNewRec – unit-internal
export function DelNewRec(): void {
  const P = RunEdiPriv;
  const av = AccessVars;
  const E = CE();
  DelAllDifTFlds(av.CRecPtr!, null);
  if (CNRecs() === 1) return;
  P.IsNewRec = false;
  P.Append = false;
  P.WasUpdated = false;
  RunEdiVars.CFld = E.FirstFld;
  if (CRec() > CNRecs()) {
    if (P.IRec > 1) P.IRec--;
    else P.BaseRec--;
  }
  RdRec(CRec());
  P.NewDisplLL = true;
  DisplWwRecsOrPage();
}

// PAS: RUNEDIT3.PAS FrstFldOnPage – unit-internal
export function FrstFldOnPage(Page: number): EFldDPtr {
  let D = CE().FirstFld!;
  while (D.Page < Page) D = D.Chain!;
  return D;
}

// PAS: RUNEDIT3.PAS F6Proc – unit-internal
export function F6Proc(): void {
  const P = RunEdiPriv;
  let iMsg = 105;
  if (P.SubSet || P.HasIndex || P.NoCreate || P.NoDelete) iMsg = 106;
  switch (Menu(iMsg, 1)) {
    case 1:
      AutoReport();
      break;
    case 2:
      CheckFromHere();
      break;
    case 3:
      PromptSelect();
      break;
    case 4:
      AutoGraph();
      break;
    case 5:
      Sorting();
      break;
  }
}

// PAS: RUNEDIT3.PAS GetEdRecNo – unit-internal
export function GetEdRecNo(): number {
  const E = CE();
  if (RunEdiPriv.IsNewRec) return 0;
  if (E.IsLocked) return E.LockedRec;
  return AbsRecNr(CRec());
}

// PAS: RUNEDIT3.PAS SetEdRecNoEtc – unit-internal
export function SetEdRecNoEtc(RNr: number): void {
  const P = RunEdiPriv;
  const av = AccessVars;
  av.EdField = RunEdiVars.CFld!.FldD!.Name;
  av.EdIRec = P.IRec;
  av.EdRecKey = '';
  av.EdKey = '';
  av.EdRecNo = RNr;
  if (RNr === 0) av.EdRecNo = GetEdRecNo();
  if (P.VK === null) return;
  if (!P.WasWK && P.VK.Alias !== null) {
    av.EdKey = P.VK.Alias;
    if (av.EdKey === '') av.EdKey = '@';
  }
  if (!P.IsNewRec) {
    // x: XString absolute EdRecKey
    const cr = av.CRecPtr;
    if (P.WasUpdated) av.CRecPtr = CE().OldRecPtr;
    let k: KeyDPtr = P.VK;
    if (P.SubSet) k = P.WK;
    const x = new XString();
    x.PackKF(k!.KFlds);
    av.EdRecKey = x.S;
    av.CRecPtr = cr;
  }
}

// PAS: RUNEDIT3.PAS StartExit
export function StartExit(X: EdExitDPtr, Displ: boolean): boolean {
  const P = RunEdiPriv;
  const av = AccessVars;
  // PAS: RUNEDIT3.PAS StartExit.StartProc
  const StartProc = (ExitProc: InstrPtr, Displ: boolean): boolean => {
    const E = CE();
    const cf = av.CFile!;
    cf.WasWrRec = false;
    let p: Uint8Array | null = null;
    if (P.HasTF) {
      p = GetRecSpace();
      Move(av.CRecPtr!, p, cf.RecLen);
    }
    SetEdRecNoEtc(0);
    const lkd = E.IsLocked;
    if (!lkd && !LockRec(false)) return false;
    let b = P.WasUpdated;
    av.EdUpdated = b;
    const b2 = HasUpdFlag();
    SetWasUpdated();
    ClearUpdFlag();
    const ta = ExitProc!.TArg[ExitProc!.N];
    ta.FD = av.CFile;
    ta.RecPtr = av.CRecPtr;
    const md = av.CFile!.LMode;
    WrEStatus();
    CallProcedure(ExitProc);
    RdEStatus();
    NewLMode(md);
    let upd = av.CFile!.WasWrRec;
    if (HasUpdFlag()) {
      b = true;
      upd = true;
    }
    P.WasUpdated = b;
    if (b2) SetUpdFlag();
    if (!P.WasUpdated && !lkd) UnLockRec(E);
    if (Displ && upd) DisplAllWwRecs();
    if (Displ) P.NewDisplLL = true;
    if (P.HasTF) {
      let f = av.CFile!.FldD;
      while (f !== null) {
        if (f.Typ === 'T' && (f.Flg & f_Stored) !== 0 && getLongint(p!, f.Displ) === getLongint(E.OldRecPtr!, f.Displ)) {
          P.NoDelTFlds = true;
        }
        f = f.Chain;
      }
      ReleaseStore(p);
    }
    return true;
  };
  // PAS: RUNEDIT3.PAS StartExit.StartRprt
  const StartRprt = (RO: RprtOptPtr): void => {
    const displ = ref(false);
    if (P.IsNewRec || P.EdRecVar || av.EdBreak === 16 || !WriteCRec(true, displ)) return;
    if (displ.v) DisplAllWwRecs();
    let kf: KeyFldDPtr = null;
    if (P.VK !== null) kf = P.VK.KFlds;
    const k = new XWKey();
    k.OneRecIdx(kf, AbsRecNr(CRec()));
    RO!.FDL.FD = av.CFile;
    RO!.FDL.ViewKey = k;
    ReportProc(RO, false);
    const E = CE();
    av.CFile = E.FD;
    av.CRecPtr = E.NewRecPtr;
  };
  switch (X!.Typ) {
    case 'P':
      return StartProc(X!.Proc, Displ);
    case 'R':
      StartRprt(X!.RO);
      break;
  }
  return true;
}

// PAS: RUNEDIT3.PAS ExitKeyProc – unit-internal
export function ExitKeyProc(): number {
  const av = AccessVars;
  const dv = DriversVars;
  let w = 0;
  const c = dv.KbdChar;
  let X = CE().ExD;
  while (X !== null) {
    if (TestExitKey(c, X)) {
      av.LastTxtPos = -1;
      if (X.Typ === 'Q') w = 1;
      else {
        const ok = av.EdOk;
        av.EdOk = false;
        StartExit(X, true);
        if (av.EdOk) w = 3;
        else w = 2;
        av.EdOk = ok;
      }
    }
    X = X.Chain;
  }
  if ((w === 0 || w === 3) && c === _ShiftF7_ && RunEdiVars.CFld!.Ed(RunEdiPriv.IsNewRec)) {
    ShiftF7Proc();
    w = 2;
  }
  dv.KbdChar = c;
  return w;
}
// PAS: RUNEDIT3.PAS FieldHelp – unit-internal
export function FieldHelp(): void {
  const cf = AccessVars.CFile!;
  Help(cf.ChptPos.R, cf.Name + '.' + RunEdiVars.CFld!.FldD!.Name, false);
}

// PAS: RUNEDIT3.PAS DisplLASwitches – unit-internal
export function DisplLASwitches(): void {
  const P = RunEdiPriv;
  const rows = BaseVars.TxtRows;
  const a = BaseVars.Colors.lSwitch;
  if (!P.ChkSwitch) ScrWrStr(0, rows - 1, '#L', a);
  if (!P.WarnSwitch) ScrWrStr(2, rows - 1, '?', a);
  if (!P.EdRecVar && !P.AddSwitch) ScrWrStr(3, rows - 1, '#A', a);
  if (!P.WithBoolDispl && P.Select) ScrWrStr(5, rows - 1, ' \x12 ', a);
}
// PAS: RUNEDIT3.PAS DisplLL – unit-internal
export function DisplLL(): void {
  const P = RunEdiPriv;
  const E = CE();
  if (E.Last !== null) {
    BaseVars.MsgLine = E.Last;
    if (BaseVars.MsgLine.length > 0) {
      WrLLMsgTxt();
      DisplLASwitches();
    }
    return;
  }
  let n: number;
  if (E.ShiftF7LD !== null) n = 144;
  else if (P.NoCreate || P.Only1Record) {
    if (P.IsNewRec) n = 129;
    else if (P.EdRecVar) n = 130;
    else n = 128;
  } else if (P.IsNewRec) n = 123;
  else n = 124;
  if (!P.F1Mode || P.Mode24) {
    WrLLMsg(n);
    DisplLASwitches();
  }
}
// PAS: RUNEDIT3.PAS DisplCtrlAltLL – unit-internal
export function DisplCtrlAltLL(Flags: number): void {
  const E = CE();
  if ((Flags & 0x04) !== 0) {
    // Ctrl
    if (E.CtrlLast !== null) {
      BaseVars.MsgLine = E.CtrlLast;
      WrLLMsgTxt();
    } else if (IsCurrChpt()) WrLLMsg(125);
    else if (RunEdiPriv.EdRecVar) WrLLMsg(154);
    else WrLLMsg(127);
  } else if ((Flags & 0x03) !== 0) {
    // Shift
    if (E.ShiftLast !== null) {
      BaseVars.MsgLine = E.ShiftLast;
      WrLLMsgTxt();
    } else DisplLL();
  } else if ((Flags & 0x08) !== 0) {
    // Alt
    if (E.AltLast !== null) {
      BaseVars.MsgLine = E.AltLast;
      WrLLMsgTxt();
    } else DisplLL();
  }
}
// PAS: RUNEDIT3.PAS DisplLLHlp – unit-internal
export function DisplLLHlp(): void {
  if (AccessVars.CRdb!.HelpFD !== null) {
    const cf = AccessVars.CFile!;
    DisplLLHelp(cf.ChptPos.R, cf.Name + '.' + RunEdiVars.CFld!.FldD!.Name, RunEdiPriv.Mode24);
  }
}

// PAS: RUNEDIT3.PAS CtrlReadKbd – unit-internal
export function CtrlReadKbd(): void {
  const P = RunEdiPriv;
  const dv = DriversVars;
  const E = CE();
  let flgs = 0;
  const isEv = (): boolean => dv.Event.What === evKeyDown || dv.Event.What === evMouseDown;
  TestEvent();
  if (!isEv()) {
    ClrEvent();
    if (P.NewDisplLL) {
      DisplLL();
      P.NewDisplLL = false;
    }
    const TimeBeg = dv.Timer;
    let D = 0;
    if (AccessVars.CFile!.NotCached()) {
      const ScreenDelay = BaseVars.Spec.ScreenDelay;
      if (!E.EdRecVar && (ScreenDelay === 0 || E.RefreshDelay < ScreenDelay)) D = E.RefreshDelay;
      if (E.WatchDelay !== 0) {
        if (D === 0) D = E.WatchDelay;
        else D = MinW(D, E.WatchDelay);
      }
    }
    if (P.F1Mode && P.Mode24) DisplLLHlp();
    for (;;) {
      // 1:
      if (dv.LLKeyFlags !== 0) {
        flgs = dv.LLKeyFlags;
        DisplCtrlAltLL(flgs); // 11:
      } else if ((dv.KbdFlgs & 0x0f) !== 0) {
        flgs = dv.KbdFlgs;
        DisplCtrlAltLL(flgs); // 11:
      } else {
        DisplLL();
        flgs = 0;
        if (P.F1Mode && !P.Mode24) DisplLLHlp();
      }
      if (D > 0) {
        if (dv.Timer >= TimeBeg + D) break; // goto 2
        WaitEvent(TimeBeg + D - dv.Timer);
      } else WaitEvent(0);
      if (!isEv()) {
        ClrEvent();
        continue;
      }
      break;
    }
  }
  // 2:
  if (flgs !== 0) {
    dv.LLKeyFlags = 0;
    DisplLL();
    AddCtrlAltShift(flgs);
  }
}
// PAS: RUNEDIT3.PAS MouseProc – unit-internal
export function MouseProc(): void {
  const P = RunEdiPriv;
  const dv = DriversVars;
  const E = CE();
  const Displ = ref(false);
  outer: for (let i = 1; i <= E.NRecs; i++) {
    const n = P.BaseRec + i - 1;
    if (n > CNRecs()) break;
    let D = E.FirstFld;
    while (D !== null) {
      if (P.IsNewRec && i === P.IRec && D === P.FirstEmptyFld) break outer;
      if (D.Page === P.CPage && MouseInRect(D.Col - 1, FldRow(D, i) - 1, D.L, 1)) {
        if (i !== P.IRec && (P.IsNewRec || !WriteCRec(true, Displ))) break outer;
        GotoRecFld(n, D);
        if ((dv.Event.Buttons & mbDoubleClick) !== 0) {
          if (P.MouseEnter) dv.Event.KeyCode = _M_;
          else dv.Event.KeyCode = _Ins_;
          dv.Event.What = evKeyDown;
          return;
        }
        ClrEvent();
        return;
      }
      D = D.Chain;
    }
  }
  // 1:
  ClrEvent();
}
// PAS: RUNEDIT3.PAS ToggleSelectRec – unit-internal
export function ToggleSelectRec(): void {
  const k = CE().SelKey!;
  const n = AbsRecNr(CRec());
  const x = new XString();
  if (k.RecNrToPath(x, n)) {
    k.NR--;
    k.DeleteOnPath();
  } else {
    k.NR++;
    k.Insert(n, false);
  }
  SetRecAttr(RunEdiPriv.IRec);
  IVon();
}
// PAS: RUNEDIT3.PAS ToggleSelectAll – unit-internal
export function ToggleSelectAll(): void {
  const P = RunEdiPriv;
  const k = CE().SelKey;
  if (k === null) return;
  if (k.NR > 0) k.Release();
  else if (P.SubSet) CopyIndex(k, P.WK);
  else CopyIndex(k, P.VK);
  DisplAllWwRecs();
}

// PAS: RUNEDIT3.PAS GoStartFld – unit-internal
export function GoStartFld(SFld: EFldDPtr): void {
  const P = RunEdiPriv;
  while (RunEdiVars.CFld !== SFld && RunEdiVars.CFld!.Chain !== null) {
    const CFld = RunEdiVars.CFld!;
    if (IsFirstEmptyFld()) {
      if (CFld.Impl !== null && LockRec(true)) AssignFld(CFld.FldD, CFld.Impl);
      P.FirstEmptyFld = P.FirstEmptyFld!.Chain;
      DisplFld(CFld, P.IRec);
    }
    GotoRecFld(CRec(), CFld.Chain);
  }
}

// PAS: RUNEDIT3.PAS RunEdit
export function RunEdit(PX: XStringPtr, Brk: Ref<number>): void {
  const P = RunEdiPriv;
  const av = AccessVars;
  const dv = DriversVars;
  const Displ = ref(false);
  const nr = ref(0);
  let LongBeep = 0;
  let OldTimeW = 0;
  let OldTimeR = 0;
  let b = false;
  // Timer: BP7 `absolute 0:$46C` (the FPC local is never set) = DriversVars.Timer (host ticks)
  Brk.v = 0;
  DisplLL();
  let lbl: string;
  if (P.OnlySearch) lbl = '2';
  else {
    if (!P.IsNewRec && PX !== null) GotoXRec(PX, nr);
    if (P.Select && !RunBool(CE().Bool)) GoPrevNextRec(+1, true);
    if (CE().StartFld !== null) {
      GoStartFld(CE().StartFld);
      lbl = '1';
    } else lbl = '0';
  }

  // the `else` branch of the key case (label 13): keys that first save the record
  const Label13 = (): string => {
    const E = CE();
    if (P.IsNewRec) return '1';
    const w = dv.KbdChar;
    if (w === _Y_) {
      if (!P.NoDelete && DeleteRecProc()) {
        ClearKeyBuf();
        b = true;
        return '14';
      }
      return '1';
    }
    if (!WriteCRec(true, Displ)) return '1';
    if (Displ.v) DisplAllWwRecs();
    dv.KbdChar = w; // only in edit mode
    const CFld = RunEdiVars.CFld;
    switch (w) {
      case _F9_:
        SaveFiles();
        P.UpdCount = 0;
        break;
      case _N_:
        if (!P.NoCreate && !P.Only1Record) {
          InsertRecProc(null);
          return '0';
        }
        break;
      case _up_:
      case _E_:
        if (E.NRecs > 1) GoPrevNextRec(-1, true);
        break;
      case _CtrlHome_:
        GoPrevNextRec(-1, true);
        break;
      case _down_:
      case _X_:
        if (E.NRecs > 1) GoPrevNextRec(+1, true);
        break;
      case _CtrlEnd_:
        GoPrevNextRec(+1, true);
        break;
      case _PgUp_:
      case _R_:
        if (E.NPages === 1) {
          if (E.NRecs === 1) GoPrevNextRec(-1, true);
          else GotoRecFld(CRec() - E.NRecs, CFld);
        } else if (P.CPage > 1) GotoRecFld(CRec(), FrstFldOnPage(P.CPage - 1));
        break;
      case _PgDn_:
      case _C_:
        if (E.NPages === 1) {
          if (E.NRecs === 1) GoPrevNextRec(+1, true);
          else GotoRecFld(CRec() + E.NRecs, CFld);
        } else if (P.CPage < E.NPages) GotoRecFld(CRec(), FrstFldOnPage(P.CPage + 1));
        break;
      case _Q_:
        switch (ReadKbd()) {
          case _S_:
            return '3';
          case _D_:
            return '4';
          case _R_:
            return '5';
          case _C_:
            return '6';
        }
        break;
      case _CtrlPgUp_:
        return '5';
      case _CtrlPgDn_:
        return '6';
      case _CtrlLeft_:
        if (CRec() > 1) SwitchRecs(-1);
        break;
      case _CtrlRight_:
        if (CRec() < CNRecs()) SwitchRecs(+1);
        break;
      case _F3_:
        if (!P.EdRecVar) {
          if (av.CFile === av.CRdb!.HelpFD) {
            const i = ref(0);
            if (PromptHelpName(i)) {
              GotoRecFld(i.v, CFld);
              return '1';
            }
          } else {
            PromptAndSearch(false);
            return '0';
          }
        }
        break;
      case _CtrlF2_:
        if (!P.EdRecVar) RefreshSubset();
        b = false;
        return '14';
      case _AltF2_:
      case _AltF3_:
        if (IsCurrChpt()) {
          if (w === _AltF3_) {
            ForAllFDs(ClosePassiveFD);
            EditHelpOrCat(w, 0, '');
          } else {
            Brk.v = 2;
            return 'fin';
          }
        } else if (av.IsTestRun && av.CFile !== av.CatFD && w === _AltF2_) {
          EditHelpOrCat(w, 1, av.CFile!.Name + '.' + CFld!.FldD!.Name);
        }
        break;
      case _CtrlF3_:
        if (!P.EdRecVar) PromptGotoRecNr();
        break;
      case _F6_:
        if (!P.EdRecVar) F6Proc();
        break;
      case _CtrlF4_:
        if (DuplToPrevEdit()) {
          av.EdBreak = 14;
          return 'fin';
        }
        break;
      case _CtrlF7_:
        DownEdit();
        break;
      case _F8_:
        if (E.SelKey !== null) {
          ToggleSelectRec();
          GoPrevNextRec(+1, true);
        }
        break;
      case _ShiftF8_:
        ToggleSelectAll();
        break;
      case _AltF7_:
        ImbeddEdit();
        break;
      default:
        if ((w >= _CtrlF8_ && w <= _CtrlF10_) || w === _AltF9_) {
          if (IsCurrChpt()) {
            Brk.v = 2;
            return 'fin';
          }
        }
    }
    return '1';
  };

  // the evKeyDown branch of the event case
  const KeyDown = (): string => {
    const E = CE();
    dv.KbdChar = dv.Event.KeyCode;
    ClrEvent();
    switch (ExitKeyProc()) {
      case 1:
        return '7'; // quit
      case 2:
        return '1'; // exit
    }
    const k = dv.KbdChar;
    const CFld = RunEdiVars.CFld!;
    switch (k) {
      case _F1_:
        RdMsg(7);
        Help(HelpFDAsRdb(), BaseVars.MsgLine, false);
        return '1';
      case _CtrlF1_:
        FieldHelp();
        return '1';
      case _AltF10_:
        Help(null, '', false);
        return '1';
      case _ESC_:
        if (P.OnlySearch) {
          if (P.IsNewRec) {
            if (CNRecs() > 1) DelNewRec();
            else return '9';
          } else if (!WriteCRec(true, Displ)) return '1';
          return '2';
        }
        return '9';
      case _AltEqual_:
        UndoRecord();
        av.EdBreak = 0;
        return 'fin';
      case _U_:
        if (PromptYN(108)) UndoRecord();
        return '1';
      case 0x1c: // ^\
        if (!CtrlMProc(2)) return '7';
        return '1';
      case _F2_:
        if (!P.EdRecVar) {
          if (P.IsNewRec) {
            if (CNRecs() > 1 && (!P.Prompt158 || EquOldNewRec() || PromptYN(158))) DelNewRec();
          } else if (!P.NoCreate && !P.Only1Record && WriteCRec(true, Displ)) {
            if (Displ.v) DisplAllWwRecs();
            SwitchToAppend();
            return '0';
          }
        }
        return '1';
      case _up_:
        return P.LUpRDown ? '11' : '13';
      case _down_:
        return P.LUpRDown ? '12' : '13';
      case _left_:
      case _S_:
        return '11';
      case _right_:
      case _D_:
        return '12';
      case _Home_:
        return '3';
      case _End_:
        return '4';
      case _M_:
        if (P.SelMode && E.SelKey !== null && !P.IsNewRec) {
          if (WriteCRec(true, Displ)) {
            if (E.SelKey !== null && E.SelKey.NRecs() === 0) ToggleSelectRec();
            av.EdBreak = 12;
            return 'fin';
          }
        } else if (E.ShiftF7LD !== null && !P.IsNewRec) {
          if (ShiftF7Duplicate()) return '9';
        } else if (!CtrlMProc(3)) return '7';
        return '1';
      case _Ins_: {
        let bb = false;
        if (CFld.Ed(P.IsNewRec) && LockRec(true)) bb = true;
        if (!EditItemProc(false, bb, Brk)) return '7';
        if (Brk.v !== 0) return 'fin';
        return '1';
      }
      case _F4_:
        if (CRec() > 1 && (IsFirstEmptyFld() || PromptYN(121)) && LockRec(true)) {
          DuplFromPrevRec();
          if (!CtrlMProc(1)) return '7';
        }
        return '1';
      case _F5_:
        SetSwitchProc();
        return '1';
      case _F7_:
        UpwEdit(null);
        return '1';
      case _CtrlF5_:
        Calculate();
        return '1';
      default:
        if (k >= 0x20 && k <= 0xfe) {
          if (CFld.Ed(P.IsNewRec) && (CFld.FldD!.Typ !== 'T' || _T(CFld.FldD) === 0) && LockRec(true)) {
            dv.KbdBuffer = String.fromCharCode(k) + dv.KbdBuffer;
            if (!EditItemProc(true, true, Brk)) return '7';
            if (Brk.v !== 0) return 'fin';
          }
          return '1';
        }
        return '13';
    }
  };

  for (;;) {
    const E = CE();
    switch (lbl) {
      case '0':
        lbl = CtrlMProc(0) ? '1' : '7';
        break;
      case '1':
        LongBeep = 0;
        lbl = '8';
        break;
      case '8':
        OldTimeW = dv.Timer;
        lbl = '81';
        break;
      case '81': {
        OldTimeR = dv.Timer;
        CtrlReadKbd();
        if (av.CFile!.NotCached()) {
          if (!P.EdRecVar && E.RefreshDelay > 0 && OldTimeR + E.RefreshDelay < dv.Timer) DisplAllWwRecs();
          if (dv.Event.What === 0) {
            if (E.WatchDelay > 0 && OldTimeW + E.WatchDelay < dv.Timer) {
              if (LongBeep < 3) {
                for (let i = 1; i <= 4; i++) beep();
                LongBeep++;
                lbl = '8';
              } else {
                UndoRecord();
                av.EdBreak = 11;
                lbl = '7';
              }
            } else lbl = '81';
            break;
          }
        }
        const Event = dv.Event;
        if (Event.What === evMouseDown) {
          if (P.F1Mode && av.CRdb!.HelpFD !== null &&
            ((P.Mode24 && Event.Where.Y === BaseVars.TxtRows - 2) ||
              (!P.Mode24 && Event.Where.Y === BaseVars.TxtRows - 1))) {
            ClrEvent();
            FieldHelp();
          } else MouseProc();
          lbl = '1';
        } else if (Event.What === evKeyDown) lbl = KeyDown();
        else {
          ClrEvent();
          lbl = '1';
        }
        break;
      }
      case '2':
        lbl = PromptAndSearch(!P.NoCreate) ? '0' : '9';
        break;
      case '9':
        av.EdBreak = 0;
        lbl = '7';
        break;
      case '7': {
        if (P.IsNewRec && !EquOldNewRec()) {
          lbl = !P.Prompt158 || PromptYN(158) ? 'fin' : '1';
          break;
        }
        const EdBr = av.EdBreak;
        const n = GetEdRecNo();
        if ((P.IsNewRec || WriteCRec(true, Displ)) &&
          (av.EdBreak === 11 || P.NoESCPrompt || (!BaseVars.Spec.ESCverify && !P.MustESCPrompt) || PromptYN(137))) {
          av.EdBreak = EdBr;
          SetEdRecNoEtc(n);
          lbl = '71';
        } else lbl = '1';
        break;
      }
      case 'fin':
        SetEdRecNoEtc(0);
        lbl = '71';
        break;
      case '71':
        if (P.IsNewRec && !P.EdRecVar) DelNewRec();
        IVoff();
        av.EdUpdated = E.EdUpdated;
        if (!P.EdRecVar) ClearRecSpace(E.NewRecPtr!);
        if (P.SubSet && !P.WasWK) P.WK!.Close();
        if (!P.EdRecVar) OldLMode(E.OldMd);
        return;
      case '11': {
        const CFld = RunEdiVars.CFld!;
        if (CFld.ChainBack !== null) GotoRecFld(CRec(), CFld.ChainBack);
        lbl = '1';
        break;
      }
      case '12': {
        const CFld = RunEdiVars.CFld!;
        if (CFld.Chain !== null && !IsFirstEmptyFld()) GotoRecFld(CRec(), CFld.Chain);
        lbl = '1';
        break;
      }
      case '3':
        GotoRecFld(CRec(), E.FirstFld);
        lbl = '1';
        break;
      case '4':
        if (P.IsNewRec && P.FirstEmptyFld !== null) GotoRecFld(CRec(), P.FirstEmptyFld);
        else GotoRecFld(CRec(), E.LastFld);
        lbl = '1';
        break;
      case '5':
        GotoRecFld(1, E.FirstFld);
        lbl = '1';
        break;
      case '6':
        GotoRecFld(CNRecs(), E.LastFld);
        lbl = '1';
        break;
      case '13':
        lbl = Label13();
        break;
      case '14':
        if ((CNRecs() === 0 || (CNRecs() === 1 && P.IsNewRec)) && P.NoCreate) {
          WrLLF10Msg(112);
          av.EdBreak = 13;
          lbl = 'fin';
        } else if (b && !CtrlMProc(0)) lbl = '7';
        else lbl = '1';
        break;
      default:
        throw new Error('RunEdit: bad label ' + lbl);
    }
  }
}

// PAS: RUNEDIT3.PAS EditDataFile – called from Proc and Projmgr
export function EditDataFile(FD: FileDPtr, EO: EditOptPtr): void {
  const av = AccessVars;
  const p = ref<Pointer>(null);
  MarkStore(p);
  if (EO!.SyntxChk) {
    av.IsCompileErr = false;
    const er = new ExitRecord();
    NewExit(null, er);
    try {
      NewEditD(FD, EO);
    } catch (e) {
      if (!(e instanceof GoExitSignal)) {
        RestoreExit(er);
        throw e;
      }
    }
    // 1:
    RestoreExit(er);
    if (av.IsCompileErr) {
      av.EdRecKey = BaseVars.MsgLine;
      BaseVars.LastExitCode = av.CurrPos + 1;
      av.IsCompileErr = false;
    } else BaseVars.LastExitCode = 0;
  } else {
    NewEditD(FD, EO);
    const E = CE();
    let w1: number;
    let w2 = 0;
    let w3 = 0;
    const pix = (E.WFlags & WPushPixel) !== 0;
    if (E.WwPart) {
      const r2 = E.WithBoolDispl ? 2 : 1;
      let r1 = BaseVars.TxtRows;
      if (E.Mode24) r1--;
      w1 = PushW1(1, 1, BaseVars.TxtCols, r2, pix, true);
      w2 = PushW1(1, r1, BaseVars.TxtCols, BaseVars.TxtRows, pix, true);
      if ((E.WFlags & WNoPop) === 0) w3 = PushW1(E.V.C1, E.V.R1, E.V.C2 + E.ShdwX, E.V.R2 + E.ShdwY, pix, true);
    } else w1 = PushW1(1, 1, BaseVars.TxtCols, BaseVars.TxtRows, pix, true);
    if (OpenEditWw()) {
      if (RunEdiPriv.OnlyAppend && !RunEdiPriv.Append) SwitchToAppend();
      const Brk = ref(0);
      RunEdit(null, Brk);
    }
    if (w3 !== 0) PopW(w3);
    if (w2 !== 0) PopW(w2);
    PopW(w1);
  }
  // 2:
  PopEdit();
  ReleaseStore(p.v);
}
