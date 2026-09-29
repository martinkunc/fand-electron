// PAS: RUNEDI.PAS (+ RUNEDIT1/2/3.PAS) – the data editor (EDIT instruction, F-file browsing), the
// one-line text editor EditTxt and the Prompt* dialogs.
//
// Porting notes:
// * Includes: runedit1.ts (records, locking, display, WriteCRec, journal), runedit2.ts (search,
//   checks, switches, free-text fields, navigation), runedit3.ts (up/down/imbedded edits, exits,
//   last line, RunEdit main loop, EditDataFile). Only the interface routines are re-exported here.
// * asm/DOS: Ovr (overlay fix-up, no-op). RunEdit reads the BIOS tick counter `Timer absolute
//   0:$46C` in BP7 (FPC: a local, i.e. the idle timer never advances -> use the host clock in
//   18.2 Hz ticks for the WatchDelay/RefreshDelay/`exit after N seconds` logic). EditTxt draws with
//   ScrWrBuf (Uint16Array words: lo = char, hi = attr).
// * Key global state:
//   - interface: RunEdiVars.TxtEdCtrlUBrk/TxtEdCtrlF4Brk (EditTxt breaks on ^U/Ctrl+F4 once, reset
//     on exit), RunEdiVars.CFld (current edit field).
//   - private (shared by the include modules): RunEdiPriv - the EditD mirror fields
//     (rdrun.ts EditDCopiedFields: FirstEmptyFld..SelMode; WrEStatus/RdEStatus copy them to/from
//     E^ field by field, as the FPC branch does) plus UpdCount, CPage, RT, HasIndex, HasTF,
//     NewDisplLL. `E: EditDPtr absolute EditDRoot` is RdRunVars.EditDRoot (use the RunEdiE accessor).
//   The Pascal name `Subset` is `SubSet` here to match EditD.
// * Tricky parts:
//   - EditTxt: labels 1..8 form the event loop (WaitEvent(Delta) with timeout -> ESC); `del`
//     clears the field on the first printable key; typ 'N'/'F'/'R' filter digits; `ret` returns on
//     any non-printable key with the Event still pending (goto 8). Returns the cursor pos or 0 on
//     ESC/Enter/^U/Ctrl+F4 (KbdChar tells which).
//   - RunEdit (RUNEDIT3) is a big goto loop over KbdChar/mouse; many exits (EdExitD with key lists,
//     procedures, Prolog) and the `Brk` result (0 normal, 1 ESC, 2 ^Break/exit key...).
//   - WriteCRec (RUNEDIT1) is the record save: checks, implicit ADD (ImplD), index update, journal
//     (WrJournal to Journal file), T-field text handling, member-reference updates (UpdMemberRef),
//     network re-read with OldRecDiffers. Locking via LockWithDep/UnLockWithDep.
//   - PromptB/PromptS/PromptR (WrPromptTxt) implement the `prompt` functions of formulas.

//   - The editor state lives in RunEdiPriv (the Pascal implementation globals) and RunEdiVars.CFld;
//     the include modules read CFile/CRecPtr through AccessVars like Pascal reads the ACCESS globals.

import { ref, ShortStr, TxtWriteln, Output, type Ref } from './pasrt.ts';
import { BaseVars, MouseInRect, WrStyleStr, type float } from './base.ts';
import {
  DriversVars, WaitEvent, ClrEvent, ScrWrBuf, GotoXY, WhereX, WhereY, CrsNorm, CrsHide, ReadKbd, beep, ToggleCS,
  evMouseDown, evKeyDown, _ESC_, _M_, _Ins_, _V_, _U_, _CtrlF4_, _left_, _S_, _right_, _D_, _Q_, _Home_, _End_, _H_,
  _Del_, _G_, _P_, _F4_,
} from './drivers.ts';
import { AccessVars, type FieldDPtr, type FrmlPtr, type KeyDPtr, type WKeyDPtr } from './access.ts';
import type { EditDPtr, EFldDPtr, ERecTxtDPtr } from './rdrun.ts';
import { RdRunVars } from './rdrun.ts';
import { RunReal, RunShortStr, RunBool, DecodeFieldRSB } from './runfrml.ts';
import { FieldEdit } from './runedit1.ts';

