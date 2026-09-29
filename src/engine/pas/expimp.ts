// PAS: EXPIMP.PAS – COPYFILE (text import/export, file copy, code page conversion), BACKUP/RESTORE
// (floppy archives and BACKUPM directory archives), RDB encoding for run-only applications
// (CodingCRdb/PromptCodeRdb/XEncode), CheckFile, OldToNewCat.
// Include DISKFPC.PAS (FPC) / DISK.PAS (BP7) → disk.ts, re-exported here (FormatOnDrive, TcFile, TBoot, ...).
//
// Porting notes:
// * No interface variables, no unit initialization. Private: `Nm: NameStr` (CloseEqualFD),
//   `E: EditDPtr absolute EditDRoot` → a getter over RdRunVars.EditDRoot.
// * Private types: InOutMode (_inp, _outp, _append); ThFile = object(TcFile) (text/binary host file,
//   floppy continuation volumes: ext digit +5 and volume label +1), TyFile = object(TcFile) (floppy
//   mount + FAT wipe), TbFile = object(TyFile) (BACKUP), TzFile = object(TyFile) (BACKUPM: directory
//   tree archive with a work-file directory list).
//   TcFile lives in disk.ts and PORTING.md 5 forbids a top-level `extends` across modules, so ThFile
//   and TyFile are declared as plain classes merged with `interface X extends TcFile`, and their
//   constructors link the prototype to TcFile.prototype (LinkTcFile) and copy TcFile's field
//   initialisers. `inherited Init` is `TcFile.prototype.Init.call(this, ...)`. TbFile/TzFile extend
//   TyFile in this module normally; their constructors are InitB/InitZ because TcFile.Init(aCompress)
//   is on the same prototype chain with another signature.
// * Private routines: Ovr (no-op), CloseEqualFD, VarFixImp/VarFixExp (fixed/variable-format record
//   text), CopyFile's nested TxtCtrlJ/ImportTxt/ExportTxt/MakeMerge/ExportFD/ImportFD/MakeCopy
//   (module-level functions taking CD), ConvWinCp, CompressCRdb, CodingCRdb's nested CompressTxt
//   (module level, exported for tests)/CodeF, PromptCodeRdb's AddLicNr/CopyH.
// * asm/DOS-specific:
//   - ConvWinCp is asm in BP7 (FPC Pascal: bytes >= $80 mapped through the 128-byte table from
//     ResFile.Get(LatToWinCp/KamToWinCp/WinCpToLat)).
//   - XEncode is asm in BP7 (LZ77-like: flag byte per 8 items, literal = byte xor rotating RMask
//     seeded from the low bits of the BIOS Timer, match = len byte + word source offset; then the
//     output is shifted right by Displ random bytes (TP Random) and t + (Displ xor $CCCC) is
//     appended). FPC XEncode is a plain copy. **BP7 wins**: CodingCRdb(true) writes the chapter
//     texts of a run-only RDB that UFAND.EXE must decode with XDecode (fand/coding.ts xDecode).
//     The Timer/Random input makes the output nondeterministic; any value decodes. The match search
//     is the asm's (earliest longest source match, len 3..255, later candidates win once the length
//     exceeds 255), found through 3-byte hash chains instead of a scan of every position.
//   - DOS writes of 0 bytes truncate the file (ImportFD, RestoreHFD `WriteH(h,0,Buf^)`); the FPC
//     WriteH does not. BP7 wins: handle.ts WriteH truncates on 0 bytes.
//   - TyFile.MountVol: floppy volume labels, boot sector/FAT rewrite through disk.ts TBoot
//     (int $25/$26 in BP7, stubs in FPC). A host has no volume labels (FindFirst(VolumeID) gives
//     DosError 18) and TBoot.ReadSect fails, so a floppy volume ends in RunError(656) as in FPC.
//   - GetDir/ChDir/MkDir/FindFirst/FindNext (TzFile) are host helpers (TS-only).
// * Key global state: BaseVars.CPath/CVol/CDir/CName/CExt, BaseVars.LastExitCode (COPYFILE result:
//   2 on start, 0 on success; CheckFile: 0 ok, 1 missing, 2 open error, 3 bad prefix, 4 missing .T),
//   AccessVars.CFile/CRecPtr/Chpt/ChptTF/CRdb/MountedVol, BaseVars.UserLicNr, compiler input state
//   (InpArrPtr/InpArrLen/CurrPos/ForwChar/PrevCompInp/SwitchLevel) used by CompressTxt.
// * TS deviations (marked in the code): ThFile.Done sets Handle := $FF (the callers' final
//   `if Handle<>$FF then Done` would otherwise close a DOS handle number already reused, e.g. by
//   ImportFD's OpenF of the catalog); CompressTxt stops an unterminated comment at ^Z and TzFile.RdH
//   stops at the end of a truncated archive (Pascal loops forever); ImportTxt calls OldLMode only
//   when RewriteF ran.

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {
  ref, fref, chr, ord, byte, getWord, setWord, getLongint, setLongint, StrR, ValR, StrToBytes, FromUnicode,
  ToUnicode, FSplit, GoExitSignal, type Ref, type Pointer,
  DirectorySeparator,
} from './pasrt.ts';
import type { LongStrPtr, StringPtr } from './base.ts';
import {
  BaseVars, MaxLStrLen, LatToWinCp, KamToWinCp, WinCpToLat, GetStore, GetZStore, MarkStore, ReleaseStore,
  MarkStore2, ReleaseStore2, MarkBoth, ReleaseBoth, ReleaseAfterLongStr, ExitRecord, NewExit, RestoreExit, GoExit,
  OpenH, CloseH, ReadH, WriteH, SeekH, FileSizeH, TruncH, FlushH, DeleteFile, RenameFile56, ClearCacheH,
  CloseClearH, SetUpdHandle, IsNetCVol, UnixPath, SEquUpcase, SetMsgPar, Set2MsgPar, AddBackSlash, DelBackSlash,
  ChainLast, MinW, EqualsMask, StrDate, ValDate, RdWrCache, SaveCache,
  _isnewfile, _isoldfile, _isoverwritefile, _isoldnewfile, RdOnly, RdShared, Shared, Exclusive,
} from './base.ts';
import { DosView, DosFExpand, GetDirDos, HostToDos } from './handle.ts';
import type { FileDPtr, FieldDPtr, LockMode, StringList } from './access.ts';
import {
  AccessVars, StringListEl, CompInpD, FrmlElem, XScan, Power10, FloppyDrives, NullMode, RdMode, ExclMode,
  f_Stored, f_Comma, _const, _number, FieldDMask, Code, GetRecSpace, ClearRecSpace, ZeroAllFlds, ClearDeletedFlag,
  PutRec, ReadRec, WriteRec, DeleteRec, TryInsertAllIndexes, LinkLastRec, AsgnParFldFrml, XNRecs, NewLMode,
  OldLMode, ChangeLMode, TestCFileError, TestCPathError, XFNotValid, RdPrefixes, WrPrefixes, CExtToT, CExtToX,
  ForAllFDs, SaveCompInp, LoadCompInp, _R, _B, _T, _ShortS, _LongS, R_, B_, S_, T_, LongS_,
} from './access.ts';
import type { CopyDPtr, InstrPtr, CpOption, EditDPtr } from './rdrun.ts';
import { RdRunVars, cpFix, cpVar, cpTxt } from './rdrun.ts';
import { DriversVars, _ESC_, _AltF10_, ConvKamenLatin, ConvToNoDiakr, foKamen, foLatin2 } from './drivers.ts';
import { RunError, PromptYN, WrLLF10Msg, RunMsgOn, RunMsgN, RunMsgOff } from './obaseww.ts';
import {
  CloseFile, SetCPathVol, SetTxtPathVol, TestMountVol, SaveFiles, OpenF, RewriteF, RdCatField, ClosePassiveFD,
  ReleaseDrive,
} from './oaccess.ts';
import { LeadChar, TrailChar, RunLongStr, RunShortStr, RunFrmlVars } from './runfrml.ts';
import { TpRandom } from '../fand/coding.ts';
import { CompileVars, SetInpStr, RdLex, ReadChar, SkipBlank, RdDirective, SkipLevel, SetInpTT } from './compile.ts';
import { ReadMerge } from './rdmerg.ts';
import { RunMerge } from './runmerg.ts';
import { CRec } from './runedit1.ts';
import { PassWord, SetPassword, HasPassword } from './wwmix.ts';
import {
  TcFile, TBoot, FormatOnDrive, ResetDisks, FatPut, FatGet, fatBadCluster, FillVolDirEntry,
} from './disk.ts';

export * from './disk.ts';

const EOFChar = '\x1a'; // ^Z

// PAS: EXPIMP.PAS Ovr (FPC: empty)
function Ovr(): void {}

// PAS: EXPIMP.PAS E: EditDPtr absolute EditDRoot
function E(): EditDPtr {
  return RdRunVars.EditDRoot;
}

// ---------------------------------------------------------------- TS-only helpers

// TS-only: s with the 1-based char i replaced by c (Pascal `s[i] := c`)
function SetCh(s: string, i: number, c: string): string {
  return s.slice(0, i - 1) + c + s.slice(i);
}
// TS-only: Pascal `inc(s[i], d)` on a char of a byte string
function IncCh(s: string, i: number, d: number): string {
  return SetCh(s, i, chr(byte(ord(s[i - 1] ?? '\0') + d)));
}
// TS-only: DOS.FExpand – a relative path is resolved against the current directory; DOS-style
// absolute paths (drive or leading '\') are kept for UnixPath
function FExpand(Path: string): string {
  if (DosView.On) return DosFExpand(Path);
  if (/^[A-Za-z]:/.test(Path) || Path.startsWith('\\')) return Path;
  const u = ToUnicode(Path);
  let r = nodePath.resolve(u);
  if ((u === '' || u.endsWith('/')) && !r.endsWith('/')) r += '/';
  return FromUnicode(r);
}
// TS-only: System.GetDir(0, Dir)
function GetDir(): string {
  if (DosView.On) return GetDirDos();
  return FromUnicode(process.cwd());
}
// TS-only: {$I-} ChDir(d) – returns IOResult
function ChDirIO(d: string): number {
  try {
    process.chdir(ToUnicode(UnixPath(d)));
    return 0;
  } catch {
    return 3;
  }
}
// TS-only: {$I-} MkDir(d) – returns IOResult
function MkDirIO(d: string): number {
  try {
    fs.mkdirSync(ToUnicode(UnixPath(d)));
    return 0;
  } catch {
    return 5;
  }
}
// TS-only: DOS.SearchRec
class SearchRec {
  Attr = 0;
  Size = 0;
  Name = '';
  /** TS: the remaining matches of FindFirst */
  List: { Name: string; Attr: number; Size: number }[] = [];
}
const faDirectory = 0x10;
// TS-only: DOS.FindFirst(Dir+'*.*', Attr, S) over a host directory; returns DosError
// (0 found, 18 no more files, 3 path not found). Attr 0 lists files only, Directory also directories.
// Host dot files count as hidden and are not listed. Names are sorted (DOS gives directory order).
function FindFirstDir(Dir: string, Attr: number, S: SearchRec): number {
  let names: string[];
  const hd = ToUnicode(UnixPath(Dir === '' ? '.' : Dir));
  try {
    names = fs.readdirSync(hd).sort();
  } catch {
    S.List = [];
    return 3;
  }
  S.List = [];
  for (const n of names) {
    if (n.startsWith('.')) continue;
    let st: fs.Stats;
    try {
      st = fs.statSync(nodePath.join(hd, n));
    } catch {
      continue;
    }
    const isDir = st.isDirectory();
    if (isDir && (Attr & faDirectory) === 0) continue;
    S.List.push({ Name: FromUnicode(n), Attr: isDir ? faDirectory : 0x20, Size: st.size });
  }
  return FindNextDir(S);
}
// TS-only: DOS.FindNext(S); returns DosError
function FindNextDir(S: SearchRec): number {
  const e = S.List.shift();
  if (e === undefined) return 18;
  S.Name = e.Name;
  S.Attr = e.Attr;
  S.Size = e.Size;
  return 0;
}
// TS-only: DOS.FindFirst(drv+':\*.*', VolumeID, S) – a host has no volume labels (error 18)
function FindFirstVol(DrvNm: string, S: SearchRec): number {
  S.Name = '';
  return 18;
}

