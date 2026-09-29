// PAS: ACCESS.PAS – the core data structures (files, fields, keys, links, formulas, local
// variables, RDBs), compare functions, file/record/field access, compiler input state.
// Includes (own modules, re-exported): TYPE.PAS -> type.ts, FILEACC.PAS -> fileacc.ts (TFile, FileD),
// INDEX.PAS -> index.ts (XString, XItem, XPage, XWFile, XFile, XKey, XWKey, XScan), RECACC.PAS -> recacc.ts.

import {
  defineDefaults, defineAliases, SysRunError, CopyRec, DirectorySeparator, type Ref, type Pointer, type DirStr,
  type NameStr,
} from './pasrt.ts';
import type { float, FloatPtr, StringPtr, CharArrPtr, LongStrPtr, ScreenStr, VolStr } from './base.ts';
import { BaseVars } from './base.ts';
import type { Instr } from './rdrun.ts';
import type { FileD, TFile } from './fileacc.ts';
import type { XKey, XWKey, XFile, XWFile, XString } from './index.ts';
import { TFile as TFileClass } from './fileacc.ts';
import { XWFile as XWFileClass } from './index.ts';
import { OldLMode } from './fileacc.ts';
import { RunError } from './obaseww.ts';
import { RdFldNameFrmlF } from './compile.ts';
import { xDecode } from '../fand/coding.ts';

export * from './type.ts';
export * from './fileacc.ts';
export * from './index.ts';
export * from './recacc.ts';

// ---------------------------------------------------------------- COMMON DECLARATION

export const LeftJust = 1; // RightJust=0, coded in M for Typ='N','A'
export const Ascend = 0; // used in SortKey
export const Descend = 6;
export const XPageSize = 1024;
export const XPageOverHead = 7;
export const MaxIndexLen = 123; // min. 4 items
export const oLeaf = 3;
export const oNotLeaf = 7;
export const f_Stored = 1; // FieldD flags
export const f_Encryp = 2;
export const f_Mask = 4;
export const f_Comma = 8;

// LockMode = (NullMode, NoExclMode, NoDelMode, NoCrMode, RdMode, WrMode, CrMode, DelMode, ExclMode)
export type LockMode = number;
export const NullMode = 0;
export const NoExclMode = 1;
export const NoDelMode = 2;
export const NoCrMode = 3;
export const RdMode = 4;
export const WrMode = 5;
export const CrMode = 6;
export const DelMode = 7;
export const ExclMode = 8;
export const LockModeTxt = ['NULL', 'NOEXCL', 'NODEL', 'NOCR', 'RD', 'WR', 'CR', 'DEL', 'EXCL'];

export const MPageSize = 512;
export const XPageShft = 10;
export const MPageShft = 9;

export type FrmlPtr = FrmlElem | null;
export type FileDPtr = FileD | null;
export type FieldDPtr = FieldDescr | null;
export type FieldList = FieldListEl | null;
export type FrmlList = FrmlListEl | null;
export type StringList = StringListEl | null;
export type FloatPtrList = FloatPtrListEl | null;
export type LinkDPtr = LinkD | null;
export type FuncDPtr = FuncD | null;
export type KeyDPtr = XKey | null;
export type WKeyDPtr = XWKey | null;
export type KeyList = KeyListEl | null;
export type LocVarPtr = LocVar | null;
export type KeyInDPtr = KeyInD | null;
export type SumElPtr = SumElem | null;
export type KeyFldDPtr = KeyFldD | null;
export type RdbDPtr = RdbD | null;
export type ChkDPtr = ChkD | null;
export type DepDPtr = DepD | null;
export type ImplDPtr = ImplD | null;
export type LiRootsPtr = LiRoots | null;
export type AddDPtr = AddD | null;
export type TFilePtr = TFile | null;
export type XFilePtr = XFile | null;
export type XWFilePtr = XWFile | null;
export type XStringPtr = XString | null;
export type CompInpDPtr = CompInpD | null;

// PAS: ACCESS.PAS FieldListEl
export class FieldListEl {
  Chain: FieldList = null;
  FldD: FieldDPtr = null;
}
// PAS: ACCESS.PAS FrmlListEl
export class FrmlListEl {
  Chain: FrmlList = null;
  Frml: FrmlPtr = null;
}
// PAS: ACCESS.PAS StringListEl
export class StringListEl {
  Chain: StringList = null;
  S = '';
  /** TS: bytes Pascal stores right after S in the same block (ViewNames: user codes). */
  After = '';
}
// PAS: ACCESS.PAS FloatPtrListEl
export class FloatPtrListEl {
  Chain: FloatPtrList = null;
  RPtr: FloatPtr = null;
}
// PAS: ACCESS.PAS KeyListEl
export class KeyListEl {
  Chain: KeyList = null;
  Key: KeyDPtr = null;
}