export { CRec, WrEStatus, RdEStatus, SetNewCRec, GotoRecFld, DisplEditWw, OpenEditWw } from './runedit1.ts';
export { EditFreeTxt, UpdateEdTFld } from './runedit2.ts';
export { RunEdit, EditDataFile, SelFldsForEO, StartExit } from './runedit3.ts';

export const RunEdiVars = {
  TxtEdCtrlUBrk: false,
  TxtEdCtrlF4Brk: false,
  CFld: null as EFldDPtr,
};

/** TS-only: the implementation-section globals of RUNEDI, shared by runedit1/2/3.ts. */
export const RunEdiPriv = {
  // mirrored in EditD (EditDCopiedFields order)
  FirstEmptyFld: null as EFldDPtr,
  VK: null as KeyDPtr,
  WK: null as WKeyDPtr,
  BaseRec: 0,
  IRec: 0,
  IsNewRec: false,
  Append: false,
  Select: false,
  WasUpdated: false,
  EdRecVar: false,
  AddSwitch: false,
  ChkSwitch: false,
  WarnSwitch: false,
  SubSet: false,
  NoDelTFlds: false,
  WasWK: false,
  NoDelete: false,
  VerifyDelete: false,
  NoCreate: false,
  F1Mode: false,
  OnlyAppend: false,
  OnlySearch: false,
  Only1Record: false,
  OnlyTabs: false,
  NoESCPrompt: false,
  MustESCPrompt: false,
  Prompt158: false,
  NoSrchMsg: false,
  WithBoolDispl: false,
  Mode24: false,
  NoCondCheck: false,
  F3LeadIn: false,
  LUpRDown: false,
  MouseEnter: false,
  TTExit: false,
  MakeWorkX: false,
  NoShiftF7Msg: false,
  MustAdd: false,
  MustCheck: false,
  SelMode: false,
  // not mirrored
  UpdCount: 0,
  CPage: 0,
  RT: null as ERecTxtDPtr,
  HasIndex: false,
  HasTF: false,
  NewDisplLL: false,
};

/** TS-only: `E: EditDPtr absolute EditDRoot` – the current data editor. */
export function RunEdiE(): EditDPtr {
  return RdRunVars.EditDRoot;
}

// PAS: RUNEDI.PAS PopEdit – E := E^.PrevE
export function PopEdit(): void {
  RdRunVars.EditDRoot = RdRunVars.EditDRoot!.PrevE;
}
// PAS: RUNEDI.PAS TestIsNewRec – used only in RunProj, RunFrml
export function TestIsNewRec(): boolean {
  return RunEdiPriv.IsNewRec;
}
// PAS: RUNEDI.PAS SetSelectFalse
export function SetSelectFalse(): void {
  RunEdiPriv.Select = false;
}

