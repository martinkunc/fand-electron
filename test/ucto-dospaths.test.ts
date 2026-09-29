// The DOS view of paths (HANDLE DosView, turned on by fand.ts main on macOS/Linux): the task sees
// DOS paths ('C:\UCTO\FAKT_FH.000') as under BP7 FAND on DOS/Windows, and UnixPath maps them back
// to host paths when a file is opened. Účto depends on it: LogName (MODUL06) takes a file's name
// with EndTxt('\',F.Path), so with host paths Tiskopisy > Faktura > Faktury built the chapter name
// 'F2' instead of 'FaktF2' ('kapitola neexistuje', then 630 'úloha MODUL06 není odladěna'), and the
// start compared '/…/ucto/\' with the stored path ('Přemístění programu' on every start).

import { describe, it, expect, afterEach } from 'vitest';
import { cpSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DosView, HostToDos, DosFExpand, UnixPath } from '../src/engine/pas/handle.ts';
import { EngineDriver } from '../src/engine/testing/driver.ts';
import { startUcto } from '../src/engine/testing/ucto.ts';
import { settle, runSteps, quitUcto } from '../src/engine/testing/bringup.ts';
import { K } from '../src/engine/console/keys.ts';

const APP = join(import.meta.dirname, '..', 'vendor/extracted/app');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB'));

describe('HANDLE DosView: host <-> DOS paths', () => {
  const saved = { on: DosView.On, c: process.env.FAND_DRIVE_C, z: process.env.FAND_DRIVE_Z, cwd: process.cwd() };
  afterEach(() => {
    DosView.On = saved.on;
    for (const [k, v] of [['FAND_DRIVE_C', saved.c], ['FAND_DRIVE_Z', saved.z]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    process.chdir(saved.cwd);
  });

  it('maps host paths to the longest drive root, and back through UnixPath', () => {
    const base = mkdtempSync('/tmp/fanddos-');
    mkdirSync(join(base, 'ucto', '{DATA}'), { recursive: true });
    writeFileSync(join(base, 'ucto', '{DATA}', 'FAKT_FH.000'), '');
    DosView.On = true;
    process.env.FAND_DRIVE_C = base;
    process.env.FAND_DRIVE_Z = '/';
    try {
      expect(HostToDos(join(base, 'ucto', '{DATA}', 'FAKT_FH.000'))).toBe('C:\\ucto\\{DATA}\\FAKT_FH.000');
      expect(HostToDos(base)).toBe('C:\\');
      expect(HostToDos('/usr/share/x')).toBe('Z:\\usr\\share\\x');
      expect(HostToDos('REL\\X.000')).toBe('REL\\X.000'); // relative paths stay
      // DOS names are case-insensitive: UnixPath finds the host case
      expect(UnixPath('C:\\UCTO\\{data}\\fakt_fh.000')).toBe(join(base, 'ucto', '{DATA}', 'FAKT_FH.000'));
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('DosFExpand: absolute DOS paths relative to GetDir, "." and ".." resolved, trailing "\\" kept', () => {
    const base = mkdtempSync('/tmp/fanddos-');
    mkdirSync(join(base, 'ucto', 'sub'), { recursive: true });
    DosView.On = true;
    process.env.FAND_DRIVE_C = base;
    process.env.FAND_DRIVE_Z = '/';
    process.chdir(join(base, 'ucto'));
    try {
      expect(DosFExpand('FAKT.000')).toBe('C:\\ucto\\FAKT.000');
      expect(DosFExpand('sub\\..\\X.RDB')).toBe('C:\\ucto\\X.RDB');
      expect(DosFExpand('\\ROOT\\A')).toBe('C:\\ROOT\\A');
      expect(DosFExpand('c:\\ucto\\.\\{DATA}\\')).toBe('C:\\ucto\\{DATA}\\');
      expect(DosFExpand('')).toBe('C:\\ucto\\');
      expect(DosFExpand(join(base, 'ucto', 'sub') + '/')).toBe('C:\\ucto\\sub\\'); // a host path
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!haveApp)('Účto with DOS paths (our engine)', () => {
  it('starts without "Přemístění programu" and opens Tiskopisy > Faktura > Faktury', async () => {
    const base = mkdtempSync('/tmp/fandbu-');
    const dir = join(base, 'ucto');
    cpSync(APP, dir, { recursive: true });
    const d = new EngineDriver({ appDir: dir, project: 'UCTO2026', env: { FAND_DOSTOOLS: '0' } });
    try {
      const start = await startUcto(d, 120_000);
      expect(start).not.toContain('Přemístění programu');
      await settle(d);
      const [menu, fakt, list] = await runSteps(d, [
        { name: 'menu: Tiskopisy', keys: [K.Right, K.Right, K.Right], wait: 'Faktura' },
        { name: 'Tiskopisy > Faktura', keys: [K.Down, K.Down, K.Enter], wait: 'Archiv faktur' },
        { name: 'Faktura > Faktury', keys: [K.Down, K.Down, K.Enter], wait: 'FAKTURY podle', settle: 1500 },
      ]);
      expect(menu.timeout).toBeUndefined();
      expect(fakt.timeout).toBeUndefined();
      expect(list.timeout).toBeUndefined();
      expect(list.screen).not.toMatch(/není odladěna|kapitola neexistuje/);
      await runSteps(d, [
        { name: 'list: Esc', keys: [K.Esc], wait: 'Archiv faktur', settle: 1000 },
        { name: 'Faktura: Esc', keys: [K.Esc], settle: 1000 },
        { name: 'Tiskopisy: Esc', keys: [K.Esc], settle: 1000 },
      ]);
      expect(await quitUcto(d)).toBe(0);
      expect(d.errors).toEqual([]);
    } finally {
      await d.close();
      rmSync(base, { recursive: true, force: true });
    }
  }, 300_000);
});
