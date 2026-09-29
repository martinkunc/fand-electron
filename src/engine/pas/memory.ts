// PAS: MEMORY.PAS (include of BASE) – heap, disk cache, exits, OS shell.
// Heap: JS GC. GetStore* allocate fresh zeroed buffers, Mark*/Release* are no-ops,
// the "available" functions return large constants. Records are allocated with `new`.
// Exits: GoExit throws GoExitSignal; see docs/PORTING.md for the NewExit pattern.
// Re-exported by base.ts; state lives in BaseVars.
//
// Porting notes:
// * asm/DOS (BP7): segment arithmetic (Normalize/AbsAdr), heap/stack-2 arenas, XMS driver calls
//   (MoveToXMS/MoveFromXMS/CloseXMS, XMS cache pages), overlay stack fix-up in NewExit/GoExit
//   (setjmp in FPC), OSshell via DOS Exec with memory swap-out and screen/font restore.
// * Disk cache (FPC): FormatCache allocates 64 CachePages of 4 kB (CachePageShft 12) in an MRU
//   chain from BaseVars.CacheRoot; HPage = Page | Handle shl 24. Cache() moves the hit to the front,
//   on a miss reuses the LAST page (writes it first if Upd and the handle is still open) and reads.
//   SaveCache(ErrH) writes all dirty pages (0 = all handles); ClearCacheH drops a handle's pages;
//   SubstHandle renames them. Write errors: WrLLF10Msg(700+err) / RunError(700+err) on read.
//   Callers depend on the cache for consistency (RdWrCache), so keep it even though fs is fast.
// * OSshell (FPC): trims the command, maps '\' to '/', SaveCache(0), CallCloseFandFiles(false),
//   FANDDOS.FandDosCmd first (built-ins, .BAT), else fpSystem; LastExitCode = rc shr 8;
//   then ResetCachePages + CallOpenFandFiles(false). Always returns true. fpSystem is
//   child_process.spawnSync with a shell (stdio inherited, cwd = the engine's current directory),
//   the command converted from CP852. TS: before FandDosCmd an installed EXEC helper hook
//   (SetExecHelperHook) may run the program as one of Účto's host helpers.
// * Private: Arena1/Arena2 bump allocators (InitMemoryArenas: no-op with GC), FandShellRun,
//   WrCPage/WriteCachePage/ReadCachePage/NewCachePage/ResetCachePages/FreeCachePage, and the
//   FPC no-ops CloseXMS (exported: BASE.MyExit), MoveToXMS/MoveFromXMS/SetMyHeapEnd/ExpandCache*.

import { spawnSync } from 'node:child_process';
import { GoExitSignal, HaltSignal, ToUnicode, ref, type Ref, type Pointer, type PathStr } from './pasrt.ts';
import type { ExitRecord, PProcedure, StoreSize, StringPtr, String127 } from './base.ts';
import { BaseVars, CachePage, type CachePagePtr, SeekH, WriteH, ReadH, IsHandle, SetMsgPar } from './base.ts';
import { WrLLF10Msg, RunError } from './obaseww.ts';
import { SetCPathForH } from './oaccess.ts';
import { FandDosCmd, FandDosVars } from './fanddos.ts';

/** What StoreAvail/MemAvail report: plenty. */
export const BigStoreAvail = 0x7fffffff;