// PAS: ACCESS.PAS FrmlElem – a formula node; the variant is chosen by Op (see the op
// constants below). All variant fields read as zero/nil until set (prototype defaults, like
// GetZStore). FrmlPtr fields sharing a Pascal offset are aliases:
// P1 = PP1 = P011 = Frml = PPP1 = PPPP1 = PPPPP1 = PPPPPP1 = EvalP1 = ownBool,
// P2 = PP2 = PPP2 = PPPP2 = ownSum, P3 = PP3. Other overlays (N.., W.. over the pointers) are separate.
export class FrmlElem {
  declare Op: string;
  // 0: generic operands
  declare P1: FrmlPtr;
  declare P2: FrmlPtr;
  declare P3: FrmlPtr;
  declare P4: FrmlPtr;
  declare P5: FrmlPtr;
  declare P6: FrmlPtr;
  declare Delim: string;
  // 1: bytes / words
  declare N01: number;
  declare N02: number;
  declare N03: number;
  declare N04: number;
  declare N11: number;
  declare N12: number;
  declare N13: number;
  declare N14: number;
  declare N21: number;
  declare N22: number;
  declare N23: number;
  declare N24: number;
  declare N31: number;
  declare W01: number;
  declare W02: number;
  declare W11: number;
  declare W12: number;
  declare W21: number;
  declare W22: number;
  // 2, 4, 5: constants
  declare R: float;
  declare S: string;
  declare B: boolean;
  // 6
  declare PP1: FrmlPtr;
  declare Mask: ScreenStr;
  // 7: _field
  declare Field: FieldDPtr;
  // 7: _access (LD=nil for param), _recvarfld (LD=RecPtr: Pascal casts the record buffer into LD,
  //    which overlays NewRP – in TS keep the buffer in NewRP and the file in File2)
  declare P011: FrmlPtr;
  declare File2: FileDPtr;
  declare LD: LinkDPtr;
  // 8: _newfile
  declare Frml: FrmlPtr;
  declare NewFile: FileDPtr;
  declare NewRP: Uint8Array | null;
  // 9: _lastupdate, _generation
  declare FD: FileDPtr;
  // 10: _catfield
  declare CatIRec: number;
  declare CatFld: FieldDPtr;
  // 11: _prompt
  declare PPP1: FrmlPtr;
  declare PP2: FrmlPtr;
  declare FldD: FieldDPtr;
  // 12: _pos, _replace
  declare PPPP1: FrmlPtr;
  declare PPP2: FrmlPtr;
  declare PP3: FrmlPtr;
  declare Options: ScreenStr;
  // 13: _recno (typ 'R' or 'S'), _recnoabs, _recnolog; Arg is 1-based, as many as key fields
  declare FFD: FileDPtr;
  declare Key: KeyDPtr;
  declare Arg: FrmlPtr[];
  // 14: _accrecno, _isdeleted
  declare PPPPP1: FrmlPtr;
  declare RecFD: FileDPtr;
  declare RecFldD: FieldDPtr;
  // 15: _link
  declare LinkLD: LinkDPtr;
  declare LinkFromRec: boolean;
  declare LinkLV: LocVarPtr;
  declare LinkRecFrml: FrmlPtr;
  // 16: _gettxt, _filesize
  declare PPPPPP1: FrmlPtr;
  declare PPPP2: FrmlPtr;
  declare TxtPath: StringPtr;
  declare TxtCatIRec: number;
  // 18: _getlocvar
  declare BPOfs: number;
  // 19: _userfunc
  declare FC: FuncDPtr;
  declare FrmlL: FrmlList;
  // 20: _keyof, _lvdeleted
  declare LV: LocVarPtr;
  declare PackKey: KeyDPtr;
  // 21: _eval
  declare EvalP1: FrmlPtr;
  declare EvalTyp: string;
  declare EvalFD: FileDPtr;
  // 22: _indexnrecs
  declare WKey: WKeyDPtr;
  // 23: _owned
  declare ownBool: FrmlPtr;
  declare ownSum: FrmlPtr;
  declare ownLD: LinkDPtr;
  /** TS: FPC FrmlInline(X) – the bytes GetOp(Op, BytesAfter) reserved after the node
   *  (_instr/_inreal constant lists, _modulo weights, _trust byte string). */
  declare Inline: Uint8Array | null;

  constructor(Op = '\0') {
    if (Op !== '\0') this.Op = Op;
  }
}
defineDefaults(FrmlElem, {
  Op: '\0', P1: null, P2: null, P3: null, P4: null, P5: null, P6: null, Delim: '\0',
  N01: 0, N02: 0, N03: 0, N04: 0, N11: 0, N12: 0, N13: 0, N14: 0, N21: 0, N22: 0, N23: 0, N24: 0, N31: 0,
  W01: 0, W02: 0, W11: 0, W12: 0, W21: 0, W22: 0,
  R: 0, S: '', B: false, Mask: '', Field: null, File2: null, LD: null, NewFile: null, NewRP: null, FD: null,
  CatIRec: 0, CatFld: null, FldD: null, Options: '', FFD: null, Key: null, Arg: () => [null, null, null],
  RecFD: null, RecFldD: null, LinkLD: null, LinkFromRec: false, LinkLV: null, LinkRecFrml: null,
  TxtPath: null, TxtCatIRec: 0, BPOfs: 0, FC: null, FrmlL: null, LV: null, PackKey: null,
  EvalTyp: '\0', EvalFD: null, WKey: null, ownLD: null, Inline: null,
});
defineAliases(FrmlElem, {
  PP1: 'P1', P011: 'P1', Frml: 'P1', PPP1: 'P1', PPPP1: 'P1', PPPPP1: 'P1', PPPPPP1: 'P1', EvalP1: 'P1', ownBool: 'P1',
  PP2: 'P2', PPP2: 'P2', PPPP2: 'P2', ownSum: 'P2',
  PP3: 'P3',
});

