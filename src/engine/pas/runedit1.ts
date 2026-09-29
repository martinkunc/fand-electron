// PAS: RUNEDIT1.PAS – include of RUNEDI: record numbers/selection, record locking, field editing
// (FieldEdit/TestMask), screen display of records and fields, OpenEditWw/BuildWork, record save
// (WriteCRec), delete (DeleteRecProc), undo, journal.
//
// Porting notes:
// * State: RunEdiVars/RunEdiPriv in runedi.ts (E = RunEdiE()). Routines not in the RUNEDI interface
//   are marked unit-internal; they are exported only for the other include modules.
// * asm/DOS: none (WrEStatus/RdEStatus: BP7 block Move over FirstEmptyFld..SelMode; the FPC branch
//   copies field by field - use rdrun.ts EditDCopiedFields).
// * WrJournal: `RP` is the record buffer; with an .X file the first byte (deleted flag) is skipped
//   (inc(RP); dec(l)) before copying into the journal record at F^.Displ.
// * WriteCRec: the order of checks, implicit ADD (ImplD, `AddD` chains with Owned/Create),
//   UpdateIndexes, T-field storage (DelAllDifTFlds), UpdMemberRef (cascading key changes through
//   LinkD with MemberRef=1/2), ExitCheck (EdExitD AtWrRec) matters for observable behaviour.
// * FieldEdit: `C999` mask for numbers, TestMask for the `mask` of A fields; returns via KbdChar.
// * Locking: LockForMemb/LockWithDep lock member files (MemberRef) together with CFile;
//   single-user semantics (PORTING.md 15) but keep the mode bookkeeping.


import {
  ref, GoExitSignal, TxtWrite, Output, StrI, StrR, ValR, Copy, Pos, Int, getLongint, setLongint, Move,
  type Ref, type Pointer,
} from './pasrt.ts';
import {
  BaseVars, ExitRecord, NewExit, RestoreExit, GoExit, MarkStore, ReleaseStore, IsDigit, IsLetter, MinW, MaxW, MinL,
  MaxL, SetMsgPar, Set2MsgPar, StrDate, ValDate, Today, CurrTime, LenStyleStr, LogToAbsLenStyleStr, WrStyleStr,
  MouseInRect, Shared, type StringPtr, type float,
} from './base.ts';
import {
  DriversVars, GetEvent, ClrEvent, GotoXY, WhereX, WhereY, CrsNorm, CrsHide, ClrEol, ClrScr, Window, ScrColor,
  ScrMove, KbdTimer, LockBeep, evKeyDown, evMouseDown, _ESC_, _M_,
} from './drivers.ts';
import {
  AccessVars, XString, XScan, XWKey, f_Stored, f_Mask, f_Comma, LeftJust, Power10, NullMode, NoExclMode,
  NoDelMode, NoCrMode, RdMode, WrMode, CrMode, DelMode, LockModeTxt, FieldDMask, RunErrorM, CompArea, GetRecSpace,
  CFileRecSize, SetUpdFlag, DeletedFlag, ClearDeletedFlag, NewLMode, OldLMode, TryLMode, TryLockN, UnLockN,
  ReadRec, WriteRec, CreateRec, DeleteRec, IncNRecs, DecNRecs, ZeroAllFlds, ClearRecSpace, DelTFld, DelDifTFld,
  DelAllDifTFlds, _ShortS, _LongS, _R, _B, S_, LongS_, R_, B_, TestXFExist, DeleteXRec, OverwrXRec,
  type FieldDPtr, type FileDPtr, type FrmlPtr, type KeyDPtr, type LockMode, type StringList, type WKeyDPtr,
  type XScanPtr, type ImplDPtr, type KeyFldDPtr,
} from './access.ts';
import type { EFldDPtr, EditDPtr, EdExitDPtr } from './rdrun.ts';
import { LockForAdd, RunAddUpdte1 } from './rdrun.ts';
import { RunEdiVars, RunEdiPriv, RunEdiE, EditTxt } from './runedi.ts';
import { CompChk, DisplChkErr } from './runedit2.ts';
import { StartExit } from './runedit3.ts';
import {
  RunBool, AssgnFrml, DecodeField, CopyLine, LeadChar, TrailChar, GetFromKey, Owned,
} from './runfrml.ts';
import { WrLLF10Msg, PushWrLLMsg, PopW, WriteWFrame, CFileMsg, PromptYN } from './obaseww.ts';
import { OpenCreateF, SaveFiles, SetCPathVol } from './oaccess.ts';
import { CreateWIndex, ScanSubstWIndex } from './sort.ts';
import { IsCurrChpt, ChptDel, ChptWriteCRec } from './projmgr1.ts';

/** TS-only: write(...) to the CRT (System.Output). */
function write(...S: string[]): void {
  TxtWrite(Output, ...S);
}
/** TS-only: the current editor E^ (never nil while an editor runs). */
function CE(): NonNullable<EditDPtr> {
  return RunEdiE()!;
}

// PAS: RUNEDIT1.PAS CRec
export function CRec(): number {
  const P = RunEdiPriv;
  return P.BaseRec + P.IRec - 1;
}
// PAS: RUNEDIT1.PAS CNRecs – unit-internal
export function CNRecs(): number {
  const P = RunEdiPriv;
  if (P.EdRecVar) return 1;
  let n: number;
  if (P.SubSet) n = P.WK!.NRecs();
  else if (P.HasIndex) n = P.VK!.NRecs();
  else n = AccessVars.CFile!.NRecs;
  if (P.IsNewRec) n++;
  return n;
}
// PAS: RUNEDIT1.PAS AbsRecNr – unit-internal
export function AbsRecNr(N: number): number {
  const P = RunEdiPriv;
  if (P.EdRecVar) {
    if (P.IsNewRec) return 0;
    return 1;
  }
  if (P.IsNewRec) {
    if (N === CRec() && N === CNRecs()) return 0;
    if (N > CRec()) N--;
  }
  if (P.SubSet) N = P.WK!.NrToRecNr(N);
  else if (P.HasIndex) {
    const md = NewLMode(RdMode);
    TestXFExist();
    N = P.VK!.NrToRecNr(N);
    OldLMode(md);
  }
  return N;
}
// PAS: RUNEDIT1.PAS LogRecNo – unit-internal
export function LogRecNo(N: number): number {
  const P = RunEdiPriv;
  let result = 0;
  if (N <= 0 || N > AccessVars.CFile!.NRecs) return result;
  const md = NewLMode(RdMode);
  ReadRec(N);
  if (!DeletedFlag()) {
    if (P.SubSet) result = P.WK!.RecNrToNr(N);
    else if (P.HasIndex) {
      TestXFExist();
      result = P.VK!.RecNrToNr(N);
    } else result = N;
  }
  OldLMode(md);
  return result;
}
// PAS: RUNEDIT1.PAS IsSelectedRec – unit-internal
export function IsSelectedRec(I: number): boolean {
  const P = RunEdiPriv;
  const E = CE();
  if (E.SelKey === null || (I === P.IRec && P.IsNewRec)) return false;
  const x = new XString();
  const n = AbsRecNr(P.BaseRec + I - 1);
  const cr = AccessVars.CRecPtr;
  if (I === P.IRec && P.WasUpdated) AccessVars.CRecPtr = E.OldRecPtr;
  const result = E.SelKey.RecNrToPath(x, n);
  AccessVars.CRecPtr = cr;
  return result;
}
// PAS: RUNEDIT1.PAS EquOldNewRec – unit-internal
export function EquOldNewRec(): boolean {
  return CompArea(AccessVars.CRecPtr!, CE().OldRecPtr!, AccessVars.CFile!.RecLen) === 1; // ord(_equ)
}

// PAS: RUNEDIT1.PAS RdRec – unit-internal
export function RdRec(N: number): void {
  if (RunEdiPriv.EdRecVar) return;
  const md = NewLMode(RdMode);
  ReadRec(AbsRecNr(N));
  OldLMode(md);
}

// PAS: RUNEDIT1.PAS ELockRec – unit-internal
export function ELockRec(E: EditDPtr, N: number, IsNewRec: boolean, Subset: boolean): boolean {
  const e = E!;
  if (e.IsLocked) return true;
  e.LockedRec = N;
  if (IsNewRec) return true;
  const cf = AccessVars.CFile!;
  if (!e.EdRecVar) {
    if (cf.NotCached()) {
      if (!TryLockN(N, 1 /* withESC */)) return false;
      const md = NewLMode(RdMode);
      ReadRec(N);
      OldLMode(md);
      if (Subset && !((RunEdiPriv.NoCondCheck || (RunBool(e.Cond) && CheckKeyIn(e))) && CheckOwner(e))) {
        WrLLF10Msg(150);
        UnLockN(N); // 1:
        return false;
      }
    } else if (DeletedFlag()) {
      WrLLF10Msg(148);
      UnLockN(N); // 1:
      return false;
    }
  }
  e.IsLocked = true;
  return true;
}