// PAS: MEMORY.PAS HeapErrFun
export function HeapErrFun(Size: number): number {
  return 0;
}
// PAS: MEMORY.PAS Normalize (no segments on the host)
export function Normalize(L: number): Pointer {
  return L;
}
// PAS: MEMORY.PAS AbsAdr (no segments on the host)
export function AbsAdr(P: Pointer): number {
  return 0;
}
// PAS: MEMORY.PAS AlignParagraph (no-op)
export function AlignParagraph(): void {}
// PAS: MEMORY.PAS GetStore – a raw zeroed block (records use `new`)
export function GetStore(Size: StoreSize): Uint8Array {
  return new Uint8Array(Size);
}
// PAS: MEMORY.PAS GetZStore
export function GetZStore(Size: StoreSize): Uint8Array {
  return new Uint8Array(Size);
}
// PAS: MEMORY.PAS MarkStore (no-op mark)
export function MarkStore(p: Ref<Pointer>): void {
  p.v = null;
}
// PAS: MEMORY.PAS ReleaseStore (no-op)
export function ReleaseStore(p: Pointer): void {}
// PAS: MEMORY.PAS ReleaseAfterLongStr (no-op)
export function ReleaseAfterLongStr(p: Pointer): void {}
// PAS: MEMORY.PAS StoreAvail
export function StoreAvail(): number {
  return BigStoreAvail;
}
// PAS: MEMORY.PAS GetStore2
export function GetStore2(Size: StoreSize): Uint8Array {
  return new Uint8Array(Size);
}
// PAS: MEMORY.PAS GetZStore2
export function GetZStore2(Size: StoreSize): Uint8Array {
  return new Uint8Array(Size);
}
// PAS: MEMORY.PAS StoreStr – a StringPtr is the string itself
export function StoreStr(S: string): StringPtr {
  return S;
}
// PAS: MEMORY.PAS MarkStore2 (no-op mark)
export function MarkStore2(p: Ref<Pointer>): void {
  p.v = null;
}
// PAS: MEMORY.PAS ReleaseStore2 (no-op)
export function ReleaseStore2(p: Pointer): void {}
// PAS: MEMORY.PAS MarkBoth (no-op marks)
export function MarkBoth(p: Ref<Pointer>, p2: Ref<Pointer>): void {
  p.v = null;
  p2.v = null;
}
// PAS: MEMORY.PAS ReleaseBoth (no-op)
export function ReleaseBoth(p: Pointer, p2: Pointer): void {}
// PAS: MEMORY.PAS AlignLongStr (no-op)
export function AlignLongStr(): void {}
// PAS: MEMORY.PAS AlignSegment (no-op)
export function AlignSegment(Skip: number): void {}
// PAS: MEMORY.PAS HeapTop
export function HeapTop(): Pointer {
  return null;
}

// PAS: MEMORY.PAS NewExit – save ExitBuf into Buf and arm it with the current state
export function NewExit(POvr: PProcedure, Buf: ExitRecord): void {
  const e = BaseVars.ExitBuf;
  Buf.OvrEx = e.OvrEx;
  Buf.mBP = e.mBP;
  Buf.ExP = e.ExP;
  Buf.BrkP = e.BrkP;
  Buf.Armed = e.Armed;
  e.OvrEx = POvr;
  e.ExP = BaseVars.ExitP;
  e.BrkP = BaseVars.BreakP;
  e.mBP = BaseVars.MyBP;
  e.Armed = true;
  BaseVars.GoExitFired = false;
}
// PAS: MEMORY.PAS GoExit – restore the NewExit state and unwind to its catch
export function GoExit(): never {
  const e = BaseVars.ExitBuf;
  BaseVars.ExitP = e.ExP;
  BaseVars.BreakP = e.BrkP;
  BaseVars.MyBP = e.mBP;
  BaseVars.GoExitFired = true;
  if (!e.Armed) throw new HaltSignal(2);
  throw new GoExitSignal();
}
// PAS: MEMORY.PAS RestoreExit
export function RestoreExit(Buf: ExitRecord): void {
  const e = BaseVars.ExitBuf;
  e.OvrEx = Buf.OvrEx;
  e.mBP = Buf.mBP;
  e.ExP = Buf.ExP;
  e.BrkP = Buf.BrkP;
  e.Armed = Buf.Armed;
}
// PAS: MEMORY.PAS KeepInMemory (FPC setjmp helper: no-op)
export function KeepInMemory(P: unknown[]): void {}
// PAS: MEMORY.PAS FandShellRun (FPC, private) – exit status of `sh -c cmd`
function FandShellRun(cmd: string): number {
  return (HostSystem(cmd) >> 8) & 255;
}
// TS: FPC fpSystem – runs cmd by the host shell, returns the wait status (exit code shl 8), -1 on failure.
// cwd: the engine's current directory (in a worker it is virtual, see fand.ts InstallVirtualCwd).
function HostSystem(cmd: string): number {
  const r = spawnSync(ToUnicode(cmd), { shell: true, stdio: 'inherit', cwd: process.cwd() });
  if (r.error) return -1;
  if (r.status === null) return 127 << 8; // killed by a signal
  return (r.status & 255) << 8;
}
/**
 * TS-only: EXEC of a host helper program. Účto EXECs Windows helpers (FAND2PDF.EXE as the print
 * manager, UTISK04, UCTOEXP ...); the runtime (src/engine/runtime/fand.ts) installs a hook that
 * runs them by the platform policy of src/engine/exechelper.ts. The hook gets OSshell's Path and
 * CmdLine (CP852 byte strings) and returns the exit code, or null when the program is not a
 * helper (then OSshell goes on with the FANDDOS built-ins and the host shell, as FPC does).
 */
