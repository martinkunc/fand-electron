// PAS: OLONGSTR.PAS – long texts from host files (GetTxt, the TXT function / text-file source of
// T fields) and copying of T-file texts between files or to a DOS handle.
//
// Porting notes:
// * No interface variables, no unit initialization, no asm. Private: GetTxtPrepare(Z, var h, var off, var len).
// * State used: AccessVars.LastTxtPos, BaseVars.LastExitCode, BaseVars.CPath, AccessVars.CFile,
//   RunFrmlVars TFD02/TF02/TF02Pos (the source text of CopyTFStringToH, set by RUNFRML).
// * T-file text layout (docs/FORMATS.md, cf. FILEACC TFile.Read/Store):
//   - short text (L <= MPageSize-2): word L + L bytes, packed at TF.FreePart inside one page; when
//     the rest of the page is too small a new page starts. After the text, when at least 3 bytes
//     remain, a word `rest = L+4-rest` (negative, stored as 2 bytes) marks the free tail.
//   - long text: chain of MPageSize (512) pages, the first starts with word LL, the last 4 bytes of each
//     page are the longint position of the next page. LL = MaxLStrLen+1 means "continued": a
//     further LL-prefixed segment follows (texts longer than 65000 bytes).
//   - consistency checks: Pos2 mod MPageSize, next pos in [MPageSize, MLen-MPageSize] → TFile.Err(888/889).
// * `X: array[0..MPageSize] of byte; ll: word absolute X` → one Uint8Array(MPageSize+1), ll = getWord(X, 0).
//   `LongintPtr(@X[MPageSize-4])^` → getLongint/setLongint at MPageSize-4.
// * RdWrCache(false, ..., 2, rest) writes the 2 low bytes of an integer (two's complement).
// * Locks: NewLMode(WrMode)/NewLMode(RdMode) unless TF.IsWork; CFile is switched to FD2/TFD02 around
//   the reads so lock and error messages refer to the right file.
// * GetTxt: missing file (HandleError 2) → empty text; longer than MaxLStrLen → truncated with
//   LastExitCode := 1. Z.P1 = 1-based offset, Z.P2 = max length (TXT(path, from, len)).
// * CopyTFString returns 0 for Pos2=0 and for an empty short text ({Mark***}).

import { getWord, setWord, setInteger, getLongint, setLongint, ref, type Ref } from './pasrt.ts';
import type { LongStrPtr } from './base.ts';
import {
  BaseVars, OpenH, CloseH, SeekH, ReadH, WriteH, FileSizeH, RdWrCache, GetStore, _isoldfile, RdOnly, MaxLStrLen,
} from './base.ts';
import type { FrmlPtr, TFilePtr, FileDPtr, LockMode } from './access.ts';
import { AccessVars, MPageSize, NullMode, RdMode, WrMode, NewLMode, OldLMode, TestCPathError } from './access.ts';
import { SetTxtPathVol, TestMountVol } from './oaccess.ts';
import { RunInt, RunFrmlVars } from './runfrml.ts';

