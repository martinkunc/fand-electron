// PAS: FILEACC.PAS (include of ACCESS) – lock modes, the text file object TFile (.T00/.DBT/.FPT),
// FileD methods, prefixes of data files. Re-exported by access.ts; state lives in AccessVars.
// TFile/FileD are declared in ACCESS.PAS; they live here with their methods.
//
// Porting notes:
// * FandNetV branch of ChangeLMode/TryLockN/UnLockN. HANDLE.TryLockH always succeeds (single
//   user), so the wait loops never run; the lock ranges are the FAND 4.2 ones (MB160/FILEACC.PAS
//   only raises them to $40000000 – an unpublished fix, incompatible with 4.2; not used).
// * T00 header (TT1Page, 512 bytes): Signum@0 OldMaxPage@2 FreePart@4 Rsrvd1@8 CompileProc@9
//   CompileAll@10 IRec@11 FreeRoot@13 MaxPage@17 TimeStmp@21 (Real48, BP7) HasCoproc@27
//   Rsrvd2@28 Version@53 LicText@57 Sum@162 X1@163 LicNr@458 X2@460 PwNew@471 Time@511.
//   TX[14..511] (offsets 13..510) are XORed with the BP7 Random(255) stream seeded by MLen+Time
//   (RandSeed is saved and restored around it, so a module-level RandSeed is used here).
// * WrPrefix: `Time` is the BIOS tick counter low byte in BP7 (uninitialised in FPC): the clock.
// * PwCode/Pw2Code are 20-byte byte strings kept XOR $AA in memory (Pascal: 40 contiguous bytes).
// * LongStr results are Uint8Arrays of length LL; Read allocates exactly LL bytes.

import {
  getWord, setWord, getInteger, setInteger, getLongint, setLongint, Swap, fref, DirectorySeparator, Clock,
  type Ref, type NameStr,
} from './pasrt.ts';
import type { float, FileUseMode } from './base.ts';
import {
  BaseVars, RdWrCache, FileSizeH, OpenH, SetUpdHandle, IsUpdHandle, ResetUpdHandle, ClearCacheH, CloseClearH,
  TryLockH, UnLockH, SaveCache, GoExit, SEquUpcase, SetMsgPar, Set2MsgPar, SwapLong, SplitDate, Today,
  StrLPCopy, GetZStore, _isoverwritefile, Exclusive, Shared, RdShared, MaxLStrLen, HasCoproc,
} from './base.ts';
import { RunError, WrLLF10Msg, CFileMsg, CFileError, PushWrLLMsg, PopW } from './obaseww.ts';
import { LockBeep, KbdTimer } from './drivers.ts';
import { OpenCreateF, SetCPathVol } from './oaccess.ts';
import { readReal48, writeReal48 } from '../fand/numbers.ts';
import {
  RdbPos, AccessVars, Code, CompArea, LockModeTxt, MPageSize, MPageShft, f_Stored, NullMode, NoExclMode,
  NoDelMode, NoCrMode, RdMode, WrMode, CrMode, DelMode, ExclMode,
  type FileDPtr, type TFilePtr, type FieldDPtr, type StringList, type XFilePtr, type KeyDPtr, type AddDPtr,
  type LockMode, type PwCodeArr, type LiRoots,
} from './access.ts';

// TFile.Format = (T00Format, DbtFormat, FptFormat)
export const T00Format = 0;
export const DbtFormat = 1;
export const FptFormat = 2;

/** TS: System.RandSeed as FILEACC uses it (always saved and restored around the header coding). */
let RandSeed = 0;
/** TS: BP7 System.Random(Range) – RandSeed := RandSeed*$08088405+1; hi word mod Range. */
function Random(Range: number): number {
  RandSeed = (Math.imul(RandSeed, 134775813) + 1) >>> 0;
  return (RandSeed >>> 16) % Range;
}

/** TS: PwCode+Pw2Code as the 40 bytes Pascal moves together. */
function PwToBytes(tf: TFile): Uint8Array {
  const b = new Uint8Array(40);
  for (let i = 0; i < 20; i++) {
    b[i] = tf.PwCode.charCodeAt(i) & 0xff;
    b[20 + i] = tf.Pw2Code.charCodeAt(i) & 0xff;
  }
  return b;
}
/** TS: Move(X, PwCode, 40) */
function PwFromBytes(tf: TFile, b: Uint8Array, ofs: number): void {
  tf.PwCode = String.fromCharCode(...b.subarray(ofs, ofs + 20));
  tf.Pw2Code = String.fromCharCode(...b.subarray(ofs + 20, ofs + 40));
}
/** TS: FillChar(PwCode,40,'@'); Code(PwCode,40) */
function PwEmpty(tf: TFile): void {
  const b = new Uint8Array(40).fill(0x40);
  Code(b, 40);
  PwFromBytes(tf, b, 0);
}