// TS-only: link a class declared as `interface X extends TcFile` to TcFile at run time (see header)
function LinkTcFile(C: { prototype: object }): void {
  if (Object.getPrototypeOf(C.prototype) !== TcFile.prototype) Object.setPrototypeOf(C.prototype, TcFile.prototype);
}

// ---------------------------------------------------------------- ThFile

type VolStr = string; // string[11]
// PAS: EXPIMP.PAS InOutMode
type InOutMode = number;
const _inp: InOutMode = 0;
const _outp: InOutMode = 1;
const _append: InOutMode = 2;

type PhFile = ThFile | null;

let Nm = ''; // PAS: EXPIMP.PAS Nm: NameStr (private, for CloseEqualFD)

// PAS: EXPIMP.PAS CloseEqualFD
function CloseEqualFD(): void {
  const cf = AccessVars.CFile!;
  const bv = BaseVars;
  if (cf.Typ !== '0' && SEquUpcase(cf.Name, Nm)) {
    const cp = bv.CPath;
    SetCPathVol();
    if (SEquUpcase(cp, bv.CPath)) CloseFile();
    bv.CPath = cp;
  }
}

// PAS: EXPIMP.PAS ThFile = object(TcFile)
interface ThFile extends Omit<TcFile, 'Init'> {}
class ThFile {
  Handle = 0;
  Path = '';
  Vol: VolStr = '';
  Mode: InOutMode = _inp;
  Floppy = false;
  IsEOL = false;
  Continued = false;
  Size = 0;
  OrigSize = 0;
  SpaceOnDisk = 0;
  FD: FileDPtr = null;

  constructor() {
    LinkTcFile(ThFile);
    Object.assign(this, new TcFile());
  }

  // PAS: EXPIMP.PAS ThFile.Init
  Init(APath: StringPtr, CatIRec: number, AMode: InOutMode, aCompress: number, F: PhFile): this {
    const bv = BaseVars;
    TcFile.prototype.Init.call(this, aCompress);
    this.Mode = AMode;
    this.Handle = 0xff;
    SetTxtPathVol(APath, CatIRec);
    this.Path = bv.CPath;
    this.Vol = bv.CVol;
    if (F !== null && F.Path === bv.CPath) {
      SetMsgPar(bv.CPath);
      RunError(660);
    }
    const l = bv.CPath.length;
    if (bv.CVol !== '#' && bv.CVol !== '' && bv.CPath.indexOf('.') + 1 === l - 3 &&
        bv.CPath[l - 1] >= '0' && bv.CPath[l - 1] <= '9' && bv.CPath[l - 2] >= '0' && bv.CPath[l - 2] <= '4') {
      this.Floppy = true;
    }
    const d = ref(''), n = ref(''), e = ref('');
    FSplit(bv.CPath, d, n, e);
    Nm = n.v;
    ForAllFDs(CloseEqualFD);
    switch (AMode) {
      case _inp:
        this.Reset();
        this.InitBufInp();
        break;
      case _outp:
        this.Rewrite();
        this.InitBufOutp();
        break;
      case _append:
        this.Append();
        this.InitBufOutp();
        break;
    }
    return this;
  }
  // PAS: EXPIMP.PAS ThFile.Done
  Done(): void {
    if (this.Mode === _inp) {
      CloseH(this.Handle);
      RunMsgOff();
    } else {
      this.WriteBuf(true);
      CloseH(this.Handle);
      if (!this.Continued && this.Size === 0) DeleteFile(this.Path);
    }
    this.Handle = 0xff; // TS: see the header (no second Done on a reused handle)
  }
  // PAS: EXPIMP.PAS ThFile.Append
  Append(): void {
    const bv = BaseVars;
    bv.CVol = this.Vol;
    bv.CPath = this.Path;
    TestMountVol(bv.CPath[0] ?? '\0');
    if (this.Floppy) {
      const l = bv.CPath.length;
      bv.CPath = IncCh(bv.CPath, l - 1, 5);
      for (;;) {
        // 1:
        this.Handle = OpenH(_isoldfile, RdOnly);
        if (bv.HandleError !== 0) break;
        CloseH(this.Handle);
        this.Continued = true;
        this.Vol = IncCh(this.Vol, this.Vol.length, 1);
        bv.CVol = this.Vol;
        TestMountVol(bv.CPath[0] ?? '\0');
      }
      bv.CPath = IncCh(bv.CPath, l - 1, -5);
    }
    this.Handle = OpenH(_isoldnewfile, Exclusive);
    TestCPathError();
    this.Size = FileSizeH(this.Handle);
    SeekH(this.Handle, this.Size);
    this.SpaceOnDisk = this.MyDiskFree(this.Floppy, byte(ord(this.Path[0] ?? '\0') - ord('@')));
  }
  // PAS: EXPIMP.PAS ThFile.ClearBuf
  ClearBuf(): void {
    this.lBuf = 0;
    this.lBuf2 = 0;
  }
  // PAS: EXPIMP.PAS ThFile.Delete
  Delete(): void {
    const bv = BaseVars;
    bv.CVol = this.Vol;
    bv.CPath = this.Path;
    TestMountVol(bv.CPath[0] ?? '\0');
    do DeleteFile(bv.CPath);
    while (this.TestErr152());
    if (this.Floppy) {
      bv.CPath = IncCh(bv.CPath, bv.CPath.length - 1, 5);
      DeleteFile(bv.CPath);
    }
  }
  // PAS: EXPIMP.PAS ThFile.WriteBuf2
  WriteBuf2(): void {
    const bv = BaseVars;
    let i = 0;
    while (i < this.lBuf2) {
      while (this.SpaceOnDisk === 0) {
        if (this.Floppy) {
          CloseH(this.Handle);
          bv.CPath = this.Path;
          bv.CPath = IncCh(bv.CPath, bv.CPath.length - 1, 5);
          RenameFile56(this.Path, bv.CPath, true);
          this.Vol = IncCh(this.Vol, this.Vol.length, 1);
          this.Rewrite();
        } else {
          bv.HandleError = 1;
          this.TestError();
        }
      }
      let n = this.lBuf2 - i;
      if (this.SpaceOnDisk >= 0 && n > this.SpaceOnDisk) n = this.SpaceOnDisk;
      WriteH(this.Handle, n, this.Buf2.subarray(i));
      this.TestError();
      i += n;
      this.Size += n;
      if (this.SpaceOnDisk > 0) this.SpaceOnDisk -= n;
    }
    this.lBuf2 = 0;
  }
  // PAS: EXPIMP.PAS ThFile.ForwChar
  ForwChar(): string {
    for (;;) {
      if (this.iBuf < this.lBuf) return chr(this.Buf[this.iBuf]);
      this.ReadBuf();
      if (this.EOF) return EOFChar;
    }
  }
  // PAS: EXPIMP.PAS ThFile.ReadBuf2
  ReadBuf2(): void {
    this.lBuf2 = 0;
    this.iBuf2 = 0;
    while (this.Size === 0) {
      if (this.Continued) {
        CloseH(this.Handle);
        RunMsgOff();
        this.Vol = IncCh(this.Vol, this.Vol.length, 1);
        this.Reset();
      } else {
        this.EOF2 = true;
        return;
      }
    }
    this.lBuf2 = this.BufSize2;
    if (this.lBuf2 > this.Size) this.lBuf2 = this.Size;
    ReadH(this.Handle, this.lBuf2, this.Buf2);
    this.TestError();
    this.Size -= this.lBuf2;
    RunMsgN(this.OrigSize - this.Size);
  }
  // PAS: EXPIMP.PAS ThFile.RdChar
  RdChar(): string {
    for (;;) {
      if (this.iBuf < this.lBuf) {
        const c = chr(this.Buf[this.iBuf]);
        this.iBuf++;
        return c;
      }
      this.ReadBuf();
      if (this.EOF) return EOFChar;
    }
  }
  // PAS: EXPIMP.PAS ThFile.RdDM
  RdDM(Delim: string, Max: number): string {
    const quoted = Delim === "'" || Delim === '"';
    let s = '';
    this.IsEOL = false;
    let c = this.RdChar();
    for (;;) {
      // 1:
      if (this.EOF) this.IsEOL = true;
      else if (c === '\r' && !quoted) {
        this.IsEOL = true;
        if (this.ForwChar() === '\n') this.RdChar();
      } else if (c !== Delim || (quoted && this.ForwChar() === c)) {
        if (c === Delim) this.RdChar(); // doubled quote
        // 2:
        s += c;
        if (s.length < Max) {
          c = this.RdChar();
          continue;
        }
      }
      break;
    }
    return s;
  }
  // PAS: EXPIMP.PAS ThFile.RdDelim
  RdDelim(Delim: string): string {
    return this.RdDM(Delim, 255);
  }
  // PAS: EXPIMP.PAS ThFile.RdFix
  RdFix(N: number): string {
    return this.RdDM('\r', N);
  }
  // PAS: EXPIMP.PAS ThFile.RdLongStr
  RdLongStr(): LongStrPtr {
    const x: number[] = [];
    if (this.ForwChar() === "'") {
      this.RdChar();
      let c = this.RdChar();
      while (!this.EOF && x.length < MaxLStrLen) {
        if (c === "'") {
          if (this.ForwChar() === "'") this.RdChar();
          else break; // goto 1
        }
        x.push(ord(c));
        c = this.RdChar();
      }
    } else {
      while (!this.EOF && x.length < MaxLStrLen && this.ForwChar() !== '\r') x.push(ord(this.RdChar()));
    }
    return Uint8Array.from(x);
  }
  // PAS: EXPIMP.PAS ThFile.Reset
  Reset(): void {
    const bv = BaseVars;
    bv.CVol = this.Vol;
    bv.CPath = this.Path;
    TestMountVol(bv.CPath[0] ?? '\0');
    do {
      this.Handle = OpenH(_isoldfile, RdOnly);
      this.Continued = false;
    } while (this.TestErr152());
    if (bv.HandleError === 2 && this.Floppy) {
      bv.CPath = IncCh(bv.CPath, bv.CPath.length - 1, 5);
      this.Handle = OpenH(_isoldfile, RdOnly);
      this.Continued = (bv.HandleError as number) === 0;
    }
    if (bv.HandleError === 2) this.Size = 0;
    else {
      this.TestError();
      this.Size = FileSizeH(this.Handle);
    }
    RunMsgOn('C', this.Size);
    this.OrigSize = this.Size;
  }
  // PAS: EXPIMP.PAS ThFile.ExtToT
  ExtToT(): void {
    const bv = BaseVars;
    bv.CPath = this.Path;
    const d = ref(''), n = ref(''), e = ref('');
    FSplit(bv.CPath, d, n, e);
    bv.CDir = d.v;
    bv.CName = n.v;
    bv.CExt = e.v;
    CExtToT();
    this.Path = bv.CPath;
  }
  // PAS: EXPIMP.PAS ThFile.ResetT
  ResetT(): void {
    this.ExtToT();
    this.Reset();
    this.InitBufInp();
  }
  // PAS: EXPIMP.PAS ThFile.ResetX
  ResetX(): void {
    this.Path = SetCh(this.Path, this.Path.length - 2, 'X');
    this.Reset();
    this.InitBufInp();
  }
  // PAS: EXPIMP.PAS ThFile.Rewrite
  Rewrite(): void {
    const bv = BaseVars;
    this.Delete();
    bv.CPath = this.Path;
    bv.CVol = this.Vol;
    this.Handle = OpenH(_isoverwritefile, Exclusive);
    TestCPathError();
    this.SpaceOnDisk = this.MyDiskFree(this.Floppy, byte(ord(this.Path[0] ?? '\0') - ord('@')));
    this.Size = 0;
  }
  // PAS: EXPIMP.PAS ThFile.RewriteT
  RewriteT(): void {
    this.ExtToT();
    this.Rewrite();
    this.InitBufOutp();
  }
  // PAS: EXPIMP.PAS ThFile.RewriteX
  RewriteX(): void {
    this.Path = SetCh(this.Path, this.Path.length - 2, 'X');
    this.Rewrite();
    this.InitBufOutp();
  }
  // PAS: EXPIMP.PAS ThFile.TestError
  TestError(): void {
    BaseVars.CPath = this.Path;
    TestCPathError();
  }
  // PAS: EXPIMP.PAS ThFile.TestErr152
  TestErr152(): boolean {
    const bv = BaseVars;
    if (bv.HandleError === 152) {
      bv.F10SpecKey = _ESC_;
      const s = bv.CPath.slice(0, 1);
      Set2MsgPar(s, '');
      WrLLF10Msg(808);
      if (DriversVars.KbdChar === _ESC_ && PromptYN(21)) GoExit();
      return true;
    }
    return false;
  }
  // PAS: EXPIMP.PAS ThFile.WrChar
  WrChar(C: string): void {
    if (this.lBuf === this.BufSize) this.WriteBuf(false);
    this.Buf[this.lBuf] = ord(C);
    this.lBuf++;
  }
  // PAS: EXPIMP.PAS ThFile.WrString
  WrString(S: string): void {
    for (let i = 0; i < S.length; i++) this.WrChar(S[i]);
  }
  // PAS: EXPIMP.PAS ThFile.WrLongStr
  WrLongStr(S: LongStrPtr, WithDelim: boolean): void {
    if (WithDelim) this.WrChar("'");
    for (let i = 0; i < S.length; i++) {
      this.WrChar(chr(S[i]));
      if (WithDelim && S[i] === 0x27) this.WrChar("'");
    }
    if (WithDelim) this.WrChar("'");
  }
}
// TS-only: New(F, Init(...))
function NewThFile(APath: StringPtr, CatIRec: number, AMode: InOutMode, aCompress: number, F: PhFile): ThFile {
  return new ThFile().Init(APath, CatIRec, AMode, aCompress, F);
}

