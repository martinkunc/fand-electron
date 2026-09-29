// PAS: BASE.PAS – common types, heap, exits, virtual file handles, messages, INSTALL tables.
// Includes (own modules, re-exported): COMMONFPC.PAS -> common.ts, HANDLE.PAS -> handle.ts,
// MEMORY.PAS -> memory.ts.
//
// Porting notes:
// * FAND.RES: BASE opens it (InitBase -> OpenResFile); RUNFAND.InitRunFand reads its header
//   (ResVersion word, ResFile.A, MsgIdxN, MsgIdx, FrstMsgPos := PosH). The TS-only decoders
//   TResFile.SetA / MsgIdxFromBytes (SizeOfResA, SizeOfMsgIdxItem) replace the untyped ReadH into
//   the Pascal records. RdMsg reads the Kamenický message, converts it (ConvKamenToCurr) and
//   substitutes '$' by MsgPar[1..] ('$$' = '$'); an unknown N shows message 0 (Nr 9999) with N.
// * FAND.CFG: RUNFAND.RdCFG reads the INSTALL 1 records; LoadSpec/LoadVideo/LoadColors/LoadFonts
//   (SizeOfSpec 35, SizeOfVideo 10, SizeOfColors 54, SizeOfFonts 3) decode the BP7 packed layout.
//   Printer strings (printer[i].Strg) are kept as the raw length-prefixed sequence for PrTab.
// * CachePage/XMSCacheD: Handle is an accessor on the top byte of HPage (Pascal variant overlay).
// * CharOrdTab/UpcCharTab start as identity / CP852 upper case (Pascal: zeroed) until RdCFG.
// * MyExit is not installed as an ExitProc: the engine calls it at the end (optional ExitCode of a
//   runtime error). `write` before InitDrivers (OpenResFile/OpenWorkH errors) goes to stderr.
// * BP7-only: InitOverlays/OpenOvrFile (overlays), StackOvr/NoOvr (overlay stack), WrTurboErr.

import {
  UPCASE_852, ShortStr, StrI, BytesToStr, getWord, getLongint, Halt, ToUnicode, TxtWrite, Output, fmOutput,
  type Ref, type Pointer, type PathStr, type DirStr, type NameStr, type ExtStr,
} from './pasrt.ts';
import type { TVideoFont } from './drivers.ts';
import {
  DriversVars, ConvKamenToCurr, DoneMouseEvents, CrsIntrDone, BreakIntrDone, Window, ClrScr, CrsNorm,
} from './drivers.ts';
import type { LocVar } from './access.ts';
import { ExtendHandles, UnExtendHandles, OpenH, SeekH, ReadH, DeleteFile, MyFExpand } from './handle.ts';
import { CloseXMS, InitMemoryArenas } from './memory.ts';
import { wait } from './common.ts';

export * from './common.ts';
export * from './handle.ts';
export * from './memory.ts';

// ---------------------------------------------------------------- COMMON

export const FDVersion = 0x0411;
export const ResVersion = 0x0420;
export const DMLVersion = 41;
/** {$ifdef Coproc} float=double else float=real – both are JS numbers; Real48 only in storage. */
export const HasCoproc = false;

