// PAS: OLDTXX.PAS – NOT a unit: a standalone DOS utility program (no `unit` header, its own
// MSDos-based OpenH/CloseH/SeekH/ReadH/WriteH). It repairs the 512-byte prefix of a .TTT/.Tnn
// text file given as ParamStr(1), converting it to the OLD prefix format (first longint = file
// length ML). Old format with negative FreePart: FreePart := -FreePart. New format (FreePage =
// $FFFF0001): PwNew is decoded; when it is '@@@@@@@@@@@@@@@@@@@@' (20 x '@') it is re-encoded with
// RandSeed := ML and moved over FreeRoot.. (the old password place), IRec -= $4000.
// Nothing in FAND uses it.
//
// Porting notes:
// * asm/DOS: all file I/O is int $21 (AH=$3D/$3E/$42/$3F/$40); writeln + halt on errors. On a host:
//   node:fs directly (or HANDLE), never through the engine.
// * State: program globals h, Size, p/d/n/e, the prefix record T (OldFreeRoot, OldMaxPage: word;
//   FreePart: longint; Rsrvd1, CompileProc, CompileAll: boolean; IRec: word; FreeRoot, MaxPage:
//   longint; Rsrvd2[32]; Version[4]; LicText[105]; Sum: byte; X1[295]; LicNr: word; X2[11];
//   PwNew[40]; Time: byte), `FreePage: longint absolute T`, Pw[40] / Pw1 absolute Pw.
//   Same layout as FILEACC TFile.RdPrefix; docs/FORMATS.md.
// * Tricky: TP Random (fand/coding.ts TpRandom): RandSeed := ML + T.Time, 458 Random(255) calls
//   discarded (i = 14..471), then Pw[i] := PwNew[i] xor Random(255). WriteH(h,0,T) at ML truncates.
//   ML = (MaxPage+1) shl 9 (or (OldMaxPage+1) shl 9 for the old format, where negative FreePart is
//   negated).
// * Port only if a tool is needed (e.g. under src/engine/tools); here a typed stub.

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import { ref, FSplit, Halt, getWord, setWord, getLongint, setLongint, ToUnicode, FromUnicode } from './pasrt.ts';
import { TpRandom } from '../fand/coding.ts';

const MPageShft = 9;
// T record offsets (the 512-byte .TTT prefix)
const T_OldMaxPage = 2;
const T_FreePart = 4;
const T_IRec = 11;
const T_FreeRoot = 13;
const T_MaxPage = 17;
const T_PwNew = 471;
const T_Time = 511;

// PAS: OLDTXX.PAS writeln (TS-only: the program's console output)
function writeln(s: string): void {
  process.stdout.write(s + '\n');
}
// PAS: OLDTXX.PAS OpenH – open for read/write (DOS mode 18 = deny all + r/w); halts when missing
function OpenH(path: string): number {
  try {
    return fs.openSync(ToUnicode(path), 'r+');
  } catch {
    writeln("file doesn't exist");
    return Halt();
  }
}
// PAS: OLDTXX.PAS CloseH
function CloseH(handle: number): void {
  try {
    fs.closeSync(handle);
  } catch {
    // DOS close errors are ignored
  }
}
// TS-only: the DOS file pointer of each handle (node:fs has no lseek)
const FilePos = new Map<number, number>();
// PAS: OLDTXX.PAS SeekH
function SeekH(handle: number, pos: number): void {
  FilePos.set(handle, pos);
}
// PAS: OLDTXX.PAS ReadH
function ReadH(handle: number, bytes: number, buffer: Uint8Array): void {
  const pos = FilePos.get(handle) ?? 0;
  const n = fs.readSync(handle, buffer, 0, bytes, pos);
  FilePos.set(handle, pos + n);
}
// PAS: OLDTXX.PAS WriteH – DOS: writing 0 bytes truncates (or extends) the file at the pointer
function WriteH(handle: number, bytes: number, buffer: Uint8Array): void {
  const pos = FilePos.get(handle) ?? 0;
  if (bytes === 0) {
    fs.ftruncateSync(handle, pos);
    return;
  }
  const n = fs.writeSync(handle, buffer, 0, bytes, pos);
  FilePos.set(handle, pos + n);
}

// PAS: OLDTXX.PAS (program body) – ParamStr1 = the .TTT/.Tnn path
export function OldTxx(ParamStr1: string): void {
  const d = ref(''), n = ref(''), e = ref('');
  FSplit(FromUnicode(nodePath.resolve(ToUnicode(ParamStr1))), d, n, e);
  if (e.v === '') e.v = '.TTT';
  else if (e.v.length < 4 || e.v[1] !== 'T') {
    writeln('incorrect file name (.TTT or .Tnn expected)');
    Halt();
  }
  const h = OpenH(d.v + n.v + e.v);
  try {
    const T = new Uint8Array(512);
    SeekH(h, 0);
    ReadH(h, 512, T);
    let ML: number;
    // FreePage: longint absolute T
    if (getLongint(T, 0) >>> 0 !== 0xffff0001) {
      const FreePart = getLongint(T, T_FreePart);
      if (FreePart >= 0) return; // exit (already the old format)
      setLongint(T, T_FreePart, -FreePart);
      ML = (getWord(T, T_OldMaxPage) + 1) * 2 ** MPageShft;
    } else {
      ML = (getLongint(T, T_MaxPage) + 1) * 2 ** MPageShft;
      const rnd = new TpRandom(ML + T[T_Time]); // RandSeed:=ML+T.Time
      for (let i = 14; i <= 471; i++) rnd.next(255);
      const Pw = new Uint8Array(40);
      for (let i = 1; i <= 40; i++) Pw[i - 1] = T[T_PwNew + i - 1] ^ rnd.next(255);
      // Pw1: array[1..20] of char absolute Pw
      if (Pw.subarray(0, 20).every((c) => c === 0x40)) {
        const rnd2 = new TpRandom(ML); // RandSeed:=ML
        for (let i = 1; i <= 40; i++) Pw[i - 1] ^= rnd2.next(255);
        T.set(Pw, T_FreeRoot); // Move(Pw,T.FreeRoot,40)
        setWord(T, T_IRec, (getWord(T, T_IRec) - 0x4000) & 0xffff);
      }
    }
    // 1:
    setLongint(T, 0, ML); // FreePage:=ML
    SeekH(h, 0);
    WriteH(h, 512, T);
    SeekH(h, ML);
    WriteH(h, 0, T);
  } finally {
    CloseH(h); // TS: also on the early exit (the DOS program ends there)
  }
}
