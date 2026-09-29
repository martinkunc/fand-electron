// Where is the PC FAND application (e.g. Účto) installed, and which task runs? Plain node:fs
// logic without Electron, so it can be tested; the dialogs are in index.ts.

import { accessSync, constants, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

/** What a folder holds of a FAND application. */
export interface AppDirScan {
  /** a directory that exists */
  exists: boolean;
  /** task names (the .RDB files without the extension, upper case), sorted */
  tasks: string[];
  /** FAND.RES (the messages of the FAND runtime) is there */
  hasRes: boolean;
  /** the folder can be written to (FAND keeps the data files there) */
  writable: boolean;
}

export function scanAppDir(dir: string): AppDirScan {
  let names: string[];
  try {
    if (!statSync(dir).isDirectory()) return { exists: false, tasks: [], hasRes: false, writable: false };
    names = readdirSync(dir);
  } catch {
    return { exists: false, tasks: [], hasRes: false, writable: false };
  }
  const tasks = names
    .filter((f) => /\.rdb$/i.test(f))
    .map((f) => f.replace(/\.rdb$/i, '').toUpperCase())
    .sort();
  const hasRes = names.some((f) => f.toUpperCase() === 'FAND.RES');
  let writable = true;
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    writable = false;
  }
  return { exists: true, tasks, hasRes, writable };
}

/** A folder the engine can run: at least one task and FAND.RES (or $FANDRES points elsewhere).
 *  The FAND desktop (development, no task) takes any folder: it creates the tasks itself, and the
 *  app brings FAND.RES/FAND.CFG of ALIS PC FAND for a folder without them (resources/fand). */
export function isAppDir(s: AppDirScan, env: NodeJS.ProcessEnv = process.env, desktop = false): boolean {
  if (desktop) return s.exists;
  return s.exists && s.tasks.length > 0 && (s.hasRes || !!env.FANDRES);
}

/**
 * The task to run without asking: the requested one if the folder has it, else the newest Účto
 * (UCTOyyyy), else the only task. null = the user has to choose.
 */
export function pickTask(tasks: string[], wanted?: string): string | null {
  const w = wanted?.replace(/\.rdb$/i, '').toUpperCase();
  if (w && tasks.includes(w)) return w;
  const ucto = tasks.filter((t) => /^UCTO\d{4}$/.test(t)).sort();
  if (ucto.length > 0) return ucto[ucto.length - 1];
  if (tasks.length === 1) return tasks[0];
  return null;
}

/** Per-user settings (settings.json in Electron's userData folder). */
export interface Settings {
  appDir?: string;
  task?: string;
  /** the folder of the FAND desktop (--fand), a development workspace of its own */
  fandDir?: string;
}

export function loadSettings(file: string): Settings {
  try {
    const s = JSON.parse(readFileSync(file, 'utf8')) as unknown;
    return s && typeof s === 'object' ? (s as Settings) : {};
  } catch {
    return {};
  }
}

export function saveSettings(file: string, s: Settings): void {
  try {
    if (!existsSync(dirname(file))) mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(s, null, 2) + '\n');
  } catch (e) {
    console.error(`cannot save ${file}: ${String(e)}`);
  }
}

/** The first candidate folder that holds a FAND application. */
export function firstAppDir(candidates: (string | undefined)[], desktop = false): string | null {
  for (const c of candidates) if (c && isAppDir(scanAppDir(c), process.env, desktop)) return c;
  return null;
}

/** Folders the packaged app may sit in (<app>/ucto-electron/ucto.exe, <app>/účto.app/Contents/MacOS/účto). */
export function parentsOf(execPath: string, levels = 6): string[] {
  const r: string[] = [];
  for (let d = dirname(execPath), i = 0; i < levels; i++, d = dirname(d)) r.push(d);
  return r;
}

export const SETTINGS_FILE = 'settings.json';
export const settingsPath = (userData: string): string => join(userData, SETTINGS_FILE);

/**
 * The installed app as it can be copied into the FAND folder, so that it finds the application next
 * to itself on the next start (firstAppDir over parentsOf):
 * * an AppImage (Linux, $APPIMAGE) or the Windows portable .exe ($PORTABLE_EXECUTABLE_FILE): the file;
 * * macOS: the .app bundle, copied as <app>/<name>.app;
 * * otherwise the folder of the executable (NSIS, deb, dir builds), copied as <app>/ucto-electron.
 * `exe` is the program to start in the copy.
 */
export interface SelfCopy {
  src: string;
  dest: string;
  exe: string;
}

export function selfCopyPlan(appDir: string, execPath: string, platform: string, env: NodeJS.ProcessEnv): SelfCopy {
  const file = env.APPIMAGE || env.PORTABLE_EXECUTABLE_FILE;
  if (file) {
    const dest = join(appDir, basename(file));
    return { src: file, dest, exe: dest };
  }
  if (platform === 'darwin') {
    const i = execPath.lastIndexOf('.app/');
    if (i >= 0) {
      const bundle = execPath.slice(0, i + 4);
      const dest = join(appDir, basename(bundle));
      return { src: bundle, dest, exe: join(dest, relative(bundle, execPath)) };
    }
  }
  const src = dirname(execPath);
  const dest = join(appDir, 'ucto-electron');
  return { src, dest, exe: join(dest, basename(execPath)) };
}

/** The app already runs from inside the FAND folder (nothing to copy). */
export function runsInside(appDir: string, src: string): boolean {
  const a = resolve(appDir) + sep;
  return resolve(src).startsWith(a);
}

/** The folders of the running AppImage / portable .exe (execPath is inside a temporary mount there). */
export function launcherDirs(env: NodeJS.ProcessEnv): string[] {
  const f = env.APPIMAGE || env.PORTABLE_EXECUTABLE_FILE;
  return f ? parentsOf(f) : [];
}