export type float = number;
export type string2 = string;
export type string3 = string;
export type string4 = string;
export type string8 = string;
export type string9 = string;
export type string12 = string;
export type string20 = string;
export type string127 = string;
export type string255 = string;
export type String12 = string;
export type String8 = string;
export type String127 = string;
export type VolStr = string; // string[11]
export type ScreenStr = string; // string[80]
export type IdentStr = string; // string[32]
/** CharArr = array[1..] of char: a byte buffer; Pascal A[i] is u8[i-1]. */
export type CharArr = Uint8Array;
export type CharArrPtr = Uint8Array | null;
/** LongStr = record LL: word; A: CharArr end – a Uint8Array whose length is LL. */
export type LongStr = Uint8Array;
/** LongStrPtr: routines that may return/accept nil use `LongStrPtr | null`. */
export type LongStrPtr = Uint8Array;
/** StringPtr = ^string: the string itself, null for nil. */
export type StringPtr = string | null;
export type PString = StringPtr;
export type StringPtrArr = StringPtr[]; // [1..10]
export type TByteArray = Uint8Array;
export type PByteArray = Uint8Array | null;
/** Typed pointers to scalars are Refs: BytePtr, WordPtr, FloatPtr ... */
export type BytePtr = Ref<number> | null;
export type CharPtr = Ref<string> | null;
export type BooleanPtr = Ref<boolean> | null;
export type WordPtr = Ref<number> | null;
export type IntegerPtr = Ref<number> | null;
export type LongintPtr = Ref<number> | null;
export type FloatPtr = Ref<number> | null;
export type RealPtr = Ref<number> | null;
export type PtrPointer = Ref<Pointer> | null;
export type PProcedure = (() => void) | null;
export type SgOfsInt = number;
export type StoreSize = number;

export { type PathStr, type DirStr, type NameStr, type ExtStr };

// PAS: BASE.PAS WRect
export class WRect {
  C1 = 0;
  R1 = 0;
  C2 = 0;
  R2 = 0;
}
export type WRectPtr = WRect | null;

// Type conversion records: use pasrt Lo/Hi/getWord... instead.
export interface WordRec {
  Lo: number;
  Hi: number;
}
export interface LongRec {
  Lo: number;
  Hi: number;
}
export interface PtrRec {
  Ofs: number;
  Seg: number;
}

export const EmptyStr = '';
export const MaxLStrLen = 65000;
export const WShadow = 0x01; // window flags
export const WNoClrScr = 0x02;
export const WPushPixel = 0x04;
export const WNoPop = 0x08;
export const WHasFrame = 0x10;
export const WDoubleFrame = 0x20;

// ---------------------------------------------------------------- MEMORY MANAGEMENT

export interface XMSParam {
  Len: number;
  SHandle: number;
  Src: Pointer;
  DHandle: number;
  Dest: Pointer;
}

export const CachePageArrOfs = 9;

// PAS: BASE.PAS CachePage – case 1: (Pg3: array[1..3] of byte; Handle: byte) overlays HPage:
// HPage = Page | Handle shl 24 (kept unsigned), Handle is its top byte.
export class CachePage {
  Chain: CachePagePtr = null;
  HPage = 0;
  Upd = false;
  Arr = new Uint8Array(4096);
  get Handle(): number {
    return this.HPage >>> 24;
  }
  set Handle(h: number) {
    this.HPage = ((this.HPage & 0xffffff) | ((h & 0xff) << 24)) >>> 0;
  }
}
export type CachePagePtr = CachePage | null;

// PAS: BASE.PAS XMSCacheD – Handle overlays the top byte of HPage (as in CachePage)
export class XMSCacheD {
  Chain: XMSCacheDPtr = null;
  HPage = 0;
  Upd = false;
  XMSPage = 0;
  get Handle(): number {
    return this.HPage >>> 24;
  }
  set Handle(h: number) {
    this.HPage = ((this.HPage & 0xffffff) | ((h & 0xff) << 24)) >>> 0;
  }
}
export type XMSCacheDPtr = XMSCacheD | null;

/** DOS program segment prefix – no meaning on the host; kept for the ParmArea. */
export interface PSPrefix {
  ParmArea: string;
}

// PAS: BASE.PAS ProcStkD – frame of local variables of a running procedure.
export class ProcStkD {
  ChainBack: ProcStkPtr = null;
  LVRoot: LocVar | null = null; // ...values of local variables...
  /** TS: the frame bytes of Pascal as values indexed by LocVar.BPOfs ('S': TWork pos, 'R': number, 'B': boolean). */
  V: (number | boolean)[] = [];
}
export type ProcStkPtr = ProcStkD | null;