// PAS: RUNEDIT1.PAS LockRec – unit-internal
export function LockRec(Displ: boolean): boolean {
  const P = RunEdiPriv;
  const E = CE();
  if (E.IsLocked) return true;
  const b = ELockRec(E, AbsRecNr(CRec()), P.IsNewRec, P.SubSet);
  if (b && !P.IsNewRec && !P.EdRecVar && AccessVars.CFile!.NotCached() && Displ) DisplRec(P.IRec);
  return b;
}
// PAS: RUNEDIT1.PAS UnLockRec – unit-internal
export function UnLockRec(E: EditDPtr): void {
  const e = E!;
  if (e.FD!.IsShared() && e.IsLocked && !e.EdRecVar) UnLockN(e.LockedRec);
  e.IsLocked = false;
}

// PAS: RUNEDIT1.PAS NewRecExit – unit-internal
export function NewRecExit(): void {
  let X: EdExitDPtr = CE().ExD;
  while (X !== null) {
    if (X.AtNewRec) {
      AccessVars.EdBreak = 18;
      AccessVars.LastTxtPos = -1;
      StartExit(X, false);
    }
    X = X.Chain;
  }
}

// PAS: RUNEDIT1.PAS SetWasUpdated – unit-internal
export function SetWasUpdated(): void {
  const P = RunEdiPriv;
  if (!P.WasUpdated) {
    if (P.EdRecVar) SetUpdFlag();
    const E = CE();
    Move(E.NewRecPtr!, E.OldRecPtr!, CFileRecSize());
    P.WasUpdated = true;
  }
}
// PAS: RUNEDIT1.PAS SetCPage – unit-internal
export function SetCPage(): void {
  const P = RunEdiPriv;
  P.CPage = RunEdiVars.CFld!.Page;
  // RT:=ERecTxtDPtr(@E^.RecTxt): the RecTxt field is the Chain of a pseudo element (page 0)
  let RT = CE().RecTxt;
  for (let i = 2; i <= P.CPage; i++) RT = RT!.Chain;
  P.RT = RT;
}
// PAS: RUNEDIT1.PAS AdjustCRec – unit-internal
export function AdjustCRec(): void {
  const P = RunEdiPriv;
  if (CRec() <= CNRecs()) return;
  while (CRec() > CNRecs()) {
    if (P.IRec > 1) P.IRec--;
    else P.BaseRec--;
  }
  if (P.BaseRec === 0) {
    P.BaseRec = 1;
    if (!P.IsNewRec) {
      P.IsNewRec = true;
      P.Append = true;
      P.FirstEmptyFld = RunEdiVars.CFld;
      ZeroAllFlds();
      SetWasUpdated();
      NewRecExit();
    } else SetWasUpdated();
    P.NewDisplLL = true;
  }
  UnLockRec(CE());
  LockRec(false);
  DisplRecNr(CRec());
}

// PAS: RUNEDIT1.PAS WrEStatus
export function WrEStatus(): void {
  const P = RunEdiPriv;
  const E = CE();
  E.CFld = RunEdiVars.CFld;
  // FPC: field by field (BP7: Move over FirstEmptyFld..SelMode)
  E.FirstEmptyFld = P.FirstEmptyFld;
  E.VK = P.VK;
  E.WK = P.WK;
  E.BaseRec = P.BaseRec;
  E.IRec = P.IRec;
  E.IsNewRec = P.IsNewRec;
  E.Append = P.Append;
  E.Select = P.Select;
  E.WasUpdated = P.WasUpdated;
  E.EdRecVar = P.EdRecVar;
  E.AddSwitch = P.AddSwitch;
  E.ChkSwitch = P.ChkSwitch;
  E.WarnSwitch = P.WarnSwitch;
  E.SubSet = P.SubSet;
  E.NoDelTFlds = P.NoDelTFlds;
  E.WasWK = P.WasWK;
  E.NoDelete = P.NoDelete;
  E.VerifyDelete = P.VerifyDelete;
  E.NoCreate = P.NoCreate;
  E.F1Mode = P.F1Mode;
  E.OnlyAppend = P.OnlyAppend;
  E.OnlySearch = P.OnlySearch;
  E.Only1Record = P.Only1Record;
  E.OnlyTabs = P.OnlyTabs;
  E.NoESCPrompt = P.NoESCPrompt;
  E.MustESCPrompt = P.MustESCPrompt;
  E.Prompt158 = P.Prompt158;
  E.NoSrchMsg = P.NoSrchMsg;
  E.WithBoolDispl = P.WithBoolDispl;
  E.Mode24 = P.Mode24;
  E.NoCondCheck = P.NoCondCheck;
  E.F3LeadIn = P.F3LeadIn;
  E.LUpRDown = P.LUpRDown;
  E.MouseEnter = P.MouseEnter;
  E.TTExit = P.TTExit;
  E.MakeWorkX = P.MakeWorkX;
  E.NoShiftF7Msg = P.NoShiftF7Msg;
  E.MustAdd = P.MustAdd;
  E.MustCheck = P.MustCheck;
  E.SelMode = P.SelMode;
}
// PAS: RUNEDIT1.PAS RdEStatus
export function RdEStatus(): void {
  const P = RunEdiPriv;
  const E = CE();
  P.FirstEmptyFld = E.FirstEmptyFld;
  P.VK = E.VK;
  P.WK = E.WK;
  P.BaseRec = E.BaseRec;
  P.IRec = E.IRec;
  P.IsNewRec = E.IsNewRec;
  P.Append = E.Append;
  P.Select = E.Select;
  P.WasUpdated = E.WasUpdated;
  P.EdRecVar = E.EdRecVar;
  P.AddSwitch = E.AddSwitch;
  P.ChkSwitch = E.ChkSwitch;
  P.WarnSwitch = E.WarnSwitch;
  P.SubSet = E.SubSet;
  P.NoDelTFlds = E.NoDelTFlds;
  P.WasWK = E.WasWK;
  P.NoDelete = E.NoDelete;
  P.VerifyDelete = E.VerifyDelete;
  P.NoCreate = E.NoCreate;
  P.F1Mode = E.F1Mode;
  P.OnlyAppend = E.OnlyAppend;
  P.OnlySearch = E.OnlySearch;
  P.Only1Record = E.Only1Record;
  P.OnlyTabs = E.OnlyTabs;
  P.NoESCPrompt = E.NoESCPrompt;
  P.MustESCPrompt = E.MustESCPrompt;
  P.Prompt158 = E.Prompt158;
  P.NoSrchMsg = E.NoSrchMsg;
  P.WithBoolDispl = E.WithBoolDispl;
  P.Mode24 = E.Mode24;
  P.NoCondCheck = E.NoCondCheck;
  P.F3LeadIn = E.F3LeadIn;
  P.LUpRDown = E.LUpRDown;
  P.MouseEnter = E.MouseEnter;
  P.TTExit = E.TTExit;
  P.MakeWorkX = E.MakeWorkX;
  P.NoShiftF7Msg = E.NoShiftF7Msg;
  P.MustAdd = E.MustAdd;
  P.MustCheck = E.MustCheck;
  P.SelMode = E.SelMode;
  if (P.VK === null) P.OnlySearch = false;
  const av = AccessVars;
  av.CFile = E.FD;
  av.CRecPtr = E.NewRecPtr;
  RunEdiVars.CFld = E.CFld;
  P.HasIndex = av.CFile!.XF !== null;
  P.HasTF = av.CFile!.TF !== null;
  SetCPage();
}

// PAS: RUNEDIT1.PAS AssignFld – unit-internal
export function AssignFld(F: FieldDPtr, Z: FrmlPtr): void {
  SetWasUpdated();
  AssgnFrml(F, Z, false, false);
}
// PAS: RUNEDIT1.PAS DuplFld – unit-internal
export function DuplFld(FD1: FileDPtr, FD2: FileDPtr, RP1: Uint8Array | null, RP2: Uint8Array | null,
  RPt: Uint8Array | null, F1: FieldDPtr, F2: FieldDPtr): void {
  const av = AccessVars;
  const cf = av.CFile;
  const cr = av.CRecPtr;
  av.CFile = FD1;
  av.CRecPtr = RP1;
  switch (F1!.FrmlTyp) {
    case 'S':
      if (F1!.Typ === 'T') {
        const ss = _LongS(F1);
        av.CFile = FD2;
        av.CRecPtr = RP2;
        if (RPt === null) DelTFld(F2);
        else DelDifTFld(RP2!, RPt, F2);
        LongS_(F2, ss);
        ReleaseStore(ss);
      } else {
        const s = _ShortS(F1);
        av.CFile = FD2;
        av.CRecPtr = RP2;
        S_(F2, s);
      }
      break;
    case 'R': {
      const r = _R(F1);
      av.CFile = FD2;
      av.CRecPtr = RP2;
      R_(F2, r);
      break;
    }
    case 'B': {
      const b = _B(F1);
      av.CFile = FD2;
      av.CRecPtr = RP2;
      B_(F2, b);
      break;
    }
  }
  av.CFile = cf;
  av.CRecPtr = cr;
}

