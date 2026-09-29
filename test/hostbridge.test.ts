import { describe, it, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { serveHost } from '../src/engine/hostbridge.ts';

describe('host bridge', () => {
  it('lets a blocked worker call async host services synchronously', async () => {
    const w = new Worker(`
      const { parentPort } = require('node:worker_threads');
      parentPort.once('message', async (url) => {
        const hb = await import(url);
        hb.setHostPost((r) => parentPort.postMessage(r));
        const a = hb.hostCall('clipboardRead');
        let err = '';
        try { hb.hostCall('secretGet', 'boom'); } catch (e) { err = e.message; }
        parentPort.postMessage({ done: [a, err] });
      });`, { eval: true });
    const got = new Promise<unknown>((res) => w.on('message', (m) => m.done && res(m.done)));
    serveHost(w, async (op, args) => {
      await new Promise((r) => setTimeout(r, 20));
      if (op === 'secretGet') throw new Error('no secret ' + args[0]);
      return 'schránka';
    });
    w.postMessage(new URL('../src/engine/hostbridge.ts', import.meta.url).href);
    expect(await got).toEqual(['schránka', 'no secret boom']);
    await w.terminate();
  });
});