// PAS: BASE.PAS ExitRecord – state saved by NewExit, restored by GoExit/RestoreExit.
export class ExitRecord {
  OvrEx: PProcedure = null;
  mBP: ProcStkPtr = null;
  ExP = false;
  BrkP = false;
  /** TS: a NewExit is active (Pascal: JmpBuf not all zero) */
  Armed = false;
}

// ---------------------------------------------------------------- VIRTUAL HANDLES

// FileOpenMode = (_isnewfile, _isoldfile, _isoverwritefile, _isoldnewfile)
export type FileOpenMode = number;
export const _isnewfile = 0;
export const _isoldfile = 1;
export const _isoverwritefile = 2;
export const _isoldnewfile = 3;
// FileUseMode = (Closed, RdOnly, RdShared, Shared, Exclusive)
export type FileUseMode = number;
export const Closed = 0;
export const RdOnly = 1;
export const RdShared = 2;
export const Shared = 3;
export const Exclusive = 4;

// ---------------------------------------------------------------- INSTALL 1

// TKbdConv = (OrigKbd, CsKbd, CaKbd, SlKbd, DtKbd)
export type TKbdConv = number;
export const OrigKbd = 0;
export const CsKbd = 1;
export const CaKbd = 2;
export const SlKbd = 3;
export const DtKbd = 4;

export const prName = 0;
export const prUl1 = 1;
export const prUl2 = 2;
export const prKv1 = 3;
export const prKv2 = 4;
export const prBr1 = 5;
export const prBr2 = 6;
export const prDb1 = 7;
export const prDb2 = 8;
export const prBd1 = 9;
export const prBd2 = 10;
export const prKp1 = 11;
export const prKp2 = 12;
export const prEl1 = 13;
export const prEl2 = 14;
export const prReset = 15;
export const prMgrFileNm = 15;
export const prMgrProg = 16;
export const prMgrParam = 17;
export const prPageSizeNN = 16;
export const prPageSizeTrail = 17;
export const prLMarg = 18;
export const prLMargTrail = 19;
export const prUs11 = 20;
export const prUs12 = 21;
export const prUs21 = 22;
export const prUs22 = 23;
export const prUs31 = 24;
export const prUs32 = 25;
export const prLine72 = 26;
export const prLine216 = 27;
export const prDen60 = 28;
export const prDen120 = 29;
export const prDen240 = 30;
export const prColor = 31;
export const prClose = 32;

export interface PrinterD {
  /** sequence of length-prefixed printer strings (FAND.CFG), PrTab(N) reads the N-th */
  Strg: Uint8Array | null;
  Typ: string;
  Kod: string;
  Lpti: number;
  TmOut: number;
  OpCls: boolean;
  ToHandle: boolean;
  ToMgr: boolean;
  Handle: number;
}
export type TPrTimeOut = number[]; // [1..4]
export interface WDaysItem {
  Typ: number;
  Nr: number;
}
export type WDaysTabType = WDaysItem[]; // [1..NWDaysTab]

// Resource file (FAND.RES) item kinds
export const RMsgIdx = 0;
export const BgiEgaVga = 1;
export const BgiHerc = 2;
export const ChrLittKam = 3;
export const ChrTripKam = 4;
export const Ega8x14K = 5;
export const Vga8x16K = 6;
export const Vga8x19K = 7;
export const Ega8x14L = 8;
export const Vga8x16L = 9;
export const Vga8x19L = 10;
export const ChrLittLat = 11;
export const ChrTripLat = 12;
export const LatToWinCp = 13;
export const KamToWinCp = 14;
export const WinCpToLat = 15;
export const FandFace = 16;

