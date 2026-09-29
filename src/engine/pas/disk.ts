// PAS: DISKFPC.PAS (FPC) / DISK.PAS (BP7) – include of EXPIMP: raw floppy access and the LZSS
// compression used by BACKUP/RESTORE (TcFile). Re-exported by expimp.ts; no state of its own.
//
// Porting notes:
// * asm/DOS (BP7 only): TBoot.ReadSect/WriteSect (int $25/$26), ResetDisks (int $13), FatPut/FatGet
//   (12-bit FAT), floppy formatting (SetDasd, FormatTrack, VerifySect, WrSect, GetDrvPar, GetDPT and
//   their tables). The FPC port stubs disk access: ReadSect/WriteSect return 1 (error),
//   FormatOnDrive = false, ResetDisks no-op; only the FAT12 helpers stay (pure Pascal). Not ported
//   further: backups go to host directories.
// * TcFile.InsertNode/DeleteNode are asm in BP7 (the Pascal is in comments). FPC compares the ring
//   buffer bytes unsigned; BP7 `repe cmpsb; jl` compares them SIGNED, so for bytes >= $80 the
//   binary tree shape and the chosen matches can differ. Both outputs decode with ReadBuf, but for
//   byte-identical backups with UFAND.EXE follow BP7 (signed compare: res := shortint(a) - shortint(b)).
// * LZSS format: 4 kB ring (RingBufSz), matches 3..18 (MinMatchLen..MaxMatchLen), flag byte per 8
//   items (bit set = literal); a match is 2 bytes: pos lo 8 bits, then (pos hi 4 bits << 4) | (len-3).
//   Ring initialised with 0, iRingBuf starts at RingBufSz-MaxMatchLen. Compress = 0: no compression,
//   Buf = Buf2 of 16 kB.
// * WriteBuf2/ReadBuf2 are virtual (EXPIMP's ThFile does the I/O). ThFile = object(TcFile) lives in
//   EXPIMP; per PORTING.md 5 `extends` must stay within one module, so ThFile should be declared in
//   this module (or TcFile made to call WriteBuf2/ReadBuf2 hooks). TcFile does not extend DRIVERS'
//   TObject for the same reason; it has its own Init/Done. (disk.ts uses no other module at its
//   top level, so it is always evaluated before expimp.ts, which imports it.)
// * MyDiskFree: spec.WithDiskFree or floppy -> DiskFree(Drive) (host: fs.statfsSync of the current
//   directory for drive 0, else of the drive root mapped by HANDLE.UnixPath; drive > 26 or a host
//   error -> -1), else $7fffffff; clamped to longint as BP7's DOS call (FPC truncates an int64).
// * Buf/Buf2 are PChar in Pascal (0-based) -> Uint8Array.

import * as fs from 'node:fs';
import { ref, shortint, GetTime, ToUnicode, chr } from './pasrt.ts';
import { BaseVars, GetStore, SplitDate, Today, MinW, UnixPath } from './base.ts';

// ---------------------------------------------------------------- boot sector, directory

// PAS: DISKFPC.PAS TBoot – DOS boot sector of drive Drive
export class TBoot {
  Drive = 0;
  Boot = new Uint8Array(3);
  Version = ''; // array[1..8] of char
  SecSize = 0;
  SecsPerClust = 0;
  ReservedSecs = 0;
  FatCount = 0;
  RootSize = 0;
  TotSecs = 0;
  MediaCode = 0;
  SecsPerFat = 0;
  SecsPerTrack = 0;
  HeadCount = 0;
  HiddenSecs2 = 0;
  TotSecs2 = 0;
  Progr = new Uint8Array(476);

  // PAS: DISKFPC.PAS TBoot.Init
  Init(aDrive: number): this {
    this.Drive = aDrive;
    this.TotSecs = 1;
    return this;
  }
  Done(): void {}
  // PAS: DISKFPC.PAS TBoot.BytesPerClust
  BytesPerClust(): number {
    return (this.SecsPerClust * this.SecSize) & 0xffff;
  }
  // PAS: DISKFPC.PAS TBoot.FrstDataSec
  FrstDataSec(): number {
    return (this.RootSec() + this.SecsPerRoot()) & 0xffff;
  }
  // PAS: DISKFPC.PAS TBoot.ReadSect – FPC: always error 1
  ReadSect(Sect: number, N: number, Buf: Uint8Array): number {
    return 1;
  }
  // PAS: DISKFPC.PAS TBoot.RootSec
  RootSec(): number {
    return (this.ReservedSecs + this.FatCount * this.SecsPerFat) & 0xffff;
  }
  // PAS: DISKFPC.PAS TBoot.SecsPerCyl
  SecsPerCyl(): number {
    return (this.SecsPerTrack * this.HeadCount) & 0xffff;
  }
  // PAS: DISKFPC.PAS TBoot.SecsPerRoot
  SecsPerRoot(): number {
    return Math.trunc(((this.RootSize << 5) & 0xffff) / this.SecSize);
  }
  // PAS: DISKFPC.PAS TBoot.TotalSecs
  TotalSecs(): number {
    return this.TotSecs !== 0 ? this.TotSecs : this.TotSecs2;
  }
  // PAS: DISKFPC.PAS TBoot.WriteSect – FPC: always error 1
  WriteSect(Sect: number, N: number, Buf: Uint8Array): number {
    return 1;
  }
}