export type ExecHelperHook = (Path: PathStr, CmdLine: string) => number | null;
let execHelperHook: ExecHelperHook | null = null;
/** TS-only: installs (or with null removes) the EXEC helper hook. */
export function SetExecHelperHook(h: ExecHelperHook | null): void {
  execHelperHook = h;
}

// PAS: MEMORY.PAS OSshell (FPC) – always true; the exit code goes to LastExitCode
export function OSshell(Path: PathStr, CmdLine: String127, NoCancel: boolean, FreeMm: boolean, LdFont: boolean, TextMd: boolean): boolean {
  let shellCmd = Path === '' ? CmdLine : Path + ' ' + CmdLine;
  while (shellCmd.length > 0 && shellCmd[0] === ' ') shellCmd = shellCmd.slice(1);
  if (shellCmd === '') {
    BaseVars.LastExitCode = 0;
    return true;
  }
  if (process.platform !== 'win32') shellCmd = shellCmd.replace(/\\/g, '/');
  const dosLine = shellCmd;
  SaveCache(0);
  BaseVars.CallCloseFandFiles?.(false);
  FandDosVars.FandDosShell = FandShellRun;
  const dosRc = ref(0);
  let rc: number;
  const hrc = execHelperHook !== null ? execHelperHook(Path, CmdLine) : null; // TS: helper programs
  if (hrc !== null) rc = (hrc & 255) << 8;
  else if (FandDosCmd(dosLine, dosRc)) rc = dosRc.v << 8;
  else rc = HostSystem(shellCmd);
  if (rc < 0) BaseVars.LastExitCode = 127;
  else BaseVars.LastExitCode = (rc >> 8) & 255;
  ResetCachePages();
  BaseVars.CallOpenFandFiles?.(false);
  return true;
}

// ---------------------------------------------------------------- disk cache (FPC)

