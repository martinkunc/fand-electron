// PAS: RUNPROJ.PAS (+ PROJMGR1.PAS, PROJMGR.PAS) – the project (task) manager: opening a task's
// chapter file (.RDB), compiling its chapters, running or editing it, installing it.
//
// Porting notes:
// * The unit body is only `E: EditDPtr absolute EditDRoot` (RdRunVars.EditDRoot) and the includes:
//   projmgr1.ts (chapter records, FD segments, help/catalog editing, StoreChptTxt) and projmgr.ts
//   (CreateOpenChpt/CloseChpt, CompileRdb, EditExecRdb, InstallRdb). CreateOpenChpt, CloseChpt
//   and CompileRdb are interface routines only in the FPC build (RUNBATCH uses them).
// * asm/DOS: Ovr (no-op); PROJMGR1 O/OCF (segment:offset relocation, BP7 only - WrFDSegment and
//   RdFDSegment are empty in FPC, see projmgr1.ts).
// * Key global state: AccessVars.Chpt (= FileDRoot, the chapter file), ChptTF/ChptTxtPos/ChptVerif/
//   ChptOldTxt/ChptTyp/ChptName/ChptTxt (field pointers set by SetChptFldDPtr), CRdb chain, TopRdbDir,
//   TopDataDir, CatFD, IsTestRun/IsInstallRun, UserName/UserCode/UserPassword/AccRight (RdUserId).
//   Private: RunProjPriv below.
// * Tricky parts: the order in which CompileRdb compiles chapters defines what FileDRoot/LinkDRoot
//   contain when procedures run; GoCompileErr + GotoErrPos jump into the chapter editor at the
//   error position (InpRdbPos, CurrPos). Passwords/licence: encrypted chapters (CRdb^.Encrypted,
//   ChptTF^.LicenseNr) cannot be edited or verified (error 647).
// * The Pascal System ChDir/MkDir/RmDir (under {$I-}, IOResult) are the TS-only helpers below; they
//   are shared with RUNFAND. process.chdir is not available in a worker thread: fand.ts main()
//   installs a virtual current directory there (InstallVirtualCwd).

import * as fs from 'node:fs';
import type { EditDPtr } from './rdrun.ts';
import type { FileDPtr } from './access.ts';
import { RdRunVars } from './rdrun.ts';
import { ToUnicode } from './pasrt.ts';
import { UnixPath } from './base.ts';

export {
  IsCurrChpt, ReleaseFDLDAfterChpt, ExtToTyp, RdFDSegment, ChptDel, ChptWriteCRec, PromptHelpName,
  EditHelpOrCat, StoreChptTxt,
} from './projmgr1.ts';
export { EditExecRdb, InstallRdb, CreateOpenChpt, CloseChpt, CompileRdb } from './projmgr.ts';

/** TS-only: implementation-section globals of RUNPROJ (PROJMGR1/PROJMGR), incl. typed constants. */
export const RunProjPriv = {
  // PROJMGR1: WrFDSegment/RdFDSegment work variables (BP7 only)
  CFileF: null as FileDPtr,
  sz: 0,
  nTb: 0,
  // PROJMGR1 EditHelpOrCat typed constants (remembered record counts/positions)
  nCat: 1,
  iCat: 1,
  nHelp: 1,
  iHelp: 1,
  // PROJMGR typed constant: PushW handle of the user screen saved while a nested task runs
  UserW: 0,
};

/** TS-only: `E: EditDPtr absolute EditDRoot`. */
export function RunProjE(): EditDPtr {
  return RdRunVars.EditDRoot;
}

/** TS-only: DOS error code (IOResult) of a failed host directory operation. */
function DirIOResult(e: unknown): number {
  switch ((e as { code?: string } | null)?.code) {
    case 'ENOENT':
    case 'ENOTDIR':
      return 3;
    case 'EACCES':
    case 'EPERM':
    case 'EEXIST':
    case 'ENOTEMPTY':
    case 'EBUSY':
      return 5;
    default:
      return 1;
  }
}
/** TS-only: System.ChDir under {$I-}; returns IOResult. FPC: an empty path is a no-op. */
export function ChDir(Dir: string): number {
  if (Dir === '') return 0;
  try {
    process.chdir(ToUnicode(UnixPath(Dir)));
    return 0;
  } catch (e) {
    return DirIOResult(e);
  }
}
/** TS-only: System.MkDir under {$I-}; returns IOResult. */
export function MkDir(Dir: string): number {
  try {
    fs.mkdirSync(ToUnicode(UnixPath(Dir)));
    return 0;
  } catch (e) {
    return DirIOResult(e);
  }
}
/** TS-only: System.RmDir under {$I-}; returns IOResult. */
export function RmDir(Dir: string): number {
  try {
    fs.rmdirSync(ToUnicode(UnixPath(Dir)));
    return 0;
  } catch (e) {
    return DirIOResult(e);
  }
}