// PAS: DISKFPC.PAS TDirEntry – 32-byte FAT directory entry
export class TDirEntry {
  Name = ''; // array[1..8] of char
  Ext = ''; // array[1..3] of char
  Attr = 0;
  Reserved = new Uint8Array(10);
  Time = 0; // DOS packed date/time
  Clust = 0;
  Size = 0;

  // PAS: DISKFPC.PAS TDirEntry.IsDeleted
  IsDeleted(): boolean {
    return this.Name.charCodeAt(0) === 0xe5;
  }
  // PAS: DISKFPC.PAS TDirEntry.IsNotUsed
  IsNotUsed(): boolean {
    return this.Name.length === 0 || this.Name.charCodeAt(0) === 0;
  }
}
export type PDirEntryArr = TDirEntry[] | null; // [0..1000]

// PAS: DISKFPC.PAS FillVolDirEntry – EE: the 32 raw bytes of a TDirEntry
export function FillVolDirEntry(EE: Uint8Array, NewName: string): void {
  EE.fill(0, 0, 32);
  EE[11] = 0x08; // Attr := VolumeID
  const Day = ref(0), Month = ref(0), Year = ref(0), Hour = ref(0), Min = ref(0), Sec = ref(0), w = ref(0);
  SplitDate(Today(), Day, Month, Year);
  GetTime(Hour, Min, Sec, w);
  // DOS.PackTime(x, e.Time)
  const t = (((((Year.v - 1980) << 9) + (Month.v << 5) + Day.v) << 16) + (Hour.v << 11) + (Min.v << 5) + (Sec.v >> 1)) | 0;
  EE[22] = t & 0xff;
  EE[23] = (t >> 8) & 0xff;
  EE[24] = (t >> 16) & 0xff;
  EE[25] = (t >> 24) & 0xff;
  const n = MinW(NewName.length, 11);
  EE.fill(0x20, 0, 11);
  for (let i = 0; i < n; i++) EE[i] = NewName.charCodeAt(i);
}
// PAS: DISKFPC.PAS ResetDisks (FPC: no-op)
export function ResetDisks(): void {}
// PAS: DISKFPC.PAS FatPut – 12-bit FAT entry I := N
export function FatPut(Fat: Uint8Array, I: number, N: number): void {
  const ofs = (I + (I >> 1)) & 0xffff;
  let v = Fat[ofs] | (Fat[ofs + 1] << 8);
  if ((I & 1) !== 0) v = (v & 0x000f) | ((N << 4) & 0xffff);
  else v = (v & 0xf000) | (N & 0x0fff);
  Fat[ofs] = v & 0xff;
  Fat[ofs + 1] = (v >> 8) & 0xff;
}
export const fatBadCluster = 0xfff7;
// PAS: DISKFPC.PAS FatGet – 12-bit FAT entry I ($FF0.. sign-extended to $FFFx)
export function FatGet(Fat: Uint8Array, I: number): number {
  const ofs = (I + (I >> 1)) & 0xffff;
  let v = Fat[ofs] | (Fat[ofs + 1] << 8);
  if ((I & 1) !== 0) v = v >> 4;
  else v = v & 0x0fff;
  if ((v & 0x0ff0) === 0x0ff0) v = v | 0xf000;
  return v;
}
// PAS: DISKFPC.PAS FormatOnDrive (FPC: formatting not supported)
export function FormatOnDrive(DriveC: string): boolean {
  return false;
}

// ---------------------------------------------------------------- LZSS compression

export const RingBufSz = 4096;
export const MaxMatchLen = 18;
export const MinMatchLen = 3;
export const Leer = RingBufSz;