// PAS: FILEACC.PAS ResetCFileUpdH (private)
function ResetCFileUpdH(): void {
  const cf = AccessVars.CFile!;
  ResetUpdHandle(cf.Handle);
  if (cf.Typ === 'X') ResetUpdHandle(cf.XF!.Handle);
  if (cf.TF !== null) ResetUpdHandle(cf.TF.Handle);
}
// PAS: FILEACC.PAS ClearCacheCFile
export function ClearCacheCFile(): void {
  const cf = AccessVars.CFile!;
  ClearCacheH(cf.Handle);
  if (cf.Typ === 'X') ClearCacheH(cf.XF!.Handle);
  if (cf.TF !== null) ClearCacheH(cf.TF.Handle);
}
// PAS: FILEACC.PAS CloseClearHCFile
export function CloseClearHCFile(): void {
  const cf = AccessVars.CFile!;
  CloseClearH(fref(cf, 'Handle'));
  if (cf.Typ === 'X') CloseClearH(fref(cf.XF!, 'Handle'));
  if (cf.TF !== null) CloseClearH(fref(cf.TF, 'Handle'));
}

// FandNetV
const TransLock = 0x0a000501; // locked while state transition
const ModeLock = 0x0a000000; // base for mode locking
const RecLock = 0x0b000000; // base for record locking

// PAS: FILEACC.PAS ModeLockBnds (private) – hi word = how many bytes, lo word = first byte
function ModeLockBnds(Mode: LockMode, Pos: Ref<number>, Len: Ref<number>): void {
  const LANNode = BaseVars.LANNode;
  let n = 0;
  switch (Mode) {
    case NoExclMode:
      n = 0x00010000 + LANNode;
      break;
    case NoDelMode:
      n = 0x00010100 + LANNode;
      break;
    case NoCrMode:
      n = 0x00010200 + LANNode;
      break;
    case RdMode:
      n = 0x00010300 + LANNode;
      break;
    case WrMode:
      n = 0x00ff0300;
      break;
    case CrMode:
      n = 0x01ff0200;
      break;
    case DelMode:
      n = 0x02ff0100;
      break;
    case ExclMode:
      n = 0x03ff0000;
      break;
  }
  Pos.v = ModeLock + (n & 0xffff);
  Len.v = (n >>> 16) & 0xffff;
}

// PAS: FILEACC.PAS ChangeLMode – Kind: 0-wait, 1-wait until ESC, 2-no wait
export function ChangeLMode(Mode: LockMode, Kind: number, RdPref: boolean): boolean {
  const cf = AccessVars.CFile!;
  if (!cf.IsShared()) {
    // neu!!
    cf.LMode = Mode;
    return true;
  }
  const oldmode = cf.LMode;
  const h = cf.Handle;
  if (oldmode >= WrMode) {
    if (Mode < WrMode) WrPrefixes();
    if (oldmode === ExclMode) {
      SaveCache(0);
      ClearCacheCFile();
    }
    if (Mode < WrMode) ResetCFileUpdH();
  }
  let w = 0;
  let count = 0;
  const pos = { v: 0 };
  const len = { v: 0 };
  const oldpos = { v: 0 };
  const oldlen = { v: 0 };
  // 1:
  for (;;) {
    let locked = true;
    if (Mode !== NullMode && !TryLockH(h, TransLock, 1)) locked = false;
    else {
      if (oldmode !== NullMode) {
        ModeLockBnds(oldmode, oldpos, oldlen);
        UnLockH(h, oldpos.v, oldlen.v);
      }
      if (Mode !== NullMode) {
        ModeLockBnds(Mode, pos, len);
        if (!TryLockH(h, pos.v, len.v)) {
          if (oldmode !== NullMode) TryLockH(h, oldpos.v, oldlen.v);
          UnLockH(h, TransLock, 1);
          locked = false;
        } else UnLockH(h, TransLock, 1);
      }
    }
    if (locked) break;
    // 2:
    if (Kind === 2) return false;
    count++;
    if (count > BaseVars.Spec.LockRetries) {
      // (d:=spec.LockDelay / spec.NetDelay is computed but unused in Pascal)
      SetCPathVol();
      Set2MsgPar(BaseVars.CPath, LockModeTxt[Mode]);
      const w1 = PushWrLLMsg(825, Kind === 1);
      if (w === 0) w = w1;
      else AccessVars.TWork.Delete(w1);
      LockBeep();
    }
    if (KbdTimer(BaseVars.Spec.NetDelay, Kind)) continue;
    if (w !== 0) PopW(w);
    return false;
  }
  if (w !== 0) PopW(w);
  cf.LMode = Mode;
  if (oldmode < RdMode && Mode >= RdMode && RdPref) RdPrefixes();
  return true;
}

// PAS: FILEACC.PAS TryLMode
export function TryLMode(Mode: LockMode, OldMode: Ref<LockMode>, Kind: number): boolean {
  const cf = AccessVars.CFile!;
  let result = true;
  if (cf.Handle === 0xff) OpenCreateF(Shared);
  OldMode.v = cf.LMode;
  if (Mode > cf.LMode) result = ChangeLMode(Mode, Kind, true);
  return result;
}
// PAS: FILEACC.PAS NewLMode
export function NewLMode(Mode: LockMode): LockMode {
  const md = { v: NullMode };
  TryLMode(Mode, md, 0);
  return md.v;
}
// PAS: FILEACC.PAS OldLMode
export function OldLMode(Mode: LockMode): void {
  const cf = AccessVars.CFile!;
  if (cf.Handle === 0xff) return;
  if (Mode !== cf.LMode) ChangeLMode(Mode, 0, true);
}

