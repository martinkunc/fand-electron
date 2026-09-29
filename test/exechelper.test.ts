import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { K } from '../src/engine/console/keys.ts';
import { execHelper, splitArgs } from '../src/engine/exechelper.ts';

describe('execHelper', () => {
  it('runs a helper synchronously and shows its message on the FAND screen', () => {
    const app = mkdtempSync(join(tmpdir(), 'ucto-'));
    mkdirSync(join(app, '{tisk}'));
    const keys = new KeyQueue();
    const crt = new Crt(keys, null);
    keys.push(K.Enter); // dismiss the message box
    let screenAtMessage = '';
    crt.screen.onChange(() => { if (crt.screen.text().includes('Chybné parametry')) screenAtMessage = crt.screen.text(); });
    const code = execHelper(crt, join(app, '{tisk}', 'FAND2PDF.EXE'), [], app, app);
    expect(code).toBe(1);
    expect(screenAtMessage).toContain('FAND2PDF');
    expect(crt.screen.text()).not.toContain('Chybné parametry'); // box restored
  });
  it('returns null for programs without a replacement', () => {
    const crt = new Crt(new KeyQueue(), null);
    expect(execHelper(crt, '/x/COMMAND.COM', [], '/x', '/x')).toBeNull();
  });
  it('splits DOS parameters', () => {
    expect(splitArgs('$ "C:\\A B\\X.TXT" 1000')).toEqual(['$', 'C:\\A B\\X.TXT', '1000']);
  });
});