// PAS: RUNEDI.PAS EditTxt – one-line editor of s at the cursor; returns the cursor pos, 0 on exit keys
export function EditTxt(s: Ref<string>, pos: number, maxlen: number, maxcol: number, typ: string, del: boolean,
  star: boolean, upd: boolean, ret: boolean, Delta: number): number {
  const dv = DriversVars;
  let base = 0;
  // PAS: RUNEDI.PAS EditTxt.DelBlk
  const DelBlk = (): void => {
    let sLen = s.v.length;
    while (sLen > 0 && s.v[sLen - 1] === ' ' && pos <= sLen) sLen--;
    s.v = s.v.slice(0, sLen);
  };
  let cx = 0;
  let cy = 0;
  let cx1 = 0;
  let cy1 = 0;
  // PAS: RUNEDI.PAS EditTxt.WriteStr
  const WriteStr = (): void => {
    if (pos <= base) base = pos - 1;
    else if (pos > base + maxcol) {
      base = pos - maxcol;
      if (pos > maxlen) base--;
    }
    if (pos === base + 1 && base > 0) base--;
    DelBlk();
    const BuffLine = new Uint16Array(maxcol);
    for (let i = 1; i <= maxcol; i++) {
      let attr = dv.TextAttr & 0xff;
      let chr: number;
      if (base + i <= s.v.length) {
        chr = star ? 0x2a : s.v.charCodeAt(base + i - 1);
        if (chr < 0x20) {
          chr += 64;
          attr = BaseVars.Colors.tCtrl;
        }
      } else chr = 0x20;
      BuffLine[i - 1] = (chr & 0xff) | ((attr & 0xff) << 8);
    }
    ScrWrBuf(cx1, cy1, BuffLine, maxcol);
    GotoXY(cx + pos - base - 1, cy);
  };
  let InsMode = true;
  if (pos > maxlen + 1) pos = maxlen + 1;
  cx = WhereX();
  cx1 = cx + dv.WindMin.X - 1;
  cy = WhereY();
  cy1 = cy + dv.WindMin.Y - 1;
  CrsNorm();
  WriteStr();
  // label 6: leave with 0
  const Exit6 = (): number => {
    DelBlk();
    CrsHide();
    RunEdiVars.TxtEdCtrlUBrk = false;
    RunEdiVars.TxtEdCtrlF4Brk = false;
    return 0;
  };
  for (;;) {
    // 1:
    const we = WaitEvent(Delta);
    if (we === 1) continue; // flags
    if (we === 2) {
      // timer
      dv.KbdChar = _ESC_;
      return Exit6();
    }
    const Event = dv.Event;
    if (Event.What === evMouseDown) {
      if (MouseInRect(cx1, cy1, maxcol, 1)) {
        ClrEvent();
        dv.KbdChar = _M_;
        return Exit6();
      }
    } else if (Event.What === evKeyDown) {
      dv.KbdChar = Event.KeyCode;
      ClrEvent();
      if (del) {
        if (dv.KbdChar >= 0x20 && dv.KbdChar <= 0xfe) {
          pos = 1;
          s.v = '';
          WriteStr();
        }
        del = false;
      }
      const k = dv.KbdChar;
      let ins = false; // goto 5
      switch (k) {
        case _Ins_:
        case _V_:
          InsMode = !InsMode;
          break;
        case _U_:
          if (RunEdiVars.TxtEdCtrlUBrk) return Exit6();
          break;
        case _CtrlF4_:
          if (RunEdiVars.TxtEdCtrlF4Brk) return Exit6();
          break;
        case _ESC_:
        case _M_:
          return Exit6();
        case _left_:
        case _S_:
          if (pos > 1) pos--;
          break;
        case _right_:
        case _D_:
          if (pos <= maxlen) {
            if (pos > s.v.length && s.v.length < maxlen) s.v = s.v + ' ';
            pos++;
          }
          break;
        case _Q_:
          switch (ReadKbd()) {
            case _S_:
              pos = 1; // goto 3
              break;
            case _D_:
              pos = s.v.length + 1; // goto 4
              break;
          }
          break;
        case _Home_:
          pos = 1;
          break;
        case _End_:
          pos = s.v.length + 1;
          break;
        case _H_:
          if (upd && pos > 1) {
            pos--;
            s.v = s.v.slice(0, pos - 1) + s.v.slice(pos); // goto 2
          }
          break;
        case _Del_:
        case _G_:
          if (upd && pos <= s.v.length) s.v = s.v.slice(0, pos - 1) + s.v.slice(pos);
          break;
        case _P_:
          if (upd) {
            ReadKbd();
            if (dv.KbdChar >= 0 && dv.KbdChar <= 31) ins = true;
          }
          break;
        case _F4_:
          if (upd && typ === 'A' && pos <= s.v.length) {
            s.v = s.v.slice(0, pos - 1) + ToggleCS(s.v[pos - 1]) + s.v.slice(pos);
          }
          break;
        default:
          if (k >= 0x20 && k <= 0xff) {
            if (upd) {
              const c = String.fromCharCode(k);
              ins = true;
              switch (typ) {
                case 'N':
                  if (!(c >= '0' && c <= '9')) ins = false;
                  break;
                case 'F':
                  if (!((c >= '0' && c <= '9') || c === '.' || c === ',' || c === '-')) ins = false;
                  break;
                case 'R':
                  if (!((c >= '0' && c <= '9') || '.,-+eE'.includes(c))) ins = false;
                  break;
              }
            }
          } else if (ret && (k < 0x20 || k >= 0x100)) {
            Event.What = evKeyDown;
            return pos; // goto 8
          }
      }
      if (ins) {
        // 5:
        const c = String.fromCharCode(dv.KbdChar & 0xff);
        if (pos > maxlen) beep();
        else {
          let ok = true;
          if (InsMode) {
            if (s.v.length === maxlen) {
              if (s.v[s.v.length - 1] === ' ') s.v = s.v.slice(0, -1);
              else {
                beep();
                ok = false;
              }
            }
            if (ok) s.v = s.v.slice(0, pos - 1) + c + s.v.slice(pos - 1);
          } else s.v = s.v.slice(0, pos - 1) + c + s.v.slice(pos);
          if (ok) pos++;
        }
        // 7:
      }
      WriteStr();
    }
    ClrEvent();
    if (!ret) continue;
    return pos; // 8:
  }
}

