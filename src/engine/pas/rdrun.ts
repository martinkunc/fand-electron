// PAS: RDRUN.PAS – run-time structures shared by the compilers (RDPROC, RDMERG, RDRPRT, RDEDIT)
// and the interpreters: merge assignments, report blocks, edit descriptors, procedure
// instructions (Instr), local-variable frames, implicit ADD updates.

import { defineDefaults, defineAliases, TextFile, ref, type Ref, type Pointer } from './pasrt.ts';
import type { float, StringPtr, LongStrPtr, ProcStkPtr } from './base.ts';
import {
  BaseVars, WRect, ProcStkD, ReleaseStore, SetMsgPar, Set2MsgPar, Today, CurrTime, SetUpdHandle,
} from './base.ts';
import {
  AccessVars, RdbPos, WRectFrml, LocVarBlkD, f_Stored, LocVarAd, GetRecSpace, ClearDeletedFlag, CreateRec, RecallRec,
  LinkUpw, LinkLastRec, IncNRecs, ReadRec, WriteRec, R_, _R, S_, LongS_, B_, TryLMode, OldLMode, LockModeTxt,
  NullMode, WrMode, CrMode, type AddD,
  type FileDPtr, type FieldDPtr, type FrmlPtr, type LocVarPtr, type KeyFldDPtr, type SumElPtr, type ChkDPtr,
  type KeyDPtr, type KeyInDPtr, type FieldList, type FloatPtrList, type StringList, type LinkDPtr, type RdbDPtr,
  type DepDPtr, type KeyList, type ImplDPtr, type WKeyDPtr, type LockMode, type AddDPtr, type XScanPtr,
} from './access.ts';
import { XString } from './index.ts';
import { RunBool, RunReal, RunShortStr, RunLongStr, LVAssignFrml } from './runfrml.ts';
import { PromptYN, WrLLF10Msg, PushWrLLMsg, PopW } from './obaseww.ts';
import { SetCPathVol } from './oaccess.ts';
import { KbdTimer } from './drivers.ts';

// ---------------------------------------------------------------- Merge

// MInstrCode = (_zero, _move, _output, _locvar, _parfile, _ifthenelseM)
export type MInstrCode = number;
export const _zero = 0;
export const _move = 1;
export const _output = 2;
export const _locvar = 3;
export const _parfile = 4;
export const _ifthenelseM = 5;

export type AssignDPtr = AssignD | null;
// PAS: RDRUN.PAS AssignD – case Kind of _zero: (FldD) | _move: (ToPtr, FromPtr, L) |
// _output: (Add, Frml, OFldD) | _locvar: (Add1, Frml1, LV) | _parfile: (Add2, Frml2, FD, PFldD) |
// _ifthenelseM: (Bool, Instr, ElseInstr). Add1/Add2 alias Add, Frml1/Frml2 alias Frml.
// ToPtr/FromPtr are views into record buffers (subarray at the field).
export class AssignD {
  Chain: AssignDPtr = null;
  Kind: MInstrCode = _zero;
  declare FldD: FieldDPtr;
  declare ToPtr: Uint8Array | null;
  declare FromPtr: Uint8Array | null;
  declare L: number;
  declare Add: boolean;
  declare Frml: FrmlPtr;
  declare OFldD: FieldDPtr;
  declare Add1: boolean;
  declare Frml1: FrmlPtr;
  declare LV: LocVarPtr;
  declare Add2: boolean;
  declare Frml2: FrmlPtr;
  declare FD: FileDPtr;
  declare PFldD: FieldDPtr;
  declare Bool: FrmlPtr;
  declare Instr: AssignDPtr;
  declare ElseInstr: AssignDPtr;
  constructor(Kind: MInstrCode = _zero) {
    this.Kind = Kind;
  }
}
defineDefaults(AssignD, {
  FldD: null, ToPtr: null, FromPtr: null, L: 0, Add: false, Frml: null, OFldD: null, LV: null, FD: null,
  PFldD: null, Bool: null, Instr: null, ElseInstr: null,
});
defineAliases(AssignD, { Add1: 'Add', Add2: 'Add', Frml1: 'Frml', Frml2: 'Frml' });

export type InpDPtr = InpD | null;
export type OutpFDPtr = OutpFD | null;
// PAS: RDRUN.PAS OutpFD
export class OutpFD {
  Chain: OutpFDPtr = null;
  FD: FileDPtr = null;
  Md: LockMode = 0;
  RecPtr: Uint8Array | null = null;
  InplFD: FileDPtr = null;
  Append = false;
}
export type OutpRDPtr = OutpRD | null;
// PAS: RDRUN.PAS OutpRD
export class OutpRD {
  Chain: OutpRDPtr = null;
  OD: OutpFDPtr = null; // nil=dummy
  Bool: FrmlPtr = null;
  Ass: AssignDPtr = null;
}
export type ConstList = ConstListEl | null;
export type LvDescrPtr = LvDescr | null;

// PAS: RDRUN.PAS InpD – used in Merge+Report. (Op, Count), (OpErr, Error), (OpWarn, Warning) are
// also formula nodes: FrmlAt(id, {Op:'Op', R:'Count'}), FrmlAt(id, {Op:'OpErr', B:'Error'}) ...
// case 1 (only Report): SFld, OldSFlds, FrstLvS, LstLvS; case 2 (only Merge): IsInplace, RD.
export class InpD {
  Scan: XScanPtr = null;
  AutoSort = false;
  SK: KeyFldDPtr = null;
  Md: LockMode = 0;
  IRec = 0;
  ForwRecPtr: Uint8Array | null = null;
  Bool: FrmlPtr = null;
  SQLFilter = false;
  MFld: KeyFldDPtr = null;
  Sum: SumElPtr = null;
  Exist = false;
  Op = '\0';
  Count: float = 0;
  Chk: ChkDPtr = null;
  OpErr = '\0';
  Error = false;
  OpWarn = '\0';
  Warning = false;
  ErrTxtFrml: FrmlPtr = null; // <>nil then record error test used
  SFld: KeyFldDPtr = null;
  OldSFlds: ConstList = null;
  FrstLvS: LvDescrPtr = null; // FrstLvS^.Ft=DE
  LstLvS: LvDescrPtr = null;
  IsInplace = false;
  RD: OutpRDPtr = null;
}

// PAS: RDRUN.PAS ConstListEl – case char of 'S': (S) | 'R': (R) | 'B': (B)
export class ConstListEl {
  Chain: ConstList = null;
  S = '';
  R: float = 0;
  B = false;
}

// ---------------------------------------------------------------- Report

// AutoRprtMode = (_ALstg, _ARprt, _ATotal, _AErrRecs)
export type AutoRprtMode = number;
export const _ALstg = 0;
export const _ARprt = 1;
export const _ATotal = 2;
export const _AErrRecs = 3;

export type RprtFDList = RprtFDListEl | null;
// PAS: RDRUN.PAS RprtFDListEl
export class RprtFDListEl {
  Chain: RprtFDList = null;
  FD: FileDPtr = null;
  ViewKey: KeyDPtr = null;
  Cond: FrmlPtr = null;
  KeyIn: KeyInDPtr = null;
  SQLFilter = false;
  LVRecPtr: Uint8Array | null = null;
}