// PAS: FILEACC.PAS TryLockN – Kind: 0-wait, 1-wait until ESC, 2-no wait
export function TryLockN(N: number, Kind: number): boolean {
  const XTxt = 'CrX';
  const cf = AccessVars.CFile!;
  let result = true;
  if (!cf.IsShared()) return result;
  let w = 0;
  // 1:
  for (;;) {
    if (!TryLockH(cf.Handle, RecLock + N, 1)) {
      if (Kind !== 2) {
        let m = 826;
        if (N === 0) {
          SetCPathVol();
          Set2MsgPar(BaseVars.CPath, XTxt);
          m = 825;
        }
        const w1 = PushWrLLMsg(m, Kind === 1);
        if (w === 0) w = w1;
        else AccessVars.TWork.Delete(w1);
        // beep; don't disturb
        if (KbdTimer(BaseVars.Spec.NetDelay, Kind)) continue;
      }
      result = false;
    }
    break;
  }
  if (w !== 0) PopW(w);
  return result;
}
// PAS: FILEACC.PAS UnLockN
export function UnLockN(N: number): void {
  const cf = AccessVars.CFile!;
  if (cf.Handle === 0xff || !cf.IsShared()) return;
  UnLockH(cf.Handle, RecLock + N, 1);
}

// PAS: FILEACC.PAS CExtToT
export function CExtToT(): void {
  const bv = BaseVars;
  if (SEquUpcase(bv.CExt, '.RDB')) bv.CExt = '.TTT';
  else if (SEquUpcase(bv.CExt, '.DBF')) {
    if (AccessVars.CFile!.TF!.Format === FptFormat) bv.CExt = '.FPT';
    else bv.CExt = '.DBT';
  } else if (bv.CExt.length >= 2) bv.CExt = bv.CExt[0] + 'T' + bv.CExt.slice(2);
  bv.CPath = bv.CDir + bv.CName + bv.CExt;
}
// PAS: FILEACC.PAS CExtToX
export function CExtToX(): void {
  const bv = BaseVars;
  if (bv.CExt.length >= 2) bv.CExt = bv.CExt[0] + 'X' + bv.CExt.slice(2);
  bv.CPath = bv.CDir + bv.CName + bv.CExt;
}
// PAS: FILEACC.PAS CloseGoExit
export function CloseGoExit(): never {
  CloseClearHCFile();
  return GoExit();
}
// PAS: FILEACC.PAS TestCFileError
export function TestCFileError(): void {
  if (BaseVars.HandleError !== 0) CFileError(700 + BaseVars.HandleError);
}
// PAS: FILEACC.PAS TestCPathError
export function TestCPathError(): void {
  const bv = BaseVars;
  if (bv.HandleError !== 0) {
    let n = 700 + bv.HandleError;
    if (n === 705 && bv.CPath[bv.CPath.length - 1] === DirectorySeparator) n = 840;
    SetMsgPar(bv.CPath);
    RunError(n);
  }
}

// ---------------------------------------------------------------- TFile

// PAS: FILEACC.PAS TT1Page – field offsets in the 512-byte T00 header
const T_Signum = 0;
const T_OldMaxPage = 2;
const T_FreePart = 4;
const T_IRec = 11;
const T_TimeStmp = 21;
const T_HasCoproc = 27;
const T_Version = 53;
const T_LicText = 57;
const T_Sum = 162;
const T_LicNr = 458;
const T_PwNew = 471;
const T_Time = 511;
const T_FreeRoot = 13;

// PAS: ACCESS.PAS TFile – memo/text file (.T00 etc.) of a FileD, or the work file TWork
export class TFile {
  Handle = 0xff;
  FreePart = 0;
  Reserved = false;
  CompileProc = false;
  CompileAll = false;
  IRec = 0;
  FreeRoot = 0;
  MaxPage = 0;
  /** Real48 in the file header (FPC: array[1..6] of byte) */
  TimeStmp: float = 0;
  LicenseNr = 0;
  MLen = 0;
  PwCode: PwCodeArr = '';
  Pw2Code: PwCodeArr = '';
  Format = T00Format;
  BlockSize = 0; // FptFormat
  IsWork = false;

