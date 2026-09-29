// Audit of DISKFPC.PAS / DISK.PAS TcFile.MyDiskFree and the host DOS.DiskFree behind it, driven by a
// flaky unit test: test/pas-base.test.ts asserted MyDiskFree(false, 0) > 0 with the Účto FAND.CFG
// (WithDiskFree = true), i.e. that the real disk has free space - it failed once in a full parallel
// run on a 91% full root filesystem.
//
// MyDiskFree itself matches both Pascal versions line by line (spec.WithDiskFree or Floppy ->
// DiskFree(Drive), else $7fffffff). DiskFree was hardened: drive 0 now follows the (possibly
// emulated) process.cwd() instead of '.', drives > 26 are invalid (-1, as DOS), host errors -> -1,
// a full disk -> 0, and big disks clamp to MaxLongInt (BP7's int 21h/36h never reports more; the
// FPC reference truncates an int64 into the longint result - intentionally not followed). The flaky
// assertion was made environment-independent; here statfs is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const statfs = vi.hoisted(() => ({ fn: null as null | ((p: string) => { bavail: number; bsize: number }), calls: [] as string[] }));
vi.mock('node:fs', async (orig) => {
  const m = await orig<typeof import('node:fs')>();
  const statfsSync = (p: string, ...rest: unknown[]): unknown => {
    statfs.calls.push(String(p));
    if (statfs.fn) return statfs.fn(String(p));
    return (m.statfsSync as (...a: unknown[]) => unknown)(p, ...rest);
  };
  return { ...m, default: { ...m, statfsSync }, statfsSync };
});

const { TcFile } = await import('../../../../src/engine/pas/disk.ts');
const { BaseVars } = await import('../../../../src/engine/pas/base.ts');

describe('DISK: TcFile.MyDiskFree / DOS.DiskFree', () => {
  let wdf = false;
  beforeEach(() => {
    wdf = BaseVars.Spec.WithDiskFree;
    statfs.fn = null;
    statfs.calls = [];
  });
  afterEach(() => {
    BaseVars.Spec.WithDiskFree = wdf;
    statfs.fn = null;
  });
  const free = (floppy: boolean, drive: number): number => new TcFile().Init(1).MyDiskFree(floppy, drive);

  it('without spec.WithDiskFree and not a floppy: $7fffffff, no disk query', () => {
    BaseVars.Spec.WithDiskFree = false;
    statfs.fn = () => { throw new Error('must not be called'); };
    expect(free(false, 0)).toBe(0x7fffffff);
    expect(free(false, 3)).toBe(0x7fffffff);
    expect(statfs.calls).toEqual([]);
  });
  it('a floppy queries the disk even without spec.WithDiskFree', () => {
    BaseVars.Spec.WithDiskFree = false;
    statfs.fn = () => ({ bavail: 10, bsize: 512 });
    expect(free(true, 0)).toBe(5120);
    expect(statfs.calls.length).toBe(1);
  });
  it('WithDiskFree: bytes = bavail * bsize, a full disk is 0, big disks clamp to MaxLongInt', () => {
    BaseVars.Spec.WithDiskFree = true;
    statfs.fn = () => ({ bavail: 1000, bsize: 4096 });
    expect(free(false, 0)).toBe(4096000);
    statfs.fn = () => ({ bavail: 0, bsize: 4096 });
    expect(free(false, 0)).toBe(0);
    // 4.8 GB free: FPC would truncate the int64 to a longint; BP7 (DOS) caps at MaxLongInt
    statfs.fn = () => ({ bavail: 1_200_000, bsize: 4096 });
    expect(free(false, 0)).toBe(0x7fffffff);
    // 3 GB free: FPC's longint truncation would be negative
    statfs.fn = () => ({ bavail: 3 * 262144, bsize: 4096 });
    expect(free(false, 0)).toBe(0x7fffffff);
  });
  it('drive 0 is the current directory (process.cwd, which follows the emulated cwd)', () => {
    BaseVars.Spec.WithDiskFree = true;
    statfs.fn = () => ({ bavail: 1, bsize: 1 });
    const cwd = process.cwd;
    process.cwd = () => '/some/virtual/dir';
    try {
      expect(free(false, 0)).toBe(1);
    } finally {
      process.cwd = cwd;
    }
    expect(statfs.calls).toEqual(['/some/virtual/dir']);
  });
  it('host errors and invalid drives give -1', () => {
    BaseVars.Spec.WithDiskFree = true;
    statfs.fn = () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); };
    expect(free(false, 0)).toBe(-1);
    expect(free(false, 3)).toBe(-1);
    statfs.fn = () => ({ bavail: 1, bsize: 1 });
    statfs.calls = [];
    // Drive is a byte computed as ord(Path[1]) - ord('@'): lower-case or non-letter -> > 26
    expect(free(false, 0x63 - 0x40)).toBe(-1);
    expect(free(false, 255)).toBe(-1);
    expect(statfs.calls).toEqual([]);
  });
  it('a letter drive is mapped by HANDLE.UnixPath (FAND_DRIVE_x)', () => {
    BaseVars.Spec.WithDiskFree = true;
    statfs.fn = () => ({ bavail: 2, bsize: 512 });
    const old = process.env.FAND_DRIVE_Q;
    process.env.FAND_DRIVE_Q = '/';
    try {
      expect(free(false, 17)).toBe(1024);
    } finally {
      if (old === undefined) delete process.env.FAND_DRIVE_Q;
      else process.env.FAND_DRIVE_Q = old;
    }
    expect(statfs.calls).toEqual(['/']);
  });
  it('the real host disk: an integer in -1..MaxLongInt', () => {
    BaseVars.Spec.WithDiskFree = true;
    const n = free(false, 0);
    expect(Number.isInteger(n) && n >= -1 && n <= 0x7fffffff).toBe(true);
  });
});