// PAS: RUNEDIT1.PAS TestMask – unit-internal
export function TestMask(S: Ref<string>, Mask: StringPtr, TypeN: boolean): boolean {
  if (Mask === null) return true;
  const M = (j: number): string => Mask.charAt(j - 1);
  let v = 0;
  let i = 0;
  let ii = 0;
  const ls = S.v.length;
  let j = 0;
  const lm = Mask.length;
  const setS = (k: number, c: string): void => {
    S.v = S.v.slice(0, k - 1) + c + S.v.slice(k);
  };
  let fail = false;
  for (;;) {
    // 1:
    if (j === lm) {
      while (i < ls) {
        i++;
        if (S.v[i - 1] !== ' ') {
          fail = true;
          break;
        }
      }
      break;
    }
    j++;
    let bad = false; // goto 3
    const mc = M(j);
    if (mc === ']' || mc === ')') v = 0;
    else if (mc === '[') {
      v = 1;
      ii = i;
    } else if (mc === '(') {
      v = 2;
      ii = i;
    } else if (mc === '|') {
      do j++;
      while (j < lm && M(j) !== ')');
    } else {
      if (i === ls) {
        fail = true;
        break;
      }
      i++;
      const c = S.v[i - 1];
      switch (mc) {
        case '#':
        case '9':
          if (!IsDigit(c)) bad = true;
          break;
        case '@':
          if (!IsLetter(c)) bad = true;
          break;
        case '?':
          break;
        case '$':
          if (!IsLetter(c)) bad = true;
          else setS(i, String.fromCharCode(BaseVars.UpcCharTab[c.charCodeAt(0)])); // goto 2
          break;
        case '!':
          setS(i, String.fromCharCode(BaseVars.UpcCharTab[c.charCodeAt(0)])); // 2:
          break;
        default:
          if (c !== mc) bad = true;
      }
    }
    if (!bad) continue; // goto 1
    // 3:
    if (v === 1) {
      do j++;
      while (j < lm && M(j) !== ']');
      v = 0;
      i = ii;
      continue;
    }
    if (v === 2) {
      do j++;
      while (j < lm && M(j) !== '|' && M(j) !== ')');
      i = ii;
      if (M(j) === '|') continue;
    }
    fail = true;
    break;
  }
  if (!fail) return true;
  // 4:
  SetMsgPar(Mask);
  WrLLF10Msg(653);
  return false;
}

// PAS: RUNEDIT1.PAS FieldEdit – unit-internal
export function FieldEdit(F: FieldDPtr, Impl: FrmlPtr, LWw: number, iPos: number, Txt: Ref<string>, RR: Ref<float>,
  del: boolean, upd: boolean, ret: boolean, Delta: number): number {
  const dv = DriversVars;
  const f = F!;
  const C999 = '999999999999999';
  const Col = WhereX();
  const Row = WhereY();
  if (f.Typ === 'B') {
    if (Txt.v === '') write(' ');
    else write(Txt.v);
    GotoXY(Col, Row);
    CrsNorm();
    let cc = '';
    for (;;) {
      // 0:
      GetEvent();
      const Event = dv.Event;
      let enter = false; // goto 11
      if (Event.What === evKeyDown) {
        dv.KbdChar = Event.KeyCode;
        ClrEvent();
        if (dv.KbdChar === _ESC_) {
          CrsHide();
          return 0; // Pascal: result undefined
        }
        if (dv.KbdChar === _M_) enter = true;
        else {
          cc = UpCaseCh(dv.KbdChar & 0xff);
          if (cc === BaseVars.AbbrYes || cc === BaseVars.AbbrNo) break; // goto 1
        }
      } else if (Event.What === evMouseDown) {
        if (MouseInRect(dv.WindMin.X + WhereX() - 1, dv.WindMin.Y + WhereY() - 1, 1, 1)) {
          ClrEvent();
          dv.KbdChar = _M_;
          enter = true;
        }
      }
      if (enter) {
        // 11:
        if (Txt.v.length > 0 && Txt.v[0] === BaseVars.AbbrYes) cc = BaseVars.AbbrYes;
        else cc = BaseVars.AbbrNo;
        break; // goto 1
      }
      ClrEvent();
    }
    // 1:
    write(cc);
    Txt.v = cc;
    CrsHide();
    return 0;
  }
  const L = f.L;
  const M = f.M;
  const Mask = FieldDMask(f);
  let Msk: StringPtr = null;
  if ((f.Flg & f_Mask) !== 0 && f.Typ === 'A') Msk = Mask;
  for (;;) {
    // 2:
    iPos = EditTxt(Txt, iPos, L, LWw, f.Typ, del, false, upd, f.FrmlTyp === 'S' && ret, Delta);
    if (iPos !== 0) return iPos;
    if (dv.KbdChar === _ESC_ || !upd) return iPos;
    del = true;
    iPos = 1;
    let r = 0;
    if (Txt.v.length === 0 && Impl !== null) {
      AssignFld(F, Impl);
      DecodeField(F, L, Txt);
    }
    let err = false; // goto 4
    switch (f.Typ) {
      case 'F':
      case 'R': {
        let T = LeadChar(' ', TrailChar(' ', Txt.v));
        const I = Pos(',', T);
        if (I > 0) T = Copy(T, 1, I - 1) + '.' + Copy(T, I + 1, 255);
        if (T.length === 0) r = 0.0;
        else {
          const rv = ref(0);
          const code = ref(0);
          ValR(T, rv, code);
          r = rv.v;
          if (f.Typ === 'F') {
            let N = L - 2 - M;
            if (M === 0) N++;
            if (code.v !== 0 || Math.abs(r) >= Power10[N]) {
              const s = Copy(C999, 1, N) + '.' + Copy(C999, 1, M);
              Set2MsgPar(s, s);
              WrLLF10Msg(617);
              err = true;
            }
          } else if (code.v !== 0) {
            WrLLF10Msg(639);
            err = true;
          }
        }
        if (err) break;
        if (f.Typ === 'F') {
          Txt.v = StrR(r, L, M);
          if ((f.Flg & f_Comma) !== 0) {
            r = r * Power10[M];
            if (r >= 0) r = r + 0.5;
            else r = r - 0.5;
            r = Int(r);
          }
        } else Txt.v = StrR(r, L);
        RR.v = r;
        break;
      }
      case 'A':
      case 'N': {
        const cc = f.Typ === 'A' ? ' ' : '0';
        // 3:
        if (M === LeftJust) while (Txt.v.length < L) Txt.v = Txt.v + cc;
        else while (Txt.v.length < L) Txt.v = cc + Txt.v;
        if (Msk !== null && !TestMask(Txt, Msk, true)) err = true;
        break;
      }
      case 'D': {
        const T = LeadChar(' ', TrailChar(' ', Txt.v));
        if (T === '') r = 0;
        else {
          r = ValDate(T, Mask!);
          if (r === 0 && T !== LeadChar(' ', TrailChar(' ', StrDate(r, Mask!)))) {
            SetMsgPar(Mask!);
            WrLLF10Msg(618);
            err = true;
            break;
          }
        }
        Txt.v = StrDate(r, Mask!);
        RR.v = r;
        break;
      }
    }
    if (!err) return 0; // FieldEdit = iPos (0)
    // 4:
    GotoXY(Col, Row);
  }
}
/** TS-only: System.UpCase of a byte char (ASCII only). */
function UpCaseCh(b: number): string {
  return b >= 0x61 && b <= 0x7a ? String.fromCharCode(b - 32) : String.fromCharCode(b);
}

// PAS: RUNEDIT1.PAS IsFirstEmptyFld – unit-internal
export function IsFirstEmptyFld(): boolean {
  return RunEdiPriv.IsNewRec && RunEdiVars.CFld === RunEdiPriv.FirstEmptyFld;
}
// PAS: RUNEDIT1.PAS FldRow – unit-internal
export function FldRow(D: EFldDPtr, I: number): number {
  const E = CE();
  return E.FrstRow + E.NHdTxt + (I - 1) * RunEdiPriv.RT!.N + D!.Ln - 1;
}
// PAS: RUNEDIT1.PAS SetFldAttr – unit-internal
export function SetFldAttr(D: EFldDPtr, I: number, Attr: number): void {
  ScrColor(D!.Col - 1, FldRow(D, I) - 1, D!.L, Attr);
}
// PAS: RUNEDIT1.PAS RecAttr – unit-internal
export function RecAttr(I: number): number {
  const P = RunEdiPriv;
  const E = CE();
  const b = I !== P.IRec || !P.IsNewRec;
  if (!P.IsNewRec && DeletedFlag()) return E.dDel;
  if (b && P.Select && RunBool(E.Bool)) return E.dSubSet;
  if (b && IsSelectedRec(I)) return E.dSelect;
  return E.dNorm;
}
// PAS: RUNEDIT1.PAS IVoff – unit-internal
export function IVoff(): void {
  SetFldAttr(RunEdiVars.CFld, RunEdiPriv.IRec, RecAttr(RunEdiPriv.IRec));
}
// PAS: RUNEDIT1.PAS IVon – unit-internal
export function IVon(): void {
  const CFld = RunEdiVars.CFld!;
  ScrColor(CFld.Col - 1, FldRow(CFld, RunEdiPriv.IRec) - 1, CFld.L, CE().dHiLi);
}

// PAS: RUNEDIT1.PAS HasTTWw – unit-internal
export function HasTTWw(F: FieldDPtr): boolean {
  return F!.Typ === 'T' && F!.L > 1 && !CE().IsUserForm;
}