// PAS: BASE.PAS TResFile
export class TResFile {
  Handle = 0;
  A = Array.from({ length: FandFace + 1 }, () => ({ Pos: 0, Size: 0 }));
  // PAS: BASE.PAS TResFile.Get – P := the resource item Kod (getmem'd), returns its size
  Get(Kod: number, P: Ref<Uint8Array | null>): number {
    const l = this.A[Kod].Size;
    P.v = new Uint8Array(l);
    SeekH(this.Handle, this.A[Kod].Pos);
    ReadH(this.Handle, l, P.v);
    return l;
  }
  // PAS: BASE.PAS TResFile.GetStr – the resource item Kod as a LongStr
  GetStr(Kod: number): LongStrPtr {
    const a = this.A[Kod];
    const s = new Uint8Array(a.Size);
    SeekH(this.Handle, a.Pos);
    ReadH(this.Handle, a.Size, s);
    return s;
  }
  /** TS-only: `ReadH(h, sizeof(ResFile.A), ResFile.A)` (RUNFAND) – A from its SizeOfResA packed bytes */
  SetA(b: Uint8Array): void {
    for (let i = 0; i <= FandFace; i++) {
      this.A[i].Pos = getLongint(b, i * 6);
      this.A[i].Size = getWord(b, i * 6 + 4);
    }
  }
}
/** TS-only: sizeof(TResFile.A) – array[0..FandFace] of (Pos: longint; Size: word) */
export const SizeOfResA = (FandFace + 1) * 6;
/** TS-only: sizeof(TMsgIdxItem) – Nr, Ofs: word; Count: byte */
export const SizeOfMsgIdxItem = 5;
/** TS-only: `ReadH(h, l, MsgIdx^)` (RUNFAND) – N packed TMsgIdxItems -> TMsgIdx (index 0 unused) */
export function MsgIdxFromBytes(b: Uint8Array, N: number): TMsgIdx {
  const r: TMsgIdx = [{ Nr: 0, Ofs: 0, Count: 0 }];
  for (let i = 0; i < N; i++) {
    const o = i * SizeOfMsgIdxItem;
    r.push({ Nr: getWord(b, o), Ofs: getWord(b, o + 2), Count: b[o + 4] });
  }
  return r;
}
export interface TMsgIdxItem {
  Nr: number;
  Ofs: number;
  Count: number;
}
export type TMsgIdx = TMsgIdxItem[]; // [1..100]

// ---------------------------------------------------------------- unit state