const frmlViews = new WeakMap<object, Map<string, FrmlElem>>();
/**
 * TS-only: PAS `FrmlPtr(@X^.Op)` – a record whose (Op, value) fields double as a formula node
 * (LocVar: Op/BPOfs, SumElem: Op/R, InpD: Op/Count, OpErr/Error, OpWarn/Warning, MergOpGroup).
 * `map` names FrmlElem fields -> fields of X; the view reads/writes X live and is cached per map.
 */
export function FrmlAt<X extends object>(x: X, map: Partial<Record<keyof FrmlElem, keyof X>>): FrmlElem {
  const key = JSON.stringify(map);
  let m = frmlViews.get(x);
  if (!m) frmlViews.set(x, (m = new Map()));
  let z = m.get(key);
  if (!z) {
    z = new FrmlElem();
    for (const [zf, xf] of Object.entries(map) as [string, keyof X][]) {
      Object.defineProperty(z, zf, {
        get: () => x[xf],
        set: (v) => {
          x[xf] = v;
        },
        enumerable: true,
      });
    }
    m.set(key, z);
  }
  return z;
}

// PAS: ACCESS.PAS KeyInD
export class KeyInD {
  Chain: KeyInDPtr = null;
  FL1: FrmlList = null;
  FL2: FrmlList = null; // FL2=nil only 1 value, else interval
  XNrBeg = 0; // set by xscan
  N = 0;
  X1: StringPtr = null;
  X2: StringPtr = null;
}

// PAS: ACCESS.PAS SumElem – (Op, R) is also a _const formula: FrmlAt(sum, { Op: 'Op', R: 'R' })
export class SumElem {
  Chain: SumElPtr = null;
  Op = '\0';
  R: float = 0;
  Frml: FrmlPtr = null;
}

// PAS: ACCESS.PAS FieldDescr – case Stored of True: (Displ) | False: (Frml; Name) – Name is always
// present; FieldDMask(F) is the string stored after Name (Mask).
export class FieldDescr {
  Chain: FieldDPtr = null;
  Typ = '\0';
  FrmlTyp = '\0';
  L = 0;
  M = 0;
  NBytes = 0;
  Flg = 0;
  Displ = 0;
  Frml: FrmlPtr = null;
  Name = '';
  /** TS: the edit mask Pascal stores after Name (see FieldDMask) */
  Mask = '';
}

// PAS: ACCESS.PAS KeyFldD
export class KeyFldD {
  Chain: KeyFldDPtr = null;
  FldD: FieldDPtr = null;
  CompLex = false;
  Descend = false;
}

// PAS: ACCESS.PAS RdbPos – with IRec=0 Pascal stores a string formula in R
// (`RdbDPtr(RdStrFrml)`, chapter named by an expression): that formula is kept in Frml (TS-only).
export class RdbPos {
  R: RdbDPtr = null;
  IRec = 0;
  Frml: FrmlPtr = null;
}

// PAS: ACCESS.PAS ChkD
export class ChkD {
  Chain: ChkDPtr = null;
  Bool: FrmlPtr = null;
  HelpName: StringPtr = null;
  TxtZ: FrmlPtr = null;
  Warning = false;
}

// PAS: ACCESS.PAS DepD
export class DepD {
  Chain: DepDPtr = null;
  Bool: FrmlPtr = null;
  Frml: FrmlPtr = null;
}

// PAS: ACCESS.PAS ImplD
export class ImplD {
  Chain: ImplDPtr = null;
  FldD: FieldDPtr = null;
  Frml: FrmlPtr = null;
}

// PAS: ACCESS.PAS LiRoots
export class LiRoots {
  Chks: ChkDPtr = null;
  Impls: ImplDPtr = null;
}

// PAS: ACCESS.PAS AddD – case Assign of true: (Bool) | false: (Chk)
export class AddD {
  Chain: AddDPtr = null;
  Field: FieldDPtr = null;
  File2: FileDPtr = null;
  LD: LinkDPtr = null;
  Create = 0; // 0- no, 1-!, 2-!!
  Frml: FrmlPtr = null;
  Assign = false;
  Bool: FrmlPtr = null;
  Chk: ChkDPtr = null;
}

/** array[1..20] of char – a 20-char byte string */
export type PwCodeArr = string;

// PAS: ACCESS.PAS DBaseFld (on-disk .DBF field descriptor, 32 bytes)
export class DBaseFld {
  Name = ''; // array[0..10] of char, zero-terminated
  Typ = '\0';
  Displ = 0;
  Len = 0;
  Dec = 0;
  x2 = new Uint8Array(14);
}

// PAS: ACCESS.PAS DBaseHd (on-disk .DBF header, 32 bytes + fields)
export class DBaseHd {
  Ver = 0;
  Date = [0, 0, 0, 0]; // [1..3]
  NRecs = 0;
  HdLen = 0;
  RecLen = 0;
  x = new Uint8Array(20);
  Flds: DBaseFld[] = [new DBaseFld()]; // [1..]
}

// PAS: ACCESS.PAS LinkD
export class LinkD {
  Chain: LinkDPtr = null;
  IndexRoot = 0;
  MemberRef = 0; // 0-no, 1-!, 2-!!(no delete)
  Args: KeyFldDPtr = null;
  FromFD: FileDPtr = null;
  ToFD: FileDPtr = null;
  ToKey: KeyDPtr = null;
  RoleName = '';
}