  // PAS: FILEACC.PAS TFile.Err
  Err(n: number, ex: boolean): void {
    if (this.IsWork) {
      SetMsgPar(BaseVars.FandWorkTName);
      WrLLF10Msg(n);
      if (ex) GoExit();
    } else {
      CFileMsg(n, 'T');
      if (ex) CloseGoExit();
    }
  }
  // PAS: FILEACC.PAS TFile.TestErr
  TestErr(): void {
    if (BaseVars.HandleError !== 0) this.Err(700 + BaseVars.HandleError, true);
  }
  // PAS: FILEACC.PAS TFile.UsedFileSize
  UsedFileSize(): number {
    if (this.Format === FptFormat) return this.FreePart * this.BlockSize;
    return (this.MaxPage + 1) * MPageSize;
  }
  // PAS: FILEACC.PAS TFile.NotCached
  NotCached(): boolean {
    return !this.IsWork && AccessVars.CFile!.NotCached();
  }
  // PAS: FILEACC.PAS TFile.RdPrefix
  RdPrefix(Chk: boolean): void {
    const GetMLen = (): void => {
      this.MLen = (this.MaxPage + 1) * MPageSize;
    };
    const T = new Uint8Array(512);
    let FS = 0;
    let ML = 0;
    if (Chk) {
      FS = FileSizeH(this.Handle);
      if (FS <= 512) {
        PwEmpty(this);
        this.SetEmpty();
        return;
      }
    }
    RdWrCache(true, this.Handle, this.NotCached(), 0, 512, T);
    const RS = RandSeed;
    this.LicenseNr = 0;
    if (this.Format === DbtFormat) {
      this.MaxPage = getLongint(T, 0) - 1; // TNxtAvailPage
      GetMLen();
      return;
    }
    if (this.Format === FptFormat) {
      this.FreePart = SwapLong(getLongint(T, 0));
      this.BlockSize = Swap(getWord(T, 6));
      return;
    }
    // Move(T.FreePart,FreePart,23)
    this.FreePart = getLongint(T, T_FreePart);
    this.Reserved = T[8] !== 0;
    this.CompileProc = T[9] !== 0;
    this.CompileAll = T[10] !== 0;
    this.IRec = getWord(T, T_IRec);
    this.FreeRoot = getLongint(T, 13);
    this.MaxPage = getLongint(T, 17);
    this.TimeStmp = readReal48(T, T_TimeStmp);
    const version = new Uint8Array(4);
    for (let i = 0; i < 4; i++) version[i] = BaseVars.Version.charCodeAt(i) & 0xff;
    if (
      !this.IsWork &&
      AccessVars.CFile === AccessVars.Chpt &&
      ((T[T_HasCoproc] !== 0) !== HasCoproc || CompArea(version, T.subarray(T_Version), 4) !== 1)
    ) {
      this.CompileAll = true;
    }
    const OldMaxPage = getWord(T, T_OldMaxPage);
    if (OldMaxPage !== 0xffff && this.FreePart > 0) {
      this.FreeRoot = 0;
      if (!Chk) FS = FileSizeH(this.Handle);
      ML = FS;
      this.MaxPage = (FS - 1) >>> MPageShft;
      GetMLen();
    } else {
      if (OldMaxPage !== 0xffff) {
        this.FreeRoot = 0;
        this.FreePart = -this.FreePart;
        this.MaxPage = OldMaxPage;
      }
      // 1:
      GetMLen();
      ML = this.MLen;
      if (!Chk) FS = ML;
    }
    if (this.IRec >= 0x6000) {
      this.IRec = this.IRec - 0x2000;
      if (!this.IsWork && AccessVars.CFile!.Typ === '0') this.LicenseNr = getInteger(T, T_LicNr);
    }
    if (this.IRec >= 0x4000) {
      this.IRec = this.IRec - 0x4000;
      RandSeed = (ML + T[T_Time]) >>> 0;
      for (let i = 14; i <= 511; i++) T[i - 1] ^= Random(255);
      PwFromBytes(this, T, T_PwNew);
    } else {
      RandSeed = ML >>> 0;
      for (let i = 14; i <= 53; i++) T[i - 1] ^= Random(255);
      PwFromBytes(this, T, T_FreeRoot); // Pw
    }
    const pw = PwToBytes(this);
    Code(pw, 40);
    PwFromBytes(this, pw, 0);
    if (this.FreePart < MPageSize || this.FreePart > ML || FS < ML || this.FreeRoot > this.MaxPage || this.MaxPage === 0) {
      this.Err(893, false);
      this.MaxPage = (FS - 1) >>> MPageShft;
      this.FreeRoot = 0;
      GetMLen();
      this.FreePart = this.NewPage(true);
      SetUpdHandle(this.Handle);
    }
    T.fill(0);
    RandSeed = RS;
  }
  // PAS: FILEACC.PAS TFile.WrPrefix
  WrPrefix(): void {
    const T = new Uint8Array(512);
    if (this.Format === DbtFormat) {
      T.fill(0x20);
      setLongint(T, 0, this.MaxPage + 1); // TNxtAvailPage
    } else if (this.Format === FptFormat) {
      setLongint(T, 0, SwapLong(this.FreePart));
      setWord(T, 6, Swap(this.BlockSize));
    } else {
      T.fill(0x40); // '@'
      const Pw = PwToBytes(this);
      Code(Pw, 40);
      const RS = RandSeed;
      if (this.LicenseNr !== 0) for (let i = 1; i <= 20; i++) Pw[i - 1] = Random(255);
      let n = 0x4000;
      // BP7: Time:byte absolute 0:$46C (BIOS ticks, 18.2/s)
      const Time = Math.floor(Clock.now().getTime() / 54.9254) & 0xff;
      T[T_Time] = Time;
      T.set(Pw, T_PwNew);
      RandSeed = (this.MLen + T[T_Time]) >>> 0;
      for (let i = 14; i <= 511; i++) T[i - 1] ^= Random(255);
      setWord(T, T_LicNr, this.LicenseNr & 0xffff);
      if (this.LicenseNr !== 0) {
        n = 0x6000;
        let sum = T[T_LicNr]; // byte := word
        for (let i = 1; i <= 105; i++) sum = (sum + T[T_LicText + i - 1]) & 0xff;
        T[T_Sum] = sum;
      }
      // Move(FreePart,T.FreePart,23)
      setLongint(T, T_FreePart, this.FreePart);
      T[8] = this.Reserved ? 1 : 0;
      T[9] = this.CompileProc ? 1 : 0;
      T[10] = this.CompileAll ? 1 : 0;
      setWord(T, T_IRec, this.IRec & 0xffff);
      setLongint(T, 13, this.FreeRoot);
      setLongint(T, 17, this.MaxPage);
      WriteTimeStmp(this.TimeStmp, T, T_TimeStmp);
      setWord(T, T_OldMaxPage, 0xffff);
      setWord(T, T_Signum, 1);
      setWord(T, T_IRec, (getWord(T, T_IRec) + n) & 0xffff);
      for (let i = 0; i < 4; i++) T[T_Version + i] = BaseVars.Version.charCodeAt(i) & 0xff;
      T[T_HasCoproc] = HasCoproc ? 1 : 0;
      RandSeed = RS;
    }
    // 1:
    RdWrCache(false, this.Handle, this.NotCached(), 0, 512, T);
  }
  // PAS: FILEACC.PAS TFile.SetEmpty
  SetEmpty(): void {
    if (this.Format === DbtFormat) {
      this.MaxPage = 0;
      this.WrPrefix();
      return;
    }
    if (this.Format === FptFormat) {
      this.FreePart = 8;
      this.BlockSize = 64;
      this.WrPrefix();
      return;
    }
    this.FreeRoot = 0;
    this.MaxPage = 1;
    this.FreePart = MPageSize;
    this.MLen = 2 * MPageSize;
    this.WrPrefix();
    const X = new Uint8Array(MPageSize);
    setInteger(X, 0, -510); // XL
    RdWrCache(false, this.Handle, this.NotCached(), MPageSize, MPageSize, X);
  }
  // PAS: FILEACC.PAS TFile.Create
  Create(): void {
    this.Handle = OpenH(_isoverwritefile, Exclusive);
    this.TestErr();
    this.IRec = 1;
    this.LicenseNr = 0;
    PwEmpty(this);
    this.SetEmpty();
  }
  // PAS: FILEACC.PAS TFile.NewPage – a zeroed page (NegL: a free slot of 510 bytes, L:longint=-510)
  NewPage(NegL: boolean): number {
    let PosPg = 0;
    let fromFree = false;
    if (this.FreeRoot !== 0) {
      PosPg = this.FreeRoot * MPageSize;
      const b = new Uint8Array(4);
      RdWrCache(true, this.Handle, this.NotCached(), PosPg, 4, b);
      this.FreeRoot = getLongint(b, 0);
      if (this.FreeRoot > this.MaxPage) {
        this.Err(888, false);
        this.FreeRoot = 0; // goto 1
      } else fromFree = true;
    }
    if (!fromFree) {
      // 1:
      this.MaxPage++;
      this.MLen += MPageSize;
      PosPg = this.MaxPage * MPageSize;
    }
    const X = new Uint8Array(MPageSize);
    if (NegL) setLongint(X, 0, -510);
    RdWrCache(false, this.Handle, this.NotCached(), PosPg, MPageSize, X);
    return PosPg;
  }
  // PAS: FILEACC.PAS TFile.ReleasePage
  ReleasePage(PosPg: number): void {
    const X = new Uint8Array(MPageSize);
    setLongint(X, 0, this.FreeRoot); // Next
    RdWrCache(false, this.Handle, this.NotCached(), PosPg, MPageSize, X);
    this.FreeRoot = PosPg >>> MPageShft;
  }
  // PAS: FILEACC.PAS TFile.Delete
  Delete(Pos: number): void {
    if (Pos <= 0) return;
    if (this.Format !== T00Format || this.NotCached()) return;
    if (Pos < MPageSize || Pos >= this.MLen) {
      this.Err(889, false);
      return;
    }
    let PosPg = Pos - (Pos & (MPageSize - 1));
    const PosI = Pos & (MPageSize - 1);
    const X = new Uint8Array(MPageSize);
    RdWrCache(true, this.Handle, this.NotCached(), PosPg, MPageSize, X);
    let l = getWord(X, PosI);
    if (l <= MPageSize - 2) {
      // small text on 1 page
      setInteger(X, PosI, -l);
      let N = 0; // = offset of wp in X
      let used = false;
      while (N < MPageSize - 2) {
        const v = getInteger(X, N);
        if (v > 0) {
          X.fill(0, PosI + 2, PosI + 2 + l);
          used = true; // goto 1
          break;
        }
        N += -v + 2;
      }
      if (used) RdWrCache(false, this.Handle, this.NotCached(), PosPg, MPageSize, X);
      else if (this.FreePart >= PosPg && this.FreePart < PosPg + MPageSize) {
        X.fill(0);
        setInteger(X, 0, -510);
        this.FreePart = PosPg;
        // 1:
        RdWrCache(false, this.Handle, this.NotCached(), PosPg, MPageSize, X);
      } else this.ReleasePage(PosPg);
      return;
    }
    // long text on more than 1 page
    if (PosI !== 0) {
      this.Err(889, false); // 3:
      return;
    }
    let IsLongTxt = false;
    let at2 = true;
    for (;;) {
      if (at2) {
        // 2:
        l = getWord(X, 0); // XL
        if (l > MaxLStrLen + 1) {
          this.Err(889, false); // 3:
          return;
        }
        IsLongTxt = l === MaxLStrLen + 1;
        l += 2;
      }
      // 4:
      this.ReleasePage(PosPg);
      if (l > MPageSize || IsLongTxt) {
        PosPg = getLongint(X, MPageSize - 4);
        if (PosPg < MPageSize || PosPg + MPageSize > this.MLen) {
          this.Err(888, false);
          return;
        }
        RdWrCache(true, this.Handle, this.NotCached(), PosPg, MPageSize, X);
        if (l <= MPageSize) {
          at2 = true;
          continue;
        }
        l -= MPageSize - 4;
        at2 = false;
        continue;
      }
      break;
    }
  }
  // PAS: FILEACC.PAS TFile.Read – StackNr 1: GetStore, else GetStore2 (both GC here)
  Read(StackNr: number, Pos: number): Uint8Array {
    Pos -= this.LicenseNr;
    if (Pos <= 0) return new Uint8Array(0); // OldTxt=-1 in RDB! (11:)
    switch (this.Format) {
      case DbtFormat: {
        const buf = new Uint8Array(32768);
        Pos = Pos * MPageSize;
        let p = 0;
        let l = 0;
        let found = false;
        pages: while (l <= 32768 - MPageSize) {
          RdWrCache(true, this.Handle, this.NotCached(), Pos, MPageSize, buf.subarray(p));
          for (let i = 1; i <= MPageSize; i++) {
            if (buf[p + i - 1] === 0x1a) {
              found = true; // goto 0
              break pages;
            }
            l++;
          }
          p += MPageSize;
          Pos += MPageSize;
        }
        if (!found) l--;
        // 0:
        return buf.slice(0, l);
      }
      case FptFormat: {
        Pos = Pos * this.BlockSize;
        const FptD = new Uint8Array(8);
        RdWrCache(true, this.Handle, this.NotCached(), Pos, 8, FptD);
        if (SwapLong(getLongint(FptD, 0)) !== 1) return new Uint8Array(0); // not text (11:)
        const l = SwapLong(getLongint(FptD, 4)) & 0x7fff;
        const s = new Uint8Array(l);
        RdWrCache(true, this.Handle, this.NotCached(), Pos + 8, l, s);
        return s;
      }
      default: {
        if (Pos < MPageSize || Pos >= this.MLen) {
          this.Err(891, false); // 1:
          return new Uint8Array(0); // 11:
        }
        const b = new Uint8Array(2);
        RdWrCache(true, this.Handle, this.NotCached(), Pos, 2, b);
        let l = getWord(b, 0);
        if (l > MaxLStrLen + 1) {
          this.Err(891, false);
          return new Uint8Array(0);
        }
        if (l === MaxLStrLen + 1) l--;
        const s = new Uint8Array(l);
        this.RdWr(true, Pos + 2, l, s);
        return s;
      }
    }
  }
  // PAS: FILEACC.PAS TFile.Store – returns the text position (0 for an empty text)
  Store(S: Uint8Array): number {
    let l = S.length;
    if (l === 0) return 0;
    let Pos: number;
    if (this.Format === DbtFormat) {
      Pos = this.MaxPage + 1;
      const N = Pos * MPageSize;
      if (l > 0x7fff) l = 0x7fff;
      RdWrCache(false, this.Handle, this.NotCached(), N, l, S);
      const X = new Uint8Array(MPageSize + 2).fill(0x20); // X:array[0..MPageSize] (+1: rest+2 may be 514)
      X[0] = 0x1a;
      X[1] = 0x1a;
      const rest = MPageSize - ((l + 2) % MPageSize);
      RdWrCache(false, this.Handle, this.NotCached(), N + l, rest + 2, X);
      this.MaxPage += Math.trunc((l + 2 + rest) / MPageSize);
      return Pos; // 1:
    }
    if (this.Format === FptFormat) {
      Pos = this.FreePart;
      let N = this.FreePart * this.BlockSize;
      if (l > 0x7fff) l = 0x7fff;
      this.FreePart = this.FreePart + Math.trunc((8 + l - 1) / this.BlockSize) + 1;
      const FptD = new Uint8Array(8);
      setLongint(FptD, 0, SwapLong(1));
      setLongint(FptD, 4, SwapLong(l));
      RdWrCache(false, this.Handle, this.NotCached(), N, 8, FptD);
      N += 8;
      RdWrCache(false, this.Handle, this.NotCached(), N, l, S);
      N += l;
      const L = this.FreePart * this.BlockSize - N; // Pascal: the same variable l (word)
      if (L > 0) {
        const p = new Uint8Array(L).fill(0x20);
        RdWrCache(false, this.Handle, this.NotCached(), N, L, p);
      }
      return Pos; // 1:
    }
    if (l > MaxLStrLen) l = MaxLStrLen;
    if (l > MPageSize - 2) Pos = this.NewPage(false); // long text
    else {
      // short text
      let Rest = MPageSize - (this.FreePart % MPageSize);
      if (l + 2 <= Rest) Pos = this.FreePart;
      else {
        Pos = this.NewPage(false);
        this.FreePart = Pos;
        Rest = MPageSize;
      }
      if (l + 4 >= Rest) this.FreePart = this.NewPage(false);
      else {
        this.FreePart += l + 2;
        Rest = l + 4 - Rest;
        const b = new Uint8Array(2);
        setInteger(b, 0, Rest);
        RdWrCache(false, this.Handle, this.NotCached(), this.FreePart, 2, b);
      }
    }
    const lb = new Uint8Array(2);
    setWord(lb, 0, l);
    RdWrCache(false, this.Handle, this.NotCached(), Pos, 2, lb);
    this.RdWr(false, Pos + 2, l, S);
    return Pos; // 1:
  }
  // PAS: FILEACC.PAS TFile.RdWr (private in Pascal) – X[0..N-1]
  RdWr(ReadOp: boolean, Pos: number, N: number, X: Uint8Array): void {
    let Rest = MPageSize - (Pos & (MPageSize - 1));
    let P = 0;
    const nb = new Uint8Array(4);
    let NxtPg = 0;
    while (N > Rest) {
      const L = Rest - 4;
      RdWrCache(ReadOp, this.Handle, this.NotCached(), Pos, L, X.subarray(P));
      P += L;
      N -= L;
      if (!ReadOp) {
        NxtPg = this.NewPage(false);
        setLongint(nb, 0, NxtPg);
      }
      RdWrCache(ReadOp, this.Handle, this.NotCached(), Pos + L, 4, nb);
      if (ReadOp) NxtPg = getLongint(nb, 0);
      Pos = NxtPg;
      if (ReadOp && (Pos < MPageSize || Pos + MPageSize > this.MLen)) {
        this.Err(890, false);
        X.fill(0x20, P, P + N);
        return;
      }
      Rest = MPageSize;
    }
    RdWrCache(ReadOp, this.Handle, this.NotCached(), Pos, N, X.subarray(P));
  }
}