export const BaseVars = {
  UserLicNrShow: 999001,
  Version: '4.20',
  CfgVersion: '4.20',

  // memory management
  MyHeapOrg: null as Pointer,
  AfterCatFD: null as Pointer,
  CacheEnd: null as Pointer,
  Stack2Ptr: null as Pointer,
  MemEnd: null as Pointer,
  CachePageSize: 4096, // 4kB
  XMSFun: null as Pointer,
  XMSHandle: 0,
  XMSError: 0,
  XMSOut: null as XMSParam | null,
  XMSIn: null as XMSParam | null,
  NCachePages: 0,
  XMSCachePages: 0,
  CachePageShft: 12,
  CurPSP: null as PSPrefix | null,
  CacheRoot: null as CachePagePtr,
  NewHT: new Uint8Array(256),
  MyHeapEnd: null as Pointer,
  XMSCacheRoot: null as XMSCacheDPtr,
  XMSCacheBuf: null as Pointer,
  CachePageSz: 0, // in paragraphs
  InitStackSz: 0,
  MinStackSz: 0,
  InitStack2Sz: 0,
  MinStack2Sz: 0,

  // exits
  ExitBuf: new ExitRecord(),
  MyBP: null as ProcStkPtr,
  ProcMyBP: null as ProcStkPtr,
  BPBound: 0,
  ExitP: false,
  BreakP: false,
  GoExitFired: false,
  LastExitCode: 0,

  // virtual handles
  HandleError: 0,
  OldDir: '' as DirStr,
  FandDir: '' as DirStr,
  WrkDir: '' as DirStr,
  FandOvrName: '' as PathStr,
  FandResName: '' as PathStr,
  FandWorkName: '' as PathStr,
  FandWorkXName: '' as PathStr,
  FandWorkTName: '' as PathStr,
  CPath: '' as PathStr,
  CDir: '' as DirStr,
  CName: '' as NameStr,
  CExt: '' as ExtStr,
  CVol: '' as VolStr,
  WasLPTCancel: false,
  WorkHandle: 0,
  MaxWSize: 0, // currently occupied in FANDWORK.$$$

  // messages
  F10SpecKey: 0,
  ProcAttr: 0, // color.uNorm
  MsgLine: '',
  MsgPar: ['', '', '', '', ''] as ScreenStr[], // [1..4]

  // DML
  FandInt3f: null as Pointer,
  OvrHandle: 0,
  Fand_ss: 0,
  Fand_sp: 0,
  Fand_bp: 0,
  DML_ss: 0,
  DML_sp: 0,
  DML_bp: 0,
  _CallDMLAddr: 0,

  // INSTALL 1 – read from FAND.CFG in declaration order (BP7 packed record, sizes in comments)
  Spec: {
    UpdCount: 0, // byte
    AutoRprtWidth: 0, // byte
    AutoRprtLimit: 0, // byte
    CpLines: 0, // byte
    AutoRprtPrint: false, // boolean
    ChoosePrMsg: false,
    TxtInsPg: false,
    TxtCharPg: '\0', // char
    ESCverify: false,
    Prompt158: false,
    F10Enter: false,
    RDBcomment: false,
    CPMdrive: '\0', // char
    RefreshDelay: 0, // word
    NetDelay: 0, // word
    LockDelay: 0, // byte
    LockRetries: 0, // byte
    Beep: false,
    LockBeepAllowed: false,
    XMSMaxKb: 0, // word
    NoCheckBreak: false,
    KbdTyp: OrigKbd as TKbdConv, // byte
    NoMouseSupport: false,
    MouseReverse: false,
    DoubleDelay: 0, // byte
    RepeatDelay: 0, // byte
    CtrlDelay: 0, // byte
    OverwrLabeledDisk: false,
    ScreenDelay: 0, // word
    OffDefaultYear: 0, // byte
    WithDiskFree: false,
  },
  Video: {
    address: 0, // word
    TxtRows: 25, // byte
    ChkSnow: false, // not used
    cursOn: 0, // word
    cursOff: 0,
    cursBig: 0,
  },
  Fonts: {
    VFont: 1 as TVideoFont, // byte, foLatin2
    LoadVideoAllowed: false,
    NoDiakrSupported: false,
  },
  /** all bytes; menu m*, select s*, prompt p*, message z*, last line l*, first line f*,
   *  text editor t*, data editor d*, user screen u*, help h*, one-line help n* */
  Colors: {
    userColor: new Uint8Array(16),
    mNorm: 0, mHili: 0, mFirst: 0, mDisabled: 0,
    sNorm: 0, sHili: 0, sMask: 0,
    pNorm: 0, pTxt: 0,
    zNorm: 0,
    lNorm: 0, lFirst: 0, lSwitch: 0,
    fNorm: 0,
    tNorm: 0, tCtrl: 0, tBlock: 0,
    tUnderline: 0, tItalic: 0, tDWidth: 0, tDStrike: 0, tEmphasized: 0, tCompressed: 0, tElite: 0,
    dNorm: 0, dHili: 0, dSubset: 0, dTxt: 0, dDeleted: 0, dSelect: 0,
    uNorm: 0,
    hNorm: 0, hHili: 0, hMenu: 0, hSpec: 0,
    nNorm: 0,
    ShadowAttr: 0,
    DesktopColor: 0,
  },
  /** array[char] of char as byte -> byte tables (read from FAND.CFG; TS: until then identity
   *  and the CP852 upper case instead of Pascal's zeroed globals) */
  CharOrdTab: Uint8Array.from({ length: 256 }, (_, i) => i),
  UpcCharTab: UPCASE_852.slice(),
  TxtCols: 80,
  TxtRows: 25,
  LaptopCGA: false, // text mode?, not graph

  prCurr: -1,
  prMax: 0,
  printer: Array.from({ length: 10 }, (): PrinterD => ({
    Strg: null, Typ: '\0', Kod: '\0', Lpti: 0, TmOut: 0, OpCls: false, ToHandle: false, ToMgr: false, Handle: 0xff,
  })),
  OldPrTimeOut: [0, 0, 0, 0, 0] as TPrTimeOut,
  PrTimeOut: [0, 0, 0, 0, 0] as TPrTimeOut,
  NWDaysTab: 0,
  /** Real48 in FAND.CFG (FPC: array[1..6] of byte) */
  WDaysFirst: 0 as float,
  WDaysLast: 0 as float,
  WDaysTab: [] as WDaysTabType,
  // end of INSTALL 1

  AbbrYes: 'Y',
  AbbrNo: 'N',
  WasInitDrivers: false,
  WasInitPgm: false,
  LANNode: 0,

  ResFile: new TResFile(),
  MsgIdx: null as TMsgIdx | null,
  MsgIdxN: 0,
  FrstMsgPos: 0,
  CallOpenFandFiles: null as ((FromDML: boolean) => void) | null,
  CallCloseFandFiles: null as ((FromDML: boolean) => void) | null,
  UserLicNr: 0,
  userToday: 0 as float,
};