// PAS: EXPIMP.PAS VarFixImp
function VarFixImp(F1: ThFile, Opt: CpOption): void {
  let F = AccessVars.CFile!.FldD;
  F1.IsEOL = false;
  while (F !== null) {
    if ((F.Flg & f_Stored) !== 0) {
      if (F1.IsEOL) {
        switch (F.FrmlTyp) {
          case 'R':
            R_(F, 0);
            break;
          case 'B':
            B_(F, false);
            break;
          case 'S':
            S_(F, '');
            break;
        }
      } else {
        switch (F.Typ) {
          case 'F': {
            const s = Opt === cpFix ? F1.RdFix(F.L) : F1.RdDelim(',');
            const r = ref(0), err = ref(0);
            ValR(LeadChar(' ', s), r, err);
            if ((F.Flg & f_Comma) !== 0) r.v = r.v * Power10[F.M];
            R_(F, r.v);
            break;
          }
          case 'A':
            if (Opt === cpFix) S_(F, F1.RdFix(F.L));
            else {
              const c = F1.ForwChar();
              let s: string;
              if (c === "'" || c === '"') {
                F1.RdChar();
                s = F1.RdDelim(c);
                F1.RdDelim(',');
              } else s = F1.RdDelim(',');
              S_(F, s);
            }
            break;
          case 'N':
            if (Opt === cpFix) S_(F, F1.RdFix(F.L));
            else S_(F, F1.RdDelim(','));
            break;
          case 'D':
          case 'R': {
            let s: string;
            if (Opt === cpFix) s = F1.RdFix(F.L);
            else {
              s = F1.RdDelim(',');
              if (s[0] === "'" || s[0] === '"') s = s.slice(1, s.length - 1);
            }
            if (s === '') R_(F, 0.0);
            else if (F.Typ === 'R') {
              const r = ref(0), err = ref(0);
              ValR(s, r, err);
              R_(F, r.v);
            } else R_(F, ValDate(s, FieldDMask(F) ?? ''));
            break;
          }
          case 'B': {
            const s = F1.RdFix(1);
            B_(F, s[0] === 'A');
            if (Opt === cpVar) F1.RdDelim(',');
            break;
          }
          case 'T':
            if (Opt === cpVar) {
              const x = F1.RdLongStr();
              F1.RdDelim(',');
              LongS_(F, x);
              ReleaseStore(x);
            } else T_(F, 0);
            break;
        }
      }
    }
    F = F.Chain;
  }
  if (!F1.IsEOL) F1.RdDelim('\r');
}

// PAS: EXPIMP.PAS VarFixExp
function VarFixExp(F2: ThFile, Opt: CpOption): void {
  let F = AccessVars.CFile!.FldD;
  let first = true;
  let s = '';
  while (F !== null) {
    if ((F.Flg & f_Stored) !== 0) {
      if (first) first = false;
      else if (Opt === cpVar) F2.WrChar(',');
      switch (F.Typ) {
        case 'F': {
          let r = _R(F);
          if ((F.Flg & f_Comma) !== 0) r = r / Power10[F.M];
          s = StrR(r, F.L, F.M);
          if (s.length > F.L) s = '>' + s.slice(1, F.L);
          if (Opt === cpVar) {
            s = LeadChar(' ', s);
            if (F.M > 0) {
              s = TrailChar('0', s);
              if (s.length > 0 && s[s.length - 1] === '.') s = s.slice(0, -1);
            }
            if (s === '0') s = '';
          }
          break;
        }
        case 'A':
          s = _ShortS(F);
          if (Opt === cpVar) {
            if (F.M === 1) s = TrailChar(' ', s);
            else s = LeadChar(' ', s);
            let s1 = '';
            for (let i = 0; i < s.length; i++) {
              s1 = s1 + s[i];
              if (s[i] === "'") s1 = s1 + "'";
            }
            s = "'" + s1 + "'";
          }
          break;
        case 'N':
          s = _ShortS(F);
          if (Opt === cpVar) {
            if (F.M === 1) s = TrailChar('0', s);
            else s = LeadChar('0', s);
          }
          break;
        case 'D':
        case 'R': {
          const r = _R(F);
          if (r === 0 && Opt === cpVar) s = '';
          else if (F.Typ === 'R') s = StrR(r, F.L);
          else {
            s = StrDate(r, FieldDMask(F) ?? '');
            if (Opt === cpVar) s = "'" + s + "'";
          }
          break;
        }
        case 'B':
          s = _B(F) ? 'A' : 'N';
          break;
        case 'T':
          if (Opt === cpVar) {
            const x = _LongS(F);
            F2.WrLongStr(x, true);
            ReleaseStore(x);
          }
          break;
      }
      if (F.Typ !== 'T') F2.WrString(s);
    }
    F = F.Chain;
  }
}

// ---------------------------------------------------------------- CopyFile

// TS-only: the NewExit/label pattern of the CopyFile parts – body, then the code at the label
function WithExit(body: () => void, atLabel: () => void): void {
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    body();
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
  } finally {
    RestoreExit(er);
  }
  atLabel();
}

// PAS: EXPIMP.PAS CopyFile.TxtCtrlJ – CR → CR LF, LF dropped
function TxtCtrlJ(CD: NonNullable<CopyDPtr>): void {
  let F1: PhFile = null;
  let F2: PhFile = null;
  WithExit(
    () => {
      let m = _outp;
      if (CD.Append) m = _append;
      F1 = NewThFile(CD.Path1, CD.CatIRec1, _inp, 0, null);
      F2 = NewThFile(CD.Path2, CD.CatIRec2, m, 0, F2);
      const f1 = F1, f2 = F2;
      let c = f1.RdChar();
      while (!f1.EOF) {
        switch (c) {
          case '\r':
            f2.WrChar('\r');
            f2.WrChar('\n');
            break;
          case '\n':
            break;
          default:
            f2.WrChar(c);
        }
        c = f1.RdChar();
      }
      BaseVars.LastExitCode = 0;
    },
    () => {
      const f1 = F1 as PhFile, f2 = F2 as PhFile;
      if (f1 !== null && f1.Handle !== 0xff) f1.Done();
      if (f2 !== null && f2.Handle !== 0xff) {
        if (BaseVars.LastExitCode !== 0) f2.ClearBuf();
        f2.Done();
      }
    },
  );
}

// PAS: EXPIMP.PAS CopyFile.ImportTxt
function ImportTxt(CD: NonNullable<CopyDPtr>): void {
  const av = AccessVars;
  let F1: PhFile = null;
  let md: LockMode | null = null; // TS: null until RewriteF (see the header)
  WithExit(
    () => {
      const f1 = (F1 = NewThFile(CD.Path1, CD.CatIRec1, _inp, 0, null));
      if (CD.HdFD !== null) {
        const FE = new FrmlElem(_const);
        FE.S = f1.RdDelim('\r');
        AsgnParFldFrml(CD.HdFD, CD.HdF, FE, false);
      }
      av.CFile = CD.FD2;
      av.CRecPtr = GetRecSpace();
      md = RewriteF(CD.Append);
      while (!f1.EOF && f1.ForwChar() !== EOFChar) {
        ZeroAllFlds();
        ClearDeletedFlag();
        VarFixImp(f1, CD.Opt1);
        f1.ForwChar(); // set IsEOF at End
        PutRec();
        if (CD.Append && av.CFile!.Typ === 'X') TryInsertAllIndexes(av.CFile!.IRec);
      }
      BaseVars.LastExitCode = 0;
    },
    () => {
      const f1 = F1 as PhFile;
      if (f1 !== null && f1.Handle !== 0xff) {
        f1.Done();
        if (md !== null) OldLMode(md);
      }
    },
  );
}

// PAS: EXPIMP.PAS CopyFile.ExportTxt
function ExportTxt(CD: NonNullable<CopyDPtr>): void {
  const av = AccessVars;
  let F2: PhFile = null;
  let Scan: XScan | null = null;
  let md: LockMode = NullMode;
  WithExit(
    () => {
      let m = _outp;
      if (CD.Append) m = _append;
      const f2 = (F2 = NewThFile(CD.Path2, CD.CatIRec2, m, 0, null));
      if (CD.HdFD !== null) {
        const n = ref(0);
        LinkLastRec(CD.HdFD, n, true);
        let s = _ShortS(CD.HdF);
        const i = s.indexOf('\r') + 1;
        if (i > 0) s = s.slice(0, i - 1);
        f2.WrString(s);
        f2.WrString('\r\n');
        ClearRecSpace(av.CRecPtr!);
        ReleaseStore(av.CRecPtr);
      }
      av.CFile = CD.FD1;
      av.CRecPtr = GetRecSpace();
      md = NewLMode(RdMode);
      const scan = (Scan = new XScan().Init(av.CFile, CD.ViewKey, null, true));
      scan.Reset(null, false);
      RunMsgOn('C', scan.NRecs);
      for (;;) {
        // 1:
        scan.GetRec();
        if (scan.EOF) break;
        VarFixExp(f2, CD.Opt2);
        f2.WrString('\r\n');
        RunMsgN(scan.IRec);
      }
      BaseVars.LastExitCode = 0;
      RunMsgOff();
    },
    () => {
      // 2:
      const scan = Scan as XScan | null, f2 = F2 as PhFile;
      if (scan !== null) {
        scan.Close();
        ClearRecSpace(av.CRecPtr!);
        OldLMode(md);
      }
      if (f2 !== null && f2.Handle !== 0xff) {
        if (BaseVars.LastExitCode !== 0) f2.ClearBuf();
        f2.Done();
      }
    },
  );
}

