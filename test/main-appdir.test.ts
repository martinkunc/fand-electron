// src/main/appdir.ts: finding the FAND application, choosing the task, remembering the choice and
// the plan of the app's copy of itself into the application folder.

import { describe, it, expect, afterAll } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstAppDir, isAppDir, launcherDirs, loadSettings, parentsOf, pickTask, runsInside, saveSettings, scanAppDir, selfCopyPlan } from '../src/main/appdir.ts';

const base = mkdtempSync('/tmp/appdir-');
afterAll(() => rmSync(base, { recursive: true, force: true }));

function folder(name: string, files: string[]): string {
  const d = join(base, name);
  mkdirSync(d, { recursive: true });
  for (const f of files) writeFileSync(join(d, f), '');
  return d;
}

describe('scanAppDir / isAppDir', () => {
  it('a FAND application needs a task (.RDB, any case) and FAND.RES', () => {
    const ucto = folder('ucto', ['UCTO2026.RDB', 'pgm.rdb', 'Fand.Res', 'X.000']);
    const s = scanAppDir(ucto);
    expect(s).toEqual({ exists: true, tasks: ['PGM', 'UCTO2026'], hasRes: true, writable: true });
    expect(isAppDir(s, {})).toBe(true);
    expect(isAppDir(scanAppDir(folder('nores', ['A.RDB'])), {})).toBe(false);
    expect(isAppDir(scanAppDir(folder('nores2', ['A.RDB'])), { FANDRES: '/x' })).toBe(true);
    expect(isAppDir(scanAppDir(folder('empty', ['FAND.RES'])), {})).toBe(false);
    // the FAND desktop (--fand) takes any folder, even an empty one
    expect(isAppDir(scanAppDir(folder('workspace', [])), {}, true)).toBe(true);
    expect(isAppDir(scanAppDir(join(base, 'missing')), {}, true)).toBe(false);
    expect(scanAppDir(join(base, 'missing')).exists).toBe(false);
    expect(scanAppDir(join(ucto, 'X.000')).exists).toBe(false); // a file, not a folder
  });
  it('reports a read-only folder', () => {
    if (process.getuid?.() === 0) return; // root can write anywhere
    const ro = folder('ro', ['A.RDB', 'FAND.RES']);
    chmodSync(ro, 0o555);
    try {
      expect(scanAppDir(ro).writable).toBe(false);
    } finally {
      chmodSync(ro, 0o755);
    }
  });
  it('firstAppDir takes the first candidate that holds an application', () => {
    const a = folder('first-a', ['README']);
    const b = folder('first-b', ['T.RDB', 'FAND.RES']);
    expect(firstAppDir([undefined, a, join(base, 'nope'), b])).toBe(b);
    expect(firstAppDir([a])).toBeNull();
  });
});

describe('pickTask', () => {
  it('the requested task, else the newest Účto, else the only task, else ask (null)', () => {
    expect(pickTask(['PGM', 'UCTO2025', 'UCTO2026'], 'ucto2025.rdb')).toBe('UCTO2025');
    expect(pickTask(['PGM', 'UCTO2025', 'UCTO2026'], 'NIC')).toBe('UCTO2026');
    expect(pickTask(['PGM', 'UCTO2025', 'UCTO2026'])).toBe('UCTO2026');
    expect(pickTask(['SKLAD'])).toBe('SKLAD');
    expect(pickTask(['SKLAD', 'MZDY'])).toBeNull();
  });
});

describe('settings', () => {
  it('are saved as JSON and read back; a missing or broken file gives {}', () => {
    const f = join(base, 'user', 'settings.json');
    expect(loadSettings(f)).toEqual({});
    saveSettings(f, { appDir: '/data/ucto', task: 'UCTO2026' });
    expect(loadSettings(f)).toEqual({ appDir: '/data/ucto', task: 'UCTO2026' });
    writeFileSync(f, '{broken');
    expect(loadSettings(f)).toEqual({});
  });
});

describe('selfCopyPlan', () => {
  it('Linux/Windows installed builds copy the program folder to <app>/ucto-electron', () => {
    const p = selfCopyPlan('/data/ucto', '/opt/ucto/ucto', 'linux', {});
    expect(p).toEqual({ src: '/opt/ucto', dest: '/data/ucto/ucto-electron', exe: '/data/ucto/ucto-electron/ucto' });
    // the copy finds the application from its own folder next time
    expect(parentsOf(p.exe)).toContain('/data/ucto');
  });
  it('an AppImage copies the image file itself (execPath is inside its temporary mount)', () => {
    const env = { APPIMAGE: '/home/u/Downloads/ucto-0.1.0.AppImage' };
    const p = selfCopyPlan('/data/ucto', '/tmp/.mount_ucto123/ucto', 'linux', env);
    expect(p).toEqual({ src: env.APPIMAGE, dest: '/data/ucto/ucto-0.1.0.AppImage', exe: '/data/ucto/ucto-0.1.0.AppImage' });
    expect(launcherDirs({ APPIMAGE: p.exe })[0]).toBe('/data/ucto');
  });
  it('macOS copies the .app bundle', () => {
    const p = selfCopyPlan('/Users/u/Ucto', '/Applications/účto.app/Contents/MacOS/účto', 'darwin', {});
    expect(p).toEqual({ src: '/Applications/účto.app', dest: '/Users/u/Ucto/účto.app', exe: '/Users/u/Ucto/účto.app/Contents/MacOS/účto' });
    expect(parentsOf(p.exe)).toContain('/Users/u/Ucto');
  });
  it('runsInside: nothing to copy when the app already sits in the application folder', () => {
    expect(runsInside('/data/ucto', '/data/ucto/ucto-electron')).toBe(true);
    expect(runsInside('/data/ucto', '/data/ucto2')).toBe(false);
    expect(runsInside('/data/ucto', '/opt/ucto')).toBe(false);
  });
});