// ---------------------------------------------------------------- FAND.CFG records (TS-only)
// RUNFAND.RdCFG reads the INSTALL 1 records with ReadH(h, sizeof(X), X); these decode the BP7
// packed ({$A-}) layouts into BaseVars.

/** TS-only: sizeof(Spec) */
export const SizeOfSpec = 35;
/** TS-only: sizeof(Video) */
export const SizeOfVideo = 10;
/** TS-only: sizeof(Colors) – userColor[0..15] + 38 named attributes */
export const SizeOfColors = 54;
/** TS-only: sizeof(Fonts) */
export const SizeOfFonts = 3;

// TS: field layout of Spec in declaration order (1 = byte/boolean/char, 2 = word)
const SpecLayout: [keyof typeof BaseVars.Spec, 1 | 2][] = [
  ['UpdCount', 1], ['AutoRprtWidth', 1], ['AutoRprtLimit', 1], ['CpLines', 1], ['AutoRprtPrint', 1],
  ['ChoosePrMsg', 1], ['TxtInsPg', 1], ['TxtCharPg', 1], ['ESCverify', 1], ['Prompt158', 1], ['F10Enter', 1],
  ['RDBcomment', 1], ['CPMdrive', 1], ['RefreshDelay', 2], ['NetDelay', 2], ['LockDelay', 1], ['LockRetries', 1],
  ['Beep', 1], ['LockBeepAllowed', 1], ['XMSMaxKb', 2], ['NoCheckBreak', 1], ['KbdTyp', 1], ['NoMouseSupport', 1],
  ['MouseReverse', 1], ['DoubleDelay', 1], ['RepeatDelay', 1], ['CtrlDelay', 1], ['OverwrLabeledDisk', 1],
  ['ScreenDelay', 2], ['OffDefaultYear', 1], ['WithDiskFree', 1],
];
// TS: Colors attributes after userColor, in declaration order
const ColorNames = [
  'mNorm', 'mHili', 'mFirst', 'mDisabled', 'sNorm', 'sHili', 'sMask', 'pNorm', 'pTxt', 'zNorm',
  'lNorm', 'lFirst', 'lSwitch', 'fNorm', 'tNorm', 'tCtrl', 'tBlock',
  'tUnderline', 'tItalic', 'tDWidth', 'tDStrike', 'tEmphasized', 'tCompressed', 'tElite',
  'dNorm', 'dHili', 'dSubset', 'dTxt', 'dDeleted', 'dSelect', 'uNorm', 'hNorm', 'hHili', 'hMenu', 'hSpec',
  'nNorm', 'ShadowAttr', 'DesktopColor',
] as const;