export type RprtOptPtr = RprtOpt | null;
// PAS: RDRUN.PAS RprtOpt
export class RprtOpt {
  FDL = new RprtFDListEl();
  Path: StringPtr = null;
  CatIRec = 0;
  UserSelFlds = false;
  UserCondQuest = false;
  FromStr = false;
  SyntxChk = false;
  Times: FrmlPtr = null;
  Mode: AutoRprtMode = _ALstg;
  RprtPos = new RdbPos();
  Flds: FieldList = null; // <>nil => autoreport
  Ctrl: FieldList = null;
  Sum: FieldList = null;
  SK: KeyFldDPtr = null;
  WidthFrml: FrmlPtr = null;
  Head: FrmlPtr = null;
  Width = 0;
  CondTxt: StringPtr = null;
  HeadTxt: LongStrPtr | null = null;
  Style = '\0';
  Edit = false;
  PrintCtrl = false;
}

export type RFldDPtr = RFldD | null;
export type BlkDPtr = BlkD | null;
// PAS: RDRUN.PAS RFldD
export class RFldD {
  Chain: RFldDPtr = null;
  FrmlTyp = '\0';
  Typ = '\0'; // R,F,D,T
  BlankOrWrap = false; // long date 'DD.MM.YYYY'
  Frml: FrmlPtr = null;
  Name = '';
}
// PAS: RDRUN.PAS BlkD
export class BlkD {
  Chain: BlkDPtr = null;
  Bool: FrmlPtr = null;
  Sum: SumElPtr = null;
  /** sequence of strings (as compiled by RDRPRT; a cursor walks it in RUNRPRT) */
  Txt: Uint8Array | null = null;
  AbsLine = false;
  SetPage = false;
  NotAtEnd = false;
  FF1 = false;
  FF2 = false;
  LineBound: FrmlPtr = null;
  LineNo: FrmlPtr = null;
  PageNo: FrmlPtr = null;
  NTxtLines = 0;
  NBlksFrst = 0;
  DHLevel = 0;
  RFD: RFldDPtr = null;
  BeforeProc: AssignDPtr = null;
  AfterProc: AssignDPtr = null;
}
// PAS: RDRUN.PAS LvDescr
export class LvDescr {
  Chain: LvDescrPtr = null;
  ChainBack: LvDescrPtr = null;
  ZeroLst: FloatPtrList = null;
  Hd: BlkDPtr = null;
  Ft: BlkDPtr = null;
  Fld: FieldDPtr = null;
}

// ---------------------------------------------------------------- Edit

export type InstrPtr = Instr | null;
export type EdExKeyDPtr = EdExKeyD | null;
// PAS: RDRUN.PAS EdExKeyD
export class EdExKeyD {
  Chain: EdExKeyDPtr = null;
  Break = 0;
  KeyCode = 0;
}
export type EdExitDPtr = EdExitD | null;
// PAS: RDRUN.PAS EdExitD – case Typ of 'R': (RO) | 'P': (Proc) (in edittxt only 'P','Q'); 'Q' quit, #0 dummy
export class EdExitD {
  Chain: EdExitDPtr = null;
  Keys: EdExKeyDPtr = null;
  AtWrRec = false;
  AtNewRec = false;
  NegFlds = false;
  Flds: FieldList = null; // in edittxt not used
  Typ = '\0';
  RO: RprtOptPtr = null;
  Proc: InstrPtr = null;
}
export type EditOptPtr = EditOpt | null;
// PAS: RDRUN.PAS EditOpt
export class EditOpt {
  FormPos = new RdbPos();
  UserSelFlds = false;
  SetOnlyView = false;
  NegDupl = false;
  NegTab = false;
  NegNoEd = false;
  SyntxChk = false;
  Flds: FieldList = null;
  Dupl: FieldList = null;
  Tab: FieldList = null;
  NoEd: FieldList = null;
  Cond: FrmlPtr = null;
  Head: FrmlPtr = null;
  Last: FrmlPtr = null;
  CtrlLast: FrmlPtr = null;
  AltLast: FrmlPtr = null;
  ShiftLast: FrmlPtr = null;
  Mode: FrmlPtr = null;
  StartRecNoZ: FrmlPtr = null;
  StartRecKeyZ: FrmlPtr = null;
  StartIRecZ: FrmlPtr = null;
  StartFieldZ: FrmlPtr = null;
  SaveAfterZ: FrmlPtr = null;
  WatchDelayZ: FrmlPtr = null;
  RefreshDelayZ: FrmlPtr = null;
  W = new WRectFrml();
  ZAttr: FrmlPtr = null;
  ZdNorm: FrmlPtr = null;
  ZdHiLi: FrmlPtr = null;
  ZdSubset: FrmlPtr = null;
  ZdDel: FrmlPtr = null;
  ZdTab: FrmlPtr = null;
  ZdSelect: FrmlPtr = null;
  Top: FrmlPtr = null;
  WFlags = 0;
  ExD: EdExitDPtr = null;
  Journal: FileDPtr = null;
  ViewName: StringPtr = null;
  OwnerTyp = '\0';
  DownLD: LinkDPtr = null;
  DownLV: LocVarPtr = null;
  DownRecPtr: Uint8Array | null = null;
  LVRecPtr: Uint8Array | null = null;
  KIRoot: KeyInDPtr = null;
  SQLFilter = false;
  SelKey: KeyDPtr = null;
  ViewKey: KeyDPtr = null;
}

export type EFldDPtr = EFldD | null;
// PAS: RDRUN.PAS EFldD – a field on an edit form
export class EFldD {
  Chain: EFldDPtr = null;
  ChainBack: EFldDPtr = null;
  FldD: FieldDPtr = null;
  Chk: ChkDPtr = null;
  Impl: FrmlPtr = null;
  Dep: DepDPtr = null;
  KL: KeyList = null;
  Page = 0;
  Col = 0;
  Ln = 0;
  L = 0;
  ScanNr = 0;
  Tab = false;
  Dupl = false;
  Used = false;
  EdU = false;
  EdN = false;
  // PAS: RDRUN.PAS EFldD.Ed
  Ed(IsNewRec: boolean): boolean {
    return (this.FldD!.Flg & f_Stored) !== 0 && (this.EdU || (IsNewRec && this.EdN));
  }
}
export type ERecTxtDPtr = ERecTxtD | null;
// PAS: RDRUN.PAS ERecTxtD
export class ERecTxtD {
  Chain: ERecTxtDPtr = null;
  N = 0;
  SL: StringList = null;
}

/**
 * TS-only: the EditD fields RUNEDIT1 copies as one memory block to/from the RUNEDI globals
 * (Move(E^.FirstEmptyFld, FirstEmptyFld, ofs(SelMode)-ofs(FirstEmptyFld)+1)), in order.
 */
