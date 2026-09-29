// PAS: FAND.PAS – the main program: `BPBound := 0; InitRunFand; Halt(0)`.
//
// Porting notes:
// * The `uses` list fixes the unit initialisation order. Of the ported units BASE (InitBase: exit
//   proc, UserLicNr, FandResName := MyFExpand('Fand.Res','FANDRES'), OpenResFile) and, in FPC,
//   DRIVERS (InitDriversUnit: FandBatch from the command line) have an initialisation section;
//   DRIVERS comes first in the uses list. DML's InitDML is called by InitRunFand itself.
// * BP7 `asm mov BPBound,bp end` records the stack base for the overlay manager; FPC sets 0.
// * Overlays ({$O ...}), graphics units (FandGraph off) and FANDEXT.INC are not part of the port.
//   BP7 InitOverlays also sets OldDir (GetDir) and FandDir (the directory of UFAND.EXE); FPC leaves
//   both empty. main() sets them BP7-like: FandDir = the application directory (FAND.RES, FAND.CFG,
//   FANDWORK default), OldDir = the directory the engine started in.
// * FPC ends with System.Halt(0); Halt(n) anywhere (batch mode `halt(DoBatch)`, fatal start-up
//   errors) arrives here as HaltSignal and becomes the return value. Pascal then runs the exit
//   procedure chain: BASE.MyExit (work files, screen) runs here in `finally`.
// * TS-only parameters: the Crt the engine runs on (DRIVERS.SetDriversCrt) and the command line
//   (ParamStr, see RUNFAND notes: task path, 'D'/'T' switch; batch: TASK --source-in|out DIR).
//
// Engine entry (for src/engine/runtime/fand.ts):
//   import { main } from '../pas/fand.ts';
//   return main(crt, { appDir: opts.appDir, task: 'ucto2026', env: { FANDOVRB: '80' } });
// which is `cd <appDir>; SET FANDOVRB=80; ufand ucto2026` of Účto's U.BAT. `env` entries are put
// into process.env (the engine's environment: GetEnv reads it), e.g. FANDCFG, FANDRES, FANDWORK,
// FANDDATA, UCTODBOX, FAND_SIZE. main() may run in a worker thread: there process.chdir does not
// exist, and InstallVirtualCwd emulates the current directory (HANDLE.UnixPath absolutizes).

import * as fs from 'node:fs';
import * as nodePath from 'node:path';
import type { Crt } from '../console/crt.ts';
import { HaltSignal, FandRunError, Halt, SetParams, FromUnicode, SetDirectorySeparator } from './pasrt.ts';
// the Pascal uses list: dos, drivers, base, ... (DRIVERS' constants must be initialised first)
import { SetDriversCrt, InitDriversUnit } from './drivers.ts';
import { BaseVars, InitBase, MyExit, HostCwd } from './base.ts';
import { DosView, GetDirDos, HostToDos } from './handle.ts';
import { InitRunFand } from './runfand.ts';
import { ChDir } from './runproj.ts';

/** TS-only: FAND.PAS main block. Returns the program exit code. */
export function FandMain(crt: Crt | null, args: string[]): number {
  SetDriversCrt(crt);
  SetParams(args);
  let code = 0;
  let rtErr = 0;
  try {
    InitDriversUnit();
    InitBase();
    BaseVars.BPBound = 0;
    InitRunFand();
    Halt(0);
  } catch (e) {
    if (e instanceof HaltSignal) code = e.code;
    else if (e instanceof FandRunError) code = rtErr = e.code;
    else {
      // EngineShutdown, NotImplementedError, JS errors: clean up the work files, then propagate
      try {
        MyExit(0);
      } catch {
        // the screen may be gone
      }
      throw e;
    }
  }
  MyExit(rtErr);
  return code;
}

/** TS-only: options of main() – the equivalent of starting `ufand <task>` in <appDir>. */
export interface FandMainOptions {
  /** directory of the installed application (UFAND.EXE, FAND.RES, FAND.CFG, <task>.RDB) */
  appDir: string;
  /** task name or path as on the UFAND command line, e.g. 'ucto2026'; omitted = the FAND desktop */
  task?: string;
  /** further command-line arguments after the task ('D' test run, 'T' edit text, --source-in DIR ...) */
  args?: string[];
  /** environment variables set for the engine (FANDOVRB, FANDCFG, UCTODBOX, FANDRES, FANDWORK ...) */
  env?: Record<string, string | undefined>;
  /** the task sees DOS paths (HANDLE DosView; default on macOS/Linux, env FAND_DOSPATHS=0 turns it off) */
  dosPaths?: boolean;
}

/**
 * TS-only: process.chdir is not available in worker threads. Emulate the current directory there:
 * process.cwd()/process.chdir work on a variable, path.resolve follows it (it calls process.cwd()),
 * and HANDLE.UnixPath makes relative paths absolute (HostCwd.Virtual) before node:fs sees them.
 */
export function InstallVirtualCwd(): void {
  if (HostCwd.Virtual) return;
  const orig = process.chdir.bind(process);
  let supported = true;
  try {
    orig(process.cwd());
  } catch (e) {
    if ((e as { code?: string }).code === 'ERR_WORKER_UNSUPPORTED_OPERATION') supported = false;
  }
  if (supported) return;
  let cwd = process.cwd();
  process.cwd = (): string => cwd;
  process.chdir = (dir: string): void => {
    const r = nodePath.resolve(cwd, dir);
    if (!fs.statSync(r).isDirectory()) {
      const err = new Error(`ENOTDIR: not a directory, chdir '${r}'`) as NodeJS.ErrnoException;
      err.code = 'ENOTDIR';
      throw err;
    }
    cwd = r;
  };
  HostCwd.Virtual = true;
}

/** TS-only: the C: root main set itself (it follows appDir; a FAND_DRIVE_C of the user is kept). */
const AutoDriveC = { v: '' };

/**
 * TS-only: the engine entry – runs FAND on `crt` like `cd appDir; ufand <task>` (see the notes).
 * Returns the exit code of the program.
 */
export function main(crt: Crt, opts: FandMainOptions): number {
  InstallVirtualCwd();
  for (const [k, v] of Object.entries(opts.env ?? {})) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  const appDir = nodePath.resolve(opts.appDir);
  // TS-only: the DOS view – C: is the parent of the application directory (C:\UCTO), Z: the host root
  DosView.On = process.platform !== 'win32' && (opts.dosPaths ?? process.env.FAND_DOSPATHS !== '0');
  if (DosView.On) {
    // an earlier main in this process may have set C: for another application directory
    if (process.env.FAND_DRIVE_C === undefined || process.env.FAND_DRIVE_C === AutoDriveC.v) {
      AutoDriveC.v = nodePath.dirname(appDir);
      process.env.FAND_DRIVE_C = AutoDriveC.v;
    }
    process.env.FAND_DRIVE_Z ??= '/';
  }
  SetDirectorySeparator(DosView.On ? '\\' : nodePath.sep);
  BaseVars.OldDir = GetDirDos(); // BP7 InitOverlays: GetDir(0, OldDir)
  BaseVars.FandDir = HostToDos(FromUnicode(appDir)); // BP7: the directory of UFAND.EXE
  if (ChDir(BaseVars.FandDir) !== 0) throw new Error(`cannot change to the application directory ${appDir}`);
  const args: string[] = [];
  if (opts.task !== undefined && opts.task !== '') args.push(FromUnicode(opts.task));
  for (const a of opts.args ?? []) args.push(FromUnicode(a));
  return FandMain(crt, args);
}
