// Audit regression: HANDLE.PAS WriteH of 0 bytes (bring-up scenario C, a new company's code lists).
// BP7 WriteH is int $21/$40, and with CX=0 DOS truncates (or extends) the file at the current
// position. EXPIMP ImportFD.Cpy (`WriteH(h,0,Buf^){trunc}`), RestoreHFD, EDEVENT/EDEVPROC
// `{truncH}`, OLDTXX, RUNPROC PutTxt and HANDLE TruncH itself rely on it. The FPC branch
// (FileWrite of 0 bytes) is a no-op: the reference FAND leaves CISDRUH.001/CISPOH.001 at the 4 kB
// cache page they were created with. BP7 wins (docs/PORTING.md), so our WriteH truncates.
// ImportFD end to end (garbage after the copied data is cut off): test/pas-expimp.test.ts.

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { FromUnicode, StrToBytes } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, OpenH, WriteH, SeekH, PosH, FileSizeH, TruncH, CloseH, IsUpdHandle, RdWrCache,
  FlushHandles, _isnewfile, _isoverwritefile, Exclusive,
} from '../src/engine/pas/base.ts';

const TMP = resolve('work/tmp-audit-handle');

function create(name: string, mode = _isnewfile): number {
  BaseVars.CPath = FromUnicode(join(TMP, name));
  BaseVars.CVol = '';
  const h = OpenH(mode, Exclusive);
  expect(BaseVars.HandleError).toBe(0);
  return h;
}

describe('HANDLE WriteH: 0 bytes is the DOS truncate at the file position (BP7)', () => {
  beforeAll(() => {
    fs.rmSync(TMP, { recursive: true, force: true });
    fs.mkdirSync(TMP, { recursive: true });
  });

  it('ImportFD.Cpy shape: a stale 4 kB page, the template written from 0, then WriteH(h,0)', () => {
    const h = create('CISPOH.001');
    // the file as the cache left it after creation: one page with unrelated bytes
    const page = new Uint8Array(4096).fill(0x55);
    WriteH(h, page.length, page);
    expect(FileSizeH(h)).toBe(4096);
    // Cpy: SeekH(h,0); the 714 template bytes; WriteH(h,0,Buf^){trunc}
    const tpl = new Uint8Array(714).map((_, i) => i & 0xff);
    SeekH(h, 0);
    WriteH(h, 500, tpl);
    WriteH(h, 214, tpl.subarray(500));
    expect(PosH(h)).toBe(714);
    WriteH(h, 0, tpl);
    expect(BaseVars.HandleError).toBe(0);
    expect(PosH(h)).toBe(714);
    expect(FileSizeH(h)).toBe(714);
    CloseH(h);
    expect(new Uint8Array(fs.readFileSync(join(TMP, 'CISPOH.001')))).toEqual(tpl);
  });

  it('truncates in the middle of a file and extends past its end (DOS CX=0)', () => {
    const h = create('mid.dat');
    WriteH(h, 10, StrToBytes('0123456789'));
    SeekH(h, 4);
    WriteH(h, 0, new Uint8Array(0));
    expect(FileSizeH(h)).toBe(4);
    SeekH(h, 9);
    WriteH(h, 0, new Uint8Array(0));
    expect(FileSizeH(h)).toBe(9);
    CloseH(h);
    expect(fs.readFileSync(join(TMP, 'mid.dat'), 'latin1')).toBe('0123\0\0\0\0\0');
  });

  it('marks the handle updated and resets HandleError like any write', () => {
    const h = create('upd.dat');
    WriteH(h, 3, StrToBytes('abc'));
    FlushHandles();
    expect(IsUpdHandle(h)).toBe(false);
    BaseVars.HandleError = 99;
    SeekH(h, 1);
    WriteH(h, 0, new Uint8Array(0));
    expect(BaseVars.HandleError).toBe(0);
    expect(IsUpdHandle(h)).toBe(true);
    expect(FileSizeH(h)).toBe(1);
    CloseH(h);
  });

  it('a RdWrCache NotCached write of 0 bytes truncates too (it is SeekH + WriteH)', () => {
    const h = create('rdwr.dat');
    WriteH(h, 8, StrToBytes('ABCDEFGH'));
    RdWrCache(false, h, true, 5, 0, new Uint8Array(0));
    expect(FileSizeH(h)).toBe(5);
    CloseH(h);
  });

  it('TruncH is SeekH + WriteH(0): shrinks only, leaves the position at N, HandleError 0', () => {
    const h = create('trunc.dat', _isoverwritefile);
    WriteH(h, 6, StrToBytes('abcdef'));
    TruncH(h, 10); // larger: nothing happens, position kept
    expect(FileSizeH(h)).toBe(6);
    expect(PosH(h)).toBe(6);
    BaseVars.HandleError = 7;
    TruncH(h, 2);
    expect(BaseVars.HandleError).toBe(0);
    expect(FileSizeH(h)).toBe(2);
    expect(PosH(h)).toBe(2);
    CloseH(h);
    expect(fs.readFileSync(join(TMP, 'trunc.dat'), 'latin1')).toBe('ab');
  });
});