// PAS: ACCESS.PAS LocVarBlkD
export class LocVarBlkD {
  Root: LocVarPtr = null;
  NParam = 0;
  Size = 0;
}

// PAS: ACCESS.PAS FuncD
export class FuncD {
  Chain: FuncDPtr = null;
  FTyp = '\0';
  LVB = new LocVarBlkD(); // 1.LV is result
  Instr: Instr | null = null;
  Name = '';
}

// PAS: ACCESS.PAS LocVar – case FTyp of 'r','f','i': (FD; RecPtr) | 'S','R','B': (Op; BPOfs;
// IsRetPar; Init); Name in both. (Op, BPOfs) is a _getlocvar formula: FrmlAt(lv, {Op:'Op', BPOfs:'BPOfs'}).
export class LocVar {
  Chain: LocVarPtr = null;
  IsPar = false;
  FTyp = '\0';
  FD: FileDPtr = null;
  /** record buffer ('r'), work index XWKey ('i') */
  RecPtr: Uint8Array | XWKey | null = null;
  Name = '';
  Op = '\0';
  BPOfs = 0;
  IsRetPar = false;
  Init: FrmlPtr = null;
}

// PAS: ACCESS.PAS RdbD
export class RdbD {
  ChainBack: RdbDPtr = null;
  FD: FileDPtr = null; // FD=FileDRoot and =Chpt for this RDB
  HelpFD: FileDPtr = null;
  OldLDRoot: LinkDPtr = null;
  OldFCRoot: FuncDPtr = null;
  Mark2: Pointer = null; // markstore2 at beginning
  Encrypted = false;
  RdbDir: DirStr = '';
  DataDir: DirStr = '';
}

/** TS-only: the Pascal sentinel `ptr(0,1)` put into InpRdbPos.R by SetInpLongStr(S, ShowErr=true). */
export const ShowErrRdb: RdbD = new RdbD();

// PAS: ACCESS.PAS WRectFrml
export class WRectFrml {
  C1: FrmlPtr = null;
  R1: FrmlPtr = null;
  C2: FrmlPtr = null;
  R2: FrmlPtr = null;
}

// PAS: ACCESS.PAS CompInpD
export class CompInpD {
  ChainBack: CompInpDPtr = null;
  InpArrPtr: CharArrPtr = null;
  InpRdbPos = new RdbPos();
  InpArrLen = 0;
  CurrPos = 0;
  OldErrPos = 0;
}

// ---------------------------------------------------------------- formula op codes (chars)
// #$0...#$5f = 0-ary, #$60...#$af = 1-ary, #$b0...#$ef = 2-ary, #$f0.. = 3-ary