// PAS: RUNEDIT1.PAS DisplFld – unit-internal
export function DisplFld(D: EFldDPtr, I: number): void {
  const E = CE();
  // PAS: RUNEDIT1.PAS DisplFld.Wr1Line
  const Wr1Line = (F: FieldDPtr): void => {
    const s = CopyLine(_LongS(F), 1, 1);
    const max = F!.L - 2;
    let l = s.length;
    if (l > 255) l = 255;
    let Txt = String.fromCharCode(...s.subarray(0, l));
    l = LenStyleStr(Txt);
    if (l > max) {
      l = max;
      Txt = Txt.slice(0, LogToAbsLenStyleStr(Txt, l));
    }
    WrStyleStr(Txt, E.dNorm);
    ReleaseStore(s);
    DriversVars.TextAttr = E.dNorm;
    if (l < max) write(' '.repeat(max - l));
  };
  const d = D!;
  const r = FldRow(D, I);
  GotoXY(d.Col, r);
  const F = d.FldD;
  const Txt = ref('');
  DecodeField(F, d.L, Txt);
  let t = '';
  for (let j = 0; j < Txt.v.length; j++) {
    const c = Txt.v.charCodeAt(j);
    t += c < 0x20 ? String.fromCharCode(c + 0x40) : Txt.v[j];
  }
  write(t);
  if (HasTTWw(F)) {
    GotoXY(d.Col + 2, r);
    Wr1Line(F);
  }
}

// PAS: RUNEDIT1.PAS DisplEmptyFld – unit-internal
export function DisplEmptyFld(D: EFldDPtr, I: number): void {
  const d = D!;
  GotoXY(d.Col, FldRow(D, I));
  const c = (d.FldD!.Flg & f_Stored) !== 0 ? '.' : ' ';
  write(c.repeat(d.L));
  if (HasTTWw(d.FldD)) write(' '.repeat(Math.max(1, d.FldD!.L - 1)));
}
// PAS: RUNEDIT1.PAS SetRecAttr – unit-internal
export function SetRecAttr(I: number): void {
  const TA = RecAttr(I);
  let D = CE().FirstFld;
  while (D !== null) {
    if (D.Page === RunEdiPriv.CPage) SetFldAttr(D, I, TA);
    D = D.Chain;
  }
}
// PAS: RUNEDIT1.PAS DisplRec – unit-internal
export function DisplRec(I: number): void {
  const P = RunEdiPriv;
  const E = CE();
  const av = AccessVars;
  let a = E.dNorm;
  const N = P.BaseRec + I - 1;
  const IsCurrNewRec = P.IsNewRec && I === P.IRec;
  const p = GetRecSpace();
  let NewFlds: boolean;
  if (N > CNRecs() && !IsCurrNewRec) NewFlds = true; // goto 1
  else {
    if (I === P.IRec) av.CRecPtr = E.NewRecPtr;
    else {
      av.CRecPtr = p;
      RdRec(N);
    }
    NewFlds = false;
    if (!P.IsNewRec) a = RecAttr(I);
  }
  // 1:
  let D = E.FirstFld;
  while (D !== null) {
    if (IsCurrNewRec && D === P.FirstEmptyFld && D.Impl === null) NewFlds = true;
    DriversVars.TextAttr = a;
    if (D.Page === P.CPage) {
      if (NewFlds) DisplEmptyFld(D, I);
      else DisplFld(D, I);
    }
    if (IsCurrNewRec && D === P.FirstEmptyFld) NewFlds = true;
    D = D.Chain;
  }
  ClearRecSpace(p);
  ReleaseStore(p);
  av.CRecPtr = E.NewRecPtr;
}
// PAS: RUNEDIT1.PAS DisplTabDupl – unit-internal
export function DisplTabDupl(): void {
  const E = CE();
  let D = E.FirstFld;
  DriversVars.TextAttr = E.dTab;
  while (D !== null) {
    if (D.Page === RunEdiPriv.CPage) {
      GotoXY(D.Col + D.L, FldRow(D, 1));
      if (D.Tab) {
        if (D.Dupl) write('\x1f');
        else write('\x11');
      } else if (D.Dupl) write('\x19');
      else write(' ');
    }
    D = D.Chain;
  }
}

// PAS: RUNEDIT1.PAS DisplRecNr – unit-internal
export function DisplRecNr(N: number): void {
  const E = CE();
  if (E.RecNrLen > 0) {
    GotoXY(E.RecNrPos, 1);
    DriversVars.TextAttr = BaseVars.Colors.fNorm;
    write(StrI(N, E.RecNrLen));
  }
}
// PAS: RUNEDIT1.PAS DisplSysLine – unit-internal
export function DisplSysLine(): void {
  const E = CE();
  const s = E.Head ?? '';
  if (s === '') return;
  GotoXY(1, 1);
  DriversVars.TextAttr = BaseVars.Colors.fNorm;
  ClrEol();
  let i = 1;
  let x = '';
  while (i <= s.length) {
    if (s[i - 1] === '_') {
      let m = '';
      let point = false;
      while (i <= s.length && (s[i - 1] === '_' || s[i - 1] === '.')) {
        if (s[i - 1] === '.') point = true;
        m = m + s[i - 1];
        i++;
      }
      if (point) {
        if (m === '__.__.__') x = x + StrDate(Today(), 'DD.MM.YY');
        else if (m === '__.__.____') x = x + StrDate(Today(), 'DD.MM.YYYY');
        else x = x + m;
      } else if (m.length === 1) x = x + m;
      else {
        E.RecNrLen = m.length;
        E.RecNrPos = i - m.length;
        x = x + ' '.repeat(m.length);
      }
    } else {
      x = x + s[i - 1];
      i++;
    }
  }
  x = x.slice(0, 255);
  if (x.length > BaseVars.TxtCols) x = x.slice(0, BaseVars.TxtCols);
  write(x);
  DisplRecNr(CRec());
}
// PAS: RUNEDIT1.PAS DisplBool – unit-internal
export function DisplBool(): void {
  const P = RunEdiPriv;
  if (!P.WithBoolDispl) return;
  const E = CE();
  GotoXY(1, 2);
  DriversVars.TextAttr = E.dSubSet;
  ClrEol();
  if (P.Select) {
    let s = E.BoolTxt ?? '';
    if (s.length > BaseVars.TxtCols) s = s.slice(0, BaseVars.TxtCols);
    GotoXY(((BaseVars.TxtCols - s.length) >> 1) + 1, 2);
    write(s);
  }
}
// PAS: RUNEDIT1.PAS DisplAllWwRecs – unit-internal
export function DisplAllWwRecs(): void {
  const P = RunEdiPriv;
  const n = CE().NRecs;
  let md: LockMode = NullMode;
  if (n > 1 && !P.EdRecVar) md = NewLMode(RdMode);
  AdjustCRec();
  if (!P.IsNewRec && !P.WasUpdated) RdRec(CRec());
  for (let i = 1; i <= n; i++) DisplRec(i);
  IVon();
  if (n > 1 && !P.EdRecVar) OldLMode(md);
}
// PAS: RUNEDIT1.PAS SetNewWwRecAttr – unit-internal
export function SetNewWwRecAttr(): void {
  const P = RunEdiPriv;
  const av = AccessVars;
  const E = CE();
  av.CRecPtr = GetRecSpace();
  for (let I = 1; I <= E.NRecs; I++) {
    if (P.BaseRec + I - 1 > CNRecs()) break; // goto 1
    if (!P.IsNewRec || I !== P.IRec) {
      RdRec(P.BaseRec + I - 1);
      SetRecAttr(I);
    }
  }
  // 1:
  IVon();
  ClearRecSpace(av.CRecPtr!);
  ReleaseStore(av.CRecPtr);
  av.CRecPtr = E.NewRecPtr;
}

// PAS: RUNEDIT1.PAS MoveDispl – unit-internal
export function MoveDispl(From: number, Where: number, Number: number): void {
  for (let i = 1; i <= Number; i++) {
    let D = CE().FirstFld;
    while (D !== null) {
      const r1 = FldRow(D, From) - 1;
      const r2 = FldRow(D, Where) - 1;
      ScrMove(D.Col - 1, r1, D.Col - 1, r2, D.L);
      if (HasTTWw(D.FldD)) ScrMove(D.Col + 1, r1, D.Col + 1, r2, D.FldD!.L - 2);
      D = D.Chain;
    }
    if (From < Where) {
      From--;
      Where--;
    } else {
      From++;
      Where++;
    }
  }
}

// PAS: RUNEDIT1.PAS SetNewCRec
export function SetNewCRec(N: number, withRead: boolean): void {
  const P = RunEdiPriv;
  const Max = CE().NRecs;
  const I = N - P.BaseRec + 1;
  if (I > Max) {
    P.BaseRec += I - Max;
    P.IRec = Max;
  } else if (I <= 0) {
    P.BaseRec -= Math.abs(I) + 1;
    P.IRec = 1;
  } else P.IRec = I;
  if (withRead) RdRec(CRec());
}

// PAS: RUNEDIT1.PAS WriteSL – unit-internal
export function WriteSL(SL: StringList): void {
  const E = CE();
  while (SL !== null) {
    const Row = WhereY();
    WrStyleStr(SL.S, E.Attr);
    GotoXY(E.FrstCol, Row + 1);
    SL = SL.Chain;
  }
}
// PAS: RUNEDIT1.PAS DisplRecTxt – unit-internal
export function DisplRecTxt(): void {
  const E = CE();
  GotoXY(E.FrstCol, E.FrstRow + E.NHdTxt);
  for (let i = 1; i <= E.NRecs; i++) WriteSL(RunEdiPriv.RT!.SL);
}

