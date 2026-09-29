// The engine entry (src/engine/runtime/fand.ts) runs the ported PC FAND main program in the
// worker, like the Electron app does: Účto starts on a copy of the installed application,
// reaches its main menu and quits with exit code 0.

import { describe, it, expect, afterAll } from 'vitest';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EngineDriver, K } from '../src/engine/testing/driver.ts';
import { startUcto } from '../src/engine/testing/ucto.ts';
import { helperHook } from '../src/engine/runtime/fand.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { BaseVars, OSshell, FormatCache, SetExecHelperHook } from '../src/engine/pas/base.ts';
import { SetDriversCrt } from '../src/engine/pas/drivers.ts';
import { FromUnicode } from '../src/engine/pas/pasrt.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const DIR = join(ROOT, 'work/tmp-runtime-main/ucto');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB')) && existsSync(join(APP, 'FAND.RES'));

afterAll(() => {
  rmSync(join(ROOT, 'work/tmp-runtime-main'), { recursive: true, force: true });
});

describe.skipIf(!haveApp)('runtime: the ported FAND runs the task', () => {
  it('starts Účto to its main menu and quits', async () => {
    rmSync(DIR, { recursive: true, force: true });
    mkdirSync(DIR, { recursive: true });
    cpSync(APP, DIR, { recursive: true });
    const d = new EngineDriver({ appDir: DIR, project: 'UCTO2026' });
    try {
      const seen = await startUcto(d, 90_000);
      expect(seen).toContain('Přepnout na Demonstrační verzi'); // first run of a pristine copy
      d.press(K.Esc); // close the Finance pull-down
      await d.waitFor(/^(?![\s\S]*Peněžní deník)/);
      d.press(K.Esc);
      await d.waitFor('Ukončit program účto');
      d.press(K.Enter);
      expect(await d.exited).toBe(0);
      expect(d.errors).toEqual([]);
    } finally {
      await d.close();
    }
  }, 180_000);
});

describe('runtime: EXEC of a helper program', () => {
  const TMP = join(ROOT, 'work/tmp-runtime-main/exec');
  afterAll(() => {
    rmSync(TMP, { recursive: true, force: true });
  });
  it('OSshell runs {tisk}\\FAND2PDF.EXE by its TS port through the runtime hook', () => {
    rmSync(TMP, { recursive: true, force: true });
    mkdirSync(join(TMP, '{tisk}'), { recursive: true });
    const keys = new KeyQueue();
    const crt = new Crt(keys, null);
    SetDriversCrt(crt);
    FormatCache();
    keys.push(K.Enter); // dismiss the helper's message
    let seen = '';
    crt.screen.onChange(() => {
      if (crt.screen.text().includes('Chybné parametry')) seen = crt.screen.text();
    });
    const cwd = process.cwd();
    const fandDir = BaseVars.FandDir;
    process.chdir(TMP);
    BaseVars.FandDir = FromUnicode(TMP);
    SetExecHelperHook(helperHook(crt));
    try {
      expect(OSshell('{tisk}\\FAND2PDF.EXE', '', true, true, false, false)).toBe(true);
      expect(BaseVars.LastExitCode).toBe(1); // no parameters: the port shows an error
      expect(seen).toContain('FAND2PDF');
      // not a helper: the FANDDOS built-ins / host shell as before
      OSshell(FromUnicode(process.execPath), '-e "process.exit(3)"', true, true, false, false);
      expect(BaseVars.LastExitCode).toBe(3);
    } finally {
      SetExecHelperHook(null);
      process.chdir(cwd);
      BaseVars.FandDir = fandDir;
    }
  });
});