export const _equ = '\x01'; // lexema
export const _lt = '\x02';
export const _le = '\x03';
export const _gt = '\x04';
export const _ge = '\x05';
export const _ne = '\x06';
export const _subrange = '\x07';
export const _number = '\x08';
export const _assign = '\x09';
export const _identifier = '\x0a';
export const _addass = '\x0b';
export const _quotedstr = '\x0c';
export const _const = '\x10'; // float/string/boolean               0-ary instructions
export const _field = '\x11'; // fieldD
export const _getlocvar = '\x12'; // BPOfs
export const _access = '\x13'; // fieldD or nil for exist, newfileD, linkD or nil
export const _recvarfld = '\x14'; // fieldD, fileD, recptr
export const _today = '\x18';
export const _currtime = '\x19';
export const _pi = '\x1a';
export const _random = '\x1b';
export const _exitcode = '\x1d';
export const _edrecno = '\x1e';
export const _getwordvar = '\x1f'; // n:0..
export const _memavail = '\x22';
export const _maxcol = '\x23';
export const _maxrow = '\x24';
export const _getmaxx = '\x25';
export const _getmaxy = '\x26';
export const _lastupdate = '\x27';
export const _nrecs = '\x28';
export const _nrecsabs = '\x29'; // FD
export const _generation = '\x2a'; // FD
export const _recno = '\x2b';
export const _recnoabs = '\x2c';
export const _recnolog = '\x2d'; // FD,K,Z1,Z2,...
export const _filesize = '\x2e'; // txtpath,txtcatirec
export const _txtpos = '\x2f';
export const _cprinter = '\x30';
export const _mousex = '\x31';
export const _mousey = '\x32';
export const _txtxy = '\x33';
export const _indexnrecs = '\x34';
export const _owned = '\x35'; // bool,sum,ld   R
export const _catfield = '\x36'; // CatIRec,CatFld
export const _password = '\x37';
export const _version = '\x38';
export const _username = '\x39';
export const _edfield = '\x3a';
export const _accright = '\x3b';
export const _readkey = '\x3c';
export const _edreckey = '\x3d';
export const _edbool = '\x3e';
export const _edfile = '\x3f';
export const _edkey = '\x40';
export const _clipbd = '\x41';
export const _keybuf = '\x42';
export const _keyof = '\x43'; // LV,KeyD   S
export const _edupdated = '\x44';
export const _keypressed = '\x45';
export const _escprompt = '\x46';
export const _trust = '\x47'; // bytestring
export const _lvdeleted = '\x48'; // LV   B
export const _userfunc = '\x49'; // fc,frmllist
export const _isnewrec = '\x4a';
export const _mouseevent = '\x4b';
export const _ismouse = '\x4c'; // what,button-masks
export const _testmode = '\x4d';
export const _newfile = '\x60'; // newfile,newRP                     1-ary instructions
export const _lneg = '\x61';
export const _inreal = '\x62'; // precision,constlst
export const _instr = '\x63'; // tilda,constlst
export const _isdeleted = '\x64'; // RecFD
export const _setmybp = '\x65';
export const _modulo = '\x66'; // length,modulo,weight1,...   B
export const _getpath = '\x68';
export const _upcase = '\x69';
export const _lowcase = '\x6a';
export const _leadchar = '\x6b';
export const _getenv = '\x6c';
export const _trailchar = '\x6d'; // char
export const _strdate = '\x6e'; // maskstring
export const _nodiakr = '\x6f'; // S
export const _char = '\x70';
export const _sqlfun = '\x71'; // SR
export const _unminus = '\x73';
export const _abs = '\x74';
export const _int = '\x75';
export const _frac = '\x76';
export const _sqr = '\x77';
export const _sqrt = '\x78';
export const _sin = '\x79';
export const _cos = '\x7a';
export const _arctan = '\x7b';
export const _ln = '\x7c';
export const _exp = '\x7d';
export const _typeday = '\x7e';
export const _color = '\x7f';
export const _link = '\x90'; // LD   R
export const _val = '\x91';
export const _valdate = '\x92'; // maskstring
export const _length = '\x93';
export const _linecnt = '\x94';
export const _diskfree = '\x95';
export const _ord = '\x96';
export const _eval = '\x97'; // Typ   RS
export const _accrecno = '\x98'; // FD,FldD   R,S,B
export const _promptyn = '\x99'; // BS
export const _conv = '\xa0'; // used in Prolog
export const _and = '\xb1'; //                                        2-ary instructions
export const _or = '\xb2';
export const _limpl = '\xb3';
export const _lequ = '\xb4';
export const _compreal = '\xb5'; // compop,precision
export const _compstr = '\xb6'; // compop,tilda   B
export const _concat = '\xc0'; // S
export const _repeatstr = '\xc2'; // SSR
export const _gettxt = '\xc3'; // txtpath,txtcatirec   SRR
export const _plus = '\xc4';
export const _minus = '\xc5';
export const _times = '\xc6';
export const _divide = '\xc7';
export const _div = '\xc8';
export const _mod = '\xc9';
export const _round = '\xca';
export const _addwdays = '\xcb';
export const _difwdays = '\xcc'; // typday
export const _addmonth = '\xcd';
export const _difmonth = '\xce';
export const _inttsr = '\xcf'; // ptr
export const _min = '\xd0';
export const _max = '\xd1'; // used in Prolog   R
export const _equmask = '\xd2'; // BSS
export const _prompt = '\xd3'; // fieldD   R,S,B
export const _portin = '\xd4'; // RBR
export const _cond = '\xf0'; // bool or nil,frml,continue or nil     3-ary instructions
export const _copy = '\xf1';
export const _str = '\xf2'; // S
export const _selectstr = '\xf3';
export const _copyline = '\xf4'; // SSRR
export const _pos = '\xf5'; // options
export const _replace = '\xf6'; // options   RSSR
export const _mousein = '\xf7'; // P4

// ---------------------------------------------------------------- unit state

export const FloppyDrives = 3;
export const Power10 = [1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20];

/** Names of the consecutive word variables that WordVarArr[0..7] overlays (absolute RprtLine). */
export const WordVarNames = ['RprtLine', 'RprtPage', 'PgeLimit', 'EdBreak', 'EdIRec', 'MenuX', 'MenuY', 'UserCode'] as const;

let twork: TFile | null = null;
let xwork: XWFile | null = null;