/** TS: TT1Page.TimeStmp := TimeStmp – the BP7 Real48 (FPC moves raw bytes). */
function WriteTimeStmp(r: float, T: Uint8Array, ofs: number): void {
  try {
    writeReal48(r, T, ofs);
  } catch {
    T.fill(0, ofs, ofs + 6);
  }
}

// ---------------------------------------------------------------- FILE MANAGEMENT

// PAS: ACCESS.PAS FileD – a declared data file (also the RDB chapter file and the catalog)
export class FileD {
  Chain: FileDPtr = null;
  RecLen = 0;
  RecPtr: Uint8Array | null = null;
  NRecs = 0;
  WasWrRec = false;
  WasRdOnly = false;
  EOF = false;
  /** 8=Fand 8; 6=Fand 16; X= .X; 0=RDB; C=CAT; D=dBase */
  Typ = '\0';
  Handle = 0xff;
  IRec = 0;
  FrstDispl = 0;
  TF: TFilePtr = null;
  /** zero for Rdb and FD translated from string */
  ChptPos = new RdbPos();
  TxtPosUDLI = 0; // =0 if not present
  OrigFD: FileDPtr = null; // like orig. or nil
  Drive = 0; // 1=A:, 2=B:, else 0
  CatIRec = 0;
  FldD: FieldDPtr = null;
  IsParFile = false;
  IsJournal = false;
  IsHlpFile = false;
  typSQLFile = false;
  IsSQLFile = false;
  IsDynFile = false;
  UMode: FileUseMode = 0;
  LMode: LockMode = 0;
  ExLMode: LockMode = 0;
  TaLMode: LockMode = 0;
  ViewNames: StringList = null; // after each string: byte string with user codes (StringListEl.After)
  XF: XFilePtr = null;
  Keys: KeyDPtr = null;
  Add: AddDPtr = null;
  nLDs = 0;
  /** Pascal: offset of the LiRoots record allocated after the FileD (0 = none); TS: the record. */
  LiOfs: LiRoots | null = null;
  Name: NameStr = '';

