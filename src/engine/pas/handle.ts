// PAS: HANDLE.PAS (include of BASE) – virtual file handles over node:fs (sync), file names.
// Handles are small numbers (Pascal word, $FF = none) mapped to host fds here.
// Engine paths are byte strings; UnixPath maps DOS-style names ('\', 'C:', any case) to host paths.
// Record locking: single-user in-process semantics (TryLockH always succeeds) – TODO network mode.
// Re-exported by base.ts; state lives in BaseVars.
//
// Porting notes:
// * asm/DOS (BP7): every routine is int $21 (MsDos/asm): open/create $3C/$3D/$5B, read/write,
//   seek $42 (MoveH), close, dup $45, lock $5C, attributes $43, delete $41, rename $56, date $57,
//   and ExtendHandles (moves the PSP handle table into NewHT for 255 handles). FPC uses SysUtils;
//   the {$ifdef FPC} branch (with the UNIX CasePath patch of scripts/ref-fand-arm64.patch) is ported.
// * Private state: Handles/UpdHandles/FlshHandles (set of 0..254 -> Set<number>), CardHandles
//   (RunError(884) when `files`=250 are open), OsH[] (FAND handle -> host fd; NewH picks the first
//   free index from 5), OldNumH/OldHTPtr (BP7 only). node:fs has no lseek: OsPos[] keeps the file
//   position of each handle (FileSeek/FileRead/FileWrite semantics). IsHandle is exported for
//   MEMORY.Cache/SaveCache (a separate module here). ReadH/WriteH throw a RangeError when the
//   buffer is shorter than `bytes` (a porting bug in the caller, Pascal would overwrite memory).
// * WriteH of 0 bytes is the DOS truncate/extend at the file position (BP7 wins over the FPC
//   FileWrite no-op: data files must end where the BP7 FAND ends them); TruncH is SeekH + WriteH(0).
// * DosErrH maps errno to DOS codes: ENOENT 2 (-> 3 when the directory is missing), ENOTDIR 3,
//   EPERM/EBADF/EACCES/EISDIR/EROFS 5, EEXIST 80, ENFILE/EMFILE 4, EAGAIN/EDEADLK/ENOLCK 33 ($21),
//   ENOSPC/EDQUOT/... 39 ($27), else 1. Messages are 700+HandleError. Node gives e.code strings.
// * OpenH: _isnewfile fails with 80 if it exists; _isoldnewfile opens or creates; non-old modes
//   mark the handle updated. Network volumes (IsNetCVol: CVol '#','##','#R') retry on 5/$21 with
//   PushWrLLMsg(825) + KbdTimer(spec.NetDelay). FlushH is a no-op in FPC (no fsync). FPC share
//   modes (flock) are not emulated (single user).
// * UnixPath: '\' -> '/'; 'X:' or a leading '\' maps to FAND_DRIVE_X or the parent of the cwd,
//   then CasePath resolves each missing component case-insensitively (catalogue '(STAN)' vs disk).
//   On Windows UnixPath returns S unchanged (FPC MSWINDOWS). Name comparison: CP852 upper case
//   (a superset of FPC SameText, which folds ASCII only).
// * GetDateTimeH packs the host mtime (local time, FANDDOS.FandFileTime) as DOS date/time, < 1980
//   clamps to 1.1.1980. MyFExpand: env dir, cwd, exe dir (TS: BaseVars.FandDir when set), PATH;
//   tries Nm, UPPER, lower case.
// * Set/GetFileAttr: FPC FileSetAttr is not implemented on UNIX (always error); the DOS read-only
//   bit ($01) is mapped to the owner write permission instead (BP7 behaviour, OACCESS.OpenF1 uses it).
// * RdWrCache: NotCached -> direct SeekH+ReadH/WriteH (RunError(700+err) with SetCPathForH),
//   else through MEMORY.Cache in 4 kB pages; Pos < 0 is RunError(713), handle $FF RunError(706).

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import {
  ShortStr, ToUnicode, FromUnicode, UpcaseStr, UPCASE_852, GetEnv, ParamStr, ref, UpCase,
  type Ref, type PathStr,
} from './pasrt.ts';
import type { FileOpenMode, FileUseMode, String12, String8 } from './base.ts';
import {
  BaseVars, _isnewfile, _isoldfile, _isoverwritefile, _isoldnewfile, RdOnly, RdShared, Shared, Exclusive,
  SEquUpcase, Set2MsgPar, SetMsgPar, AddBackSlash, Cache, ClearCacheH,
} from './base.ts';
import { LockBeep, KbdTimer } from './drivers.ts';
import { PushWrLLMsg, PopW, RunError } from './obaseww.ts';
import { SetCPathForH } from './oaccess.ts';
import { FandFileTime } from './fanddos.ts';

