// PC FAND on its own, without Účto: an empty folder and the FAND.RES/FAND.CFG of ALIS PC FAND (MIT)
// that the app bundles in resources/fand (the FAND desktop, `--fand`). A new task is created from
// chapter text files (RUNBATCH --source-in), then run as `ufand DEMO` and from the chapter editor
// (`ufand DEMO D`, Ctrl+F9) – the whole development cycle of a FAND application in our engine.

import { describe, it, expect, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { main } from '../src/engine/pas/fand.ts';
import { EngineDriver } from '../src/engine/testing/driver.ts';
import { K, fKey } from '../src/engine/console/keys.ts';

const FAND = join(import.meta.dirname, '..', 'resources', 'fand');
const env = { FANDRES: FAND, FANDCFG: FAND };
const base = mkdtempSync('/tmp/fandalone-');
const dir = join(base, 'demo');
const startCwd = process.cwd();
afterAll(() => {
  process.chdir(startCwd);
  rmSync(base, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!existsSync(join(FAND, 'FAND.RES')))('PC FAND alone: a new task in an empty folder', () => {
  it('--source-in creates DEMO.RDB from chapter files (batch, no screen)', () => {
    const src = join(base, 'src');
    mkdirSync(src, { recursive: true });
    mkdirSync(dir);
    writeFileSync(join(src, '010-F-Osoby.txt'), 'Jmeno:A,20;\nVek:F,3.0;\n');
    writeFileSync(join(src, '020-P-main.txt'), "begin\n  writeln('Ahoj z FANDu');\n  wait;\nend;\n");
    const q = new KeyQueue();
    q.close();
    const errs: string[] = [];
    const w = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => (errs.push(String(s)), true)) as typeof process.stderr.write;
    let code: number;
    try {
      code = main(new Crt(q, null, 80, 25), { appDir: dir, task: 'DEMO', args: ['--source-in', src], env });
    } finally {
      process.stderr.write = w;
      process.chdir(startCwd);
    }
    expect(errs.join('')).toMatch(/DEMO: 2 chapters from /);
    expect(code).toBe(0);
    expect(readdirSync(dir).map((f) => f.toUpperCase())).toContain('DEMO.RDB');
  });

  it('`ufand DEMO` runs procedure main', async () => {
    const d = new EngineDriver({ appDir: dir, project: 'DEMO', env });
    try {
      await d.waitFor('Ahoj z FANDu', 30_000);
      d.press(K.Enter);
      expect(await d.close()).toBe(0);
      expect(d.errors).toEqual([]);
    } finally {
      await d.close();
    }
  }, 60_000);

  it('`ufand DEMO D`: the chapter editor lists the chapters, Ctrl+F9 runs main, Esc back to the desktop', async () => {
    const d = new EngineDriver({ appDir: dir, project: 'DEMO', args: ['D'], env });
    try {
      const ed = await d.waitFor(/Typ\s+Nazev/, 30_000);
      expect(ed).toMatch(/DEMO\.RDB/);
      expect(ed).toMatch(/ F\s+Osoby/);
      expect(ed).toMatch(/ P\s+main/);
      d.press(K.Down, fKey(9, 2)); // to P main, Ctrl+F9
      await d.waitFor('Ahoj z FANDu', 30_000);
      d.press(K.Enter);
      await d.waitFor(/Typ\s+Nazev/, 30_000);
      d.press(K.Esc);
      await d.waitFor(/Provést úlohu/, 30_000); // the FAND desktop
      d.press(K.Esc);
      await sleep(500);
      expect(d.errors).toEqual([]);
    } finally {
      await d.close();
    }
  }, 90_000);
});