  // PAS: FILEACC.PAS FileD.UsedFileSize
  UsedFileSize(): number {
    let n = this.NRecs * this.RecLen + this.FrstDispl;
    if (this.Typ === 'D') n++;
    return n;
  }
  // PAS: FILEACC.PAS FileD.IsShared
  IsShared(): boolean {
    return this.UMode === Shared || this.UMode === RdShared;
  }
  // PAS: FILEACC.PAS FileD.NotCached
  NotCached(): boolean {
    return (this.UMode === Shared || this.UMode === RdShared) && this.LMode !== ExclMode;
  }
  // PAS: FILEACC.PAS FileD.GetNrKeys
  GetNrKeys(): number {
    let n = 0;
    for (let k = this.Keys; k !== null; k = k.Chain) n++;
    return n;
  }
}

// PAS: FILEACC.PAS RdPrefix – of CFile; $FFFF = ok, else the record length found in the file
export function RdPrefix(): number {
  const cf = AccessVars.CFile!;
  switch (cf.Typ) {
    case '8': {
      const X8 = new Uint8Array(4);
      RdWrCache(true, cf.Handle, cf.NotCached(), 0, 4, X8);
      cf.NRecs = getWord(X8, 0);
      const RLen = getWord(X8, 2);
      if (cf.RecLen !== RLen) return RLen;
      break;
    }
    case 'D': {
      const XD = new Uint8Array(12);
      RdWrCache(true, cf.Handle, cf.NotCached(), 0, 12, XD);
      cf.NRecs = getLongint(XD, 4);
      const RLen = getWord(XD, 10);
      if (cf.RecLen !== RLen) return RLen;
      cf.FrstDispl = getWord(XD, 8);
      break;
    }
    default: {
      const X6 = new Uint8Array(6);
      RdWrCache(true, cf.Handle, cf.NotCached(), 0, 6, X6);
      const NRs = getLongint(X6, 0);
      const RLen = getWord(X6, 4);
      cf.NRecs = Math.abs(NRs);
      if ((NRs < 0 && cf.Typ !== 'X') || (NRs > 0 && cf.Typ === 'X') || cf.RecLen !== RLen) return RLen;
    }
  }
  return 0xffff;
}
// PAS: FILEACC.PAS RdPrefixes
export function RdPrefixes(): void {
  if (RdPrefix() !== 0xffff) CFileError(883);
  const cf = AccessVars.CFile!;
  if (cf.XF !== null && cf.XF.Handle !== 0xff) cf.XF.RdPrefix();
  if (cf.TF !== null) cf.TF.RdPrefix(false);
}