export const AccessVars = {
  FileDRoot: null as FileDPtr, // only current RDB
  LinkDRoot: null as LinkDPtr, // for all RDBs
  FuncDRoot: null as FuncDPtr,
  CFile: null as FileDPtr,
  CRecPtr: null as Uint8Array | null,
  CViewKey: null as KeyDPtr,
  TopRdbDir: '' as DirStr,
  TopDataDir: '' as DirStr,
  CatFDName: '' as NameStr,
  CRdb: null as RdbDPtr,
  TopRdb: null as RdbDPtr,
  CatFD: null as FileDPtr,
  HelpFD: null as FileDPtr,

  XPath: Array.from({ length: 11 }, () => ({ Page: 0, I: 0 })), // [1..10]
  XPathN: 0,
  get XWork(): XWFile {
    return (xwork ??= new XWFileClass());
  },
  set XWork(v: XWFile) {
    xwork = v;
  },
  get TWork(): TFile {
    return (twork ??= new TFileClass());
  },
  set TWork(v: TFile) {
    twork = v;
  },
  ClpBdPos: 0,
  IsTestRun: false,
  IsInstallRun: false,

  /** Chpt: FileDPtr absolute FileDRoot */
  get Chpt(): FileDPtr {
    return this.FileDRoot;
  },
  set Chpt(v: FileDPtr) {
    this.FileDRoot = v;
  },
  ChptTF: null as TFilePtr,
  ChptTxtPos: null as FieldDPtr,
  ChptVerif: null as FieldDPtr, // updated record
  ChptOldTxt: null as FieldDPtr, // ChptTyp='F': -1 = new unchecked record, else = old declaration
  ChptTyp: null as FieldDPtr,
  ChptName: null as FieldDPtr,
  ChptTxt: null as FieldDPtr,

  EscPrompt: false,
  UserName: '',
  UserPassword: '',
  AccRight: '\0',
  EdUpdated: false,
  EdRecNo: 0,
  EdRecKey: '',
  EdKey: '',
  EdOk: false,
  EdField: '',
  LastTxtPos: 0,
  TxtXY: 0,
  // consecutive word-sized (for formula access: WordVarArr, see GetWordVar/SetWordVar)
  RprtLine: 0, // report
  RprtPage: 0,
  PgeLimit: 0,
  EdBreak: 0, // common - alphabetical order
  EdIRec: 1,
  MenuX: 1,
  MenuY: 1,
  UserCode: 0,
  CatRdbName: null as FieldDPtr,
  CatFileName: null as FieldDPtr,
  CatArchiv: null as FieldDPtr,
  CatPathName: null as FieldDPtr,
  CatVolume: null as FieldDPtr,
  MountedVol: ['', '', '', ''] as VolStr[], // [1..FloppyDrives] 1=A,2=B,3=CPMDrive
  SQLDateMask: 'DD.MM.YYYY hh:mm:ss',

  // Compile
  CurrChar: '\0',
  ForwChar: '\0',
  ExpChar: '\0',
  Lexem: '\0',
  LexWord: '',
  SpecFDNameAllowed: false,
  IdxLocVarAllowed: false,
  FDLocVarAllowed: false,
  IsCompileErr: false,
  PrevCompInp: null as CompInpDPtr, // saved at "include"
  InpArrPtr: null as CharArrPtr,
  InpRdbPos: new RdbPos(),
  InpArrLen: 0,
  CurrPos: 0,
  OldErrPos: 0,
  FrmlSumEl: null as SumElPtr, // set while reading sum/count argument
  FrstSumVar: false,
  FileVarsAllowed: false,
  RdFldNameFrml: null as ((FTyp: Ref<string>) => FrmlPtr) | null,
  RdFunction: null as ((FTyp: Ref<string>) => FrmlPtr) | null,
  ChainSumEl: null as (() => void) | null, // set by user
  LstCompileVar: 0, // boundary

  Switches: '',
  SwitchLevel: 0,
};

/** PAS: WordVarArr: array[0..8] of word absolute RprtLine – WordVarArr[i] reads/writes AccessVars. */
export const WordVarArr: number[] = new Proxy([] as number[], {
  get(t, k) {
    const i = typeof k === 'string' ? Number(k) : NaN;
    return i >= 0 && i < WordVarNames.length ? AccessVars[WordVarNames[i]] : Reflect.get(t, k);
  },
  set(t, k, v) {
    const i = typeof k === 'string' ? Number(k) : NaN;
    if (i >= 0 && i < WordVarNames.length) AccessVars[WordVarNames[i]] = v & 0xffff;
    else Reflect.set(t, k, v);
    return true;
  },
});

/** TS-only: WordVarArr[i] read (absolute RprtLine). */
export function GetWordVar(i: number): number {
  return AccessVars[WordVarNames[i]];
}
/** TS-only: WordVarArr[i] := v. */
export function SetWordVar(i: number, v: number): void {
  AccessVars[WordVarNames[i]] = v & 0xffff;
}

// ---------------------------------------------------------------- routines

// PAS: ACCESS.PAS FieldDMask
export function FieldDMask(F: FieldDescr): StringPtr {
  return F.Mask;
}

// PAS: ACCESS.PAS RunErrorM
export function RunErrorM(Md: LockMode, N: number): never {
  OldLMode(Md);
  return RunError(N);
}

// Compare functions return ord(_equ)=1, ord(_lt)=2, ord(_gt)=4.