// PAS: HANDLE.PAS files – files in CONFIG.SYS -3
const files = 250;
let CardHandles = 0;
const Handles = new Set<number>();
const UpdHandles = new Set<number>();
const FlshHandles = new Set<number>();
/** PAS: HANDLE.PAS OsH – FAND handle -> host fd */
const OsH: number[] = [];
/** TS: the file position of each handle (Pascal: the OS file pointer) */
const OsPos: number[] = [];

// PAS: HANDLE.PAS IsHandle (implementation; exported for MEMORY.Cache)
export function IsHandle(H: number): boolean {
  return H !== 0xff && Handles.has(H);
}
// PAS: HANDLE.PAS IsUpdHandle
export function IsUpdHandle(H: number): boolean {
  return H !== 0xff && UpdHandles.has(H);
}
// PAS: HANDLE.PAS IsFlshHandle
function IsFlshHandle(H: number): boolean {
  return H !== 0xff && FlshHandles.has(H);
}
// PAS: HANDLE.PAS SetHandle
function SetHandle(H: number): void {
  if (H === 0xff) return;
  Handles.add(H);
  CardHandles++;
}
// PAS: HANDLE.PAS SetUpdHandle
export function SetUpdHandle(H: number): void {
  if (H === 0xff) return;
  UpdHandles.add(H);
}
// PAS: HANDLE.PAS SetFlshHandle
function SetFlshHandle(H: number): void {
  if (H === 0xff) return;
  FlshHandles.add(H);
}
// PAS: HANDLE.PAS ResetHandle
function ResetHandle(H: number): void {
  if (H === 0xff) return;
  Handles.delete(H);
  CardHandles--;
}
// PAS: HANDLE.PAS ResetUpdHandle
export function ResetUpdHandle(H: number): void {
  if (IsUpdHandle(H)) {
    UpdHandles.delete(H);
    SetFlshHandle(H);
  }
}
// PAS: HANDLE.PAS ResetFlshHandle
function ResetFlshHandle(H: number): void {
  if (H === 0xff) return;
  FlshHandles.delete(H);
}
// PAS: HANDLE.PAS ClearHandles
function ClearHandles(): void {
  Handles.clear();
  CardHandles = 0;
}
// PAS: HANDLE.PAS ClearUpdHandles
function ClearUpdHandles(): void {
  UpdHandles.clear();
}
// PAS: HANDLE.PAS ClearFlshHandles
function ClearFlshHandles(): void {
  FlshHandles.clear();
}
// PAS: HANDLE.PAS IsNetCVol
export function IsNetCVol(): boolean {
  const CVol = BaseVars.CVol;
  return CVol === '#' || CVol === '##' || SEquUpcase(CVol, '#R');
}
// PAS: HANDLE.PAS ExtendHandles
export function ExtendHandles(): void {
  ClearHandles();
  ClearUpdHandles();
  ClearFlshHandles();
}
// PAS: HANDLE.PAS UnExtendHandles
export function UnExtendHandles(): void {
  for (let h = 0; h <= files; h++) if (IsHandle(h)) CloseH(h);
}

