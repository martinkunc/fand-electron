// Engine entry point: the equivalent of `UFAND.EXE <task>` (Účto's U.BAT: `SET FANDOVRB=80`,
// `ufand ucto2026` in the application directory). It runs the ported PC FAND main program
// (src/engine/pas/fand.ts). The earlier read-only project browser (chapter list) is still
// reachable with `browse: true`.

import * as nodePath from 'node:path';
import type { Crt } from '../console/crt.ts';
import { main } from '../pas/fand.ts';
import { BaseVars, UnixPath, SetExecHelperHook, type ExecHelperHook } from '../pas/base.ts';
import { ToUnicode } from '../pas/pasrt.ts';
import { execHelper, splitArgs } from '../exechelper.ts';
import { chooseProject, projectManager } from './projmgr.ts';

export interface RunOptions {
  appDir: string; // directory with the installed application (UFAND.EXE, UCTO2026.RDB, ...)
  project?: string; // task name, e.g. "UCTO2026" or "UCTO2026.RDB"; omitted = the FAND desktop
  /** further UFAND command-line arguments after the task ('D' test run, 'T' edit a text file, ...) */
  args?: string[];
  /** environment for the engine (FANDCFG, FANDWORK, UCTODBOX ...); FANDOVRB=80 as in U.BAT by default */
  env?: Record<string, string | undefined>;
  /** open the task in the TS project browser (chapter list) instead of running it */
  browse?: boolean;
}

export function runFand(crt: Crt, opts: RunOptions): number {
  if (opts.browse) return browseProjects(crt, opts);
  const task = opts.project ? taskName(opts.project) : undefined;
  SetExecHelperHook(helperHook(crt));
  try {
    return main(crt, { appDir: opts.appDir, task, args: opts.args, env: { FANDOVRB: '80', ...opts.env } });
  } finally {
    SetExecHelperHook(null);
  }
}

/**
 * EXEC (MEMORY.OSshell) of one of Účto's Windows helper programs: run it by the platform policy of
 * exechelper.ts (the original on Windows, a TS port or Mono elsewhere). Path is the program (or
 * empty, then the first word of CmdLine); both are CP852 byte strings with DOS paths.
 */
export function helperHook(crt: Crt): ExecHelperHook {
  return (Path, CmdLine) => {
    let prog = Path.trim();
    let params = CmdLine;
    if (prog === '') {
      const m = /^\s*("[^"]*"|\S+)\s*([\s\S]*)$/.exec(CmdLine);
      if (!m) return null;
      prog = m[1].replace(/"/g, '');
      params = m[2];
    }
    const exe = nodePath.resolve(ToUnicode(UnixPath(prog)));
    return execHelper(crt, exe, splitArgs(ToUnicode(params)), process.cwd(), ToUnicode(BaseVars.FandDir));
  };
}

/** The project browser: choose a project, show its chapters, until the chooser is left. */
function browseProjects(crt: Crt, opts: RunOptions): number {
  let project = opts.project ? normalizeTask(opts.project) : undefined;
  for (;;) {
    const chosen = chooseProject(crt, opts.appDir, project);
    if (!chosen) return 0;
    project = chosen;
    projectManager(crt, opts.appDir, chosen);
  }
}

/** UFAND takes the task without the .RDB extension (`ufand ucto2026`). */
function taskName(t: string): string {
  return t.replace(/\.rdb$/i, '');
}

function normalizeTask(t: string): string {
  return /\.\w+$/.test(t) ? t : `${t}.RDB`;
}