// PAS: EXPIMP.PAS CopyFile.MakeMerge – FD1 → FD2 through a generated merge '#I1_… #O1_…'
function MakeMerge(CD: NonNullable<CopyDPtr>): void {
  WithExit(
    () => {
      let s = '#I1_' + CD.FD1!.Name;
      if (CD.ViewKey !== null) {
        let ali = CD.ViewKey.Alias ?? '';
        if (ali === '') ali = '@';
        s = s + '/' + ali;
      }
      s = s + ' #O1_' + CD.FD2!.Name;
      if (CD.Append) s = s + '+';
      SetInpStr(ref(s));
      ReadMerge();
      RunMerge();
      BaseVars.LastExitCode = 0;
    },
    () => {},
  );
}

// PAS: EXPIMP.PAS CopyFile.ExportFD.Cpy
function ExportFDCpy(h: number, sz: number, F2: ThFile): void {
  SeekH(h, 0);
  let i = 0;
  RunMsgOn('C', sz);
  while (i < sz) {
    const n = sz - i > F2.BufSize ? F2.BufSize : sz - i;
    i += n;
    ReadH(h, n, F2.Buf);
    TestCFileError();
    F2.lBuf = n;
    F2.WriteBuf(false);
    RunMsgN(i);
  }
  F2.Done();
  RunMsgOff();
}
// PAS: EXPIMP.PAS CopyFile.ExportFD – raw copy of the data file (+ .T, + .X with WithX1)
function ExportFD(CD: NonNullable<CopyDPtr>): void {
  const av = AccessVars;
  let F2: PhFile = null;
  let md: LockMode = NullMode;
  WithExit(
    () => {
      av.CFile = CD.FD1;
      SaveFiles();
      md = NewLMode(RdMode);
      const f2 = (F2 = NewThFile(CD.Path2, CD.CatIRec2, _outp, 0, null));
      const n = XNRecs(CD.FD1!.Keys);
      const cf = av.CFile!;
      if (n === 0) f2.Done();
      else ExportFDCpy(cf.Handle, cf.UsedFileSize(), f2);
      if (cf.TF !== null) {
        f2.RewriteT();
        if (n === 0) f2.Done();
        else ExportFDCpy(cf.TF.Handle, cf.TF.UsedFileSize(), f2);
      }
      if (CD.WithX1) {
        f2.RewriteX();
        if (n === 0) f2.Done();
        else ExportFDCpy(cf.XF!.Handle, cf.XF!.UsedFileSize(), f2);
      }
      // 0:
      BaseVars.LastExitCode = 0;
    },
    () => {
      const f2 = F2 as PhFile;
      if (f2 !== null && f2.Handle !== 0xff) {
        if (BaseVars.LastExitCode !== 0) f2.ClearBuf();
        f2.Done();
        OldLMode(md);
      }
    },
  );
}

// PAS: EXPIMP.PAS CopyFile.ImportFD.Cpy
function ImportFDCpy(h: number, F1: ThFile): void {
  ClearCacheH(h);
  SeekH(h, 0);
  while (!F1.EOF) {
    WriteH(h, F1.lBuf, F1.Buf);
    TestCFileError();
    F1.ReadBuf();
  }
  WriteH(h, 0, F1.Buf); // trunc (DOS: at the file position, handle.ts WriteH)
  F1.Done();
}
// PAS: EXPIMP.PAS CopyFile.ImportFD – raw copy over the data file (+ .T, + .X with WithX2)
function ImportFD(CD: NonNullable<CopyDPtr>): void {
  const av = AccessVars;
  let F1: PhFile = null;
  WithExit(
    () => {
      const f1 = (F1 = NewThFile(CD.Path1, CD.CatIRec1, _inp, 0, null));
      av.CFile = CD.FD2;
      NewLMode(ExclMode);
      const cf = av.CFile!;
      ImportFDCpy(cf.Handle, f1);
      if (cf.TF !== null) {
        f1.ResetT();
        ImportFDCpy(cf.TF.Handle, f1);
        CloseClearH(fref(cf.TF, 'Handle'));
      }
      if (cf.XF !== null) {
        if (CD.WithX2) {
          f1.ResetX();
          ImportFDCpy(cf.XF.Handle, f1);
        } else {
          XFNotValid();
          SaveCache(0);
        }
        CloseClearH(fref(cf.XF, 'Handle'));
      }
      BaseVars.LastExitCode = 0;
      CloseClearH(fref(cf, 'Handle'));
      if (cf === av.CatFD) OpenF(Exclusive);
    },
    () => {
      const f1 = F1 as PhFile;
      if (f1 !== null && f1.Handle !== 0xff) f1.Done();
    },
  );
}

// PAS: EXPIMP.PAS ConvWinCp – bytes >= $80 through the 128-byte table pKod
function ConvWinCp(pBuf: Uint8Array, pKod: Uint8Array, L: number): void {
  for (let i = 0; i < L; i++) {
    const b = pBuf[i];
    if (b >= 0x80) pBuf[i] = pKod[b - 0x80];
  }
}

// PAS: EXPIMP.PAS CopyFile.MakeCopy – file copy with code page conversion CD^.Mode
function MakeCopy(CD: NonNullable<CopyDPtr>): void {
  let F1: PhFile = null;
  let F2: PhFile = null;
  WithExit(
    () => {
      const f1 = (F1 = NewThFile(CD.Path1, CD.CatIRec1, _inp, 0, null));
      let m = _outp;
      if (CD.Append) m = _append;
      const f2 = (F2 = NewThFile(CD.Path2, CD.CatIRec2, m, 0, f1));
      const pKod = ref<Uint8Array | null>(null);
      let kod = 0;
      switch (CD.Mode) {
        case 5:
          kod = LatToWinCp;
          break;
        case 6:
          kod = KamToWinCp;
          break;
        case 7:
          kod = WinCpToLat;
          break;
      }
      if (kod !== 0) BaseVars.ResFile.Get(kod, pKod); // 0:
      while (!f1.EOF) {
        f2.Buf.set(f1.Buf.subarray(0, f1.lBuf));
        f2.lBuf = f1.lBuf;
        switch (CD.Mode) {
          case 1:
            ConvKamenLatin(f2.Buf, f2.lBuf, true);
            break;
          case 2:
            ConvKamenLatin(f2.Buf, f2.lBuf, false);
            break;
          case 3:
            ConvToNoDiakr(f2.Buf, f2.lBuf, foKamen);
            break;
          case 4:
            ConvToNoDiakr(f2.Buf, f2.lBuf, foLatin2);
            break;
          case 5:
          case 6:
          case 7:
            ConvWinCp(f2.Buf, pKod.v!, f2.lBuf);
            break;
        }
        f2.WriteBuf(false);
        f1.ReadBuf();
      }
      BaseVars.LastExitCode = 0;
    },
    () => {
      const f1 = F1 as PhFile, f2 = F2 as PhFile;
      if (f1 !== null && f1.Handle !== 0xff) f1.Done();
      if (f2 !== null && f2.Handle !== 0xff) {
        if (BaseVars.LastExitCode !== 0) f2.ClearBuf();
        f2.Done();
      }
    },
  );
}

// PAS: EXPIMP.PAS CopyFile – the COPYFILE instruction
export function CopyFile(CD: CopyDPtr): void {
  const cd = CD!;
  const p = ref<Pointer>(null);
  BaseVars.LastExitCode = 2;
  MarkStore(p);
  if (cd.Opt1 === cpFix || cd.Opt1 === cpVar) ImportTxt(cd);
  else if (cd.Opt2 === cpFix || cd.Opt2 === cpVar) ExportTxt(cd);
  else if (cd.FD1 !== null) {
    if (cd.FD2 !== null) MakeMerge(cd);
    else ExportFD(cd);
  } else if (cd.FD2 !== null) ImportFD(cd);
  else if (cd.Opt1 === cpTxt) TxtCtrlJ(cd);
  else MakeCopy(cd);
  SaveFiles();
  RunMsgOff();
  ReleaseStore(p.v);
  if (BaseVars.LastExitCode !== 0 && !cd.NoCancel) GoExit();
}
// FormatOnDrive(DriveC: char): boolean is declared in EXPIMP's interface but implemented in the
// DISKFPC include: see disk.ts (re-exported above).

// PAS: EXPIMP.PAS OldToNewCat – convert an old-format catalog CFile in place; FilSz := new file size
export function OldToNewCat(FilSz: Ref<number>): boolean {
  const cf = AccessVars.CFile!;
  if (cf.Typ !== 'C') return false;
  const x = new Uint8Array(6); // record NRecs: longint; RecLen: word end
  RdWrCache(true, cf.Handle, cf.NotCached(), 0, 6, x);
  if (getWord(x, 4) !== 106) return false;
  setWord(x, 4, 107);
  RdWrCache(false, cf.Handle, cf.NotCached(), 0, 6, x);
  const NRecs = getLongint(x, 0);
  const a = new Uint8Array(90);
  for (let i = NRecs; i >= 1; i--) {
    const off = 6 + (i - 1) * 106;
    const offNew = off + (i - 1);
    RdWrCache(true, cf.Handle, cf.NotCached(), off + 16, 90, a);
    RdWrCache(false, cf.Handle, cf.NotCached(), offNew + 17, 90, a);
    a[16] = 0; // a[17]
    RdWrCache(true, cf.Handle, cf.NotCached(), off, 16, a);
    RdWrCache(false, cf.Handle, cf.NotCached(), offNew, 17, a);
  }
  cf.NRecs = NRecs;
  FilSz.v = NRecs * 107 + 6;
  return true;
}

// ---------------------------------------------------------------- TyFile / TbFile (BACKUP)

// PAS: EXPIMP.PAS TyFile = object(TcFile)
interface TyFile extends TcFile {}
class TyFile {
  Drive = 0;
  DrvNm = ''; // string[1]
  Vol: VolStr = '';
  Path = '';
  IsBackup = false;
  Floppy = false;
  Continued = false;

  constructor() {
    LinkTcFile(TyFile);
    Object.assign(this, new TcFile());
  }