/** TS-only: `ReadH(h, sizeof(spec), spec)` – decode SizeOfSpec bytes into BaseVars.Spec */
export function LoadSpec(b: Uint8Array): void {
  const sp = BaseVars.Spec as Record<string, unknown>;
  let o = 0;
  for (const [k, sz] of SpecLayout) {
    const v = sz === 2 ? getWord(b, o) : b[o];
    const cur = sp[k];
    sp[k] = typeof cur === 'boolean' ? v !== 0 : typeof cur === 'string' ? String.fromCharCode(v) : v;
    o += sz;
  }
}
/** TS-only: `ReadH(h, sizeof(video), video)` */
export function LoadVideo(b: Uint8Array): void {
  const v = BaseVars.Video;
  v.address = getWord(b, 0);
  v.TxtRows = b[2];
  v.ChkSnow = b[3] !== 0;
  v.cursOn = getWord(b, 4);
  v.cursOff = getWord(b, 6);
  v.cursBig = getWord(b, 8);
}
/** TS-only: `ReadH(h, sizeof(colors), colors)` */
export function LoadColors(b: Uint8Array): void {
  const c = BaseVars.Colors;
  c.userColor.set(b.subarray(0, 16));
  ColorNames.forEach((k, i) => {
    c[k] = b[16 + i];
  });
}
/** TS-only: `ReadH(h, sizeof(Fonts), Fonts)` */
export function LoadFonts(b: Uint8Array): void {
  BaseVars.Fonts.VFont = b[0];
  BaseVars.Fonts.LoadVideoAllowed = b[1] !== 0;
  BaseVars.Fonts.NoDiakrSupported = b[2] !== 0;
}

// ---------------------------------------------------------------- BASE.PAS routines

// TS: BP7 `write(s)` before InitDrivers (Output not yet assigned to the CRT) goes to the console
function WriteEarly(s: string): void {
  if (Output.Mode === fmOutput) TxtWrite(Output, s);
  else process.stderr.write(ToUnicode(s) + '\n');
}

// PAS: BASE.PAS unit initialization (begin ... end.): ExtendHandles, prCurr := -1,
// ExitProc := MyExit, UserLicNr, FandResName := MyFExpand('Fand.Res','FANDRES'), OpenResFile.
// TS: the engine calls MyExit itself when the program ends (there is no ExitProc chain).
export function InitBase(): void {
  BaseVars.CurPSP = null;
  BaseVars.MyHeapEnd = null;
  InitMemoryArenas();
  ExtendHandles();
  BaseVars.prCurr = -1;
  BaseVars.MyBP = null;
  BaseVars.UserLicNr = (BaseVars.UserLicNrShow & 0xffff) & 0x7fff;
  BaseVars.FandResName = MyFExpand('Fand.Res', 'FANDRES');
  OpenResFile();
}

// PAS: BASE.PAS MyExit (exit procedure: delete work files, restore the screen).
// TS: ExitCode = the runtime error code when the program ends by a Pascal runtime error, else 0.
export function MyExit(ExitCode = 0): void {
  if (BaseVars.WasInitPgm) {
    if (ExitCode !== 0) process.stderr.write(`FAND: runtime error ${ExitCode}\n`);
    UnExtendHandles();
    DeleteFile(BaseVars.FandWorkName);
    DeleteFile(BaseVars.FandWorkXName);
    DeleteFile(BaseVars.FandWorkTName);
    CloseXMS();
  } else UnExtendHandles();
  // 1:
  if (BaseVars.WasInitDrivers) {
    DoneMouseEvents();
    CrsIntrDone();
    BreakIntrDone();
    if (DriversVars.IsGraphMode) {
      DriversVars.IsGraphMode = false;
      DriversVars.ScrSeg = BaseVars.Video.address;
    }
    Window(1, 1, BaseVars.TxtCols, BaseVars.TxtRows);
    DriversVars.TextAttr = DriversVars.StartAttr;
    ClrScr();
    CrsNorm();
    if (BaseVars.OldDir !== '') {
      try {
        process.chdir(ToUnicode(BaseVars.OldDir));
      } catch {
        // ChDir error ignored ({$I-} semantics in an exit procedure)
      }
    }
    SetCurrPrinter(-1);
  }
}