// PAS: MEMORY.PAS CloseXMS (FPC: no-op)
export function CloseXMS(): void {}
// PAS: MEMORY.PAS MoveToXMS (FPC: no-op)
function MoveToXMS(NPage: number, Src: Uint8Array): void {}
// PAS: MEMORY.PAS MoveFromXMS (FPC: no-op)
function MoveFromXMS(NPage: number, Dest: Uint8Array): void {}
// PAS: MEMORY.PAS SetMyHeapEnd (FPC: no-op)
function SetMyHeapEnd(): void {}
// PAS: MEMORY.PAS CacheExist
export function CacheExist(): boolean {
  return BaseVars.NCachePages > 0;
}
// TS: Pascal `CachePagePtr(@CacheRoot)` – the root pointer viewed as a page whose Chain is CacheRoot
const RootPage = {
  get Chain(): CachePagePtr {
    return BaseVars.CacheRoot;
  },
  set Chain(z: CachePagePtr) {
    BaseVars.CacheRoot = z;
  },
};
type ChainedPage = { Chain: CachePagePtr };
// PAS: MEMORY.PAS NewCachePage (private)
function NewCachePage(ZLast: Ref<ChainedPage>, Z: CachePage): void {
  Z.Handle = 0xff;
  Z.Upd = false;
  Z.Chain = null;
  BaseVars.NCachePages++;
  ZLast.v.Chain = Z;
  ZLast.v = Z;
}
// PAS: MEMORY.PAS FormatCache – 64 pages of 4 kB
export function FormatCache(): void {
  BaseVars.NCachePages = 0;
  const ZLast = ref<ChainedPage>(RootPage);
  BaseVars.Stack2Ptr = null;
  BaseVars.CacheEnd = null;
  for (let i = 1; i <= 64; i++) NewCachePage(ZLast, new CachePage());
}
// PAS: MEMORY.PAS ResetCachePages (private)
function ResetCachePages(): void {
  let Z = BaseVars.CacheRoot;
  while (Z !== null) {
    Z.Handle = 0xff;
    Z.Upd = false;
    Z = Z.Chain;
  }
}
// PAS: MEMORY.PAS WrCPage (private)
function WrCPage(Handle: number, N: number, Buf: Uint8Array, ErrH: number): boolean {
  SeekH(Handle, N * 2 ** BaseVars.CachePageShft);
  WriteH(Handle, BaseVars.CachePageSize, Buf);
  if (BaseVars.HandleError !== 0 && ErrH !== Handle) {
    const err = BaseVars.HandleError;
    SaveCache(Handle);
    SetCPathForH(Handle);
    SetMsgPar(BaseVars.CPath);
    WrLLF10Msg(700 + err);
    return false;
  }
  return true;
}
// PAS: MEMORY.PAS WriteCachePage (private)
function WriteCachePage(Z: CachePage, ErrH: number): boolean {
  return WrCPage(Z.Handle, Z.HPage & 0xffffff, Z.Arr, ErrH);
}
// PAS: MEMORY.PAS ReadCachePage (private) – a short read at EOF leaves the rest of Arr as it was
function ReadCachePage(Z: CachePage): void {
  const h = Z.Handle;
  SeekH(h, (Z.HPage & 0xffffff) * 2 ** BaseVars.CachePageShft);
  ReadH(h, BaseVars.CachePageSize, Z.Arr);
  if (BaseVars.HandleError !== 0) {
    const err = BaseVars.HandleError;
    SetCPathForH(h);
    SetMsgPar(BaseVars.CPath);
    RunError(700 + err);
  }
}
// PAS: MEMORY.PAS Cache – the page of Handle at Page (4 kB pages), moved to the front (MRU)
export function Cache(Handle: number, Page: number): CachePagePtr {
  const HPage = ((Page & 0xffffff) | ((Handle & 0xff) << 24)) >>> 0;
  let Found = false;
  let Y: ChainedPage = RootPage;
  let Z = BaseVars.CacheRoot;
  while (Z !== null) {
    if (Z.HPage === HPage) {
      Found = true;
      break;
    }
    if (Z.Chain === null) break;
    Y = Z;
    Z = Z.Chain;
  }
  if (Z === null) return RunError(624); // FPC: nil^ (no cache formatted)
  if (Z !== BaseVars.CacheRoot) {
    Y.Chain = Z.Chain;
    Z.Chain = BaseVars.CacheRoot;
    BaseVars.CacheRoot = Z;
  }
  if (!Found) {
    if (Z.Upd && Z.Handle !== 0xff) {
      Z.Upd = false;
      if (IsHandle(Z.Handle)) if (!WriteCachePage(Z, 0)) GoExit();
    }
    Z.HPage = HPage;
    ReadCachePage(Z);
  }
  return Z;
}
// PAS: MEMORY.PAS LockCache (no-op)
export function LockCache(): void {}
// PAS: MEMORY.PAS UnLockCache (no-op)
export function UnLockCache(): void {}
// PAS: MEMORY.PAS SaveCache – writes the dirty pages of ErrH (0 = all handles)
export function SaveCache(ErrH: number): boolean {
  let Z = BaseVars.CacheRoot;
  let result = true;
  while (Z !== null) {
    if (Z.Upd && Z.Handle !== 0xff && (ErrH === 0 || Z.Handle === ErrH) && IsHandle(Z.Handle) && !WriteCachePage(Z, ErrH)) {
      result = false;
    }
    Z.Upd = false;
    Z = Z.Chain;
  }
  return result;
}
// PAS: MEMORY.PAS ClearCacheH
export function ClearCacheH(h: number): void {
  if (h === 0xff) return;
  let Z = BaseVars.CacheRoot;
  while (Z !== null) {
    if (Z.Handle === h) {
      Z.Upd = false;
      Z.Handle = 0xff;
    }
    Z = Z.Chain;
  }
}
// PAS: MEMORY.PAS SubstHandle
export function SubstHandle(h1: number, h2: number): void {
  let Z = BaseVars.CacheRoot;
  while (Z !== null) {
    if (Z.Handle === h1) Z.Handle = h2;
    Z = Z.Chain;
  }
}
// PAS: MEMORY.PAS FreeCachePage (private)
function FreeCachePage(Z: CachePage): void {
  if (BaseVars.NCachePages <= 1) RunError(624);
  BaseVars.NCachePages--;
  let Z1: ChainedPage = RootPage;
  let Z2 = BaseVars.CacheRoot;
  while (Z2 !== null) {
    if (Z2 === Z) {
      Z1.Chain = Z2.Chain;
      if (Z2.Upd) {
        if (!WriteCachePage(Z2, 0)) GoExit();
      }
      return;
    }
    Z1 = Z2;
    Z2 = Z2.Chain;
  }
}
// PAS: MEMORY.PAS ExpandCacheUp (FPC: no-op)
function ExpandCacheUp(): void {}
// PAS: MEMORY.PAS ExpandCacheDown (FPC: no-op)
function ExpandCacheDown(): void {}
// PAS: MEMORY.PAS InitMemoryArenas (FPC: bump allocators; the JS heap needs none)
export function InitMemoryArenas(): void {}