// PAS: ACCESS.PAS CompLongStr
export function CompLongStr(S1: LongStrPtr, S2: LongStrPtr): number {
  const n = Math.min(S1.length, S2.length);
  for (let i = 0; i < n; i++) {
    if (S1[i] !== S2[i]) return S1[i] < S2[i] ? 2 : 4;
  }
  return S1.length < S2.length ? 2 : S1.length > S2.length ? 4 : 1;
}
// PAS: ACCESS.PAS CompStr
export function CompStr(S1: string, S2: string): number {
  const n = Math.min(S1.length, S2.length);
  for (let i = 0; i < n; i++) {
    const a = S1.charCodeAt(i);
    const b = S2.charCodeAt(i);
    if (a !== b) return a < b ? 2 : 4;
  }
  return S1.length < S2.length ? 2 : S1.length > S2.length ? 4 : 1;
}
// PAS: ACCESS.PAS CompLongShortStr – S1 limited to 255
export function CompLongShortStr(S1: LongStrPtr, S2: StringPtr): number {
  const l1 = Math.min(S1.length, 255);
  const s2 = S2 ?? '';
  const n = Math.min(l1, s2.length);
  for (let i = 0; i < n; i++) {
    const b = s2.charCodeAt(i);
    if (S1[i] !== b) return S1[i] < b ? 2 : 4;
  }
  return l1 < s2.length ? 2 : l1 > s2.length ? 4 : 1;
}
// PAS: ACCESS.PAS CompArea
export function CompArea(A: Uint8Array, B: Uint8Array, L: number): number {
  for (let i = 0; i < L; i++) {
    if (A[i] !== B[i]) return A[i] < B[i] ? 2 : 4;
  }
  return 1;
}
// PAS: ACCESS.PAS TranslateOrd (BP7 asm, near) – S[0..Len-1] through CharOrdTab; a 'c' followed
// by 'h' (CharOrdTab $43, $49) becomes the single letter 'ch' ($4A, sorted after H). Not FandAng.
// TS signature: returns the translated bytes (Pascal writes a length-prefixed string at ss:di and,
// with dx=1, a 0 after it, which CmpLxStr needs to compare past the shorter string).
export function TranslateOrd(S: ArrayLike<number>, Len: number): Uint8Array {
  const tab = BaseVars.CharOrdTab;
  const out = new Uint8Array(Len);
  let n = 0;
  for (let i = 0; i < Len; i++) {
    const al = tab[S[i] & 0xff];
    if (al === 0x49 && n > 0 && out[n - 1] === 0x43) out[n - 1] = 0x4a; // ch
    else out[n++] = al;
  }
  return out.subarray(0, n);
}
/** TS-only: BP7 CmpLxStr – compares two TranslateOrd results (shorter prefix is less). */
function CmpLxStr(A: Uint8Array, B: Uint8Array): number {
  const n = Math.min(A.length, B.length);
  for (let i = 0; i < n; i++) if (A[i] !== B[i]) return A[i] < B[i] ? 2 : 4;
  return A.length === B.length ? 1 : A.length < B.length ? 2 : 4;
}
/** TS-only: the chars of a byte string as bytes (for TranslateOrd). */
function StrCodes(s: string): number[] {
  const a = new Array<number>(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
// PAS: ACCESS.PAS CompLexLongStr – BP7 TranslateOrd: CharOrdTab + the Czech 'ch' ligature; max 255
export function CompLexLongStr(S1: LongStrPtr, S2: LongStrPtr): number {
  const Str11 = TranslateOrd(S1, Math.min(S1.length, 255));
  const Str22 = TranslateOrd(S2, Math.min(S2.length, 255));
  return CmpLxStr(Str11, Str22);
}
// PAS: ACCESS.PAS CompLexLongShortStr
export function CompLexLongShortStr(S1: LongStrPtr, S2: StringPtr): number {
  const s2 = S2 ?? '';
  const Str11 = TranslateOrd(S1, Math.min(S1.length, 255));
  const Str22 = TranslateOrd(StrCodes(s2), s2.length);
  return CmpLxStr(Str11, Str22);
}
// PAS: ACCESS.PAS CompLexStr
export function CompLexStr(S1: string, S2: string): number {
  const Str11 = TranslateOrd(StrCodes(S1), S1.length);
  const Str22 = TranslateOrd(StrCodes(S2), S2.length);
  return CmpLxStr(Str11, Str22);
}
// PAS: ACCESS.PAS EquKFlds
export function EquKFlds(KF1: KeyFldDPtr, KF2: KeyFldDPtr): boolean {
  while (KF1 !== null) {
    if (KF2 === null || KF1.CompLex !== KF2.CompLex || KF1.Descend !== KF2.Descend || KF1.FldD!.Name !== KF2.FldD!.Name) {
      return false;
    }
    KF1 = KF1.Chain;
    KF2 = KF2.Chain;
  }
  return KF2 === null;
}
// PAS: ACCESS.PAS Code – XOR $AA
export function Code(A: Uint8Array, L: number): void {
  for (let i = 0; i < L; i++) A[i] ^= 0xaa;
}
// PAS: ACCESS.PAS XDecode (private) – decompresses a licence-coded chapter text; Pascal works in
// place and sets S^.LL, here the result is a new array (fand/coding.ts xDecode, the same algorithm).
function XDecode(S: LongStrPtr): LongStrPtr {
  if (S.length === 0) return S;
  return xDecode(S);
}
// PAS: ACCESS.PAS CodingLongStr – Code (in place) or XDecode; may return a new array
export function CodingLongStr(S: LongStrPtr): LongStrPtr {
  if (AccessVars.CFile!.TF!.LicenseNr === 0) {
    Code(S, S.length);
    return S;
  }
  return XDecode(S);
}
// PAS: ACCESS.PAS DirMinusBackslash (private, unused in FAND)
export function DirMinusBackslash(D: Ref<DirStr>): void {
  if (D.v.length > 3 && D.v[D.v.length - 1] === DirectorySeparator) D.v = D.v.slice(0, -1);
}

// PAS: ACCESS.PAS LocVarAd – the value slot of a 'S','R','B' local variable in the frame MyBP
export function LocVarAd(LV: LocVar): Ref<number | boolean> {
  const bp = BaseVars.MyBP;
  if (!bp) return SysRunError(204);
  const o = LV.BPOfs;
  return {
    get v() {
      return bp.V[o];
    },
    set v(x: number | boolean) {
      bp.V[o] = x;
    },
  };
}

// ---------------------------------------------------------------- FILE MANAGEMENT

// PAS: ACCESS.PAS GetRecSpace – RecLen+2: [RecLen] texts in TWork?, [RecLen+1] data updated?
export function GetRecSpace(): Uint8Array {
  return new Uint8Array(AccessVars.CFile!.RecLen + 2);
}
// PAS: ACCESS.PAS GetRecSpace2
export function GetRecSpace2(): Uint8Array {
  return new Uint8Array(AccessVars.CFile!.RecLen + 2);
}
// PAS: ACCESS.PAS CFileRecSize
export function CFileRecSize(): number {
  return AccessVars.CFile!.RecLen + 2;
}
// PAS: ACCESS.PAS SetTWorkFlag
export function SetTWorkFlag(): void {
  AccessVars.CRecPtr![AccessVars.CFile!.RecLen] = 1;
}
// PAS: ACCESS.PAS ClearTWorkFlag
export function ClearTWorkFlag(): void {
  AccessVars.CRecPtr![AccessVars.CFile!.RecLen] = 0;
}
// PAS: ACCESS.PAS HasTWorkFlag
export function HasTWorkFlag(): boolean {
  return AccessVars.CRecPtr![AccessVars.CFile!.RecLen] !== 0;
}
// PAS: ACCESS.PAS SetUpdFlag
export function SetUpdFlag(): void {
  AccessVars.CRecPtr![AccessVars.CFile!.RecLen + 1] = 1;
}
// PAS: ACCESS.PAS ClearUpdFlag
export function ClearUpdFlag(): void {
  AccessVars.CRecPtr![AccessVars.CFile!.RecLen + 1] = 0;
}
// PAS: ACCESS.PAS HasUpdFlag
export function HasUpdFlag(): boolean {
  return AccessVars.CRecPtr![AccessVars.CFile!.RecLen + 1] !== 0;
}
// PAS: ACCESS.PAS DeletedFlag
export function DeletedFlag(): boolean {
  const t = AccessVars.CFile!.Typ;
  const r = AccessVars.CRecPtr!;
  if (t === 'X') return r[0] !== 0;
  if (t === 'D') return r[0] === 0x2a; // '*'
  return false;
}
// PAS: ACCESS.PAS ClearDeletedFlag
export function ClearDeletedFlag(): void {
  const t = AccessVars.CFile!.Typ;
  if (t === 'X') AccessVars.CRecPtr![0] = 0;
  else if (t === 'D') AccessVars.CRecPtr![0] = 0x20;
}
// PAS: ACCESS.PAS SetDeletedFlag
export function SetDeletedFlag(): void {
  const t = AccessVars.CFile!.Typ;
  if (t === 'X') AccessVars.CRecPtr![0] = 1;
  else if (t === 'D') AccessVars.CRecPtr![0] = 0x2a;
}

// PAS: ACCESS.PAS ReadDelInTWork
export function ReadDelInTWork(Pos: number): LongStrPtr {
  const tw = AccessVars.TWork;
  const s = tw.Read(1, Pos);
  tw.Delete(Pos);
  return s;
}
// PAS: ACCESS.PAS StoreInTWork
export function StoreInTWork(S: LongStrPtr): number {
  return AccessVars.TWork.Store(S);
}
export type proc = () => void;
// PAS: ACCESS.PAS ForAllFDs – P runs with CFile set to each file of all active RDBs
export function ForAllFDs(P: proc): void {
  const cf = AccessVars.CFile;
  let R = AccessVars.CRdb;
  while (R !== null) {
    AccessVars.CFile = R.FD;
    while (AccessVars.CFile !== null) {
      P();
      AccessVars.CFile = AccessVars.CFile.Chain;
    }
    R = R.ChainBack;
  }
  AccessVars.CFile = cf;
}
// PAS: ACCESS.PAS IsActiveRdb
export function IsActiveRdb(FD: FileDPtr): boolean {
  for (let R = AccessVars.CRdb; R !== null; R = R.ChainBack) if (FD === R.FD) return true;
  return false;
}

// PAS: ACCESS.PAS ResetCompilePars (RdFldNameFrml := COMPILE.RdFldNameFrmlF)
export function ResetCompilePars(): void {
  const a = AccessVars;
  a.RdFldNameFrml = RdFldNameFrmlF;
  a.RdFunction = null;
  a.ChainSumEl = null;
  a.FileVarsAllowed = true;
  a.FDLocVarAllowed = false;
  a.IdxLocVarAllowed = false;
  a.PrevCompInp = null;
}
// PAS: ACCESS.PAS SaveCompInp
export function SaveCompInp(ci: CompInpD): void {
  const a = AccessVars;
  ci.ChainBack = a.PrevCompInp;
  ci.InpArrPtr = a.InpArrPtr;
  ci.InpRdbPos = CopyRec(a.InpRdbPos);
  ci.InpArrLen = a.InpArrLen;
  ci.CurrPos = a.CurrPos;
  ci.OldErrPos = a.OldErrPos;
}
// PAS: ACCESS.PAS LoadCompInp
export function LoadCompInp(ci: CompInpD): void {
  const a = AccessVars;
  a.InpArrPtr = ci.InpArrPtr;
  a.InpRdbPos = CopyRec(ci.InpRdbPos);
  a.InpArrLen = ci.InpArrLen;
  a.CurrPos = ci.CurrPos;
  a.OldErrPos = ci.OldErrPos;
  a.PrevCompInp = ci.ChainBack;
}