export const EditDCopiedFields = [
  'FirstEmptyFld', 'VK', 'WK', 'BaseRec', 'IRec', 'IsNewRec', 'Append', 'Select', 'WasUpdated', 'EdRecVar',
  'AddSwitch', 'ChkSwitch', 'WarnSwitch', 'SubSet', 'NoDelTFlds', 'WasWK', 'NoDelete', 'VerifyDelete', 'NoCreate',
  'F1Mode', 'OnlyAppend', 'OnlySearch', 'Only1Record', 'OnlyTabs', 'NoESCPrompt', 'MustESCPrompt', 'Prompt158',
  'NoSrchMsg', 'WithBoolDispl', 'Mode24', 'NoCondCheck', 'F3LeadIn', 'LUpRDown', 'MouseEnter', 'TTExit',
  'MakeWorkX', 'NoShiftF7Msg', 'MustAdd', 'MustCheck', 'SelMode',
] as const;

export type EditDPtr = EditD | null;
// PAS: RDRUN.PAS EditD – a running (or suspended) data editor
export class EditD {
  PrevE: EditDPtr = null;
  FD: FileDPtr = null;
  OldMd: LockMode = 0;
  IsUserForm = false;
  Flds: FieldList = null;
  OldRecPtr: Uint8Array | null = null;
  NewRecPtr: Uint8Array | null = null;
  FrstCol = 0;
  FrstRow = 0;
  LastCol = 0;
  LastRow = 0;
  Rows = 0;
  V = new WRect();
  ShdwX = 0;
  ShdwY = 0;
  Attr = 0;
  dNorm = 0;
  dHiLi = 0;
  dSubSet = 0;
  dDel = 0;
  dTab = 0;
  dSelect = 0;
  Top: StringPtr = null;
  WFlags = 0; // copied from EO
  ExD: EdExitDPtr = null; // "
  Journal: FileDPtr = null; // "
  ViewName: StringPtr = null; // "
  OwnerTyp = '\0'; // #0=CtrlF7  "
  DownLD: LinkDPtr = null; // "
  DownLV: LocVarPtr = null; // "
  DownRecPtr: Uint8Array | null = null; // "
  LVRecPtr: Uint8Array | null = null; // "
  KIRoot: KeyInDPtr = null; // "
  SQLFilter = false; // "
  SelKey: WKeyDPtr = null; // "
  HdTxt: StringList = null;
  NHdTxt = 0;
  SaveAfter = 0;
  WatchDelay = 0;
  RefreshDelay = 0;
  RecNrPos = 0;
  RecNrLen = 0;
  NPages = 0;
  RecTxt: ERecTxtDPtr = null;
  NRecs = 0; // display
  FirstFld: EFldDPtr = null;
  LastFld: EFldDPtr = null;
  StartFld: EFldDPtr = null;
  CFld: EFldDPtr = null; // copied
  FirstEmptyFld: EFldDPtr = null; // copied (EditDCopiedFields from here to SelMode)
  VK: KeyDPtr = null;
  WK: WKeyDPtr = null;
  BaseRec = 0;
  IRec = 0;
  IsNewRec = false;
  Append = false;
  Select = false;
  WasUpdated = false;
  EdRecVar = false;
  AddSwitch = false;
  ChkSwitch = false;
  WarnSwitch = false;
  SubSet = false;
  NoDelTFlds = false;
  WasWK = false;
  NoDelete = false;
  VerifyDelete = false;
  NoCreate = false;
  F1Mode = false;
  OnlyAppend = false;
  OnlySearch = false;
  Only1Record = false;
  OnlyTabs = false;
  NoESCPrompt = false;
  MustESCPrompt = false;
  Prompt158 = false;
  NoSrchMsg = false;
  WithBoolDispl = false;
  Mode24 = false;
  NoCondCheck = false;
  F3LeadIn = false;
  LUpRDown = false;
  MouseEnter = false;
  TTExit = false;
  MakeWorkX = false;
  NoShiftF7Msg = false;
  MustAdd = false;
  MustCheck = false;
  SelMode = false;
  DownSet = false;
  IsLocked = false;
  WwPart = false;
  DownKey: KeyDPtr = null;
  LockedRec = 0;
  Cond: FrmlPtr = null;
  Bool: FrmlPtr = null;
  BoolTxt: StringPtr = null;
  Head: StringPtr = null;
  Last: StringPtr = null;
  CtrlLast: StringPtr = null;
  AltLast: StringPtr = null;
  ShiftLast: StringPtr = null;
  NFlds = 0;
  NTabsSet = 0;
  NDuplSet = 0;
  NEdSet = 0;
  EdUpdated = false;
  Impl: ImplDPtr = null;
  StartRecNo = 0;
  StartRecKey: StringPtr = null;
  StartIRec = 0;
  OwnerRecNo = 0;
  ShiftF7LD: LinkDPtr = null;
  /** heap mark after the editor's data (PROJMGR releases to it) */
  AfterE: Pointer = null;
}

// ---------------------------------------------------------------- Procedures

// PInstrCode, in declaration order (ordinal values matter: `Kind in [..]`, ranges)
export type PInstrCode = number;
export const PInstrCodeNames = [
  '_menubox', '_menubar', '_ifthenelseP', '_whiledo',
  '_repeatuntil', '_break', '_exit', '_cancel', '_save', '_closefds',
  '_window', '_clrscr', '_clrww', '_clreol', '_gotoxy', '_display',
  '_writeln', '_comment', '_setkeybuf', '_clearkeybuf', '_headline',
  '_call', '_exec', '_copyfile', '_proc', '_lproc', '_merge', '_sort', '_edit', '_report',
  '_edittxt', '_printtxt', '_puttxt', '_sql',
  '_asgnloc', '_asgnpar', '_asgnfield', '_asgnedok', '_asgnrand', '_asgnusertoday',
  '_randomize',
  '_asgnusercode', '_asgnusername',
  '_asgnaccright', '_asgnxnrecs',
  '_asgnnrecs', '_asgncatfield', '_asgnrecfld', '_asgnrecvar', '_asgnclipbd',
  '_turncat', '_appendrec', '_deleterec', '_recallrec', '_readrec', '_writerec',
  '_linkrec',
  '_releasedrive', '_mount', '_indexfile', '_getindex', '_forall',
  '_withshared', '_withlocked', '_withgraphics',
  '_memdiag', '_wait', '_delay', '_beep', '_sound', '_nosound', '_help', '_setprinter',
  '_graph', '_putpixel', '_line', '_rectangle', '_ellipse', '_floodfill', '_outtextxy',
  '_backup', '_backupm', '_resetcat',
  '_setedittxt', '_setmouse', '_checkfile', '_login', '_sqlrdwrtxt',
  '_portout',
] as const;
export const _menubox = 0;
export const _menubar = 1;
export const _ifthenelseP = 2;
export const _whiledo = 3;
export const _repeatuntil = 4;
export const _break = 5;
export const _exit = 6;
export const _cancel = 7;
export const _save = 8;
export const _closefds = 9;
export const _window = 10;
export const _clrscr = 11;
export const _clrww = 12;
export const _clreol = 13;
export const _gotoxy = 14;
export const _display = 15;
export const _writeln = 16;
export const _comment = 17;
export const _setkeybuf = 18;
export const _clearkeybuf = 19;
export const _headline = 20;
export const _call = 21;
export const _exec = 22;
export const _copyfile = 23;
export const _proc = 24;
export const _lproc = 25;
export const _merge = 26;
export const _sort = 27;
export const _edit = 28;
export const _report = 29;
export const _edittxt = 30;
export const _printtxt = 31;
export const _puttxt = 32;
export const _sql = 33;
export const _asgnloc = 34;
export const _asgnpar = 35;
export const _asgnfield = 36;
export const _asgnedok = 37;
export const _asgnrand = 38;
export const _asgnusertoday = 39;
export const _randomize = 40;
export const _asgnusercode = 41;
export const _asgnusername = 42;
export const _asgnaccright = 43;
export const _asgnxnrecs = 44;
export const _asgnnrecs = 45;
export const _asgncatfield = 46;
export const _asgnrecfld = 47;
export const _asgnrecvar = 48;
export const _asgnclipbd = 49;
export const _turncat = 50;
export const _appendrec = 51;
export const _deleterec = 52;
export const _recallrec = 53;
export const _readrec = 54;
export const _writerec = 55;
export const _linkrec = 56;
export const _releasedrive = 57;
export const _mount = 58;
export const _indexfile = 59;
export const _getindex = 60;
export const _forall = 61;
export const _withshared = 62;
export const _withlocked = 63;
export const _withgraphics = 64;
export const _memdiag = 65;
export const _wait = 66;
export const _delay = 67;
export const _beep = 68;
export const _sound = 69;
export const _nosound = 70;
export const _help = 71;
export const _setprinter = 72;
export const _graph = 73;
export const _putpixel = 74;
export const _line = 75;
export const _rectangle = 76;
export const _ellipse = 77;
export const _floodfill = 78;
export const _outtextxy = 79;
export const _backup = 80;
export const _backupm = 81;
export const _resetcat = 82;
export const _setedittxt = 83;
export const _setmouse = 84;
export const _checkfile = 85;
export const _login = 86;
export const _sqlrdwrtxt = 87;
export const _portout = 88;