// PAS: HANDLE.PAS DosErrH – host error (a Node error or an errno code string) -> DOS error code
function DosErrH(e: unknown): number {
  const code = typeof e === 'string' ? e : ((e as { code?: string } | null)?.code ?? '');
  switch (code) {
    case 'ENOENT':
      return 2;
    case 'ENOTDIR':
      return 3;
    case 'EPERM':
    case 'EBADF':
    case 'EACCES':
    case 'EISDIR':
    case 'EROFS':
      return 5;
    case 'EEXIST':
      return 80;
    case 'ENFILE':
    case 'EMFILE':
      return 4;
    case 'EAGAIN':
    case 'EWOULDBLOCK':
    case 'EDEADLK':
    case 'ENOLCK':
    case 'EBADFD':
      return 0x21;
    case 'ENOSPC':
    case 'EDQUOT':
      return 0x27;
    default:
      return 1;
  }
}
// PAS: HANDLE.PAS HErr
function HErr(e: unknown): void {
  BaseVars.HandleError = DosErrH(e);
}
// PAS: HANDLE.PAS NewH
function NewH(h: number): number {
  for (let i = 5; i <= files; i++) {
    if (!Handles.has(i)) {
      OsH[i] = h;
      OsPos[i] = 0;
      return i;
    }
  }
  return RunError(884);
}
// TS: the host fd of a FAND handle (-1 when it was never opened)
function Fd(handle: number): number {
  return OsH[handle] ?? -1;
}
// PAS: HANDLE.PAS MoveH – FileSeek(OsH[handle], dist, method); -1 on error
function MoveH(dist: number, method: number, handle: number): number {
  BaseVars.HandleError = 0;
  const fd = Fd(handle);
  try {
    if (fd < 0) throw Object.assign(new Error('EBADF'), { code: 'EBADF' });
    let base = 0;
    if (method === 1) base = OsPos[handle] ?? 0;
    else if (method === 2) base = fs.fstatSync(fd).size;
    const r = base + dist;
    if (r < 0) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' });
    OsPos[handle] = r;
    return r;
  } catch (e) {
    HErr(e);
    return -1;
  }
}
// PAS: HANDLE.PAS PosH
export function PosH(handle: number): number {
  return MoveH(0, 1, handle);
}
// PAS: HANDLE.PAS SeekH
export function SeekH(handle: number, pos: number): void {
  if (handle === 0xff) RunError(705);
  MoveH(pos, 0, handle);
}
// PAS: HANDLE.PAS FileSizeH
export function FileSizeH(handle: number): number {
  const pos = PosH(handle);
  const r = MoveH(0, 2, handle);
  SeekH(handle, pos);
  return r;
}
// PAS: HANDLE.PAS TryLockH (always true in the FPC port)
export function TryLockH(Handle: number, Pos: number, Len: number): boolean {
  return true; // TODO network locking
}
// PAS: HANDLE.PAS UnLockH (no-op in the FPC port)
export function UnLockH(Handle: number, Pos: number, Len: number): void {}

// TS: FPC FileExists / DirectoryExists on a host path (byte string)
function HostFileExists(p: string): boolean {
  try {
    return !fs.statSync(ToUnicode(p)).isDirectory();
  } catch {
    return false;
  }
}
function HostDirectoryExists(p: string): boolean {
  try {
    return fs.statSync(ToUnicode(p)).isDirectory();
  } catch {
    return false;
  }
}
// TS: FPC ExtractFileDir (no trailing separator except for the root)
function ExtractFileDir(p: string): string {
  const i = p.lastIndexOf('/');
  if (i < 0) return '';
  return i === 0 ? '/' : p.slice(0, i);
}
// PAS: HANDLE.PAS CasePath (UNIX) – DOS names are case-insensitive: each path component takes
// the case found on disk (a catalogue's (STAN) directory is (stan)); a missing one is kept as is
function CasePath(P: string): string {
  if (P === '' || HostFileExists(P) || HostDirectoryExists(P)) return P;
  let res = '';
  let i = 1;
  if (P[0] === '/') {
    res = '/';
    i = 2;
  }
  while (i <= P.length) {
    let j = i;
    while (j <= P.length && P[j - 1] !== '/') j++;
    let comp = P.slice(i - 1, j - 1);
    if (comp !== '' && comp !== '.' && comp !== '..' && !HostFileExists(res + comp) && !HostDirectoryExists(res + comp)) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(res === '' ? '.' : ToUnicode(res));
      } catch {
        names = [];
      }
      const up = UpcaseStr(comp, UPCASE_852);
      for (const nm of names) {
        const b = FromUnicode(nm);
        if (UpcaseStr(b, UPCASE_852) === up) {
          comp = b;
          break;
        }
      }
    }
    res = res + comp;
    if (j <= P.length) res = res + '/';
    i = j + 1;
  }
  return res;
}
/** TS-only (added for RUNPROJ/FAND main): true when process.chdir is emulated because the engine
 *  runs in a worker thread (fand.ts InstallVirtualCwd); relative host paths are then made absolute
 *  against process.cwd() in UnixPath before they reach node:fs. */