// PAS: RUNEDIT1.PAS DisplEditWw
export function DisplEditWw(): void {
  const E = CE();
  const dv = DriversVars;
  const Colors = BaseVars.Colors;
  const V = E.V;
  if (E.ShdwY === 1) ScrColor(V.C1 + 1, V.R2, V.C2 - V.C1 + E.ShdwX - 1, Colors.ShadowAttr);
  if (E.ShdwX > 0) for (let i = V.R1; i <= V.R2; i++) ScrColor(V.C2, i, E.ShdwX, Colors.ShadowAttr);
  Window(V.C1, V.R1, V.C2, V.R2);
  dv.TextAttr = E.Attr;
  ClrScr();
  WriteWFrame(E.WFlags, E.Top ?? '', '');
  Window(1, 1, BaseVars.TxtCols, BaseVars.TxtRows);
  DisplSysLine();
  DisplBool();
  GotoXY(E.FrstCol, E.FrstRow);
  WriteSL(E.HdTxt);
  DisplRecTxt();
  DisplTabDupl();
  RunEdiPriv.NewDisplLL = true;
  DisplAllWwRecs();
}
// PAS: RUNEDIT1.PAS DisplWwRecsOrPage – unit-internal
export function DisplWwRecsOrPage(): void {
  const P = RunEdiPriv;
  const E = CE();
  const dv = DriversVars;
  if (P.CPage !== RunEdiVars.CFld!.Page) {
    SetCPage();
    dv.TextAttr = E.Attr;
    const min = { X: dv.WindMin.X, Y: dv.WindMin.Y };
    const max = { X: dv.WindMax.X, Y: dv.WindMax.Y };
    Window(E.FrstCol, E.FrstRow + E.NHdTxt, E.LastCol, E.FrstRow + E.Rows - 1);
    ClrScr();
    dv.WindMin.X = min.X;
    dv.WindMin.Y = min.Y;
    dv.WindMax.X = max.X;
    dv.WindMax.Y = max.Y;
    DisplRecTxt();
    DisplTabDupl();
  }
  DisplAllWwRecs();
  DisplRecNr(CRec());
}

// PAS: RUNEDIT1.PAS DuplOwnerKey – unit-internal
export function DuplOwnerKey(): void {
  const E = CE();
  if (!E.DownSet || E.OwnerTyp === 'i') return;
  let KF = E.DownLD!.ToKey!.KFlds;
  let Arg = E.DownLD!.Args;
  while (Arg !== null) {
    DuplFld(E.DownLD!.ToFD, AccessVars.CFile, E.DownRecPtr, E.NewRecPtr, E.OldRecPtr, KF!.FldD, Arg.FldD);
    Arg = Arg.Chain;
    KF = KF!.Chain;
  }
}
// PAS: RUNEDIT1.PAS CheckOwner – unit-internal
export function CheckOwner(E: EditDPtr): boolean {
  const e = E!;
  const av = AccessVars;
  let result = true;
  if (e.DownSet && e.OwnerTyp !== 'i') {
    const X = new XString();
    const X1 = new XString();
    X.PackKF(e.DownKey!.KFlds);
    av.CFile = e.DownLD!.ToFD;
    av.CRecPtr = e.DownRecPtr;
    X1.PackKF(e.DownLD!.ToKey!.KFlds);
    X.S = X.S.slice(0, MinW(X.S.length, X1.S.length));
    if (X.S !== X1.S) result = false;
    av.CFile = e.FD;
    av.CRecPtr = e.NewRecPtr;
  }
  return result;
}
// PAS: RUNEDIT1.PAS CheckKeyIn – unit-internal
export function CheckKeyIn(E: EditDPtr): boolean {
  const e = E!;
  let k = e.KIRoot;
  if (k === null) return true;
  const X = new XString();
  X.PackKF(e.VK!.KFlds);
  while (k !== null) {
    const p1 = k.X1 ?? '';
    let p2 = k.X2;
    if (p2 === null) p2 = p1;
    if (p1 <= X.S && X.S <= (p2 + '\xff').slice(0, 255)) return true;
    k = k.Chain;
  }
  return false;
}
// PAS: RUNEDIT1.PAS TestDuplKey – unit-internal
export function TestDuplKey(K: KeyDPtr): boolean {
  const x = new XString();
  const N = ref(0);
  x.PackKF(K!.KFlds);
  return K!.Search(x, false, N) && (RunEdiPriv.IsNewRec || CE().LockedRec !== N.v);
}
// PAS: RUNEDIT1.PAS DuplKeyMsg – unit-internal
export function DuplKeyMsg(K: KeyDPtr): void {
  SetMsgPar(K!.Alias ?? '');
  WrLLF10Msg(820);
}

// PAS: RUNEDIT1.PAS BuildWork – unit-internal
export function BuildWork(): void {
  const P = RunEdiPriv;
  const E = CE();
  const av = AccessVars;
  let K: KeyDPtr = null;
  let KF = null as KeyFldDPtr;
  if (av.CFile!.Keys !== null) KF = av.CFile!.Keys.KFlds;
  let dupl = true;
  let intvl = false;
  if (P.HasIndex) {
    K = P.VK;
    KF = K!.KFlds;
    dupl = K!.Duplic;
    intvl = K!.Intervaltest;
  }
  P.WK!.Open(KF, dupl, intvl);
  if (P.OnlyAppend) return;
  const bool = E.Cond;
  const ki = E.KIRoot;
  let wk2: WKeyDPtr = null;
  const p = ref<Pointer>(null);
  MarkStore(p);
  let ok = false; // (FandSQL: f, l - key-only field list of SQL files)
  const er = new ExitRecord();
  NewExit(null, er);
  try {
    let Scan: XScanPtr;
    if (E.DownSet) {
      Scan = new XScan().Init(av.CFile, E.DownKey, null, false);
      if (E.OwnerTyp === 'i') Scan.ResetOwnerIndex(E.DownLD, E.DownLV, bool);
      else {
        av.CFile = E.DownLD!.ToFD;
        av.CRecPtr = E.DownRecPtr;
        const xx = new XString();
        xx.PackKF(E.DownLD!.ToKey!.KFlds);
        av.CFile = E.FD;
        av.CRecPtr = E.NewRecPtr;
        Scan.ResetOwner(xx, bool);
      }
      if (ki !== null) {
        wk2 = new XWKey();
        wk2.Open(KF, true, false);
        CreateWIndex(Scan, wk2, 'W');
        const Scan2 = new XScan().Init(av.CFile, wk2, ki, false);
        Scan2.Reset(null, false);
        Scan = Scan2;
      }
    } else {
      if (bool !== null) if (K !== null && !K.InWork && ki === null) K = null;
      Scan = new XScan().Init(av.CFile, K, ki, false);
      Scan.Reset(bool, E.SQLFilter);
    }
    CreateWIndex(Scan, P.WK, 'W');
    Scan.Close();
    if (wk2 !== null) wk2.Close();
    ok = true;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) {
      RestoreExit(er);
      throw e;
    }
  }
  // 1:
  RestoreExit(er);
  if (!ok) GoExit();
  ReleaseStore(p.v);
}

// PAS: RUNEDIT1.PAS SetStartRec – unit-internal
export function SetStartRec(): void {
  const P = RunEdiPriv;
  const E = CE();
  let k: KeyDPtr = P.VK;
  if (P.SubSet) k = P.WK;
  let kf = null as KeyFldDPtr;
  if (k !== null) kf = k.KFlds;
  const n = ref(0);
  let set = false; // goto 1
  if (E.StartRecKey !== null && k !== null) {
    const x = new XString();
    x.S = E.StartRecKey;
    if (k.FindNr(x, n)) set = true;
  } else if (E.StartRecNo > 0) {
    n.v = LogRecNo(E.StartRecNo);
    set = true;
  }
  if (set) {
    // 1:
    n.v = MaxL(1, MinL(n.v, CNRecs()));
    P.IRec = MaxW(1, MinW(E.StartIRec, E.NRecs));
    P.BaseRec = n.v - P.IRec + 1;
    if (P.BaseRec <= 0) {
      P.IRec += P.BaseRec - 1;
      P.BaseRec = 1;
    }
  }
  if (P.Only1Record) {
    let nn: number;
    if (CNRecs() > 0) {
      RdRec(CRec());
      nn = AbsRecNr(CRec());
    } else nn = 0;
    if (P.SubSet) P.WK!.Close();
    P.SubSet = true;
    if (nn === 0) P.WK!.Open(null, true, false);
    else P.WK!.OneRecIdx(kf, nn);
    P.BaseRec = 1;
    P.IRec = 1;
  }
}