// CpOption = (cpNo, cpFix, cpVar, cpTxt)
export type CpOption = number;
export const cpNo = 0;
export const cpFix = 1;
export const cpVar = 2;
export const cpTxt = 3;

export type CopyDPtr = CopyD | null;
// PAS: RDRUN.PAS CopyD
export class CopyD {
  Path1: StringPtr = null; // FrmlPtr if cpList
  CatIRec1 = 0;
  FD1: FileDPtr = null;
  ViewKey: KeyDPtr = null;
  WithX1 = false;
  Opt1: CpOption = cpNo;
  Path2: StringPtr = null;
  CatIRec2 = 0;
  FD2: FileDPtr = null;
  WithX2 = false;
  Opt2: CpOption = cpNo;
  HdFD: FileDPtr = null;
  HdF: FieldDPtr = null;
  Append = false;
  NoCancel = false;
  Mode = 0;
}
export type ChoiceDPtr = ChoiceD | null;
// PAS: RDRUN.PAS ChoiceD – a menu item
export class ChoiceD {
  Chain: ChoiceDPtr = null;
  HelpName: StringPtr = null;
  Displ = false;
  DisplEver = false;
  Enabled = false;
  TxtConst = false;
  Bool: FrmlPtr = null;
  Instr: InstrPtr = null;
  TxtFrml: FrmlPtr = null;
  Txt: StringPtr = null;
}
export type WrLnDPtr = WrLnD | null;
// PAS: RDRUN.PAS WrLnD – case char of 'F': (N, M) | 'D': (Mask)
export class WrLnD {
  Chain: WrLnDPtr = null;
  Frml: FrmlPtr = null;
  Typ = '\0'; // S,B,F,D
  N = 0;
  M = 0;
  Mask: StringPtr = null;
}
export type LockDPtr = LockD | null;
// PAS: RDRUN.PAS LockD
export class LockD {
  Chain: LockDPtr = null;
  FD: FileDPtr = null;
  Frml: FrmlPtr = null;
  Md: LockMode = 0;
  OldMd: LockMode = 0;
  N = 0;
}

// Graphics descriptors (GRAPH is parsed – FandGraphParse – but not run in this port)
export type GraphVDPtr = GraphVD | null;
// PAS: RDRUN.PAS GraphVD
export class GraphVD {
  Chain: GraphVDPtr = null;
  XZ: FrmlPtr = null; // real
  YZ: FrmlPtr = null;
  Velikost: FrmlPtr = null;
  BarPis: FrmlPtr = null; // string
  Text: FrmlPtr = null;
}
export type GraphWDPtr = GraphWD | null;
// PAS: RDRUN.PAS GraphWD
export class GraphWD {
  Chain: GraphWDPtr = null;
  XZ: FrmlPtr = null; // real
  YZ: FrmlPtr = null;
  XK: FrmlPtr = null;
  YK: FrmlPtr = null;
  BarPoz: FrmlPtr = null; // string
  BarPis: FrmlPtr = null;
  Text: FrmlPtr = null;
}
export type GraphRGBDPtr = GraphRGBD | null;
// PAS: RDRUN.PAS GraphRGBD
export class GraphRGBD {
  Chain: GraphRGBDPtr = null;
  Barva: FrmlPtr = null; // string
  R: FrmlPtr = null; // real
  G: FrmlPtr = null;
  B: FrmlPtr = null;
}
export type WinGPtr = WinG | null;
// PAS: RDRUN.PAS WinG
export class WinG {
  W = new WRectFrml();
  WR = new WRect();
  ColFrame: FrmlPtr = null; // string
  ColBack: FrmlPtr = null;
  ColFor: FrmlPtr = null;
  Top: FrmlPtr = null;
  WFlags = 0;
}
export type GraphDPtr = GraphD | null;
// PAS: RDRUN.PAS GraphD
export class GraphD {
  FD: FileDPtr = null;
  GF: FrmlPtr = null;
  X: FieldDPtr = null;
  Y: FieldDPtr = null;
  Z: FieldDPtr = null;
  ZA: FieldDPtr[] = Array(10).fill(null); // [0..9]
  HZA: FrmlPtr[] = Array(10).fill(null); // [0..9]
  T: FrmlPtr = null; // string
  H: FrmlPtr = null;
  HX: FrmlPtr = null;
  HY: FrmlPtr = null;
  HZ: FrmlPtr = null;
  C: FrmlPtr = null;
  D: FrmlPtr = null;
  R: FrmlPtr = null;
  P: FrmlPtr = null;
  CO: FrmlPtr = null;
  Assign: FrmlPtr = null;
  Cond: FrmlPtr = null;
  S: FrmlPtr = null; // real
  RS: FrmlPtr = null;
  RN: FrmlPtr = null;
  Max: FrmlPtr = null;
  Min: FrmlPtr = null;
  SP: FrmlPtr = null;
  Interact = false;
  V: GraphVDPtr = null;
  W: GraphWDPtr = null;
  RGB: GraphRGBDPtr = null;
  KeyIn: KeyInDPtr = null;
  SQLFilter = false;
  ViewKey: KeyDPtr = null;
  WW: WinGPtr = null;
}