export const HostCwd = { Virtual: false };
// PAS: HANDLE.PAS UnixPath – DOS-style path -> host path (FAND_DRIVE_x, case-insensitive lookup)
export function UnixPath(S: string): string {
  if (process.platform === 'win32') return S;
  if (DosView.On && S !== '' && S[0] === '\\') {
    const cwd = GetDirDos();
    if (cwd.length >= 2 && cwd[1] === ':') S = cwd.slice(0, 2) + S;
  }
  let r = S.replace(/\\/g, '/');
  const drive = r.length >= 2 && UpCase(r[0]) >= 'A' && UpCase(r[0]) <= 'Z' && r[1] === ':';
  if (drive || (r.length >= 1 && r[0] === '/' && S[0] === '\\')) {
    let root = '';
    if (r[1] === ':') root = GetEnv('FAND_DRIVE_' + UpCase(r[0]));
    if (root === '') {
      const cwd = FromUnicode(process.cwd());
      let i = cwd.length;
      while (i > 1 && cwd[i - 1] !== '/') i--;
      root = cwd.slice(0, i);
    } else if (root[root.length - 1] !== '/') root = root + '/';
    if (r[1] === ':') r = r.slice(2);
    if (r !== '' && r[0] === '/') r = r.slice(1);
    r = root + r;
  }
  if (HostCwd.Virtual && r !== '' && r[0] !== '/') r = FromUnicode(process.cwd()) + '/' + r;
  r = CasePath(r);
  return ShortStr(r);
}
/**
 * TS-only: the DOS view of host paths (BP7 semantics). When On (fand.ts main on macOS/Linux), the
 * task sees DOS paths ('C:\UCTO\FAKT_FH.000'): GetDir, FExpand, FandDir and the catalogue paths are
 * DOS paths, DirectorySeparator is '\', and UnixPath maps them back to host paths at the node:fs
 * boundary. FAND programs parse paths as on DOS (Účto: EndTxt('\',F.Path), Dir+'\'). The drives are
 * the FAND_DRIVE_x roots (main sets C: to the parent of the application directory and Z: to '/').
 * Off (unit tests that run parts of the engine, Windows): engine paths are host paths as in FPC.
 */