  // PAS: EXPIMP.PAS TyFile.MountVol
  MountVol(isFirst: boolean): void {
    const bv = BaseVars;
    const MountedVol = AccessVars.MountedVol;
    if (isFirst) {
      this.Drive = byte(ord((this.DrvNm[0] ?? '\0').toUpperCase()) - ord('@'));
      this.Floppy = this.Vol !== '' && this.Vol[0] !== '#' && this.Drive < FloppyDrives;
    }
    if (!this.Floppy) return;
    if (!isFirst) this.Vol = IncCh(this.Vol, this.Vol.length, 1);
    bv.CVol = this.Vol;
    let lbl = 2;
    if (!SEquUpcase(MountedVol[this.Drive], this.Vol)) {
      ReleaseDrive(this.Drive);
      lbl = 1;
    }
    const s = new SearchRec();
    for (;;) {
      if (lbl === 1) {
        // 1:
        bv.F10SpecKey = _ESC_;
        Set2MsgPar(this.DrvNm, this.Vol);
        WrLLF10Msg(808);
        if (DriversVars.KbdChar === _ESC_) {
          if (PromptYN(21)) GoExit();
          else continue;
        }
      }
      if (lbl <= 2) {
        // 2:
        const DosError = FindFirstVol(this.DrvNm, s);
        lbl = 1;
        if (DosError === 31 || DosError === 158 || DosError === 162) {
          // hardware failure
          if (this.IsBackup && PromptYN(655) && FormatOnDrive(this.DrvNm[0] ?? '\0')) {
            MountedVol[this.Drive] = this.Vol;
            return;
          }
          continue;
        } else if (DosError === 152) continue; // drive not ready
        else if (DosError === 18) {
          // label missing
          if (this.IsBackup) {
            if (PromptYN(807)) lbl = 3;
            else continue;
          } else {
            WrLLF10Msg(809);
            continue;
          }
        } else if (DosError !== 0) {
          WrLLF10Msg(810);
          continue;
        }
        if (lbl !== 3) {
          let name = s.Name;
          const i = name.indexOf('.');
          if (i >= 0) name = name.slice(0, i) + name.slice(i + 1);
          if (!SEquUpcase(name, this.Vol)) {
            SetMsgPar(name);
            if (this.IsBackup) {
              if (bv.Spec.OverwrLabeledDisk && PromptYN(816)) lbl = 3;
              else continue;
            } else {
              WrLLF10Msg(817);
              continue;
            }
          }
        }
      }
      // 3:
      MountedVol[this.Drive] = this.Vol;
      if (!this.IsBackup) return;
      SetMsgPar(this.DrvNm);
      ResetDisks();
      const bt = new TBoot().Init(this.Drive - 1);
      const b = new Uint8Array(512); // bt.Boot (the boot sector over the TBoot fields)
      if (bt.ReadSect(0, 1, b) !== 0) RunError(656);
      const fat = GetZStore(bt.SecSize * bt.SecsPerFat);
      bt.ReadSect(bt.ReservedSecs, bt.SecsPerFat, fat);
      FatPut(fat, 0, 0xff00 + bt.MediaCode);
      FatPut(fat, 1, 0xffff);
      for (let i = 2; i <= Math.trunc((2 * bt.SecsPerFat * bt.SecSize) / 3) - 1; i++) {
        const j = FatGet(fat, i);
        if (j !== fatBadCluster) FatPut(fat, i, 0);
      }
      let failed = false;
      for (let i = 0; i <= bt.FatCount - 1; i++) {
        const err = bt.WriteSect(bt.ReservedSecs + i * bt.SecsPerFat, bt.SecsPerFat, fat);
        if (err !== 0) {
          if (err === 3) WrLLF10Msg(850);
          else WrLLF10Msg(860);
          failed = true;
          break;
        }
      }
      if (failed) {
        lbl = 1;
        continue;
      }
      const p = GetZStore(bt.SecsPerRoot() * bt.SecSize);
      FillVolDirEntry(p, this.Vol);
      bt.WriteSect(bt.RootSec(), bt.SecsPerRoot(), p);
      ResetDisks();
      ReleaseStore(fat);
      return;
    }
  }
}

// FindFDforI's globals (PAS: EXPIMP.PAS x_FD, x_I)
let x_FD: FileDPtr = null;
let x_I = 0;
// PAS: EXPIMP.PAS FindFDforI
function FindFDforI(): void {
  if (x_FD === null && AccessVars.CFile!.CatIRec === x_I) x_FD = AccessVars.CFile;
}

// PAS: EXPIMP.PAS TbFile = object(TyFile)
class TbFile extends TyFile {
  Handle = 0;
  Dir = '';
  FName = '';
  Ext = '';
  Size = 0;
  OrigSize = 0;
  SpaceOnDisk = 0;

  // PAS: EXPIMP.PAS TbFile.Init
  InitB(NoCompress: boolean): this {
    if (NoCompress) TcFile.prototype.Init.call(this, 0);
    else TcFile.prototype.Init.call(this, 1);
    return this;
  }
  // PAS: EXPIMP.PAS TbFile.TestErr
  TestErr(): void {
    BaseVars.CPath = this.Path;
    TestCPathError();
  }
  // PAS: EXPIMP.PAS TbFile.Reset
  Reset(): void {
    const bv = BaseVars;
    this.Path = this.Dir + this.FName + this.Ext;
    bv.CVol = this.Vol;
    bv.CPath = this.Path;
    this.Handle = OpenH(_isoldfile, RdOnly);
    this.Continued = false;
    if (bv.HandleError === 2 && this.Floppy) {
      bv.CPath = IncCh(bv.CPath, bv.CPath.length - 2, 5);
      this.Handle = OpenH(_isoldfile, RdOnly);
      this.Continued = true;
    }
    TestCPathError();
    this.Size = FileSizeH(this.Handle);
    this.OrigSize = this.Size;
    RunMsgOn('C', this.Size);
  }
  // PAS: EXPIMP.PAS TbFile.Rewrite
  Rewrite(): void {
    const bv = BaseVars;
    this.Path = this.Dir + this.FName + this.Ext;
    bv.CPath = this.Path;
    bv.CVol = this.Vol;
    this.Handle = OpenH(_isoverwritefile, Exclusive);
    TestCPathError();
    this.SpaceOnDisk = this.MyDiskFree(this.Floppy, this.Drive);
  }
  // PAS: EXPIMP.PAS TbFile.ReadBuf2
  ReadBuf2(): void {
    this.lBuf2 = 0;
    this.iBuf2 = 0;
    if (this.Size === 0 && this.Continued) {
      CloseH(this.Handle);
      RunMsgOff();
      this.MountVol(false);
      this.Reset();
    }
    if (this.Size === 0) {
      this.EOF2 = true;
      return;
    }
    this.lBuf2 = this.BufSize2;
    if (this.lBuf2 > this.Size) this.lBuf2 = this.Size;
    ReadH(this.Handle, this.lBuf2, this.Buf2);
    this.TestErr();
    this.Size -= this.lBuf2;
    RunMsgN(this.OrigSize - this.Size);
  }
  // PAS: EXPIMP.PAS TbFile.WriteBuf2
  WriteBuf2(): void {
    const bv = BaseVars;
    let i = 0;
    while (i < this.lBuf2) {
      if (this.SpaceOnDisk === 0) {
        if (this.Floppy) {
          CloseH(this.Handle);
          bv.CPath = this.Path;
          bv.CPath = IncCh(bv.CPath, bv.CPath.length - 2, 5);
          RenameFile56(this.Path, bv.CPath, true);
          this.MountVol(false);
          this.Rewrite();
        } else {
          bv.HandleError = 1;
          this.TestErr();
        }
      }
      let n = this.lBuf2 - i;
      if (this.SpaceOnDisk >= 0 && n > this.SpaceOnDisk) n = this.SpaceOnDisk;
      WriteH(this.Handle, n, this.Buf2.subarray(i));
      this.TestErr();
      i += n;
      if (this.SpaceOnDisk > 0) this.SpaceOnDisk -= n;
    }
    this.lBuf2 = 0;
  }
  // PAS: EXPIMP.PAS TbFile.BackupH – the host file CPath into the archive file
  BackupH(): void {
    const bv = BaseVars;
    const h = OpenH(_isoldfile, RdOnly);
    if (bv.HandleError === 2) {
      this.Rewrite();
      this.InitBufOutp();
    } else {
      TestCPathError();
      this.Rewrite();
      this.InitBufOutp();
      const sz = FileSizeH(h);
      RunMsgOn('C', sz);
      let i = 0;
      while (i < sz) {
        const n = sz - i > this.BufSize ? this.BufSize : sz - i;
        i += n;
        ReadH(h, n, this.Buf);
        this.lBuf = n;
        this.WriteBuf(false);
        RunMsgN(i);
      }
      CloseH(h);
      RunMsgOff();
    }
    // 1:
    this.WriteBuf(true);
    CloseH(this.Handle);
  }
  // PAS: EXPIMP.PAS TbFile.RestoreH – the archive file into the host file CPath
  RestoreH(): void {
    const bv = BaseVars;
    const s = bv.CPath;
    const h = OpenH(_isoverwritefile, Exclusive);
    TestCPathError();
    this.Reset();
    this.InitBufInp();
    while (!this.EOF) {
      WriteH(h, this.lBuf, this.Buf);
      this.ReadBuf();
    }
    CloseH(this.Handle);
    const l = FileSizeH(h);
    CloseH(h);
    if (l === 0) DeleteFile(s); // wegen 6 byte shared files
    RunMsgOff();
  }
  // PAS: EXPIMP.PAS TbFile.BackupHFD
  BackupHFD(h: number): void {
    this.Rewrite();
    this.InitBufOutp();
    const sz = FileSizeH(h);
    RunMsgOn('C', sz);
    SeekH(h, 0);
    let i = 0;
    while (i < sz) {
      const n = sz - i > this.BufSize ? this.BufSize : sz - i;
      i += n;
      ReadH(h, n, this.Buf);
      this.lBuf = n;
      this.WriteBuf(false);
      RunMsgN(i);
    }
    this.WriteBuf(true);
    CloseH(this.Handle);
    RunMsgOff();
  }
  // PAS: EXPIMP.PAS TbFile.RestoreHFD
  RestoreHFD(h: number): void {
    SeekH(h, 0);
    while (!this.EOF) {
      WriteH(h, this.lBuf, this.Buf);
      this.ReadBuf();
    }
    WriteH(h, 0, this.Buf); // trunc (DOS: at the file position, handle.ts WriteH)
    ClearCacheH(h);
    CloseH(this.Handle);
    RunMsgOff();
  }
  // PAS: EXPIMP.PAS TbFile.BackupFD
  BackupFD(): void {
    const cf = AccessVars.CFile!;
    const md = NewLMode(RdMode);
    this.BackupHFD(cf.Handle);
    if (cf.TF !== null) {
      this.Ext = SetCh(this.Ext, 2, 'T');
      this.BackupHFD(cf.TF.Handle);
    }
    OldLMode(md);
  }
  // PAS: EXPIMP.PAS TbFile.RestoreFD
  RestoreFD(): void {
    const cf = AccessVars.CFile!;
    this.Reset();
    this.InitBufInp();
    if (this.lBuf >= 6 && (cf.Typ === '6' || cf.Typ === 'X')) {
      const l = getWord(this.Buf, 4);
      if (cf.RecLen !== l) {
        SetMsgPar(this.Path);
        RunError(883);
      }
    }
    if (cf.Handle === 0xff) {
      SetCPathVol();
      cf.LMode = NullMode;
      if (IsNetCVol()) cf.UMode = Shared;
      else cf.UMode = Exclusive;
      cf.Handle = OpenH(_isoldnewfile, cf.UMode);
      TestCFileError();
      cf.NRecs = 0;
      if (cf.TF !== null) {
        CExtToT();
        cf.TF.Handle = OpenH(_isoldnewfile, cf.UMode);
        cf.TF.TestErr();
      }
      if (cf.Typ === 'X') {
        CExtToX();
        cf.XF!.Handle = OpenH(_isoldnewfile, cf.UMode);
        cf.XF!.TestErr();
      }
    }
    const md = cf.LMode;
    if (cf.IsShared() && ExclMode > cf.LMode) ChangeLMode(ExclMode, 0, false);
    this.RestoreHFD(cf.Handle);
    if (cf.TF !== null) {
      this.Ext = SetCh(this.Ext, 2, 'T');
      this.Reset();
      this.InitBufInp();
      this.RestoreHFD(cf.TF.Handle);
    }
    RdPrefixes();
    XFNotValid();
    SaveCache(0);
    OldLMode(md);
  }
  // PAS: EXPIMP.PAS TbFile.Backup
  Backup(aIsBackup: boolean, Ir: number): void {
    const bv = BaseVars;
    const av = AccessVars;
    this.IsBackup = aIsBackup;
    SaveFiles();
    let ArNr = RdCatField(Ir, av.CatArchiv); // string[2]
    this.Vol = RdCatField(Ir, av.CatVolume);
    this.Path = RdCatField(Ir, av.CatPathName);
    const i0 = this.Path.indexOf(' ') + 1;
    let numbers = '';
    if (i0 !== 0) {
      numbers = this.Path.slice(i0 - 1, i0 - 1 + 80); // BP7 numbers: string[80]
      this.Path = this.Path.slice(0, i0 - 1);
    }
    this.Path = FExpand(this.Path);
    const d = ref(''), n = ref(''), e = ref('');
    FSplit(this.Path, d, n, e);
    this.Dir = d.v;
    this.Ext = '.000';
    this.DrvNm = this.Dir.slice(0, 1);
    this.MountVol(true);
    SetInpStr(ref(numbers));
    RdLex();
    for (;;) {
      // 1:
      for (let i = 1; i <= av.CatFD!.NRecs; i++) {
        if (SEquUpcase(RdCatField(i, av.CatRdbName), 'ARCHIVES')) continue;
        if (RdCatField(i, av.CatArchiv) !== ArNr) continue;
        FSplit(RdCatField(i, av.CatPathName), d, n, e);
        this.FName = n.v;
        this.Ext = SetCh(this.Ext, 2, '0');
        switch (this.Ext[3]) {
          case '9':
            this.Ext = SetCh(this.Ext, 4, 'A');
            break;
          case 'Z':
            this.Ext = SetCh(this.Ext, 4, '0');
            if (this.Ext[2] === '9') this.Ext = SetCh(this.Ext, 3, 'A');
            else this.Ext = IncCh(this.Ext, 3, 1);
            break;
          default:
            this.Ext = IncCh(this.Ext, 4, 1);
        }
        x_FD = null;
        x_I = i;
        ForAllFDs(FindFDforI);
        av.CFile = x_FD as FileDPtr; // TS: set by FindFDforI
        if (av.CFile !== null) {
          const h = av.CFile.Handle;
          if (this.IsBackup) this.BackupFD();
          else this.RestoreFD();
          if (h === 0xff) CloseFile();
        } else {
          bv.CPath = FExpand(RdCatField(i, av.CatPathName));
          bv.CVol = RdCatField(i, av.CatVolume);
          TestMountVol(bv.CPath[0] ?? '\0');
          if (this.IsBackup) this.BackupH();
          else this.RestoreH();
        }
      }
      while (av.Lexem !== EOFChar && av.Lexem !== _number) RdLex();
      if (av.Lexem !== _number) break;
      if (av.LexWord.length === 1) ArNr = '0' + av.LexWord;
      else ArNr = av.LexWord;
      RdLex();
    }
  }
}