// PAS: RUNEDIT1.PAS OpenEditWw
export function OpenEditWw(): boolean {
  const P = RunEdiPriv;
  const av = AccessVars;
  let E = CE();
  av.CFile = E.Journal;
  if (av.CFile !== null) OpenCreateF(Shared);
  RdEStatus();
  E = CE();
  let lbl = 0;
  let md2: LockMode = NullMode;
  if (P.EdRecVar) lbl = P.OnlyAppend ? 2 : 3;
  if (lbl === 0) {
    OpenCreateF(Shared);
    E.OldMd = E.FD!.LMode;
    P.UpdCount = 0;
    const cf = av.CFile!;
    if (P.HasIndex) TestXFExist();
    let md: LockMode = NoDelMode;
    if (P.OnlyAppend || E.Cond !== null || E.KIRoot !== null || E.DownSet ||
      (P.MakeWorkX && P.HasIndex && cf.NotCached() && !P.Only1Record)) {
      P.SubSet = true;
      if (P.HasIndex) md = NoExclMode;
      else md = NoCrMode;
    } else if (P.VK !== null && P.VK.InWork) md = NoExclMode;
    if (P.SubSet || P.Only1Record) P.WK = new XWKey();
    const md1 = ref<LockMode>(NullMode);
    if (!TryLMode(md, md1, 1)) {
      av.EdBreak = 15;
      lbl = 1;
    } else {
      md2 = NewLMode(RdMode);
      if (E.DownSet && E.OwnerTyp === 'F') {
        av.CFile = E.DownLD!.ToFD;
        av.CRecPtr = E.DownRecPtr;
        const mdo = NewLMode(RdMode);
        const n = E.OwnerRecNo;
        if (n === 0 || n > av.CFile!.NRecs) RunErrorM(E.OldMd, 611);
        ReadRec(n);
        OldLMode(mdo);
        av.CFile = E.FD;
        av.CRecPtr = E.NewRecPtr;
      }
      if (P.SubSet) BuildWork();
      if (!P.Only1Record && P.HasIndex && P.VK!.InWork) {
        if (!P.SubSet) P.WK = P.VK as XWKey;
        P.VK = av.CFile!.Keys;
        P.WasWK = true;
        P.SubSet = true;
      }
      if (!P.OnlyAppend) SetStartRec();
      if (CNRecs() === 0) {
        if (P.NoCreate) {
          if (P.SubSet) CFileMsg(107, '0');
          else CFileMsg(115, '0');
          av.EdBreak = 13;
          lbl = 1;
        } else lbl = 2;
      } else {
        RdRec(CRec());
        lbl = 3;
      }
    }
  }
  if (lbl === 1) {
    if (P.SubSet && !P.WasWK) P.WK!.Close();
    OldLMode(E.OldMd);
    return false;
  }
  if (lbl === 2) {
    P.IsNewRec = true;
    P.Append = true;
    LockRec(false);
    ZeroAllFlds();
    DuplOwnerKey();
    SetWasUpdated();
  }
  // 3:
  const m = ref<Pointer>(null);
  MarkStore(m);
  E.AfterE = m.v;
  DisplEditWw();
  if (!P.EdRecVar) OldLMode(md2);
  if (P.IsNewRec) NewRecExit();
  return true;
}

// PAS: RUNEDIT1.PAS RefreshSubset – unit-internal
export function RefreshSubset(): void {
  const P = RunEdiPriv;
  const md = NewLMode(RdMode);
  if (P.SubSet && !(P.OnlyAppend || P.Only1Record || P.WasWK)) {
    P.WK!.Close();
    BuildWork();
  }
  DisplAllWwRecs();
  OldLMode(md);
}

// PAS: RUNEDIT1.PAS GotoRecFld
export function GotoRecFld(NewRec: number, NewFld: EFldDPtr): void {
  const P = RunEdiPriv;
  IVoff();
  RunEdiVars.CFld = NewFld;
  if (NewRec === CRec()) {
    if (P.CPage !== RunEdiVars.CFld!.Page) DisplWwRecsOrPage();
    else IVon();
    return;
  }
  let md: LockMode = NullMode;
  if (!P.EdRecVar) md = NewLMode(RdMode);
  if (NewRec > CNRecs()) NewRec = CNRecs();
  if (NewRec <= 0) NewRec = 1;
  if (P.Select) SetRecAttr(P.IRec);
  RunEdiVars.CFld = NewFld;
  const Max = CE().NRecs;
  const Delta = NewRec - CRec();
  const NewIRec = P.IRec + Delta;
  let redisplayed = false;
  if (NewIRec > 0 && NewIRec <= Max) {
    P.IRec = NewIRec;
    RdRec(CRec());
  } else {
    let NewBase = P.BaseRec + Delta;
    if (NewBase + Max - 1 > CNRecs()) NewBase = CNRecs() - (Max - 1);
    if (NewBase <= 0) NewBase = 1;
    P.IRec = NewRec - NewBase + 1;
    let D = NewBase - P.BaseRec;
    P.BaseRec = NewBase;
    RdRec(CRec());
    if (Math.abs(D) >= Max) {
      DisplWwRecsOrPage();
      redisplayed = true; // goto 2
    } else if (D > 0) {
      MoveDispl(D + 1, 1, Max - D);
      for (let i = Max - D + 1; i <= Max; i++) DisplRec(i);
    } else {
      D = -D;
      MoveDispl(Max - D, Max, Max - D);
      for (let i = 1; i <= D; i++) DisplRec(i);
    }
  }
  if (!redisplayed) {
    // 1:
    DisplRecNr(CRec());
    IVon();
  }
  // 2:
  if (!P.EdRecVar) OldLMode(md);
}

// PAS: RUNEDIT1.PAS UpdMemberRef – unit-internal
export function UpdMemberRef(POld: Uint8Array | null, PNew: Uint8Array | null): void {
  const av = AccessVars;
  const cf = av.CFile;
  const cr = av.CRecPtr;
  let LD = av.LinkDRoot;
  while (LD !== null) {
    if (LD.MemberRef !== 0 && LD.ToFD === cf && (PNew !== null || LD.MemberRef !== 2)) {
      av.CFile = cf;
      const kf2 = LD.ToKey!.KFlds;
      av.CRecPtr = POld;
      const xold = new XString();
      xold.PackKF(kf2);
      let same = false;
      if (PNew !== null) {
        av.CRecPtr = PNew;
        const xnew = new XString();
        xnew.PackKF(kf2);
        if (xnew.S === xold.S) same = true; // goto 2
      }
      if (!same) {
        av.CFile = LD.FromFD;
        const k = GetFromKey(LD);
        const kf1 = k!.KFlds;
        const p = GetRecSpace();
        av.CRecPtr = p;
        let p2: Uint8Array | null = null;
        if (PNew !== null) p2 = GetRecSpace();
        const Scan = new XScan().Init(av.CFile, k, null, true);
        Scan.ResetOwner(xold, null);
        ScanSubstWIndex(Scan, kf1, 'W');
        for (;;) {
          // 1:
          av.CRecPtr = p;
          Scan.GetRec();
          if (Scan.EOF) break;
          if (PNew === null) {
            RunAddUpdte1('-', null, false, null, LD);
            UpdMemberRef(p, null);
            DeleteXRec(Scan.RecNr, true);
          } else {
            Move(av.CRecPtr!, p2!, av.CFile!.RecLen);
            av.CRecPtr = p2;
            let kf = kf2;
            let Arg = LD.Args;
            while (kf !== null) {
              DuplFld(cf, av.CFile, PNew, p2, null, kf.FldD, Arg!.FldD);
              Arg = Arg!.Chain;
              kf = kf.Chain;
            }
            RunAddUpdte1('d', p, false, null, LD);
            UpdMemberRef(p, p2);
            OverwrXRec(Scan.RecNr, p, p2!);
          }
        }
        Scan.Close();
        ClearRecSpace(p);
        ReleaseStore(p);
      }
    }
    // 2:
    LD = LD.Chain;
  }
  av.CFile = cf;
  av.CRecPtr = cr;
}

// PAS: RUNEDIT1.PAS WrJournal – unit-internal
export function WrJournal(Upd: string, RP: Uint8Array | null, Time: float): void {
  const P = RunEdiPriv;
  const E = CE();
  const av = AccessVars;
  if (E.Journal !== null) {
    let l = av.CFile!.RecLen;
    const n = AbsRecNr(CRec());
    let rp = RP!;
    if (av.CFile!.XF !== null) {
      rp = rp.subarray(1);
      l--;
    }
    av.CFile = E.Journal;
    av.CRecPtr = GetRecSpace();
    let F = av.CFile.FldD;
    S_(F, Upd);
    F = F!.Chain;
    R_(F, Int(n));
    F = F!.Chain;
    R_(F, Int(av.UserCode));
    F = F!.Chain;
    R_(F, Time);
    F = F!.Chain;
    const cr = av.CRecPtr;
    const cnt = Math.min(l, cr.length - F!.Displ); // TS: never beyond the journal record
    Move(rp, cr, cnt, 0, F!.Displ);
    const md = NewLMode(CrMode);
    IncNRecs(1);
    WriteRec(av.CFile.NRecs);
    OldLMode(md);
    ReleaseStore(av.CRecPtr);
    av.CFile = E.FD;
    av.CRecPtr = E.NewRecPtr;
  }
  // 1:
  P.UpdCount = (P.UpdCount + 1) & 0xffff;
  if (P.UpdCount === E.SaveAfter) {
    SaveFiles();
    P.UpdCount = 0;
  }
}