// PAS: RDRUN.PAS TypAndFrml – a procedure call argument.
// case FTyp of 'S','R','B': (Frml, FromProlog, IsRetPar) | 'r','i','f': (FD, RecPtr) |
// 'f': (TxtFrml, Name {if RecPtr<>nil}). TxtFrml overlays FD and Name overlays RecPtr in Pascal;
// here they are separate: for FTyp='f' test `Name !== null` where Pascal tests RecPtr<>nil.
export class TypAndFrml {
  FTyp = '\0';
  Frml: FrmlPtr = null;
  FromProlog = false;
  IsRetPar = false;
  FD: FileDPtr = null;
  RecPtr: Uint8Array | WKeyDPtr = null;
  TxtFrml: FrmlPtr = null;
  Name: StringPtr = null;
}

// PAS: RDRUN.PAS Instr – a compiled procedure instruction; the variant is chosen by Kind.
// All variant fields read as zero/nil until set (prototype defaults = GetZStore); embedded
// records (Pos, WD, W, Ww, WLD ...) are created per instance on first access.
// Same-offset aliases: Frml0/Frml1/Frml2/Frml3 = Frml, Add1/Add2 = Add, AssLV2 = AssLV, PPos = Pos,
// TxtPath1/TxtPath2 = TxtPath, TxtCatIRec1/TxtCatIRec2 = TxtCatIRec, W2 = W, Attr2 = Attr.
// Arrays: mAttr [0..3]; TArg [1..N] (1-based, up to 30); bmX [1..5].
export class Instr {
  Chain: InstrPtr = null;
  Kind: PInstrCode;
  // _menubox, _menubar
  declare HdLine: FrmlPtr;
  declare HelpRdb: RdbDPtr;
  declare WasESCBranch: boolean;
  declare ESCInstr: InstrPtr;
  declare Choices: ChoiceDPtr;
  declare Loop: boolean;
  declare PullDown: boolean;
  declare Shdw: boolean;
  declare X: FrmlPtr;
  declare Y: FrmlPtr;
  declare XSz: FrmlPtr;
  declare mAttr: FrmlPtr[];
  // _ifthenelseP, _whiledo, _repeatuntil
  declare Bool: FrmlPtr;
  declare Instr: InstrPtr;
  declare ElseInstr: InstrPtr;
  // _merge, _display
  declare Pos: RdbPos;
  // _proc
  declare PPos: RdbPos;
  declare N: number;
  declare ExPar: boolean;
  declare TArg: TypAndFrml[];
  // _lproc
  declare lpPos: RdbPos;
  declare lpName: StringPtr;
  // _call
  declare RdbNm: StringPtr;
  declare ProcNm: StringPtr;
  declare ProcCall: InstrPtr;
  // _exec
  declare ProgPath: StringPtr;
  declare ProgCatIRec: number;
  declare NoCancel: boolean;
  declare FreeMm: boolean;
  declare LdFont: boolean;
  declare TextMd: boolean;
  declare Param: FrmlPtr;
  // _copyfile
  declare CD: CopyDPtr;
  // _writeln: LF 0-write, 1-writeln, 2-message, 3-message+help
  declare LF: number;
  declare WD: WrLnD;
  declare mHlpRdb: RdbDPtr;
  declare mHlpFrml: FrmlPtr;
  // _gotoxy
  declare GoX: FrmlPtr;
  declare GoY: FrmlPtr;
  // _asgnloc, _asgnusercode, _asgnusername, _asgnaccright, _asgnedok, _asgnrand, _asgnusertoday;
  // Frml also for _setprinter, _sound, _delay (real), _setkeybuf, _headline, _sql (string)
  declare Frml: FrmlPtr;
  declare Add: boolean;
  declare AssLV: LocVarPtr;
  // _help
  declare Frml0: FrmlPtr;
  declare HelpRdb0: RdbDPtr;
  // _asgnpar, _asgnnrecs, _asgnfield
  declare Frml1: FrmlPtr;
  declare Add1: boolean;
  declare FD: FileDPtr;
  declare FldD: FieldDPtr;
  declare RecFrml: FrmlPtr;
  declare Indexarg: boolean;
  // _asgnrecfld
  declare Frml2: FrmlPtr;
  declare Add2: boolean;
  declare AssLV2: LocVarPtr;
  declare RecFldD: FieldDPtr;
  // _asgncatfield
  declare Frml3: FrmlPtr;
  declare FD3: FileDPtr;
  declare CatIRec: number;
  declare CatFld: FieldDPtr;
  // _asgnrecvar, _linkrec: case 0: (Ass) | 1: (LinkLD)
  declare RecLV1: LocVarPtr;
  declare RecLV2: LocVarPtr;
  declare Ass: AssignDPtr;
  declare LinkLD: LinkDPtr;
  // _asgnxnrecs
  declare xnrIdx: WKeyDPtr;
  // _readrec, _writerec, _recallrec, _deleterec (+ _appendrec: RecFD): case 0: (LV, ByKey, Key,
  // CompOp) | 1: (RecFD)
  declare RecNr: FrmlPtr;
  declare AdUpd: boolean;
  declare LV: LocVarPtr;
  declare ByKey: boolean;
  declare Key: KeyDPtr;
  declare CompOp: string;
  declare RecFD: FileDPtr;
  // _turncat
  declare NextGenFD: FileDPtr;
  declare FrstCatIRec: number;
  declare NCatIRecs: number;
  declare TCFrml: FrmlPtr;
  // _sort
  declare SortFD: FileDPtr;
  declare SK: KeyFldDPtr;
  // _edit
  declare EditFD: FileDPtr;
  declare EO: EditOptPtr;
  // _report
  declare RO: RprtOptPtr;
  // _edittxt, _printtxt
  declare TxtPath: StringPtr;
  declare TxtCatIRec: number;
  declare TxtLV: LocVarPtr;
  declare EdTxtMode: string;
  declare ExD: EdExitDPtr;
  declare WFlags: number;
  declare TxtPos: FrmlPtr;
  declare TxtXY: FrmlPtr;
  declare ErrMsg: FrmlPtr;
  declare Ww: WRectFrml;
  declare Atr: FrmlPtr;
  declare Hd: FrmlPtr;
  declare Head: FrmlPtr;
  declare Last: FrmlPtr;
  declare CtrlLast: FrmlPtr;
  declare AltLast: FrmlPtr;
  declare ShiftLast: FrmlPtr;
  // _puttxt
  declare TxtPath1: StringPtr;
  declare TxtCatIRec1: number;
  declare Txt: FrmlPtr;
  declare App: boolean;
  // _releasedrive
  declare Drive: FrmlPtr;
  // _mount
  declare MountCatIRec: number;
  declare MountNoCancel: boolean;
  // _indexfile
  declare IndexFD: FileDPtr;
  declare Compress: boolean;
  // _getindex: giMode '+', '-', ' '; giCond or RecNr-Frml
  declare giLV: LocVarPtr;
  declare giMode: string;
  declare giCond: FrmlPtr;
  declare giKD: KeyDPtr;
  declare giKFlds: KeyFldDPtr;
  declare giKIRoot: KeyInDPtr;
  declare giSQLFilter: boolean;
  declare giOwnerTyp: string;
  declare giLD: LinkDPtr;
  declare giLV2: LocVarPtr;
  // _window
  declare W: WRectFrml;
  declare Attr: FrmlPtr;
  declare WwInstr: InstrPtr;
  declare Top: FrmlPtr;
  declare WithWFlags: number;
  // _clrww
  declare W2: WRectFrml;
  declare Attr2: FrmlPtr;
  declare FillC: FrmlPtr;
  // _forall: CBool or SQLTxt
  declare CFD: FileDPtr;
  declare CKey: KeyDPtr;
  declare CVar: LocVarPtr;
  declare CRecVar: LocVarPtr;
  declare CKIRoot: KeyInDPtr;
  declare CBool: FrmlPtr;
  declare CInstr: InstrPtr;
  declare CLD: LinkDPtr;
  declare CWIdx: boolean;
  declare inSQL: boolean;
  declare CSQLFilter: boolean;
  declare CProcent: boolean;
  declare COwnerTyp: string;
  declare CLV: LocVarPtr;
  // _withshared, _withlocked, _withgraphics
  declare WDoInstr: InstrPtr;
  declare WElseInstr: InstrPtr;
  declare WasElse: boolean;
  declare WLD: LockD;
  // _graph
  declare GD: GraphDPtr;
  // _putpixel, _line, _rectangle, _ellipse, _floodfill, _outtextxy
  declare Par1: FrmlPtr;
  declare Par2: FrmlPtr;
  declare Par3: FrmlPtr;
  declare Par4: FrmlPtr;
  declare Par5: FrmlPtr;
  declare Par6: FrmlPtr;
  declare Par7: FrmlPtr;
  declare Par8: FrmlPtr;
  declare Par9: FrmlPtr;
  declare Par10: FrmlPtr;
  declare Par11: FrmlPtr;
  // _backup
  declare BrCatIRec: number;
  declare IsBackup: boolean;
  declare NoCompress: boolean;
  declare BrNoCancel: boolean;
  // _backupm: bmMasks backup only
  declare bmX: number[];
  declare bmDir: FrmlPtr;
  declare bmMasks: FrmlPtr;
  declare bmSubDir: boolean;
  declare bmOverwr: boolean;
  // _closefds
  declare clFD: FileDPtr;
  // _setedittxt
  declare Insert: FrmlPtr;
  declare Indent: FrmlPtr;
  declare Wrap: FrmlPtr;
  declare Just: FrmlPtr;
  declare ColBlk: FrmlPtr;
  declare Left: FrmlPtr;
  declare Right: FrmlPtr;
  // _setmouse
  declare MouseX: FrmlPtr;
  declare MouseY: FrmlPtr;
  declare Show: FrmlPtr;
  // _checkfile
  declare cfFD: FileDPtr;
  declare cfPath: StringPtr;
  declare cfCatIRec: number;
  // _login
  declare liName: FrmlPtr;
  declare liPassWord: FrmlPtr;
  // _sqlrdwrtxt
  declare TxtPath2: StringPtr;
  declare TxtCatIRec2: number;
  declare IsRead: boolean;
  declare sqlFD: FileDPtr;
  declare sqlKey: KeyDPtr;
  declare sqlFldD: FieldDPtr;
  declare sqlXStr: FrmlPtr;
  // _portout
  declare IsWord: FrmlPtr;
  declare Port: FrmlPtr;
  declare PortWhat: FrmlPtr;