// PAS: EXPIMP.PAS Backup – BACKUP/RESTORE of catalog record Ir (floppy archive)
export function Backup(IsBackup: boolean, NoCompress: boolean, Ir: number, NoCancel: boolean): void {
  const F = new TbFile().InitB(NoCompress);
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    BaseVars.LastExitCode = 1;
    F.Backup(IsBackup, Ir);
    BaseVars.LastExitCode = 0;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
  } finally {
    RestoreExit(er);
  }
  F.Done(); // Dispose(F, Done)
  if (BaseVars.LastExitCode !== 0) {
    RunMsgOff();
    if (!NoCancel) GoExit();
  }
}

// ---------------------------------------------------------------- TzFile (BACKUPM)

// PAS: EXPIMP.PAS TzFile = object(TyFile)
class TzFile extends TyFile {
  WBase = 0;
  WPos = 0;
  Handle = 0;
  SpaceOnDisk = 0;
  Size = 0;
  OrigSize = 0;
  OldDir = '';
  Dir = '';
  SubDirOpt = false;
  OverwrOpt = false;

  // PAS: EXPIMP.PAS TzFile.Init
  InitZ(BkUp: boolean, NoCompr: boolean, SubDirO: boolean, OverwrO: boolean, Ir: number, aDir: string): this {
    const bv = BaseVars;
    const av = AccessVars;
    SaveFiles();
    ForAllFDs(ClosePassiveFD);
    if (NoCompr) TcFile.prototype.Init.call(this, 0);
    else TcFile.prototype.Init.call(this, 1);
    this.IsBackup = BkUp;
    this.SubDirOpt = SubDirO;
    this.OverwrOpt = OverwrO;
    this.OldDir = GetDir();
    this.Vol = RdCatField(Ir, av.CatVolume);
    bv.CPath = RdCatField(Ir, av.CatPathName);
    this.Path = FExpand(bv.CPath);
    this.DrvNm = this.Path.slice(0, 1);
    const d = ref(aDir);
    AddBackSlash(d);
    this.Dir = d.v;
    this.WBase = bv.MaxWSize;
    this.WPos = this.WBase;
    return this;
  }
  // PAS: EXPIMP.PAS TzFile.Close
  Close(): void {
    const bv = BaseVars;
    if (this.Handle !== 0) {
      bv.MaxWSize = this.WBase;
      TruncH(bv.WorkHandle, bv.MaxWSize);
      FlushH(bv.WorkHandle);
      CloseH(this.Handle);
      ChDirIO(this.OldDir);
    }
  }
  // PAS: EXPIMP.PAS TzFile.GetWPtr
  GetWPtr(): number {
    const r = this.WPos - this.WBase;
    this.WPos += 4;
    return r;
  }
  // PAS: EXPIMP.PAS TzFile.StoreWPtr
  StoreWPtr(Pos: number, N: number): void {
    const b = new Uint8Array(4);
    setLongint(b, 0, N);
    SeekH(BaseVars.WorkHandle, this.WBase + Pos);
    WriteH(BaseVars.WorkHandle, 4, b);
  }
  // PAS: EXPIMP.PAS TzFile.StoreWStr
  StoreWStr(s: string): number {
    const b = new Uint8Array(s.length + 1);
    b[0] = s.length;
    b.set(StrToBytes(s), 1);
    SeekH(BaseVars.WorkHandle, this.WPos);
    WriteH(BaseVars.WorkHandle, s.length + 1, b);
    const r = this.WPos - this.WBase;
    this.WPos += s.length + 1;
    return r;
  }
  // PAS: EXPIMP.PAS TzFile.ReadWPtr
  ReadWPtr(Pos: number): number {
    const b = new Uint8Array(4);
    SeekH(BaseVars.WorkHandle, this.WBase + Pos);
    ReadH(BaseVars.WorkHandle, 4, b);
    return getLongint(b, 0);
  }
  // PAS: EXPIMP.PAS TzFile.ReadWStr
  ReadWStr(Pos: Ref<number>): string {
    const b = new Uint8Array(256);
    SeekH(BaseVars.WorkHandle, this.WBase + Pos.v);
    ReadH(BaseVars.WorkHandle, 1, b);
    const l = b[0];
    ReadH(BaseVars.WorkHandle, l, b.subarray(1));
    Pos.v += l + 1;
    let s = '';
    for (let i = 1; i <= l; i++) s += chr(b[i]);
    return s;
  }
  // PAS: EXPIMP.PAS TzFile.StoreDirD – directory record: Next, first file name, file count, RDir
  StoreDirD(RDir: string): number {
    const r = this.GetWPtr();
    this.GetWPtr();
    this.GetWPtr();
    this.StoreWStr(RDir);
    return r;
  }
  // PAS: EXPIMP.PAS TzFile.SetDir
  SetDir(RDir: string): void {
    const d = ref(this.Dir + RDir);
    SetMsgPar(d.v);
    DelBackSlash(d);
    for (;;) {
      // 1:
      if (ChDirIO(d.v) === 0) return;
      if (!this.IsBackup && this.SubDirOpt) {
        if (MkDirIO(d.v) !== 0) RunError(644);
        continue;
      }
      RunError(703);
    }
  }
  // PAS: EXPIMP.PAS TzFile.Get1Dir
  Get1Dir(Msk: StringList, D: number, DLast: Ref<number>): void {
    const SR = new SearchRec();
    const i = ref(D + 12);
    const RDir = this.ReadWStr(i);
    const p = this.Dir + RDir + '*.*';
    let n = 0;
    let DosError = FindFirstDir(this.Dir + RDir, 0, SR);
    if (DosError !== 0 && DosError !== 18) {
      SetMsgPar(p);
      RunError(904);
    }
    while (DosError === 0) {
      let take = Msk === null;
      if (!take) {
        const nm = StrToBytes(SR.Name);
        for (let sl = Msk; sl !== null; sl = sl.Chain) {
          if (EqualsMask(nm, nm.length, sl.S)) {
            take = true;
            break;
          }
        }
      }
      if (take) {
        // 1:
        const w = this.StoreWStr(SR.Name);
        if (n === 0) this.StoreWPtr(D + 4, w);
        n++;
      }
      DosError = FindNextDir(SR);
    }
    this.StoreWPtr(D + 8, n);
    this.StoreWPtr(DLast.v, 0);
    if (!this.SubDirOpt) return;
    DosError = FindFirstDir(this.Dir + RDir, faDirectory, SR);
    while (DosError === 0) {
      if ((SR.Attr & faDirectory) === faDirectory && SR.Name[0] !== '.') {
        const w = this.StoreDirD(RDir + SR.Name + DirectorySeparator); // FPC DirectorySeparator
        this.StoreWPtr(DLast.v, w);
        DLast.v = w;
      }
      DosError = FindNextDir(SR);
    }
  }
  // PAS: EXPIMP.PAS TzFile.GetDirs
  GetDirs(Mask: LongStrPtr): void {
    const slRoot = ref<StringList>(null);
    const l = Mask.length;
    let j = 1;
    let n: number;
    const blank = (c: number): boolean => c === 0x20 || c === 0x2c;
    do {
      while (j <= l && blank(Mask[j - 1])) j++;
      n = l - j + 1;
      for (let i = j; i <= l; i++) {
        if (blank(Mask[i - 1])) {
          n = i - j;
          break;
        }
      }
      if (n > 0) {
        n = MinW(n, 255);
        const sl = new StringListEl();
        ChainLast(slRoot, sl);
        let s = '';
        for (let k = 0; k < n; k++) s += chr(Mask[j - 1 + k]);
        sl.S = s;
        j += n;
      }
    } while (n !== 0);
    let d = this.StoreDirD('');
    const dLast = ref(d);
    do {
      this.Get1Dir(slRoot.v, d, dLast);
      d = this.ReadWPtr(d);
    } while (d !== 0);
    SeekH(BaseVars.WorkHandle, this.WBase);
    this.WrH(BaseVars.WorkHandle, this.WPos - this.WBase);
  }
  // PAS: EXPIMP.PAS TzFile.Reset
  Reset(): void {
    const bv = BaseVars;
    bv.CVol = this.Vol;
    bv.CPath = this.Path;
    this.Handle = OpenH(_isoldfile, RdOnly);
    this.Continued = false;
    if (bv.HandleError === 2 && this.Floppy) {
      bv.CPath = IncCh(bv.CPath, bv.CPath.length - 2, 5);
      this.Handle = OpenH(_isoldfile, RdOnly);
      this.Continued = true;
    }
    TestCPathError();
    this.Size = FileSizeH(this.Handle);
    this.OrigSize = this.Size;
    RunMsgOn('C', this.Size);
  }
  // PAS: EXPIMP.PAS TzFile.Rewrite
  Rewrite(): void {
    const bv = BaseVars;
    bv.CVol = this.Vol;
    bv.CPath = this.Path;
    this.Handle = OpenH(_isoverwritefile, Exclusive);
    TestCPathError();
    this.SpaceOnDisk = this.MyDiskFree(this.Floppy, this.Drive);
  }
  // PAS: EXPIMP.PAS TzFile.ReadBuf2
  ReadBuf2(): void {
    const bv = BaseVars;
    this.lBuf2 = 0;
    this.iBuf2 = 0;
    if (this.Size === 0 && this.Continued) {
      CloseH(this.Handle);
      RunMsgOff();
      this.MountVol(false);
      this.Reset();
    }
    if (this.Size === 0) {
      this.EOF2 = true;
      return;
    }
    this.lBuf2 = this.BufSize2;
    if (this.lBuf2 > this.Size) this.lBuf2 = this.Size;
    ReadH(this.Handle, this.lBuf2, this.Buf2);
    bv.CPath = this.Path;
    TestCPathError();
    this.Size -= this.lBuf2;
    RunMsgN(this.OrigSize - this.Size);
  }
  // PAS: EXPIMP.PAS TzFile.WriteBuf2
  WriteBuf2(): void {
    const bv = BaseVars;
    let i = 0;
    while (i < this.lBuf2) {
      if (this.SpaceOnDisk === 0) {
        CloseH(this.Handle);
        bv.CPath = this.Path;
        bv.CPath = IncCh(bv.CPath, bv.CPath.length - 2, 5);
        RenameFile56(this.Path, bv.CPath, true);
        this.MountVol(false);
        this.Rewrite();
      }
      let n = this.lBuf2 - i;
      // TS: a failed DiskFree (-1) means no limit, as in ThFile/TbFile (Pascal would write $FFFF bytes)
      if (this.SpaceOnDisk >= 0 && n > this.SpaceOnDisk) n = this.SpaceOnDisk;
      WriteH(this.Handle, n, this.Buf2.subarray(i));
      bv.CPath = this.Path;
      TestCPathError();
      i += n;
      if (this.SpaceOnDisk >= 0) this.SpaceOnDisk -= n;
    }
    this.lBuf2 = 0;
  }
  // PAS: EXPIMP.PAS TzFile.RdH – a size-prefixed block of the archive into H (or skipped)
  RdH(H: number, Skip: boolean): void {
    const a = new Uint8Array(4);
    for (let i = 0; i <= 3; i++) {
      if (this.iBuf === this.lBuf) this.ReadBuf();
      a[i] = this.Buf[this.iBuf];
      this.iBuf++;
    }
    let sz = getLongint(a, 0);
    while (sz > 0) {
      if (this.iBuf === this.lBuf) this.ReadBuf();
      if (this.EOF) break; // TS: truncated archive (Pascal loops forever)
      let n = this.lBuf - this.iBuf;
      if (sz < n) n = sz;
      if (!Skip) WriteH(H, n, this.Buf.subarray(this.iBuf));
      this.iBuf += n;
      sz -= n;
    }
  }
  // PAS: EXPIMP.PAS TzFile.WrH – Sz bytes of H into the archive, size-prefixed
  WrH(H: number, Sz: number): void {
    setLongint(this.Buf, 0, Sz);
    let j = 4;
    let max = this.BufSize - 4;
    RunMsgOn('C', Sz);
    let i = 0;
    do {
      const n = Sz - i > max ? max : Sz - i;
      i += n;
      if (n > 0) ReadH(H, n, this.Buf.subarray(j));
      this.lBuf = j + n;
      this.WriteBuf(false);
      j = 0;
      max = this.BufSize;
      RunMsgN(i);
    } while (i !== Sz);
    RunMsgOff();
  }
  // PAS: EXPIMP.PAS TzFile.ProcFileList
  ProcFileList(): void {
    const bv = BaseVars;
    let d = 0;
    const p = ref<Pointer>(null);
    MarkStore(p);
    do {
      const dNext = this.ReadWPtr(d);
      let n = this.ReadWPtr(d + 8);
      const i = ref(d + 12);
      const RDir = this.ReadWStr(i);
      this.SetDir(RDir);
      i.v = this.ReadWPtr(d + 4);
      while (n > 0) {
        const FName = this.ReadWStr(i);
        n--;
        bv.CPath = FExpand(FName);
        bv.CVol = '';
        let h: number;
        if (this.IsBackup) {
          h = OpenH(_isoldfile, RdOnly);
          TestCPathError();
          this.WrH(h, FileSizeH(h));
        } else {
          let skp = false;
          if (!this.OverwrOpt) {
            h = OpenH(_isnewfile, Exclusive);
            if (bv.HandleError === 80) {
              SetMsgPar(bv.CPath);
              if (PromptYN(780)) h = OpenH(_isoverwritefile, Exclusive);
              else skp = true; // goto 1
            }
          } else h = OpenH(_isoverwritefile, Exclusive);
          if (!skp) TestCPathError();
          // 1:
          this.RdH(h, skp);
        }
        CloseH(h);
      }
      d = dNext;
      ReleaseStore(p.v);
    } while (d !== 0);
  }
  // PAS: EXPIMP.PAS TzFile.Backup
  Backup(aMsk: LongStrPtr): void {
    this.MountVol(true);
    this.Rewrite();
    this.InitBufOutp();
    this.GetDirs(aMsk);
    this.ProcFileList();
    this.WriteBuf(true);
  }
  // PAS: EXPIMP.PAS TzFile.Restore
  Restore(): void {
    this.MountVol(true);
    this.Reset();
    if (this.Size === 0) CloseH(this.Handle);
    else {
      this.InitBufInp();
      SeekH(BaseVars.WorkHandle, this.WBase);
      this.RdH(BaseVars.WorkHandle, false);
      this.ProcFileList();
    }
    RunMsgOff();
  }
}