// PAS: RUNEDIT1.PAS LockForMemb – unit-internal
export function LockForMemb(FD: FileDPtr, Kind: number, NewMd: LockMode, md: Ref<LockMode>): boolean {
  const av = AccessVars;
  let ld = av.LinkDRoot;
  while (ld !== null) {
    if (ld.ToFD === FD && ((NewMd !== DelMode && ld.MemberRef !== 0) || ld.MemberRef === 1) && ld.FromFD !== FD) {
      av.CFile = ld.FromFD;
      const cf = av.CFile!;
      switch (Kind) {
        case 0:
          cf.TaLMode = cf.LMode;
          break;
        case 1: {
          md.v = NewMd;
          const md1 = ref<LockMode>(NullMode);
          if (!TryLMode(NewMd, md1, 2)) return false;
          break;
        }
        case 2:
          OldLMode(cf.TaLMode);
          break;
      }
      if (!LockForAdd(av.CFile, Kind, true, md)) return false;
      if (!LockForMemb(ld.FromFD, Kind, NewMd, md)) return false;
    }
    ld = ld.Chain;
  }
  return true;
}
// PAS: RUNEDIT1.PAS LockWithDep – unit-internal
export function LockWithDep(CfMd: LockMode, MembMd: LockMode, OldMd: Ref<LockMode>): boolean {
  if (RunEdiPriv.EdRecVar) return true;
  const av = AccessVars;
  const cf = av.CFile;
  let cf2: FileDPtr = null;
  let w = 0;
  let result = true;
  const md = ref<LockMode>(NullMode);
  LockForAdd(cf, 0, true, md);
  LockForMemb(cf, 0, MembMd, md);
  for (;;) {
    // 1:
    av.CFile = cf;
    let fail = 0;
    if (!TryLMode(CfMd, OldMd, 1)) {
      md.v = CfMd;
      fail = 3;
    } else if (!LockForAdd(cf, 1, true, md)) {
      cf2 = av.CFile;
      fail = 2;
    } else if (MembMd !== NullMode && !LockForMemb(cf, 1, MembMd, md)) {
      cf2 = av.CFile;
      LockForMemb(cf, 2, MembMd, md);
      fail = 2;
    }
    if (fail === 0) break; // goto 4
    if (fail === 2) {
      // 2:
      LockForAdd(cf, 2, true, md);
      av.CFile = cf;
      OldLMode(OldMd.v);
      av.CFile = cf2;
    }
    // 3:
    SetCPathVol();
    Set2MsgPar(BaseVars.CPath, LockModeTxt[md.v]);
    const w1 = PushWrLLMsg(825, true);
    if (w === 0) w = w1;
    else av.TWork.Delete(w1);
    LockBeep();
    if (KbdTimer(BaseVars.Spec.NetDelay, 1)) continue;
    result = false;
    break;
  }
  // 4:
  av.CFile = cf;
  if (w !== 0) PopW(w);
  return result;
}
// PAS: RUNEDIT1.PAS UnLockWithDep – unit-internal
export function UnLockWithDep(OldMd: LockMode): void {
  if (RunEdiPriv.EdRecVar) return;
  const av = AccessVars;
  const cf = av.CFile;
  const md = ref<LockMode>(NullMode);
  OldLMode(OldMd);
  LockForAdd(cf, 2, true, md);
  LockForMemb(cf, 2, md.v, md);
  av.CFile = cf;
}

// PAS: RUNEDIT1.PAS DeleteRecProc – unit-internal
export function DeleteRecProc(): boolean {
  const P = RunEdiPriv;
  const av = AccessVars;
  const E = CE();
  // PAS: RUNEDIT1.PAS DeleteRecProc.CleanUp
  const CleanUp = (): boolean => {
    if (P.HasIndex && DeletedFlag()) return false;
    let X = E.ExD;
    while (X !== null) {
      if (X.AtWrRec) {
        av.EdBreak = 17;
        const ok = av.EdOk;
        av.EdOk = true;
        av.LastTxtPos = -1;
        if (!StartExit(X, false) || !av.EdOk) {
          av.EdOk = ok;
          return false;
        }
        av.EdOk = ok;
        P.WasUpdated = false;
      }
      X = X.Chain;
    }
    if (P.AddSwitch) {
      let ld = av.LinkDRoot;
      while (ld !== null) {
        if (ld.MemberRef === 2 && ld.ToFD === av.CFile && Owned(null, null, ld) > 0) {
          WrLLF10Msg(662);
          return false;
        }
        ld = ld.Chain;
      }
      if (!RunAddUpdte1('-', null, false, null, null)) return false;
      UpdMemberRef(av.CRecPtr, null);
    }
    if (!ChptDel()) return false;
    WrJournal('-', av.CRecPtr, Today() + CurrTime());
    return true;
  };
  // PAS: RUNEDIT1.PAS DeleteRecProc.DelIndRec
  const DelIndRec = (I: number, N: number): boolean => {
    if (CleanUp()) {
      DeleteXRec(N, true);
      if (E.SelKey !== null && E.SelKey.Delete(N)) E.SelKey.NR--;
      if (P.SubSet) P.WK!.DeleteAtNr(I);
      E.EdUpdated = true;
      return true;
    }
    return false;
  };
  let Group = false;
  if (P.Select) {
    BaseVars.F10SpecKey = _ESC_;
    Group = PromptYN(116);
    if (DriversVars.KbdChar === _ESC_) return false;
  }
  if (!Group) if (P.VerifyDelete && !PromptYN(109)) return false;
  const OldMd = ref<LockMode>(NullMode);
  if (!LockWithDep(DelMode, DelMode, OldMd)) return false;
  UndoRecord();
  let N = AbsRecNr(CRec());
  RdRec(CRec());
  const oIRec = P.IRec;
  const oBaseRec = P.BaseRec;
  if (P.HasIndex) {
    TestXFExist();
    if (Group) {
      P.IRec = 1;
      P.BaseRec = 1;
      while (P.BaseRec <= CNRecs()) {
        N = AbsRecNr(P.BaseRec);
        ClearDeletedFlag(); // prevent err msg 148
        if (!ELockRec(E, N, false, P.SubSet)) break; // goto 1
        RdRec(P.BaseRec);
        let b: boolean;
        if (RunBool(E.Bool)) b = DelIndRec(P.BaseRec, N);
        else {
          b = true;
          P.BaseRec++;
        }
        UnLockRec(E);
        if (!b) break;
      }
      // 1:
    } else if (ELockRec(E, N, false, P.SubSet)) {
      DelIndRec(CRec(), N);
      UnLockRec(E);
    }
  } else if (Group) {
    let J = 0;
    let fail = false;
    P.BaseRec = 1;
    P.IRec = 1;
    E.EdUpdated = true;
    const cf = av.CFile!;
    const n = cf.NRecs;
    for (let I = 1; I <= n; I++) {
      ReadRec(I);
      let keep = fail; // goto 2
      if (!keep) {
        if (P.SubSet) {
          const WK = P.WK!;
          if (P.BaseRec > WK.NRecs() || WK.NrToRecNr(P.BaseRec) !== J + 1) keep = true;
        } else P.BaseRec = I;
      }
      if (!keep) {
        if (RunBool(E.Bool)) {
          if (!CleanUp()) {
            fail = true;
            keep = true;
          } else {
            if (P.SubSet) {
              P.WK!.DeleteAtNr(P.BaseRec);
              P.WK!.AddToRecNr(J + 1, -1);
            }
            DelAllDifTFlds(av.CRecPtr!, null);
          }
        } else {
          if (P.SubSet) P.BaseRec++;
          keep = true;
        }
      }
      if (keep) {
        // 2:
        J++;
        WriteRec(J);
      }
    }
    DecNRecs(cf.NRecs - J);
  } else if (CleanUp()) {
    E.EdUpdated = true;
    if (P.SubSet) {
      P.WK!.DeleteAtNr(CRec());
      P.WK!.AddToRecNr(N, -1);
    }
    DeleteRec(N);
  }
  RunEdiVars.CFld = E.FirstFld;
  P.IRec = oIRec;
  P.BaseRec = oBaseRec;
  ClearDeletedFlag();
  AdjustCRec();
  if (P.IsNewRec) DuplOwnerKey();
  else RdRec(CRec());
  DisplWwRecsOrPage();
  UnLockWithDep(OldMd.v);
  return true;
}