  constructor(Kind: PInstrCode) {
    this.Kind = Kind;
  }
}
defineDefaults(Instr, {
  HdLine: null, HelpRdb: null, WasESCBranch: false, ESCInstr: null, Choices: null, Loop: false, PullDown: false,
  Shdw: false, X: null, Y: null, XSz: null, mAttr: () => [null, null, null, null],
  Bool: null, Instr: null, ElseInstr: null,
  Pos: () => new RdbPos(),
  N: 0, ExPar: false, TArg: () => [],
  lpPos: () => new RdbPos(), lpName: null,
  RdbNm: null, ProcNm: null, ProcCall: null,
  ProgPath: null, ProgCatIRec: 0, NoCancel: false, FreeMm: false, LdFont: false, TextMd: false, Param: null,
  CD: null,
  LF: 0, WD: () => new WrLnD(), mHlpRdb: null, mHlpFrml: null,
  GoX: null, GoY: null,
  Frml: null, Add: false, AssLV: null,
  HelpRdb0: null,
  FD: null, FldD: null, RecFrml: null, Indexarg: false,
  RecFldD: null,
  FD3: null, CatIRec: 0, CatFld: null,
  RecLV1: null, RecLV2: null, Ass: null, LinkLD: null,
  xnrIdx: null,
  RecNr: null, AdUpd: false, LV: null, ByKey: false, Key: null, CompOp: '\0', RecFD: null,
  NextGenFD: null, FrstCatIRec: 0, NCatIRecs: 0, TCFrml: null,
  SortFD: null, SK: null,
  EditFD: null, EO: null,
  RO: null,
  TxtPath: null, TxtCatIRec: 0, TxtLV: null, EdTxtMode: '\0', ExD: null, WFlags: 0, TxtPos: null, TxtXY: null,
  ErrMsg: null, Ww: () => new WRectFrml(), Atr: null, Hd: null, Head: null, Last: null, CtrlLast: null,
  AltLast: null, ShiftLast: null,
  Txt: null, App: false,
  Drive: null,
  MountCatIRec: 0, MountNoCancel: false,
  IndexFD: null, Compress: false,
  giLV: null, giMode: '\0', giCond: null, giKD: null, giKFlds: null, giKIRoot: null, giSQLFilter: false,
  giOwnerTyp: '\0', giLD: null, giLV2: null,
  W: () => new WRectFrml(), Attr: null, WwInstr: null, Top: null, WithWFlags: 0,
  FillC: null,
  CFD: null, CKey: null, CVar: null, CRecVar: null, CKIRoot: null, CBool: null, CInstr: null, CLD: null,
  CWIdx: false, inSQL: false, CSQLFilter: false, CProcent: false, COwnerTyp: '\0', CLV: null,
  WDoInstr: null, WElseInstr: null, WasElse: false, WLD: () => new LockD(),
  GD: null,
  Par1: null, Par2: null, Par3: null, Par4: null, Par5: null, Par6: null, Par7: null, Par8: null, Par9: null,
  Par10: null, Par11: null,
  BrCatIRec: 0, IsBackup: false, NoCompress: false, BrNoCancel: false,
  bmX: () => [0, 0, 0, 0, 0, 0], bmDir: null, bmMasks: null, bmSubDir: false, bmOverwr: false,
  clFD: null,
  Insert: null, Indent: null, Wrap: null, Just: null, ColBlk: null, Left: null, Right: null,
  MouseX: null, MouseY: null, Show: null,
  cfFD: null, cfPath: null, cfCatIRec: 0,
  liName: null, liPassWord: null,
  IsRead: false, sqlFD: null, sqlKey: null, sqlFldD: null, sqlXStr: null,
  IsWord: null, Port: null, PortWhat: null,
});
defineAliases(Instr, {
  Frml0: 'Frml', Frml1: 'Frml', Frml2: 'Frml', Frml3: 'Frml', Add1: 'Add', Add2: 'Add', AssLV2: 'AssLV',
  TxtPath1: 'TxtPath', TxtPath2: 'TxtPath', TxtCatIRec1: 'TxtCatIRec', TxtCatIRec2: 'TxtCatIRec',
  W2: 'W', Attr2: 'Attr', PPos: 'Pos', // PPos: _proc (RDPROLG) = Pos (RDPROC, RUNPROC)
});