// PAS: EXPIMP.PAS BackupM – BACKUPM/RESTOREM instruction (directory archive with masks)
export function BackupM(PD: InstrPtr): void {
  const pd = PD!;
  const p = ref<Pointer>(null);
  MarkStore(p);
  let s: LongStrPtr = new Uint8Array(0);
  if (pd.IsBackup) s = RunLongStr(pd.bmMasks);
  const F = new TzFile().InitZ(pd.IsBackup, pd.NoCompress, pd.bmSubDir, pd.bmOverwr, pd.BrCatIRec, RunShortStr(pd.bmDir));
  const er = new ExitRecord();
  NewExit(Ovr, er);
  try {
    BaseVars.LastExitCode = 1;
    if (pd.IsBackup) F.Backup(s);
    else F.Restore();
    BaseVars.LastExitCode = 0;
  } catch (e) {
    if (!(e instanceof GoExitSignal)) throw e;
  } finally {
    RestoreExit(er);
  }
  // 1:
  F.Close();
  if (BaseVars.LastExitCode !== 0) {
    RunMsgOff();
    if (!pd.BrNoCancel) GoExit();
  }
  ReleaseStore(p.v);
}

// ---------------------------------------------------------------- XEncode

// TS: BP7 System.Random(Range) on the shared System.RandSeed (RunFrmlVars.RandSeed): XEncode does
// not save/restore it, so it advances the sequence `random` in FAND programs continues from.
function Random(Range: number): number {
  const rnd = new TpRandom(RunFrmlVars.RandSeed);
  const r = rnd.next(Range);
  RunFrmlVars.RandSeed = rnd.seed | 0;
  return r;
}

// PAS: EXPIMP.PAS XEncode – encode S1 into S2 (run-only chapter texts; inverse of XDecode).
// Pascal writes into a preallocated $FFFE-byte S2 and sets S2^.LL; here S2.v gets the result.
// BP7 asm (the FPC version is a plain copy, see the header).
export function XEncode(S1: LongStrPtr, S2: Ref<LongStrPtr>): void {
  const src = S1;
  const Len0 = src.length;
  const t = DriversVars.Timer & 0xff;
  const rol = (v: number, n: number): number => ((v << n) | (v >> (8 - n))) & 0xff;
  let RMask = rol(0x9c, t & 3);
  const enc = new Uint8Array(Len0 + (Len0 >> 3) + 2);
  // TS: 3-byte hash chains of the source positions p that the asm scan may compare (p <= cur-3),
  // in increasing order – the same candidates in the same order, minus those that cannot reach 3
  const heads = new Map<number, number[]>();
  let nIns = 0; // positions 0..nIns-1 are in the chains
  const tri = (p: number): number => (src[p] << 16) | (src[p + 1] << 8) | src[p + 2];
  let cur = 0; // si - S1 - 2
  let Len = Len0;
  let d = 0; // di - S2 - 2
  let Displ = 0;
  let Mask = 1;
  let FlagPos = 0;
  let Flags = 0;
  for (;;) {
    // @1:
    FlagPos = d;
    d++;
    Mask = 1;
    Flags = 0;
    let done = false;
    for (;;) {
      // @2:
      if (Len === 0) {
        done = true;
        break;
      }
      let SequLen = 0;
      let SequPos = 0;
      if (Len > 2) {
        while (nIns <= cur - 3) {
          const k = tri(nIns);
          let a = heads.get(k);
          if (a === undefined) heads.set(k, (a = []));
          a.push(nIns);
          nIns++;
        }
        const a = heads.get(tri(cur));
        if (a !== undefined) {
          for (const p of a) {
            let cx = cur - p; // @3: cx := min(si-di, Len)
            if (cx > Len) cx = Len;
            let k = 3;
            while (k < cx && src[cur + k] === src[p + k]) k++;
            if (k > SequLen) {
              SequPos = p;
              SequLen = k > 255 ? 255 : k;
            }
          }
        }
      }
      // @15:
      if (SequLen <= 2) {
        RMask = rol(RMask, 1);
        enc[d++] = src[cur++] ^ RMask;
        Len--;
      } else {
        // @16:
        enc[d++] = SequLen;
        const pos = SequPos + 2;
        enc[d++] = pos & 0xff;
        enc[d++] = (pos >> 8) & 0xff;
        Flags |= Mask;
        Len -= SequLen;
        cur += SequLen;
      }
      // @17:
      if (cur > d && cur - d > Displ) Displ = cur - d;
      // @18:
      Mask = (Mask << 1) & 0xff;
      if (Mask !== 0) continue;
      enc[FlagPos] = Flags;
      break;
    }
    if (done) break;
  }
  // @19:
  if (Mask === 1) d--;
  else enc[FlagPos] = Flags;
  // @21:
  const NewLen = d;
  const LL = Displ + NewLen + 3;
  const out = new Uint8Array(LL);
  out.set(enc.subarray(0, NewLen), Displ);
  out[LL - 3] = t;
  setWord(out, LL - 2, Displ ^ 0xcccc);
  for (let i = 1; i <= Displ; i++) out[i - 1] = Random(255);
  S2.v = out;
}

// ---------------------------------------------------------------- RDB coding

// PAS: EXPIMP.PAS CompressCRdb – rewrite the chapter file by a merge (drops deleted records)
function CompressCRdb(): void {
  const av = AccessVars;
  const p = ref<Pointer>(null);
  MarkStore(p);
  const Chpt = av.Chpt!;
  const cr = Chpt.RecPtr;
  const s = '#I1_' + Chpt.Name + '#O1_' + Chpt.Name;
  SetInpStr(ref(s));
  av.SpecFDNameAllowed = true;
  ReadMerge();
  av.SpecFDNameAllowed = false;
  RunMerge();
  SaveFiles();
  ReleaseStore(p.v);
  Chpt.RecPtr = cr;
  av.CFile = Chpt;
  // TS: FPC-like fallback when the editor is not active (E=nil): Chpt^.RecPtr
  const e = E();
  av.CRecPtr = e !== null ? e.NewRecPtr : Chpt.RecPtr;
  ReadRec(CRec());
  const tf = av.ChptTF!;
  tf.CompileAll = false;
  tf.CompileProc = false;
  SetUpdHandle(tf.Handle);
}

