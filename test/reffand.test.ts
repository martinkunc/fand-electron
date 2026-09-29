// The reference PC FAND (vendor/reference/standa_pcfand, scripts/build-ref-fand.sh)
// runs Účto in a pty: the oracle for screens and resulting data files. Skipped when
// the reference is not built or Účto is not extracted.

import { describe, it, expect } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REF_FAND, RefFandDriver, copyTask } from '../src/engine/testing/refdriver.ts';
import { UCTO_MAIN_MENU, startUcto } from '../src/engine/testing/ucto.ts';
import { K } from '../src/engine/console/keys.ts';

const APP = join(import.meta.dirname, '../vendor/extracted/app');
const ready = existsSync(REF_FAND) && existsSync(join(APP, 'UCTO2026.RDB'));

describe.skipIf(!ready)('reference PC FAND', () => {
  it('starts Účto 2026 to the main menu and quits', async () => {
    const dir = copyTask(APP);
    const d = new RefFandDriver({ taskDir: dir, task: 'ucto2026' });
    try {
      const seen = await startUcto(d);
      // a pristine copy: version choice, demo confirmation and first-run notices
      expect(seen).toEqual(expect.arrayContaining(['VYBERTE VERZI', 'Přepnout na Demonstrační verzi']));
      const screen = d.text();
      expect(screen.split('\n')[0]).toMatch(UCTO_MAIN_MENU);
      expect(screen).toContain('Peněžní deník');
      expect(screen).toContain('FIRMA: STEHLÍK & SYN NOVÝ BOR');
      expect(screen).toContain('DEMOVERZE');

      d.press(K.Esc); // close the pull-down
      await d.waitFor(/^(?![\s\S]*Peněžní deník)/);
      d.press(K.Esc);
      await d.waitFor('Ukončit program účto');
      d.press(K.Enter);
      expect(await d.exited).toBe(0);

      // data the first run wrote: the station's parameters, the reports directory
      expect(existsSync(join(dir, '{stan}', 'PARAM3.000'))).toBe(true);
      expect(existsSync(join(dir, '{SEST}'))).toBe(true);
    } finally {
      await d.close();
      rmSync(dirname(dir), { recursive: true, force: true });
    }
  }, 120_000);
});