// PAS: FILEACC.PAS WrPrefix.WrDBaseHd (local) – the .DBF header (32 bytes + 32 per field + CR)
function WrDBaseHd(): void {
  const cf = AccessVars.CFile!;
  const P = GetZStore(cf.FrstDispl);
  let F = cf.FldD;
  let n = 0;
  while (F !== null) {
    if ((F.Flg & f_Stored) !== 0) {
      n++;
      const o = 32 * n; // Flds[n]: Name@0 (11) Typ@11 Displ@12 Len@16 Dec@17
      let Typ = 0;
      switch (F.Typ) {
        case 'F':
          Typ = 0x4e; // 'N'
          P[o + 17] = F.M;
          break;
        case 'N':
          Typ = 0x4e;
          break;
        case 'A':
          Typ = 0x43; // 'C'
          break;
        case 'D':
          Typ = 0x44; // 'D'
          break;
        case 'B':
          Typ = 0x4c; // 'L'
          break;
        case 'T':
          Typ = 0x4d; // 'M'
          break;
      }
      P[o + 11] = Typ;
      P[o + 16] = F.NBytes;
      setLongint(P, o + 12, F.Displ);
      let s = F.Name.slice(0, 11);
      let su = '';
      for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        su += String.fromCharCode(c >= 0x61 && c <= 0x7a ? c - 32 : c); // System.UpCase
      }
      s = su;
      StrLPCopy(P.subarray(o, o + 11), s, 11);
    }
    F = F.Chain;
  }
  if (cf.TF !== null) P[0] = cf.TF.Format === FptFormat ? 0xf5 : 0x83;
  else P[0] = 0x03;
  setWord(P, 10, cf.RecLen);
  const d = { v: 0 };
  const m = { v: 0 };
  const y = { v: 0 };
  SplitDate(Today(), d, m, y);
  P[1] = (y.v - 1900) & 0xff;
  P[2] = m.v;
  P[3] = d.v;
  setLongint(P, 4, cf.NRecs);
  const HdLen = cf.FrstDispl;
  setWord(P, 8, HdLen);
  const cr = Math.trunc(HdLen / 32) * 32;
  if (cr < P.length) P[cr] = 0x0d; // PA^[(HdLen div 32)*32+1]:=^m
  RdWrCache(false, cf.Handle, cf.NotCached(), 0, cf.FrstDispl, P);
  RdWrCache(false, cf.Handle, cf.NotCached(), cf.NRecs * cf.RecLen + cf.FrstDispl, 1, new Uint8Array([0x1a]));
}