export const DosView = { On: false };
/** TS-only: the FAND_DRIVE_x host roots (with a trailing '/'), the longest first. */
function DosDriveRoots(): { L: string; Root: string }[] {
  const r: { L: string; Root: string }[] = [];
  for (let c = 65; c <= 90; c++) {
    let root = GetEnv('FAND_DRIVE_' + String.fromCharCode(c));
    if (root === '' || root[0] !== '/') continue;
    if (root[root.length - 1] !== '/') root = root + '/';
    r.push({ L: String.fromCharCode(c), Root: root });
  }
  return r.sort((a, b) => b.Root.length - a.Root.length);
}
/** TS-only: a host path as the DOS path the task sees (DosView); relative paths keep their form. */
export function HostToDos(P: string): string {
  if (!DosView.On || P === '' || P[0] !== '/') return P;
  const h = P.replace(/\\/g, '/');
  for (const d of DosDriveRoots()) {
    if (h.startsWith(d.Root) || h + '/' === d.Root) return d.L + ':\\' + h.slice(d.Root.length).replace(/\//g, '\\');
  }
  return P;
}
/** TS-only: System.GetDir(0) in the DOS view (the host cwd otherwise). */
export function GetDirDos(): string {
  return HostToDos(FromUnicode(process.cwd()));
}
/** TS-only: DOS.FExpand in the DOS view: 'X:\...' with '.' and '..' resolved, relative to GetDir;
 *  a trailing '\' (or an empty path) keeps a trailing '\'; a host path is converted by HostToDos. */
export function DosFExpand(Path: string): string {
  let p = Path;
  if (p !== '' && p[0] === '/') p = HostToDos(p);
  p = p.replace(/\//g, '\\');
  const cwd = GetDirDos();
  let drv: string;
  let rest: string;
  if (p.length >= 2 && p[1] === ':') {
    drv = UpCase(p[0]);
    rest = p.slice(2);
    if (rest === '' || rest[0] !== '\\') rest = (drv === UpCase(cwd[0]) ? cwd.slice(2) : '\\') + '\\' + rest;
  } else {
    drv = UpCase(cwd[0] ?? 'C');
    rest = p !== '' && p[0] === '\\' ? p : cwd.slice(2) + '\\' + p;
  }
  const out: string[] = [];
  for (const c of rest.split('\\')) {
    if (c === '' || c === '.') continue;
    if (c === '..') out.pop();
    else out.push(c);
  }
  let r = drv + ':\\' + out.join('\\');
  if ((Path === '' || Path.endsWith('\\') || Path.endsWith('/')) && !r.endsWith('\\')) r = r + '\\';
  return ShortStr(r);
}
// TS: FPC FileOpen/FileCreate – host fd, or throws the Node error
function HostOpen(path: string, flags: string): number {
  return fs.openSync(ToUnicode(path), flags);
}

// PAS: HANDLE.PAS OpenH – opens BaseVars.CPath; returns the handle, $FF + HandleError on failure
export function OpenH(Mode: FileOpenMode, UM: FileUseMode): number {
  const Txt = ['Clos', 'OpRd', 'OpRs', 'OpSh', 'OpEx'];
  const path = UnixPath(BaseVars.CPath);
  if (CardHandles === files) RunError(884);
  let w = 0;
  let h = -1;
  // 1:
  for (;;) {
    let flags: string;
    switch (UM) {
      case RdOnly:
      case RdShared:
        flags = 'r';
        break;
      case Shared:
      case Exclusive:
      default:
        flags = 'r+'; // TODO network locking (fmShareDenyWrite)
        break;
    }
    const open = (fl: string): void => {
      try {
        h = HostOpen(path, fl);
        BaseVars.HandleError = 0;
      } catch (e) {
        h = -1;
        HErr(e);
      }
    };
    switch (Mode) {
      case _isoldfile:
        open(flags);
        break;
      case _isoverwritefile:
        open('w+');
        break;
      case _isnewfile:
        if (HostFileExists(path)) {
          h = -1;
          BaseVars.HandleError = 80;
        } else open('w+');
        break;
      case _isoldnewfile:
        open(flags);
        if (h < 0) open('w+');
        break;
    }
    // UNIX ENOENT: DOS tells a missing directory (3) from a missing file
    if (BaseVars.HandleError === 2 && ExtractFileDir(path) !== '' && !HostDirectoryExists(ExtractFileDir(path))) {
      BaseVars.HandleError = 3;
    }
    if (IsNetCVol() && (BaseVars.HandleError === 0x05 || BaseVars.HandleError === 0x21)) {
      if (w === 0) {
        Set2MsgPar(path, Txt[UM]);
        w = PushWrLLMsg(825, false);
      }
      LockBeep();
      KbdTimer(BaseVars.Spec.NetDelay, 0);
      continue;
    }
    break;
  }
  let result = 0xff;
  if (BaseVars.HandleError === 0) {
    h = NewH(h);
    result = h;
    SetHandle(h);
    if (Mode !== _isoldfile) SetUpdHandle(h);
  }
  if (w !== 0) PopW(w);
  return result;
}
// PAS: HANDLE.PAS ReadH
export function ReadH(handle: number, bytes: number, buffer: Uint8Array): number {
  if (handle === 0xff) RunError(706);
  if (bytes > buffer.length) throw new RangeError(`ReadH: ${bytes} bytes into a buffer of ${buffer.length}`);
  BaseVars.HandleError = 0;
  try {
    const pos = OsPos[handle] ?? 0;
    const n = bytes === 0 ? 0 : fs.readSync(Fd(handle), buffer, 0, bytes, pos);
    OsPos[handle] = pos + n;
    return n & 0xffff;
  } catch (e) {
    HErr(e);
    return 0;
  }
}
// PAS: HANDLE.PAS ReadLongH (private)
function ReadLongH(handle: number, bytes: number, buf: Uint8Array): void {
  let ofs = 0;
  while (bytes >= 0x7ff0) {
    ReadH(handle, 0x7ff0, buf.subarray(ofs));
    bytes -= 0x7ff0;
    ofs += 0x7ff0;
  }
  ReadH(handle, bytes, buf.subarray(ofs));
}
// PAS: HANDLE.PAS WriteH – BP7 semantics for 0 bytes: DOS int $21/$40 with CX=0 truncates (or
// extends) the file at the current position; TruncH, EXPIMP ImportFD/RestoreHFD, EDEVENT, EDEVPROC,
// OLDTXX and RUNPROC PutTxt rely on it. The FPC branch (FileWrite of 0 bytes) is a no-op there,
// which leaves stale bytes behind in the reference FAND (a known reference-side difference).
export function WriteH(handle: number, bytes: number, buffer: Uint8Array): void {
  if (handle === 0xff) RunError(706);
  if (bytes > buffer.length) throw new RangeError(`WriteH: ${bytes} bytes from a buffer of ${buffer.length}`);
  BaseVars.HandleError = 0;
  let n: number;
  let err: unknown = null;
  try {
    const pos = OsPos[handle] ?? 0;
    if (bytes === 0) {
      fs.ftruncateSync(Fd(handle), pos);
      n = 0;
    } else n = fs.writeSync(Fd(handle), buffer, 0, bytes, pos);
    OsPos[handle] = pos + n;
  } catch (e) {
    n = -1;
    err = e;
  }
  SetUpdHandle(handle);
  if (n < 0 || n !== bytes) HErr(err ?? 'ENOSPC');
}
// PAS: HANDLE.PAS WriteLongH (private)
function WriteLongH(handle: number, bytes: number, buf: Uint8Array): void {
  let ofs = 0;
  while (bytes >= 0x7ff0) {
    WriteH(handle, 0x7ff0, buf.subarray(ofs));
    bytes -= 0x7ff0;
    ofs += 0x7ff0;
  }
  WriteH(handle, bytes, buf.subarray(ofs));
}
// PAS: HANDLE.PAS CloseH
export function CloseH(handle: number): void {
  if (handle === 0xff) return;
  BaseVars.HandleError = 0;
  const fd = Fd(handle);
  if (fd >= 0) {
    try {
      fs.closeSync(fd);
    } catch {
      // FPC FileClose ignores errors
    }
    OsH[handle] = -1;
  }
  ResetHandle(handle);
  ResetUpdHandle(handle);
  ResetFlshHandle(handle);
}
// PAS: HANDLE.PAS FlushH (FPC: no-op; writeSync already hands the data to the OS)
export function FlushH(handle: number): void {
  if (handle === 0xff) return;
  BaseVars.HandleError = 0;
}
// PAS: HANDLE.PAS FlushHandles
export function FlushHandles(): void {
  if (CardHandles === files) return;
  for (let h = 0; h <= files; h++) if (IsUpdHandle(h) || IsFlshHandle(h)) FlushH(h);
  ClearUpdHandles();
  ClearFlshHandles();
}
// PAS: HANDLE.PAS TruncH – BP7: SeekH + WriteH(handle,0,...) (the DOS truncate; sets HandleError
// and marks the handle updated). FPC: FileTruncate, result ignored.
export function TruncH(handle: number, N: number): void {
  if (handle === 0xff) return;
  if (FileSizeH(handle) > N) {
    SeekH(handle, N);
    WriteH(handle, 0, EmptyBuf);
  }
}
const EmptyBuf = new Uint8Array(0);
// PAS: HANDLE.PAS CloseClearH
export function CloseClearH(h: Ref<number>): void {
  if (h.v === 0xff) return;
  CloseH(h.v);
  ClearCacheH(h.v);
  h.v = 0xff;
}
// PAS: HANDLE.PAS SetFileAttr – of BaseVars.CPath; only the read-only bit maps to the host
export function SetFileAttr(Attr: number): void {
  BaseVars.HandleError = 0;
  try {
    const p = ToUnicode(UnixPath(BaseVars.CPath));
    const mode = fs.statSync(p).mode & 0o7777;
    fs.chmodSync(p, (Attr & 0x01) !== 0 ? mode & ~0o222 : mode | 0o200);
  } catch {
    BaseVars.HandleError = 1;
  }
}
// PAS: HANDLE.PAS GetFileAttr – of BaseVars.CPath (FPC LinuxToWinAttr)
export function GetFileAttr(): number {
  BaseVars.HandleError = 0;
  const p = UnixPath(BaseVars.CPath);
  let st: fs.Stats;
  try {
    st = fs.statSync(ToUnicode(p));
  } catch {
    BaseVars.HandleError = 1;
    return 0;
  }
  let r = 0x20; // faArchive
  if (st.isDirectory()) r |= 0x10;
  const nm = nodePath.posix.basename(p);
  if (nm.length >= 2 && nm[0] === '.' && nm[1] !== '.') r |= 0x02;
  if ((st.mode & 0o200) === 0) r |= 0x01;
  if (st.isSocket() || st.isBlockDevice() || st.isCharacterDevice() || st.isFIFO()) r |= 0x04;
  return r;
}
// PAS: HANDLE.PAS RdWrCache – Buf[0..N-1] at file position Pos
export function RdWrCache(ReadOp: boolean, Handle: number, NotCached: boolean, Pos: number, N: number, Buf: Uint8Array): void {
  if (Handle === 0xff) RunError(706);
  if (Pos < 0) RunError(713);
  if (NotCached) {
    SeekH(Handle, Pos);
    if (ReadOp) ReadH(Handle, N, Buf);
    else WriteH(Handle, N, Buf);
    if (BaseVars.HandleError === 0) return;
    const err = BaseVars.HandleError;
    SetCPathForH(Handle);
    SetMsgPar(BaseVars.CPath);
    RunError(700 + err);
  }
  const CachePageSize = BaseVars.CachePageSize;
  let PgeIdx = Pos & (CachePageSize - 1);
  let PgeRest = CachePageSize - PgeIdx;
  let PgeNo = Math.floor(Pos / 2 ** BaseVars.CachePageShft);
  let BufP = 0;
  let Z = Cache(Handle, PgeNo)!;
  while (N > PgeRest) {
    if (ReadOp) Buf.set(Z.Arr.subarray(PgeIdx, PgeIdx + PgeRest), BufP);
    else {
      Z.Arr.set(Buf.subarray(BufP, BufP + PgeRest), PgeIdx);
      Z.Upd = true;
    }
    BufP += PgeRest;
    N -= PgeRest;
    PgeNo++;
    Z = Cache(Handle, PgeNo)!;
    PgeRest = CachePageSize;
    PgeIdx = 0;
  }
  if (ReadOp) Buf.set(Z.Arr.subarray(PgeIdx, PgeIdx + N), BufP);
  else {
    Z.Arr.set(Buf.subarray(BufP, BufP + N), PgeIdx);
    Z.Upd = true;
    SetUpdHandle(Handle);
  }
}
// PAS: HANDLE.PAS GetDateTimeH – DOS packed date/time
export function GetDateTimeH(handle: number): number {
  BaseVars.HandleError = 0;
  let dt: number;
  try {
    dt = Math.trunc(fs.fstatSync(Fd(handle)).mtimeMs / 1000);
  } catch {
    BaseVars.HandleError = 1;
    return 0;
  }
  const y = ref(0), mo = ref(0), dy = ref(0), h = ref(0), mi = ref(0), s = ref(0);
  FandFileTime(dt, y, mo, dy, h, mi, s);
  if (y.v < 1980) {
    y.v = 1980;
    mo.v = 1;
    dy.v = 1;
    h.v = 0;
    mi.v = 0;
    s.v = 0;
  }
  return ((y.v - 1980) << 25) | (mo.v << 21) | (dy.v << 16) | (h.v << 11) | (mi.v << 5) | (s.v >> 1);
}
// PAS: HANDLE.PAS DeleteFile
export function DeleteFile(path: PathStr): void {
  BaseVars.HandleError = 0;
  try {
    fs.unlinkSync(ToUnicode(UnixPath(path)));
  } catch {
    BaseVars.HandleError = 1;
  }
}
// PAS: HANDLE.PAS RenameFile56
export function RenameFile56(OldPath: PathStr, NewPath: PathStr, Msg: boolean): void {
  BaseVars.HandleError = 0;
  try {
    fs.renameSync(ToUnicode(UnixPath(OldPath)), ToUnicode(UnixPath(NewPath)));
  } catch {
    BaseVars.HandleError = 1;
  }
  if (Msg && BaseVars.HandleError !== 0) {
    Set2MsgPar(OldPath, NewPath);
    RunError(829);
  }
}
// TS: FPC UpperCase/LowerCase (ASCII letters only)
function AsciiCase(s: string, up: boolean): string {
  return s.replace(up ? /[a-z]+/g : /[A-Z]+/g, (m) => (up ? m.toUpperCase() : m.toLowerCase()));
}
// TS: FPC ExpandFileName on a byte string (DosFExpand in the DOS view)
function ExpandFileName(p: string): string {
  if (DosView.On) return DosFExpand(p);
  return FromUnicode(nodePath.resolve(ToUnicode(p)));
}
// TS: DOS.FSearch(Name, DirList) – the current directory first, then each directory of the list
function FSearch(Nm: string, DirList: string): string {
  if (HostFileExists(Nm)) return Nm;
  for (let d of DirList.split(nodePath.delimiter)) {
    if (d === '') continue;
    if (d[d.length - 1] !== '/') d += '/';
    if (HostFileExists(d + Nm)) return d + Nm;
  }
  return '';
}
// PAS: HANDLE.PAS MyFExpand
export function MyFExpand(Nm: String12, EnvName: String8): PathStr {
  const Has = (Dir: string, Found: Ref<string>): boolean => {
    const Exists = (f: string): boolean => HostFileExists(DosView.On ? UnixPath(f) : f);
    Found.v = Dir + Nm;
    if (Exists(Found.v)) return true;
    Found.v = Dir + AsciiCase(Nm, true);
    if (Exists(Found.v)) return true;
    Found.v = Dir + AsciiCase(Nm, false);
    if (Exists(Found.v)) return true;
    return false;
  };
  const p = ref(GetEnv(EnvName));
  if (p.v !== '') {
    AddBackSlash(p);
    const bin = p.v;
    if (!Has(bin, p)) p.v = bin + Nm;
    return ExpandFileName(p.v);
  }
  if (Has('', p)) return ExpandFileName(p.v);
  // FPC: the directory of the executable; here FandDir when the engine sets it
  let bin: string;
  if (BaseVars.FandDir !== '') {
    const d = ref(BaseVars.FandDir);
    AddBackSlash(d);
    bin = d.v;
  } else bin = FromUnicode(nodePath.dirname(nodePath.resolve(ToUnicode(ParamStr(0))))) + '/';
  if (Has(bin, p)) return DosView.On ? ExpandFileName(p.v) : p.v;
  p.v = FSearch(Nm, GetEnv('PATH'));
  if (p.v === '') p.v = Nm;
  return ExpandFileName(p.v);
}