// PAS: OLONGSTR.PAS GetTxtPrepare (private) – opens the text file of Z; h = $FF when it is missing
function GetTxtPrepare(Z: FrmlPtr, h: Ref<number>, off: Ref<number>, len: Ref<number>): void {
  const z = Z!;
  off.v = 0;
  if (z.P1 !== null) {
    off.v = RunInt(z.P1) - 1;
    if (off.v < 0) off.v = 0;
  }
  SetTxtPathVol(z.TxtPath, z.TxtCatIRec);
  TestMountVol(BaseVars.CPath[0] ?? '\0');
  h.v = OpenH(_isoldfile, RdOnly);
  if (BaseVars.HandleError !== 0) {
    if (BaseVars.HandleError === 2) {
      h.v = 0xff;
      len.v = 0;
      return;
    }
    TestCPathError();
  }
  len.v = FileSizeH(h.v);
  BaseVars.LastExitCode = 0;
  if (off.v >= len.v) off.v = len.v;
  len.v -= off.v;
  if (z.P2 !== null) {
    let l = RunInt(z.P2);
    if (l < 0) l = 0;
    if (l < len.v) len.v = l;
  }
  SeekH(h.v, off.v);
}
// PAS: OLONGSTR.PAS GetTxt – read (a part of) the host text file of Z.TxtPath/TxtCatIRec
export function GetTxt(Z: FrmlPtr): LongStrPtr {
  const h = ref(0), len = ref(0), off = ref(0);
  GetTxtPrepare(Z, h, off, len);
  if (len.v > MaxLStrLen) {
    len.v = MaxLStrLen;
    BaseVars.LastExitCode = 1;
  }
  const s = GetStore(len.v);
  AccessVars.LastTxtPos = off.v + len.v;
  if (len.v > 0) ReadH(h.v, len.v, s);
  CloseH(h.v);
  return s;
}
// TS-only: RdWrCache of a word / an integer variable (2 bytes)
function WrWord(TF: NonNullable<TFilePtr>, Pos: number, W: number, Signed: boolean): void {
  const b = new Uint8Array(2);
  if (Signed) setInteger(b, 0, W);
  else setWord(b, 0, W);
  RdWrCache(false, TF.Handle, TF.NotCached(), Pos, 2, b);
}
function RdWord(TF: NonNullable<TFilePtr>, Pos: number): number {
  const b = new Uint8Array(2);
  RdWrCache(true, TF.Handle, TF.NotCached(), Pos, 2, b);
  return getWord(b, 0);
}
// TS-only: the short-text placement shared by CopyTFFromGetTxt and CopyTFString (same Pascal code
// in both): X[0..l-1] is stored at TF.FreePart or on a new page; returns its position
function StoreShortTxt(TF: NonNullable<TFilePtr>, l: number, X: Uint8Array): number {
  let pos: number;
  let rest = MPageSize - (TF.FreePart % MPageSize);
  if (l + 2 <= rest) pos = TF.FreePart;
  else {
    pos = TF.NewPage(false);
    TF.FreePart = pos;
    rest = MPageSize;
  }
  if (l + 4 >= rest) TF.FreePart = TF.NewPage(false);
  else {
    TF.FreePart += l + 2;
    rest = l + 4 - rest;
    WrWord(TF, TF.FreePart, rest, true);
  }
  WrWord(TF, pos, l, false);
  RdWrCache(false, TF.Handle, TF.NotCached(), pos + 2, l, X);
  return pos;
}
// PAS: OLONGSTR.PAS CopyTFFromGetTxt – store the host file text of Z directly into TF; returns its position
export function CopyTFFromGetTxt(TF: TFilePtr, Z: FrmlPtr): number {
  const tf = TF!;
  const h = ref(0), len = ref(0), off = ref(0);
  let md: LockMode = NullMode;
  const X = new Uint8Array(MPageSize + 1); // ll: word absolute X
  let result: number;
  GetTxtPrepare(Z, h, off, len);
  AccessVars.LastTxtPos = off.v + len.v;
  if (len.v === 0) {
    CloseH(h.v);
    return 0;
  }
  if (!tf.IsWork) md = NewLMode(WrMode);
  if (len.v <= MPageSize - 2) {
    // short text
    const l = len.v & 0xffff;
    ReadH(h.v, l, X);
    result = StoreShortTxt(tf, l, X);
  } else {
    let pos = tf.NewPage(false);
    result = pos;
    let l = 0;
    let continued = false;
    // 1:
    for (let seg = true; seg; ) {
      if (len.v > MaxLStrLen) {
        l = MaxLStrLen;
        setWord(X, 0, l + 1);
        len.v = len.v - l;
        continued = true;
      } else {
        l = len.v & 0xffff;
        setWord(X, 0, l);
        len.v = 0;
        continued = false;
      }
      let i = 2;
      seg = false;
      // 3:
      for (;;) {
        if (l > MPageSize - i || continued) {
          let n = MPageSize - 4 - i;
          if (n > l) n = l;
          ReadH(h.v, n, X.subarray(i));
          i = 0;
          const nxtPos = tf.NewPage(false);
          setLongint(X, MPageSize - 4, nxtPos);
          RdWrCache(false, tf.Handle, tf.NotCached(), pos, MPageSize, X);
          pos = nxtPos;
          l -= n;
          if (continued && l === 0) {
            seg = true; // goto 1
            break;
          }
          continue; // goto 3
        }
        ReadH(h.v, l, X.subarray(i));
        RdWrCache(false, tf.Handle, tf.NotCached(), pos, MPageSize, X);
        break;
      }
    }
  }
  // 4:
  if (!tf.IsWork) OldLMode(md);
  CloseH(h.v);
  return result;
}
// PAS: OLONGSTR.PAS CopyTFString – copy the text at Pos2 of TF2 (file FD2) into TF; returns the new position
export function CopyTFString(TF: TFilePtr, FD2: FileDPtr, TF2: TFilePtr, Pos2: number): number {
  if (Pos2 === 0) return 0; // 0:
  const tf = TF!;
  const tf2 = TF2!;
  const av = AccessVars;
  const X = new Uint8Array(MPageSize + 1); // ll: word absolute X
  let md: LockMode = NullMode;
  let md2: LockMode = NullMode;
  let result = 0;
  const cf = av.CFile;
  if (!tf.IsWork) md = NewLMode(WrMode);
  av.CFile = FD2;
  if (!tf2.IsWork) md2 = NewLMode(RdMode);
  let l = RdWord(tf2, Pos2);
  body: {
    if (l <= MPageSize - 2) {
      // short text
      if (l === 0) return 0; // goto 0 {Mark***}: Pascal exits without restoring CFile and the locks
      RdWrCache(true, tf2.Handle, tf2.NotCached(), Pos2 + 2, l, X);
      av.CFile = cf;
      result = StoreShortTxt(tf, l, X);
      break body; // goto 4
    }
    if (Pos2 % MPageSize !== 0) {
      tf2.Err(889, false); // goto 2
      result = 0;
      break body;
    }
    RdWrCache(true, tf2.Handle, tf2.NotCached(), Pos2, MPageSize, X);
    let frst = true;
    let pos = 0;
    // 1:
    for (;;) {
      if (l > MaxLStrLen + 1) {
        tf2.Err(889, false); // 2:
        result = 0;
        break body;
      }
      const isLongTxt = l === MaxLStrLen + 1;
      if (isLongTxt) l--;
      l += 2;
      let again = false;
      // 3:
      for (;;) {
        av.CFile = cf;
        if (frst) {
          pos = tf.NewPage(false);
          result = pos;
          frst = false;
        }
        if (l > MPageSize || isLongTxt) {
          Pos2 = getLongint(X, MPageSize - 4);
          const nxtPos = tf.NewPage(false);
          setLongint(X, MPageSize - 4, nxtPos);
          RdWrCache(false, tf.Handle, tf.NotCached(), pos, MPageSize, X);
          pos = nxtPos;
          av.CFile = FD2;
          if (Pos2 < MPageSize || Pos2 + MPageSize > tf2.MLen || Pos2 % MPageSize !== 0) {
            tf2.Err(888, false);
            result = 0;
            break body;
          }
          RdWrCache(true, tf2.Handle, tf2.NotCached(), Pos2, MPageSize, X);
          if (l <= MPageSize) {
            l = getWord(X, 0);
            again = true; // goto 1
            break;
          }
          l -= MPageSize - 4;
          continue; // goto 3
        }
        RdWrCache(false, tf.Handle, tf.NotCached(), pos, MPageSize, X);
        break;
      }
      if (!again) break;
    }
  }
  // 4:
  av.CFile = FD2;
  if (!tf2.IsWork) OldLMode(md2);
  av.CFile = cf;
  if (!tf.IsWork) OldLMode(md);
  return result;
}
// PAS: OLONGSTR.PAS CopyTFStringToH – write the text TF02/TF02Pos to handle h
export function CopyTFStringToH(h: number): void {
  const av = AccessVars;
  let pos = RunFrmlVars.TF02Pos;
  if (pos === 0) return;
  const cf = av.CFile;
  av.CFile = RunFrmlVars.TFD02;
  const tf = RunFrmlVars.TF02!;
  const X = new Uint8Array(MPageSize + 1); // ll: word absolute X
  let md2: LockMode = NullMode;
  if (!tf.IsWork) md2 = NewLMode(RdMode);
  let l = RdWord(tf, pos);
  body: {
    if (l <= MPageSize - 2) {
      // short text
      RdWrCache(true, tf.Handle, tf.NotCached(), pos + 2, l, X);
      WriteH(h, l, X);
      break body;
    }
    if (pos % MPageSize !== 0) {
      tf.Err(889, false); // goto 2
      break body;
    }
    RdWrCache(true, tf.Handle, tf.NotCached(), pos, MPageSize, X);
    // 1:
    for (;;) {
      if (l > MaxLStrLen + 1) {
        tf.Err(889, false); // 2:
        break body;
      }
      const isLongTxt = l === MaxLStrLen + 1;
      if (isLongTxt) l--;
      let i = 2;
      let again = false;
      // 3:
      for (;;) {
        if (l > MPageSize - i || isLongTxt) {
          let n = MPageSize - 4 - i;
          if (n > l) n = l;
          WriteH(h, n, X.subarray(i));
          pos = getLongint(X, MPageSize - 4);
          if (pos < MPageSize || pos + MPageSize > tf.MLen || pos % MPageSize !== 0) {
            tf.Err(888, false);
            break body;
          }
          RdWrCache(true, tf.Handle, tf.NotCached(), pos, MPageSize, X);
          if (l <= MPageSize - i) {
            l = getWord(X, 0);
            again = true; // goto 1
            break;
          }
          l -= n;
          i = 0;
          continue; // goto 3
        }
        WriteH(h, l, X.subarray(i));
        break;
      }
      if (!again) break;
    }
  }
  // 4:
  if (!tf.IsWork) OldLMode(md2);
  av.CFile = cf;
}
