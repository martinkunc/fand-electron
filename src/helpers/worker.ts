// Helper worker: runs async helper replacements on behalf of the blocked engine thread.

import { parentPort, type MessagePort } from 'node:worker_threads';
import { dirname } from 'node:path';
import { helperFor } from './registry.ts';
import { dosToHost } from './util.ts';
import type { HelperContext, HelperUi } from './types.ts';
import type { HelperCall, UiRequest } from './sync.ts';

parentPort!.on('message', async (msg: { call: HelperCall; port: MessagePort; signal: SharedArrayBuffer }) => {
  const signal = new Int32Array(msg.signal);
  const done = (state: number, code = 0) => {
    Atomics.store(signal, 1, code);
    Atomics.store(signal, 0, state);
    Atomics.notify(signal, 0);
    msg.port.close();
  };
  const helper = helperFor(msg.call.exePath);
  if (!helper) return done(2);

  let nextId = 1;
  const pending = new Map<number, (v: unknown) => void>();
  msg.port.on('message', (r: { id: number; result: unknown }) => {
    pending.get(r.id)?.(r.result);
    pending.delete(r.id);
  });
  const ask = <T>(op: UiRequest['op'], ...args: unknown[]) =>
    new Promise<T>((resolve) => {
      const id = nextId++;
      pending.set(id, resolve as (v: unknown) => void);
      msg.port.postMessage({ id, op, args } satisfies UiRequest);
    });
  const ui: HelperUi = {
    message: (t, x, k) => ask('message', t, x, k ?? 'info'),
    confirm: (t, x) => ask('confirm', t, x),
    prompt: (t, l, i, s) => ask('prompt', t, l, i ?? '', !!s),
    open: (t) => ask('open', t),
    print: (p, o) => ask('print', p, o),
    clipboardRead: () => ask('clipboardRead'),
    clipboardWrite: (t) => ask('clipboardWrite', t),
    chooseFile: (o) => ask('chooseFile', o),
    secretGet: (k) => ask('secretGet', k),
    secretSet: (k, v) => ask('secretSet', k, v),
  };
  const c = msg.call;
  const ctx: HelperContext = {
    name: c.exePath.replace(/\\/g, '/').split('/').pop()!.toLowerCase(),
    exeDir: dirname(c.exePath),
    cwd: c.cwd,
    args: c.args,
    appDir: c.appDir,
    resolvePath: (p) => dosToHost(p, c.appDir, c.cwd),
    ui,
    fetch: globalThis.fetch,
    now: () => new Date(),
    env: c.env ?? process.env,
  };
  try {
    done(1, await helper(ctx));
  } catch (e) {
    console.error(e);
    done(3);
  }
});