// PAS: DISKFPC.PAS TXBuf – ring buffer and the binary search trees
export class TXBuf {
  RingBuf = new Uint8Array(RingBufSz + MaxMatchLen - 1); // [0..RingBufSz+MaxMatchLen-2]
  LSon = new Uint16Array(RingBufSz + 1);
  Dad = new Uint16Array(RingBufSz + 1);
  RSon = new Uint16Array(RingBufSz + 257);
}

// PAS: DISKFPC.PAS TcFile – buffered (optionally compressed) stream; WriteBuf2/ReadBuf2 do the I/O
export class TcFile {
  Buf: Uint8Array = new Uint8Array(0); // PChar, 0-based
  Buf2: Uint8Array = new Uint8Array(0);
  iBuf = 0;
  lBuf = 0;
  iBuf2 = 0;
  lBuf2 = 0;
  BufSize = 0;
  BufSize2 = 0;
  EOF = false;
  EOF2 = false;
  Compress = 0;
  CodeMask = 0;
  CodeMaskW = 0;
  lCode = 0;
  lInput = 0;
  nToRead = 0;
  iRingBuf = 0;
  jRingBuf = 0;
  MatchPos = 0;
  MatchLen = 0;
  CodeBuf = new Uint8Array(17);
  XBuf: TXBuf | null = null;