// ---------------------------------------------------------------- unit state

let oldMXStr: XString | null = null;
let lvbd: LocVarBlkD | null = null;

export const RdRunVars = {
  OldMFlds: null as ConstList, // Merge + Report
  NewMFlds: null as ConstList,
  IDA: [null, null, null, null, null, null, null, null, null, null] as InpDPtr[], // [1..9]
  MaxIi: 0,
  get OldMXStr(): XString {
    return (oldMXStr ??= new XString()); // Merge
  },
  set OldMXStr(v: XString) {
    oldMXStr = v;
  },
  OutpFDRoot: null as OutpFDPtr,
  OutpRDs: null as OutpRDPtr,
  Join: false,

  PrintView: false, // Report
  Rprt: new TextFile(),
  RprtHd: null as BlkDPtr,
  PageHd: null as BlkDPtr,
  PageFt: null as BlkDPtr,
  PFZeroLst: null as FloatPtrList,
  FrstLvM: null as LvDescrPtr,
  LstLvM: null as LvDescrPtr, // LstLvM^.Ft=RF
  SelQuest: false,
  PgeSizeZ: null as FrmlPtr,
  PgeLimitZ: null as FrmlPtr,

  EditDRoot: null as EditDPtr, // Edit
  CompileFD: false,
  EditRdbMode: false,

  get LVBD(): LocVarBlkD {
    return (lvbd ??= new LocVarBlkD());
  },
  set LVBD(v: LocVarBlkD) {
    lvbd = v;
  },

  CalcTxt: '', // calc
  /** (Op, Group) is a formula node: FrmlAt(RdRunVars.MergOpGroup, { Op: 'Op', R: 'Group' }) */
  MergOpGroup: { Op: '\x10' /* _const */, Group: 0 as float },
};

// ---------------------------------------------------------------- routines

// PAS: RDRUN.PAS ResetLVBD
export function ResetLVBD(): void {
  const l = RdRunVars.LVBD;
  l.Root = null;
  l.NParam = 0;
  l.Size = 8; // 2*sizeof(pointer) in BP7: BPOfs of the first variable
}
// PAS: RDRUN.PAS SetMyBP
export function SetMyBP(Bp: ProcStkPtr): void {
  BaseVars.MyBP = Bp;
  RdRunVars.LVBD.Root = Bp !== null ? Bp.LVRoot : null;
}
// PAS: RDRUN.PAS PushProcStk – new frame for LVBD (zero values per FTyp, then Init formulas)
export function PushProcStk(): void {
  const ps = new ProcStkD(); // GetZStore(LVBD.Size)
  ps.ChainBack = BaseVars.MyBP;
  BaseVars.MyBP = ps;
  let lv = RdRunVars.LVBD.Root;
  ps.LVRoot = lv;
  // GetZStore: every slot of the frame starts as its typed zero
  for (let l = lv; l !== null; l = l.Chain) {
    if (l.FTyp === 'R' || l.FTyp === 'S') ps.V[l.BPOfs] = 0;
    else if (l.FTyp === 'B') ps.V[l.BPOfs] = false;
  }
  while (lv !== null) {
    if ((lv.FTyp === 'R' || lv.FTyp === 'S' || lv.FTyp === 'B') && lv.Init !== null) {
      LVAssignFrml(lv, BaseVars.MyBP, false, lv.Init);
    }
    lv = lv.Chain;
  }
}
// PAS: RDRUN.PAS PopProcStk
export function PopProcStk(): void {
  let lv = BaseVars.MyBP!.LVRoot;
  while (lv !== null) {
    if (lv.FTyp === 'S') AccessVars.TWork.Delete(LocVarAd(lv).v as number);
    lv = lv.Chain;
  }
  SetMyBP(BaseVars.MyBP!.ChainBack);
}