// PAS: EXPIMP.PAS CodingCRdb.CompressTxt – re-tokenise chapter text s (comments, directives,
// whitespace); s.v gets the compressed text. Exported for tests (a nested procedure in Pascal).
export function CompressTxt(IRec: number, s: Ref<LongStrPtr>, Typ: string): void {
  const av = AccessVars;
  const ss = new Uint8Array(MaxLStrLen);
  let l = 0;
  // PAS: EXPIMP.PAS CodingCRdb.CompressTxt.Wr
  const Wr = (c: string): void => {
    if (l >= MaxLStrLen) RunError(661);
    ss[l] = ord(c);
    l++;
  };
  av.InpArrLen = s.v.length;
  av.InpArrPtr = s.v;
  av.PrevCompInp = null;
  if (av.InpArrLen === 0) av.ForwChar = EOFChar;
  else av.ForwChar = chr(av.InpArrPtr[0]);
  av.CurrPos = 1;
  av.SwitchLevel = 0;
  const cr = av.CRecPtr;
  const p2 = ref<Pointer>(null);
  MarkStore2(p2);
  const fc = (): string => av.ForwChar; // TS: ForwChar changes under ReadChar (defeats narrowing)
  if (Typ === 'E') {
    // 0: read headlines
    for (;;) {
      while (!(fc() === '#' || fc() === EOFChar || fc() === '\r' || fc() === '{')) {
        Wr(fc());
        ReadChar();
      }
      const c = fc();
      if (c === EOFChar || c === '#') break; // goto 1
      if (c === '{') {
        SkipBlank(true);
        Wr('{');
        Wr('}');
      } else {
        ReadChar();
        if (fc() === '\n') ReadChar();
      }
      Wr('\r');
      Wr('\n');
    }
  }
  for (;;) {
    // 1:
    const c = fc();
    if (c === EOFChar) {
      if (av.PrevCompInp !== null) {
        const ci = av.PrevCompInp;
        LoadCompInp(ci);
        if (av.CurrPos <= av.InpArrLen) av.ForwChar = chr(av.InpArrPtr![av.CurrPos - 1]);
        continue;
      }
      s.v = ss.slice(0, l);
      ReleaseAfterLongStr(s.v);
      ReleaseStore2(p2.v);
      av.CRecPtr = cr;
      return;
    } else if (c === '{') {
      ReadChar();
      if (fc() === '$') {
        const b = ref(false);
        const n = RdDirective(b);
        switch (n) {
          case 0:
            break;
          case 1:
            av.SwitchLevel++;
            if (!b.v) SkipLevel(true);
            break;
          case 5: {
            const ci = new CompInpD();
            SaveCompInp(ci);
            av.PrevCompInp = ci;
            SetInpTT(CompileVars.ChptIPos, true);
            break;
          }
          default:
            if (n === 3) SkipLevel(false);
            else av.SwitchLevel--;
        }
        continue;
      }
      let n = 1;
      for (;;) {
        // 2:
        const c2 = fc();
        if (c2 === '{') n++;
        else if (c2 === '}') {
          n--;
          if (n === 0) break;
        } else if (c2 === EOFChar) break; // TS: unterminated comment (Pascal loops forever)
        ReadChar();
      }
      Wr(' ');
      if (fc() !== EOFChar) ReadChar();
      continue;
    } else if (c === "'") {
      do {
        Wr(fc());
        ReadChar();
      } while (!(fc() === "'" || fc() === EOFChar));
      if (fc() === EOFChar) continue;
    } else if (c <= ' ' && c !== EOFChar) {
      // FPC ^@..#$19,#$1B..' '
      if (!(Typ === 'R' || Typ === 'U' || Typ === 'E' || Typ === 'H')) {
        while (fc() <= ' ' && fc() !== EOFChar) ReadChar();
        Wr(' ');
        continue;
      }
    }
    Wr(fc());
    ReadChar();
  }
}

let posUDLI = 0; // PAS: EXPIMP.PAS CodingCRdb posUDLI

// PAS: EXPIMP.PAS CodingCRdb.CodeF
function CodeF(Rotate: boolean, IRec: number, F: FieldDPtr, Typ: string): void {
  const av = AccessVars;
  const pos = _T(F);
  if (pos === 0) return;
  const p = ref<Pointer>(null), p2 = ref<Pointer>(null);
  MarkBoth(p, p2);
  const tf = av.ChptTF!;
  let s: LongStrPtr = tf.Read(1, pos);
  let l = s.length;
  tf.Delete(pos);
  if (l !== 0) {
    if (Rotate) {
      let skip = false;
      if (F === av.ChptOldTxt) {
        // FileDPtr(@s^.A)^.TxtPosUDLI: the BP7 FileD image, TxtPosUDLI at offset 36
        if (Typ === 'F' && s.length >= 38) setWord(s, 36, posUDLI);
      } else {
        const rs = ref(s);
        CompressTxt(IRec, rs, Typ);
        s = rs.v;
        l = s.length;
        if (l === 0) skip = true; // goto 2
        else {
          if (l > MaxLStrLen) RunError(661);
          if (Typ === 'F') {
            posUDLI = 0;
            let b = true;
            for (let i = 1; i <= l - 1; i++) {
              const c = s[i - 1];
              if (c === 0x23) {
                const c1 = s[i];
                if (b && (c1 === 0x55 || c1 === 0x44 || c1 === 0x4c || c1 === 0x49)) {
                  posUDLI = i;
                  break; // goto 1
                }
              } else if (c === 0x27) b = !b;
            }
          }
        }
      }
      if (!skip) {
        // 1:
        const s2 = ref<LongStrPtr>(GetStore(0));
        XEncode(s, s2);
        s = s2.v;
      }
    } else Code(s, l);
  }
  // 2:
  LongS_(F, s);
  ReleaseBoth(p.v, p2.v);
}

// PAS: EXPIMP.PAS CodingCRdb – encode (Rotate: run-only XEncode) or password-code (Code) the chapter texts of CRdb
export function CodingCRdb(Rotate: boolean): void {
  const av = AccessVars;
  const cf = av.CFile;
  const cr = av.CRecPtr;
  av.CFile = av.Chpt;
  av.CRecPtr = GetRecSpace();
  const C = av.CFile!;
  RunMsgOn('C', C.NRecs);
  const tf = av.ChptTF!;
  const irec = tf.IRec;
  const compileAll = tf.CompileAll;
  for (let i = 1; i <= C.NRecs; i++) {
    ReadRec(i);
    RunMsgN(i);
    const s = _ShortS(av.ChptTyp).slice(0, 1); // string[1]
    SetMsgPar(_ShortS(av.ChptName));
    if (Rotate && (s === ' ' || s === 'I')) {
      // skip
    } else {
      CodeF(Rotate, i, av.ChptTxt, s);
      CodeF(Rotate, i, av.ChptOldTxt, s);
      WriteRec(i);
    }
  }
  if (Rotate) {
    let i = 1;
    while (i <= C.NRecs) {
      ReadRec(i);
      const s = _ShortS(av.ChptTyp).slice(0, 1);
      if (s === ' ' || s === 'I') DeleteRec(i);
      else i++;
    }
  }
  RunMsgOff();
  ReleaseStore(av.CRecPtr);
  av.CFile = cf;
  av.CRecPtr = cr;
  CompressCRdb();
  tf.IRec = irec;
  tf.CompileAll = compileAll;
}

// PAS: EXPIMP.PAS PromptCodeRdb.AddLicNr
function AddLicNr(F: FieldDPtr): void {
  if (_T(F) !== 0) T_(F, _T(F) + BaseVars.UserLicNr);
}
// PAS: EXPIMP.PAS PromptCodeRdb.CopyH – copy the whole file H to the host file Nm
function CopyH(H: number, Nm: string): void {
  const bv = BaseVars;
  const buf = GetStore(MaxLStrLen);
  bv.CPath = Nm;
  bv.CVol = '';
  const h2 = OpenH(_isoverwritefile, Exclusive);
  let sz = FileSizeH(H);
  SeekH(H, 0);
  while (sz > 0) {
    const n = sz > MaxLStrLen ? MaxLStrLen : sz;
    sz -= n;
    ReadH(H, n, buf);
    WriteH(h2, n, buf);
  }
  CloseH(h2);
  ReleaseStore(buf);
}
// PAS: EXPIMP.PAS PromptCodeRdb – ask for RDB encoding (prompts 133/147); false when only compressed
export function PromptCodeRdb(): boolean {
  const av = AccessVars;
  const bv = BaseVars;
  const Chpt = av.Chpt;
  SetPassword(Chpt, 1, '');
  SetPassword(Chpt, 2, '');
  bv.F10SpecKey = _AltF10_;
  let b = PromptYN(133);
  let compressOnly = false;
  if (DriversVars.KbdChar === _AltF10_) {
    bv.F10SpecKey = _ESC_;
    b = PromptYN(147);
    if ((DriversVars.KbdChar as number) === _ESC_) compressOnly = true; // goto 1
    else {
      if (b) {
        av.CFile = Chpt;
        WrPrefixes();
        SaveCache(0);
        const s = ref(av.CRdb!.RdbDir);
        AddBackSlash(s);
        s.v = s.v + Chpt!.Name;
        CopyH(Chpt!.Handle, s.v + '.RD$');
        CopyH(av.ChptTF!.Handle, s.v + '.TT$');
      }
      CodingCRdb(true);
      av.ChptTF!.LicenseNr = bv.UserLicNr;
      const cf = av.CFile;
      const cr = av.CRecPtr;
      av.CFile = Chpt;
      av.CRecPtr = GetRecSpace();
      for (let i = 1; i <= Chpt!.NRecs; i++) {
        ReadRec(i);
        AddLicNr(av.ChptOldTxt);
        AddLicNr(av.ChptTxt);
        WriteRec(i);
      }
      ReleaseStore(av.CRecPtr);
      av.CFile = cf;
      av.CRecPtr = cr;
      return true;
    }
  }
  if (!compressOnly && b) {
    SetPassword(Chpt, 1, PassWord(true));
    if (!HasPassword(Chpt, 1, '')) {
      CodingCRdb(false);
      return true;
    }
  }
  // 1:
  CompressCRdb();
  return false;
}

// PAS: EXPIMP.PAS CheckFile – check the prefix of file CPath against FD; result in LastExitCode
export function CheckFile(FD: FileDPtr): void {
  const bv = BaseVars;
  const fd = FD!;
  TestMountVol(bv.CPath[0] ?? '\0');
  let h = OpenH(_isoldfile, RdShared);
  bv.LastExitCode = 0;
  if (bv.HandleError !== 0) {
    if (bv.HandleError === 2) bv.LastExitCode = 1;
    else bv.LastExitCode = 2;
    return;
  }
  const Prfx = new Uint8Array(6); // record NRecs: longint; RecLen: word end
  ReadH(h, 6, Prfx);
  const fs0 = FileSizeH(h);
  CloseH(h);
  const NRecs = getLongint(Prfx, 0);
  const RecLen = getWord(Prfx, 4);
  if (fd.RecLen !== RecLen || (NRecs < 0 && fd.Typ !== 'X') ||
      Math.trunc((fs0 - fd.FrstDispl) / RecLen) < NRecs || (NRecs > 0 && fd.Typ === 'X')) {
    bv.LastExitCode = 3;
    return;
  }
  if (fd.TF === null) return;
  const d = ref(''), n = ref(''), e = ref('');
  FSplit(bv.CPath, d, n, e);
  if (SEquUpcase(e.v, '.RDB')) e.v = '.TTT';
  else e.v = SetCh(e.v, 2, 'T');
  bv.CPath = d.v + n.v + e.v;
  h = OpenH(_isoldfile, RdShared);
  if (bv.HandleError === 0) CloseH(h);
  else bv.LastExitCode = 4;
}