// PAS: FILEACC.PAS WrPrefix – of CFile, when its handle was updated
export function WrPrefix(): void {
  const cf = AccessVars.CFile!;
  if (!IsUpdHandle(cf.Handle)) return;
  switch (cf.Typ) {
    case '8': {
      const Pfx8 = new Uint8Array(4);
      setWord(Pfx8, 2, cf.RecLen);
      setWord(Pfx8, 0, cf.NRecs & 0xffff);
      RdWrCache(false, cf.Handle, cf.NotCached(), 0, 4, Pfx8);
      break;
    }
    case 'D':
      WrDBaseHd();
      break;
    default: {
      const Pfx6 = new Uint8Array(6);
      setWord(Pfx6, 4, cf.RecLen);
      setLongint(Pfx6, 0, cf.Typ === 'X' ? -cf.NRecs : cf.NRecs);
      RdWrCache(false, cf.Handle, cf.NotCached(), 0, 6, Pfx6);
    }
  }
}
// PAS: FILEACC.PAS WrPrefixes
export function WrPrefixes(): void {
  WrPrefix();
  const cf = AccessVars.CFile!;
  if (cf.TF !== null && IsUpdHandle(cf.TF.Handle)) cf.TF.WrPrefix();
  if (
    cf.Typ === 'X' &&
    cf.XF!.Handle !== 0xff && // call from CopyDuplF
    (IsUpdHandle(cf.XF!.Handle) || IsUpdHandle(cf.Handle))
  ) {
    cf.XF!.WrPrefix();
  }
}

// PAS: FILEACC.PAS XFNotValid
export function XFNotValid(): void {
  const XF = AccessVars.CFile!.XF;
  if (XF === null) return;
  if (XF.Handle === 0xff) RunError(903);
  XF.SetNotValid();
}