  // PAS: DISKFPC.PAS TcFile.Init
  Init(aCompress: number): this {
    this.Compress = aCompress;
    if (aCompress === 0) {
      this.BufSize = 4 * RingBufSz;
      this.BufSize2 = this.BufSize;
      this.Buf = GetStore(this.BufSize);
      this.Buf2 = this.Buf;
    } else {
      this.BufSize = RingBufSz;
      this.BufSize2 = 4 * this.BufSize;
      this.XBuf = new TXBuf();
      this.Buf = GetStore(this.BufSize);
      this.Buf2 = GetStore(this.BufSize2);
    }
    return this;
  }
  // PAS: DRIVERS.PAS TObject.Done (virtual destructor)
  Done(): void {}
  // PAS: DISKFPC.PAS TcFile.MyDiskFree
  MyDiskFree(Floppy: boolean, Drive: number): number {
    if (BaseVars.Spec.WithDiskFree || Floppy) return DiskFree(Drive);
    return 0x7fffffff;
  }
  // PAS: DISKFPC.PAS TcFile.InsertNode (BP7 asm: `repe cmpsb; jl` – a SIGNED byte compare)
  InsertNode(r: number): void {
    const X = this.XBuf!;
    const rb = X.RingBuf;
    let res = 1;
    const key = r;
    let p = RingBufSz + 1 + rb[r];
    X.RSon[r] = Leer;
    X.LSon[r] = Leer;
    this.MatchLen = 0;
    for (;;) {
      if (res >= 0) {
        if (X.RSon[p] !== Leer) p = X.RSon[p];
        else {
          X.RSon[p] = r;
          X.Dad[r] = p;
          return;
        }
      } else {
        if (X.LSon[p] !== Leer) p = X.LSon[p];
        else {
          X.LSon[p] = r;
          X.Dad[r] = p;
          return;
        }
      }
      let i = 1;
      while (i <= MaxMatchLen - 1) {
        res = shortint(rb[key + i]) - shortint(rb[p + i]);
        if (res !== 0) break;
        i++;
      }
      if (i <= this.MatchLen) continue;
      this.MatchPos = p;
      this.MatchLen = i;
      if (i >= MaxMatchLen) {
        X.Dad[r] = X.Dad[p];
        X.LSon[r] = X.LSon[p];
        X.RSon[r] = X.RSon[p];
        X.Dad[X.LSon[p]] = r;
        X.Dad[X.RSon[p]] = r;
        if (X.RSon[X.Dad[p]] === p) X.RSon[X.Dad[p]] = r;
        else X.LSon[X.Dad[p]] = r;
        X.Dad[p] = Leer;
        return;
      }
    }
  }
  // PAS: DISKFPC.PAS TcFile.DeleteNode
  DeleteNode(p: number): void {
    const X = this.XBuf!;
    let q: number;
    if (X.Dad[p] === Leer) return;
    if (X.RSon[p] === Leer) q = X.LSon[p];
    else if (X.LSon[p] === Leer) q = X.RSon[p];
    else {
      q = X.LSon[p];
      if (X.RSon[q] !== Leer) {
        do q = X.RSon[q];
        while (X.RSon[q] !== Leer);
        X.RSon[X.Dad[q]] = X.LSon[q];
        X.Dad[X.LSon[q]] = X.Dad[q];
        X.LSon[q] = X.LSon[p];
        X.Dad[X.LSon[p]] = q;
      }
      X.RSon[q] = X.RSon[p];
      X.Dad[X.RSon[p]] = q;
    }
    X.Dad[q] = X.Dad[p];
    if (X.RSon[X.Dad[p]] === p) X.RSon[X.Dad[p]] = q;
    else X.LSon[X.Dad[p]] = q;
    X.Dad[p] = Leer;
  }
  // PAS: DISKFPC.PAS TcFile.WriteCodeBuf
  WriteCodeBuf(): void {
    for (let i = 0; i < this.lCode; i++) {
      if (this.lBuf2 >= this.BufSize2) this.WriteBuf2();
      this.Buf2[this.lBuf2] = this.CodeBuf[i];
      this.lBuf2++;
    }
    this.CodeBuf[0] = 0;
    this.lCode = 1;
    this.CodeMask = 1;
  }
  // PAS: DISKFPC.PAS TcFile.InitBufOutp
  InitBufOutp(): void {
    if (this.Compress !== 0) {
      const X = this.XBuf!;
      X.LSon.fill(Leer);
      X.Dad.fill(Leer);
      X.RSon.fill(Leer);
      X.RingBuf.fill(0, 0, RingBufSz);
      this.CodeBuf[0] = 0;
      this.lCode = 1;
      this.CodeMask = 1;
      this.jRingBuf = 0;
      this.iRingBuf = RingBufSz - MaxMatchLen;
      this.lInput = 0;
      this.nToRead = 0;
    }
    this.lBuf = 0;
    this.lBuf2 = 0;
  }
  // PAS: DISKFPC.PAS TcFile.WriteBuf – compresses Buf[0..lBuf-1] into Buf2
  WriteBuf(isLast: boolean): void {
    if (this.Compress === 0) {
      this.lBuf2 = this.lBuf;
      this.WriteBuf2();
      this.lBuf = 0;
      return;
    }
    const X = this.XBuf!;
    const rb = X.RingBuf;
    const mask = RingBufSz - 1;
    let i = 0;
    if (this.lInput === 0) {
      // initialization phase
      while (this.lInput < MaxMatchLen && i < this.lBuf) {
        rb[RingBufSz - MaxMatchLen + this.lInput] = this.Buf[i];
        i++;
        this.lInput++;
      }
      for (let j = 1; j <= MaxMatchLen; j++) this.InsertNode(this.iRingBuf - j);
      this.InsertNode(this.iRingBuf);
    }
    // 1:
    outer: for (;;) {
      while (this.lInput !== 0) {
        while (this.nToRead > 0) {
          if (i >= this.lBuf) {
            if (!isLast) break outer; // goto 2
            while (this.nToRead > 0) {
              this.DeleteNode(this.jRingBuf);
              this.jRingBuf = (this.jRingBuf + 1) & mask;
              this.iRingBuf = (this.iRingBuf + 1) & mask;
              this.lInput--;
              this.nToRead--;
              if (this.lInput !== 0) this.InsertNode(this.iRingBuf);
            }
            continue outer; // goto 1
          }
          const c = this.Buf[i];
          i++;
          this.nToRead--;
          this.DeleteNode(this.jRingBuf);
          rb[this.jRingBuf] = c;
          if (this.jRingBuf < MaxMatchLen - 1) rb[this.jRingBuf + RingBufSz] = c;
          this.jRingBuf = (this.jRingBuf + 1) & mask;
          this.iRingBuf = (this.iRingBuf + 1) & mask;
          this.InsertNode(this.iRingBuf);
        }
        if (this.MatchLen > this.lInput) this.MatchLen = this.lInput;
        if (this.MatchLen < MinMatchLen) {
          this.nToRead = 1;
          this.CodeBuf[0] = this.CodeBuf[0] | this.CodeMask;
          this.CodeBuf[this.lCode] = rb[this.iRingBuf];
          this.lCode++;
        } else {
          this.CodeBuf[this.lCode] = this.MatchPos & 0xff;
          this.CodeBuf[this.lCode + 1] = ((this.MatchPos >> 4) & 0xf0) | (this.MatchLen - MinMatchLen);
          this.lCode += 2;
          this.nToRead = this.MatchLen;
        }
        this.CodeMask = (this.CodeMask << 1) & 0xff;
        if (this.CodeMask === 0) this.WriteCodeBuf();
      }
      this.WriteCodeBuf();
      break;
    }
    // 2:
    if (isLast) this.WriteBuf2();
    this.lBuf = 0;
  }
  // PAS: DISKFPC.PAS TcFile.WriteBuf2 (virtual: writes Buf2[0..lBuf2-1] and sets lBuf2 := 0)
  WriteBuf2(): void {}
  // PAS: DISKFPC.PAS TcFile.InitBufInp
  InitBufInp(): void {
    if (this.Compress !== 0) {
      this.XBuf!.RingBuf.fill(0, 0, RingBufSz - MaxMatchLen);
      this.iRingBuf = RingBufSz - MaxMatchLen;
      this.CodeMaskW = 0;
    }
    this.iBuf2 = 0;
    this.lBuf2 = 0;
    this.EOF = false;
    this.EOF2 = false;
    this.ReadBuf();
  }
  // PAS: DISKFPC.PAS TcFile.ReadBuf – decompresses into Buf[0..lBuf-1]
  ReadBuf(): void {
    this.lBuf = 0;
    this.iBuf = 0;
    if (this.EOF) return;
    if (this.Compress === 0) {
      this.ReadBuf2();
      if (this.EOF2) {
        this.EOF = true;
        return;
      }
      this.lBuf = this.lBuf2;
      this.iBuf2 += this.lBuf;
      return;
    }
    const rb = this.XBuf!.RingBuf;
    const mask = RingBufSz - 1;
    // TS: `if iBuf2>=lBuf2 then begin ReadBuf2; if EOF2 then goto 2 end` – false means goto 2
    const avail = (): boolean => {
      if (this.iBuf2 >= this.lBuf2) {
        this.ReadBuf2();
        if (this.EOF2) return false;
      }
      return true;
    };
    // 1:
    for (;;) {
      if (this.lBuf > this.BufSize - MaxMatchLen) return;
      this.CodeMaskW = this.CodeMaskW >>> 1;
      if ((this.CodeMaskW & 256) === 0) {
        if (!avail()) break;
        this.CodeMaskW = this.Buf2[this.iBuf2] | 0xff00;
        this.iBuf2++;
      }
      if ((this.CodeMaskW & 1) !== 0) {
        if (!avail()) break;
        const c = this.Buf2[this.iBuf2];
        this.iBuf2++;
        this.Buf[this.lBuf] = c;
        this.lBuf++;
        rb[this.iRingBuf] = c;
        this.iRingBuf = (this.iRingBuf + 1) & mask;
      } else {
        if (!avail()) break;
        const wLo = this.Buf2[this.iBuf2];
        this.iBuf2++;
        if (!avail()) break;
        const wHi = this.Buf2[this.iBuf2];
        this.iBuf2++;
        this.MatchPos = wLo | ((wHi & 0xf0) << 4);
        this.MatchLen = (wHi & 0x0f) + MinMatchLen;
        for (let i = 0; i < this.MatchLen; i++) {
          const c = rb[(this.MatchPos + i) & mask];
          this.Buf[this.lBuf] = c;
          this.lBuf++;
          rb[this.iRingBuf] = c;
          this.iRingBuf = (this.iRingBuf + 1) & mask;
        }
      }
    }
    // 2:
    if (this.lBuf === 0) this.EOF = true;
  }
  // PAS: DISKFPC.PAS TcFile.ReadBuf2 (virtual: fills Buf2, sets lBuf2/iBuf2/EOF2)
  ReadBuf2(): void {}
}

// TS: DOS.DiskFree(Drive) – free bytes of drive (0 = current, 1 = A: .. 26 = Z:), -1 on an invalid
// drive or any host error. BP7 (int 21h AH=36h) never reports more than ~2 GB, so the result is
// clamped to MaxLongInt; the FPC reference returns int64 and MyDiskFree's longint assignment
// truncates it (may wrap negative on big disks) – intentionally not followed. Drive 0 uses
// process.cwd() (the emulated cwd in worker threads, fand.ts InstallVirtualCwd), not '.', which
// would be the OS cwd of the worker. A full disk legitimately yields 0.
function DiskFree(Drive: number): number {
  if (Drive > 26) return -1;
  try {
    const p = Drive === 0 ? process.cwd() : ToUnicode(UnixPath(chr(0x40 + Drive) + ':\\'));
    const st = fs.statfsSync(p);
    const n = Math.trunc(Number(st.bavail) * Number(st.bsize));
    return n < 0 ? -1 : Math.min(n, 0x7fffffff);
  } catch {
    return -1;
  }
}