// PAS: RDRUN.PAS RunAddUpdte1 – the #A cumulations of CFile for the record CRecPtr (Kind '+' new,
// '-' deleted, 'd' changed from CRold); Back = undo (tracking), StopAD ends the undo pass
export function RunAddUpdte1(Kind: string, CRold: Uint8Array | null, Back: boolean, StopAD: AddDPtr, notLD: LinkDPtr): boolean {
  const a = AccessVars;
  // PAS: RDRUN.PAS RunAddUpdte1.CrIndRec
  const CrIndRec = (): void => {
    CreateRec(a.CFile!.NRecs + 1);
    RecallRec(a.CFile!.NRecs);
  };
  // PAS: RDRUN.PAS RunAddUpdte1.Link – CFile/CRecPtr := the record of AD^.File2 to update (N);
  // Kind2 '+' when it was created
  const Link = (AD: AddD, N: Ref<number>, Kind2: Ref<string>): boolean => {
    const LD = AD.LD;
    Kind2.v = 'd';
    if (LD !== null) {
      if (LinkUpw(LD, N, false)) return true;
      SetMsgPar(LD.RoleName);
    } else {
      if (!LinkLastRec(AD.File2, N, false)) {
        IncNRecs(1);
        WriteRec(1);
      }
      return true;
    }
    Kind2.v = '+';
    if (AD.Create === 2 || (AD.Create === 1 && PromptYN(132))) {
      ClearDeletedFlag();
      if (LD !== null && a.CFile!.Typ === 'X') {
        CrIndRec();
        N.v = a.CFile!.NRecs;
      } else CreateRec(N.v);
      return true;
    }
    WrLLF10Msg(119);
    return false;
  };
  // PAS: RDRUN.PAS RunAddUpdte1.TransAdd – the cumulations of the updated record itself
  const TransAdd = (
    AD: AddD, FD: FileDPtr, RP: Uint8Array | null, CRnew: Uint8Array | null, N: number, Kind2: string, Back: boolean,
  ): boolean => {
    if (a.CFile!.Add === null) return true;
    if (Kind2 === '+') {
      a.CRecPtr = CRnew;
      return RunAddUpdte1('+', null, Back, null, null);
    }
    const CRold = GetRecSpace();
    a.CRecPtr = CRold;
    ReadRec(N); // FandSQL: SelectXRec (not ported)
    a.CRecPtr = CRnew;
    const result = RunAddUpdte1('d', CRold, Back, null, null);
    ReleaseStore(CRold);
    return result;
  };
  // PAS: RDRUN.PAS RunAddUpdte1.Add
  const Add = (AD: AddD, RP: Uint8Array | null, R: float): boolean => {
    a.CRecPtr = RP;
    if (Back) R = -R;
    R_(AD.Field, _R(AD.Field) + R);
    if (AD.Chk === null) return true;
    if (!Back && !RunBool(AD.Chk.Bool)) {
      SetMsgPar(RunShortStr(AD.Chk.TxtZ));
      WrLLF10Msg(110);
      return false;
    }
    return true;
  };
  // PAS: RDRUN.PAS RunAddUpdte1.WrUpdRec
  const WrUpdRec = (AD: AddD, FD: FileDPtr, RP: Uint8Array | null, CRnew: Uint8Array | null, N: number): void => {
    a.CRecPtr = CRnew;
    WriteRec(N); // FandSQL: UpdateXFld (not ported)
  };
  // PAS: RDRUN.PAS RunAddUpdte1.Assign – '#A F:=frml (bool)' assignment into the linked record
  const Assign = (AD: AddD): boolean => {
    if (!RunBool(AD.Bool)) return true;
    const F = AD.Field!;
    const Z = AD.Frml;
    let R: float = 0;
    let S: LongStrPtr = new Uint8Array(0);
    let ss = '';
    let B = false;
    switch (F.FrmlTyp) {
      case 'R':
        R = RunReal(Z);
        break;
      case 'S':
        if (F.Typ === 'T') S = RunLongStr(Z);
        else ss = RunShortStr(Z);
        break;
      default:
        B = RunBool(Z);
    }
    const N2 = ref(0);
    const Kind2 = ref('\0');
    if (!Link(AD, N2, Kind2)) return false;
    switch (F.FrmlTyp) {
      case 'R':
        R_(F, R);
        break;
      case 'S':
        if (F.Typ === 'T') LongS_(F, S);
        else S_(F, ss);
        break;
      default:
        B_(F, B);
    }
    WriteRec(N2.v);
    return true;
  };

  let AD = a.CFile!.Add;
  const CF = a.CFile;
  const CR = a.CRecPtr;
  let ADback: AddDPtr = null;
  // one AD; false = goto fail
  const Step = (AD: AddD): boolean => {
    if (notLD !== null && AD.LD === notLD) return true;
    if (AD.Assign) return Assign(AD);
    let R = RunReal(AD.Frml);
    if (Kind === '-') R = -R;
    let Rold: float = 0;
    if (Kind === 'd') {
      a.CRecPtr = CRold;
      Rold = RunReal(AD.Frml);
    }
    ADback = AD;
    const CF2 = AD.File2;
    const N2 = ref(0);
    const N2old = ref(0);
    const Kind2 = ref('\0');
    const Kind2old = ref('\0');
    let CR2: Uint8Array | null = null;
    let CR2old: Uint8Array | null = null;
    if (R !== 0) {
      a.CRecPtr = CR;
      if (!Link(AD, N2, Kind2)) return false;
      CR2 = a.CRecPtr;
    }
    if (Rold !== 0) {
      a.CFile = CF;
      a.CRecPtr = CRold;
      if (!Link(AD, N2old, Kind2old)) return false;
      CR2old = a.CRecPtr;
      if (N2old.v === N2.v) {
        R = R - Rold;
        if (R === 0) return true;
        N2old.v = 0;
      }
    }
    if (N2.v === 0 && N2old.v === 0) return true;
    a.CFile = CF2;
    if (N2old.v !== 0) {
      if (!Add(AD, CR2old, -Rold)) return false;
    }
    if (N2.v !== 0) {
      if (!Add(AD, CR2, R)) return false;
    }
    if (N2old.v !== 0 && !TransAdd(AD, CF, CR, CR2old, N2old.v, Kind2old.v, false)) return false;
    if (N2.v !== 0 && !TransAdd(AD, CF, CR, CR2, N2.v, Kind2.v, false)) {
      if (N2old.v !== 0) TransAdd(AD, CF, CR, CR2old, N2old.v, Kind2old.v, true);
      return false;
    }
    if (N2old.v !== 0) WrUpdRec(AD, CF, CR, CR2old, N2old.v);
    if (N2.v !== 0) WrUpdRec(AD, CF, CR, CR2, N2.v);
    return true;
  };
  while (AD !== null) {
    if (AD === StopAD) return true; // ReleaseStore(p); exit
    if (!Step(AD)) {
      // fail:
      a.CFile = CF;
      a.CRecPtr = CR;
      if (ADback !== null) RunAddUpdte1(Kind, CRold, true, ADback, notLD); // backtracking
      return false;
    }
    // 1:
    a.CFile = CF;
    a.CRecPtr = CR;
    AD = AD.Chain;
  }
  return true;
}
// PAS: RDRUN.PAS LockForAdd – Kind 0: remember the lock modes of the #A target files,
// 1: lock them (md = the mode that failed), 2: return to the remembered modes
export function LockForAdd(FD: FileDPtr, Kind: number, Ta: boolean, md: Ref<LockMode>): boolean {
  const a = AccessVars;
  a.CFile = FD;
  let AD = FD!.Add;
  while (AD !== null) {
    if (a.CFile !== AD.File2) {
      a.CFile = AD.File2;
      const cf = a.CFile!;
      switch (Kind) {
        case 0:
          if (Ta) cf.TaLMode = cf.LMode;
          else cf.ExLMode = cf.LMode;
          break;
        case 1: {
          md.v = WrMode;
          if (AD.Create > 0) md.v = CrMode;
          const md1 = ref<LockMode>(NullMode);
          if (!TryLMode(md.v, md1, 2)) return false;
          break;
        }
        case 2:
          if (Ta) OldLMode(cf.TaLMode);
          else OldLMode(cf.ExLMode);
          break;
      }
      if (!LockForAdd(a.CFile, Kind, Ta, md)) return false;
    }
    AD = AD.Chain;
  }
  return true;
}
// PAS: RDRUN.PAS RunAddUpdte – Kind '+', '-', 'd'
export function RunAddUpdte(Kind: string, CRold: Uint8Array | null, notLD: LinkDPtr): boolean {
  const a = AccessVars;
  const CF = a.CFile;
  const md = ref<LockMode>(NullMode);
  LockForAdd(CF, 0, false, md);
  while (!LockForAdd(CF, 1, false, md)) {
    SetCPathVol();
    Set2MsgPar(BaseVars.CPath, LockModeTxt[md.v]);
    LockForAdd(CF, 2, false, md);
    const w = PushWrLLMsg(825, false);
    KbdTimer(BaseVars.Spec.NetDelay, 0);
    if (w !== 0) PopW(w);
  }
  a.CFile = CF;
  const b = RunAddUpdte1(Kind, CRold, false, null, notLD);
  LockForAdd(CF, 2, false, md);
  a.CFile = CF;
  return b;
}
// PAS: RDRUN.PAS TestExitKey
export function TestExitKey(KeyCode: number, X: EdExitD): boolean {
  for (let E = X.Keys; E !== null; E = E.Chain) {
    if (KeyCode === E.KeyCode) {
      AccessVars.EdBreak = E.Break;
      return true;
    }
  }
  return false;
}
// PAS: RDRUN.PAS SetCompileAll – force a full recompile (BP7: TimeStmp is the Real48 today+currtime)
export function SetCompileAll(): void {
  const tf = AccessVars.ChptTF!;
  tf.CompileAll = true;
  tf.TimeStmp = Today() + CurrTime();
  SetUpdHandle(tf.Handle);
}
