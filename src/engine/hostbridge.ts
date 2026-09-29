// Synchronous calls from the engine worker to the host (Electron main process or a
// test harness). The engine posts a request and blocks on a SharedArrayBuffer until the
// host writes the JSON-encoded answer, so synchronous FAND code (EXEC of a helper) can
// use OS services: open a file/URL, print a PDF, clipboard, file dialogs, secrets.

import type { MessagePort } from 'node:worker_threads';

export type HostOp = 'open' | 'print' | 'clipboardRead' | 'clipboardWrite' | 'chooseFile' | 'secretGet' | 'secretSet';

export interface HostRequest {
  type: 'host';
  op: HostOp;
  args: unknown[];
  sab: SharedArrayBuffer; // [0] state (0 pending, 1 done), [1] byte length, then UTF-8 JSON
}

const HEADER = 8;
const CAPACITY = 1 << 20;

/** Worker side: send a request through `post` and block until answered. */
export function callHostSync(post: (req: HostRequest) => void, op: HostOp, args: unknown[], timeoutMs = 30 * 60_000): unknown {
  const sab = new SharedArrayBuffer(HEADER + CAPACITY);
  const hdr = new Int32Array(sab, 0, 2);
  post({ type: 'host', op, args, sab });
  const deadline = Date.now() + timeoutMs;
  while (Atomics.load(hdr, 0) === 0) {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error(`host call ${op} timed out`);
    Atomics.wait(hdr, 0, 0, Math.min(left, 1000));
  }
  const len = Atomics.load(hdr, 1);
  const json = new TextDecoder().decode(new Uint8Array(sab, HEADER, len).slice());
  const res = JSON.parse(json) as { ok: boolean; value?: unknown; error?: string };
  if (!res.ok) throw new Error(res.error ?? `host call ${op} failed`);
  return res.value;
}

/** Host side: answer a request (value must be JSON-serialisable). */
export function answerHost(req: HostRequest, result: { ok: true; value: unknown } | { ok: false; error: string }): void {
  const bytes = new TextEncoder().encode(JSON.stringify(result));
  const hdr = new Int32Array(req.sab, 0, 2);
  if (bytes.length > CAPACITY) {
    const err = new TextEncoder().encode(JSON.stringify({ ok: false, error: 'host answer too large' }));
    new Uint8Array(req.sab, HEADER).set(err);
    Atomics.store(hdr, 1, err.length);
  } else {
    new Uint8Array(req.sab, HEADER).set(bytes);
    Atomics.store(hdr, 1, bytes.length);
  }
  Atomics.store(hdr, 0, 1);
  Atomics.notify(hdr, 0);
}

export type HostHandler = (op: HostOp, args: unknown[]) => Promise<unknown>;

/** Host side: dispatch HostRequest messages arriving from a worker. */
export function serveHost(port: { on(ev: 'message', fn: (m: unknown) => void): unknown } | MessagePort, handler: HostHandler): void {
  (port as { on(ev: 'message', fn: (m: unknown) => void): unknown }).on('message', (m: unknown) => {
    const req = m as HostRequest;
    if (req?.type !== 'host') return;
    handler(req.op, req.args).then(
      (value) => answerHost(req, { ok: true, value: value ?? null }),
      (e) => answerHost(req, { ok: false, error: String((e as Error)?.message ?? e) }),
    );
  });
}

// The engine worker registers how requests reach the host (parentPort.postMessage).
let hostPost: ((req: HostRequest) => void) | null = null;

export function setHostPost(post: ((req: HostRequest) => void) | null): void {
  hostPost = post;
}

/** Engine-side convenience: synchronous host call through the registered channel. */
export function hostCall(op: HostOp, ...args: unknown[]): unknown {
  if (!hostPost) throw new Error('no host attached (headless run)');
  return callHostSync(hostPost, op, args);
}