// PAS: RUNEDI.PAS WrPromptTxt – unit-internal: common part of PromptB/S/R
export function WrPromptTxt(S: string, Impl: FrmlPtr, F: FieldDPtr, Txt: Ref<string>, R: Ref<float>): void {
  const dv = DriversVars;
  const f = F!;
  WrStyleStr(S, BaseVars.ProcAttr);
  const T = ref('');
  const x = WhereX();
  const y = WhereY();
  const d = dv.WindMax.X - dv.WindMin.X + 1;
  let LWw: number;
  if (x + f.L - 1 > d) LWw = d - x;
  else LWw = f.L;
  dv.TextAttr = BaseVars.Colors.dHili;
  if (Impl !== null) {
    let RR = 0;
    let SS = '';
    let BB = false;
    switch (f.FrmlTyp) {
      case 'R':
        RR = RunReal(Impl);
        break;
      case 'S':
        SS = RunShortStr(Impl);
        break;
      default:
        BB = RunBool(Impl);
    }
    DecodeFieldRSB(F, f.L, RR, SS, BB, T);
  }
  GotoXY(x, y);
  FieldEdit(F, null, LWw, 1, T, R, true, true, false, 0);
  dv.TextAttr = BaseVars.ProcAttr;
  if (dv.KbdChar === _ESC_) {
    AccessVars.EscPrompt = true;
    TxtWriteln(Output);
  } else {
    AccessVars.EscPrompt = false;
    Txt.v = T.v;
    // T[0]:=char(LWw)
    const t = ShortStr(T.v, LWw).padEnd(LWw, ' ');
    GotoXY(x, y);
    TxtWriteln(Output, t);
  }
}
// PAS: RUNEDI.PAS PromptB
export function PromptB(S: string, Impl: FrmlPtr, F: FieldDPtr): boolean {
  const Txt = ref('');
  const R = ref(0);
  WrPromptTxt(S, Impl, F, Txt, R);
  let result = Txt.v.charAt(0) === BaseVars.AbbrYes;
  if (DriversVars.KbdChar === _ESC_) {
    if (Impl !== null) result = RunBool(Impl);
    else result = false;
  }
  return result;
}
// PAS: RUNEDI.PAS PromptS
export function PromptS(S: string, Impl: FrmlPtr, F: FieldDPtr): string {
  const Txt = ref('');
  const R = ref(0);
  WrPromptTxt(S, Impl, F, Txt, R);
  let result = Txt.v;
  if (DriversVars.KbdChar === _ESC_) {
    if (Impl !== null) result = RunShortStr(Impl);
    else result = '';
  }
  return result;
}
// PAS: RUNEDI.PAS PromptR
export function PromptR(S: string, Impl: FrmlPtr, F: FieldDPtr): float {
  const Txt = ref('');
  const R = ref(0);
  WrPromptTxt(S, Impl, F, Txt, R);
  let result = R.v;
  if (DriversVars.KbdChar === _ESC_) {
    if (Impl !== null) result = RunReal(Impl);
    else result = 0;
  }
  return result;
}