// PAS: RUNEDIT1.PAS WriteCRec – unit-internal
export function WriteCRec(MayDispl: boolean, Displ: Ref<boolean>): boolean {
  const P = RunEdiPriv;
  const av = AccessVars;
  const E = CE();
  // PAS: RUNEDIT1.PAS WriteCRec.ExitCheck
  const ExitCheck = (): boolean => {
    let X = E.ExD;
    while (X !== null) {
      if (X.AtWrRec) {
        av.EdBreak = 16;
        const ok = av.EdOk;
        av.EdOk = true;
        av.LastTxtPos = -1;
        if (StartExit(X, MayDispl) && av.EdOk) av.EdOk = ok;
        else {
          av.EdOk = ok;
          return false;
        }
      }
      X = X.Chain;
    }
    return true;
  };
  // PAS: RUNEDIT1.PAS WriteCRec.UpdateIndexes
  const UpdateIndexes = (): number => {
    const cf = av.CFile!;
    const VK = P.VK!;
    let NNew = E.LockedRec;
    const KSel = E.SelKey;
    const x = new XString();
    let N: number;
    if (P.IsNewRec) {
      NNew = cf.NRecs + 1;
      cf.XF!.NRecs++;
    } else if (KSel !== null) {
      av.CRecPtr = E.OldRecPtr;
      if (KSel.RecNrToPath(x, NNew)) {
        KSel.DeleteOnPath();
        av.CRecPtr = E.NewRecPtr;
        KSel.Insert(NNew, false);
      }
      av.CRecPtr = E.NewRecPtr;
    }
    if (VK.RecNrToPath(x, E.LockedRec) && !P.WasWK) {
      if (P.IsNewRec) {
        VK.InsertOnPath(x, NNew);
        if (P.SubSet) P.WK!.InsertAtNr(CRec(), NNew);
      }
      N = CRec();
    } else {
      if (!P.IsNewRec) {
        av.CRecPtr = E.OldRecPtr;
        VK.Delete(E.LockedRec);
        if (P.SubSet) P.WK!.DeleteAtNr(CRec());
        av.CRecPtr = E.NewRecPtr;
        x.PackKF(VK.KFlds);
        const nn = ref(0);
        VK.Search(x, true, nn);
      }
      N = VK.PathToNr();
      VK.InsertOnPath(x, NNew);
      if (VK.InWork) (VK as XWKey).NR++;
      if (P.SubSet) N = P.WK!.InsertGetNr(NNew);
    }
    let K = cf.Keys;
    while (K !== null) {
      if (K !== VK) {
        if (!P.IsNewRec) {
          av.CRecPtr = E.OldRecPtr;
          K.Delete(E.LockedRec);
        }
        av.CRecPtr = E.NewRecPtr;
        K.Insert(NNew, true);
      }
      K = K.Chain;
    }
    av.CRecPtr = E.NewRecPtr;
    return N;
  };
  // PAS: RUNEDIT1.PAS WriteCRec.OldRecDiffers
  const OldRecDiffers = (): boolean => {
    let result = false;
    if (IsCurrChpt() || !av.CFile!.NotCached()) return result;
    av.CRecPtr = GetRecSpace();
    ReadRec(E.LockedRec);
    if (CompArea(av.CRecPtr, E.OldRecPtr!, av.CFile!.RecLen) !== 1) {
      // 1:
      DelAllDifTFlds(E.NewRecPtr!, E.OldRecPtr);
      Move(av.CRecPtr, E.NewRecPtr!, av.CFile!.RecLen);
      P.WasUpdated = false;
      result = true;
    }
    // 2:
    ClearRecSpace(av.CRecPtr);
    ReleaseStore(av.CRecPtr);
    av.CRecPtr = E.NewRecPtr;
    return result;
  };

  Displ.v = false;
  if (!P.WasUpdated || (!P.IsNewRec && EquOldNewRec())) {
    P.IsNewRec = false;
    P.WasUpdated = false;
    UnLockRec(E);
    return true;
  }
  if (P.IsNewRec) {
    let ID: ImplDPtr = E.Impl;
    while (ID !== null) {
      AssgnFrml(ID.FldD, ID.Frml, true, false);
      ID = ID.Chain;
    }
  }
  if (P.MustCheck) {
    // repeat field checking
    let D = E.FirstFld;
    while (D !== null) {
      const C = CompChk(D, 'F');
      if (C !== null) {
        if (MayDispl) GotoRecFld(CRec(), D);
        else RunEdiVars.CFld = D;
        DisplChkErr(C);
        return false;
      }
      D = D.Chain;
    }
  }
  const OldMd = ref<LockMode>(NullMode);
  if (P.IsNewRec) {
    if (!LockWithDep(CrMode, NullMode, OldMd)) return false;
  } else if (!P.EdRecVar) {
    if (!LockWithDep(WrMode, WrMode, OldMd)) return false;
    if (OldRecDiffers()) {
      UnLockRec(E);
      UnLockWithDep(OldMd.v);
      WrLLF10Msg(149);
      DisplRec(CRec());
      IVon();
      return false;
    }
  }
  if (P.SubSet && !(P.NoCondCheck || (RunBool(E.Cond) && CheckKeyIn(E)))) {
    UnLockWithDep(OldMd.v);
    WrLLF10Msg(823);
    return false;
  }
  if (E.DownSet) {
    DuplOwnerKey();
    Displ.v = true;
  }
  let result = false;
  // label 1 = UnLockWithDep, label 2 = finish the write
  const finish = (): boolean => {
    // 2:
    if (!P.IsNewRec && !P.NoDelTFlds) DelAllDifTFlds(E.OldRecPtr!, E.NewRecPtr);
    E.EdUpdated = true;
    P.NoDelTFlds = false;
    P.IsNewRec = false;
    P.WasUpdated = false;
    UnLockRec(E);
    return true;
  };
  body: {
    if (!ExitCheck()) break body; // goto 1
    if (P.EdRecVar) {
      result = finish();
      break body;
    }
    const cf = av.CFile!;
    if (P.HasIndex) {
      // test duplicate keys
      let K = cf.Keys;
      while (K !== null) {
        if (!K.Duplic && TestDuplKey(K)) {
          UnLockWithDep(OldMd.v);
          DuplKeyMsg(K);
          return false;
        }
        K = K.Chain;
      }
    }
    ClearDeletedFlag();
    if (P.HasIndex) {
      TestXFExist();
      let CNew: number;
      if (P.IsNewRec) {
        if (P.AddSwitch && !RunAddUpdte1('+', null, false, null, null)) break body;
        CNew = UpdateIndexes();
        CreateRec(cf.NRecs + 1);
      } else {
        if (P.AddSwitch) {
          if (!RunAddUpdte1('d', E.OldRecPtr, false, null, null)) break body;
          UpdMemberRef(E.OldRecPtr, av.CRecPtr);
        }
        CNew = UpdateIndexes();
        WriteRec(E.LockedRec);
      }
      if (CNew !== CRec()) {
        SetNewCRec(CNew, true);
        if (E.NRecs > 1) Displ.v = true;
      }
    } else if (P.IsNewRec) {
      let N = E.LockedRec;
      if (N === 0) {
        N = CRec();
        if (N === CNRecs()) N = cf.NRecs + 1;
        else if (P.SubSet) N = P.WK!.NrToRecNr(N);
      }
      if (P.AddSwitch && !RunAddUpdte1('+', null, false, null, null)) break body;
      if (ChptWriteCRec() !== 0) break body;
      CreateRec(N);
      if (P.SubSet) {
        P.WK!.AddToRecNr(N, 1);
        P.WK!.InsertAtNr(CRec(), N);
      }
    } else {
      if (P.AddSwitch) {
        if (!RunAddUpdte1('d', E.OldRecPtr, false, null, null)) break body;
        UpdMemberRef(E.OldRecPtr, av.CRecPtr);
      }
      switch (ChptWriteCRec()) {
        case 1:
          break body;
        case 2: {
          const ChptTxt = av.ChptTxt!;
          if (getLongint(E.OldRecPtr!, ChptTxt.Displ) !== getLongint(av.CRecPtr!, ChptTxt.Displ) && PromptYN(157)) {
            const s = _LongS(ChptTxt);
            av.TWork.Delete(av.ClpBdPos);
            av.ClpBdPos = av.TWork.Store(s);
            ReleaseStore(s);
          }
          UndoRecord();
          break body;
        }
      }
      WriteRec(E.LockedRec);
    }
    const time = Today() + CurrTime();
    if (P.IsNewRec) WrJournal('+', av.CRecPtr, time);
    else {
      WrJournal('O', E.OldRecPtr, time);
      WrJournal('N', av.CRecPtr, time);
    }
    result = finish();
  }
  // 1:
  UnLockWithDep(OldMd.v);
  return result;
}

// PAS: RUNEDIT1.PAS UndoRecord – unit-internal
export function UndoRecord(): void {
  const P = RunEdiPriv;
  const av = AccessVars;
  if (!P.IsNewRec && P.WasUpdated) {
    const E = CE();
    if (P.HasTF) {
      if (P.NoDelTFlds) {
        let f = av.CFile!.FldD;
        while (f !== null) {
          if ((f.Flg & f_Stored) !== 0 && f.Typ === 'T') {
            setLongint(E.OldRecPtr!, f.Displ, getLongint(av.CRecPtr!, f.Displ));
          }
          f = f.Chain;
        }
      } else DelAllDifTFlds(E.NewRecPtr!, E.OldRecPtr);
    }
    Move(E.OldRecPtr!, E.NewRecPtr!, av.CFile!.RecLen);
    P.WasUpdated = false;
    P.NoDelTFlds = false;
    UnLockRec(E);
    DisplRec(P.IRec);
    IVon();
  }
}

// PAS: RUNEDIT1.PAS DuplFromPrevRec – unit-internal
export function DuplFromPrevRec(): void {
  const P = RunEdiPriv;
  const av = AccessVars;
  const CFld = RunEdiVars.CFld!;
  if (CFld.Ed(P.IsNewRec)) {
    const E = CE();
    const F = CFld.FldD;
    let md: LockMode = RdMode;
    if (F!.Typ === 'T') md = WrMode;
    md = NewLMode(md);
    SetWasUpdated();
    const cr = av.CRecPtr;
    av.CRecPtr = GetRecSpace();
    RdRec(CRec() - 1);
    DuplFld(av.CFile, av.CFile, av.CRecPtr, E.NewRecPtr, E.OldRecPtr, F, F);
    ClearRecSpace(av.CRecPtr);
    ReleaseStore(av.CRecPtr);
    av.CRecPtr = cr;
    OldLMode(md);
  }
}