// PAS: BASE.PAS StackOvr (overlay stack fix-up; no-op in the FPC port)
export function StackOvr(NewBP: number): void {}

// PAS: BASE.PAS PrTab – the N-th (0-based) length-prefixed string of the current printer
export function PrTab(N: number): string {
  const pr = BaseVars.printer[BaseVars.prCurr];
  const p = pr?.Strg;
  if (!p) return '';
  let o = 0;
  for (let i = 1; i <= N; i++) o += (p[o] ?? 0) + 1;
  return BytesToStr(p, o + 1, p[o] ?? 0);
}
// PAS: BASE.PAS SetCurrPrinter
export function SetCurrPrinter(NewPr: number): void {
  if (NewPr >= BaseVars.prMax) return;
  if (BaseVars.prCurr >= 0) {
    const pr = BaseVars.printer[BaseVars.prCurr];
    if (pr.TmOut !== 0) BaseVars.PrTimeOut[pr.Lpti] = BaseVars.OldPrTimeOut[pr.Lpti];
  }
  BaseVars.prCurr = NewPr;
  if (BaseVars.prCurr >= 0) {
    const pr = BaseVars.printer[BaseVars.prCurr];
    if (pr.TmOut !== 0) BaseVars.PrTimeOut[pr.Lpti] = pr.TmOut;
  }
}
// PAS: BASE.PAS RdMsg – message N of FAND.RES into MsgLine, '$' replaced by MsgPar[1..], '$$' = '$'
export function RdMsg(N: number): void {
  let j = 1;
  let o = 0;
  let found = false;
  const idx = BaseVars.MsgIdx;
  for (let i = 1; i <= BaseVars.MsgIdxN; i++) {
    const it = idx![i];
    if (N >= it.Nr && N < it.Nr + it.Count) {
      j = N - it.Nr + 1;
      o = it.Ofs;
      found = true;
      break;
    }
  }
  if (!found) {
    o = 0;
    j = 1;
    BaseVars.MsgPar[1] = StrI(N);
  }
  // 1:
  const h = BaseVars.ResFile.Handle;
  SeekH(h, BaseVars.FrstMsgPos + o);
  const buf = new Uint8Array(256);
  let len = 0;
  for (let i = 1; i <= j; i++) {
    ReadH(h, 1, buf);
    len = buf[0];
    ReadH(h, len, buf.subarray(1));
  }
  const sb = buf.subarray(1, 1 + len);
  ConvKamenToCurr(sb, len);
  const s = BytesToStr(sb) + '\0';
  let MsgLine = '';
  j = 1;
  for (let i = 1; i <= len; i++) {
    if (s[i - 1] === '$' && s[i] !== '$') {
      MsgLine = ShortStr(MsgLine + (BaseVars.MsgPar[j] ?? ''));
      j++;
    } else {
      MsgLine = ShortStr(MsgLine + s[i - 1]);
      if (s[i - 1] === '$') i++;
    }
  }
  BaseVars.MsgLine = MsgLine;
}
// PAS: BASE.PAS OpenResFile
export function OpenResFile(): void {
  BaseVars.CPath = BaseVars.FandResName;
  BaseVars.CVol = '';
  BaseVars.ResFile.Handle = OpenH(_isoldfile, RdOnly);
  if (BaseVars.HandleError !== 0) {
    WriteEarly("can't open " + BaseVars.FandResName);
    if (BaseVars.WasInitDrivers) wait();
    Halt(1);
  }
}
// PAS: BASE.PAS OpenWorkH
export function OpenWorkH(): void {
  BaseVars.CPath = BaseVars.FandWorkName;
  BaseVars.CVol = '';
  BaseVars.WorkHandle = OpenH(_isoldnewfile, Exclusive);
  if (BaseVars.HandleError !== 0) {
    WriteEarly("can't open " + BaseVars.FandWorkName);
    if (BaseVars.WasInitDrivers) wait();
    Halt(1);
  }
}
