// Run an async helper from the synchronous engine thread.
// The helper executes in its own worker; the engine blocks (Atomics.wait) but keeps
// serving the helper's UI requests (message boxes, prompts) synchronously through
// receiveMessageOnPort, so dialogs appear on the FAND screen while EXEC waits.

import { Worker, MessageChannel, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';
import type { MessageKind } from './types.ts';

export interface SyncUi {
  message(title: string, text: string, kind: MessageKind): void;
  confirm(title: string, text: string): boolean;
  prompt(title: string, label: string, initial: string, secret: boolean): string | null;
  open(target: string): void;
  print(pdfPath: string, opts: { dialog: boolean; copies: number }): boolean;
  clipboardRead(): string;
  clipboardWrite(text: string): void;
  chooseFile(opts: { title: string; save?: boolean; defaultPath?: string; filters?: { name: string; extensions: string[] }[] }): string | null;
  secretGet(key: string): string | null;
  secretSet(key: string, value: string | null): void;
}

export interface HelperCall {
  exePath: string; // host path of the original exe (its directory holds the config)
  args: string[];
  cwd: string;
  appDir: string;
  env?: Record<string, string | undefined>;
}

export interface UiRequest {
  id: number;
  op: 'message' | 'confirm' | 'prompt' | 'open' | 'print' | 'clipboardRead' | 'clipboardWrite' | 'chooseFile' | 'secretGet' | 'secretSet';
  args: unknown[];
}

let worker: Worker | null = null;

function getWorker(): Worker {
  if (!worker) {
    // Bundled builds point UCTO_HELPER_WORKER at the built helper-worker.js.
    worker = new Worker(process.env.UCTO_HELPER_WORKER ?? new URL('./worker.ts', import.meta.url));
    worker.unref();
  }
  return worker;
}

/** Returns the helper exit code, or null when no replacement exists for the exe. */
export function runHelperSync(call: HelperCall, ui: SyncUi, timeoutMs = 10 * 60_000): number | null {
  const signal = new Int32Array(new SharedArrayBuffer(8)); // [0] done flag, [1] exit code
  const { port1, port2 } = new MessageChannel();
  getWorker().postMessage({ call, port: port2, signal: signal.buffer }, [port2]);
  const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      serveUi(port1, ui);
      if (Atomics.load(signal, 0) !== 0) break;
      if (Date.now() > deadline) throw new Error(`helper ${call.exePath} timed out`);
      Atomics.wait(signal, 0, 0, 20);
    }
    serveUi(port1, ui);
    const state = Atomics.load(signal, 0);
    if (state === 2) return null; // not registered
    if (state === 3) throw new Error(`helper ${call.exePath} failed`);
    return Atomics.load(signal, 1);
  } finally {
    port1.close();
  }
}

function serveUi(port: MessagePort, ui: SyncUi): void {
  for (let m = receiveMessageOnPort(port); m; m = receiveMessageOnPort(port)) {
    const req = m.message as UiRequest;
    const a = req.args as [string, string, never, never];
    let result: unknown = null;
    switch (req.op) {
      case 'message': ui.message(a[0], a[1], (req.args[2] as MessageKind) ?? 'info'); break;
      case 'confirm': result = ui.confirm(a[0], a[1]); break;
      case 'prompt': result = ui.prompt(a[0], a[1], (req.args[2] as string) ?? '', !!req.args[3]); break;
      case 'open': ui.open(a[0]); break;
      case 'print': result = ui.print(a[0], req.args[1] as { dialog: boolean; copies: number }); break;
      case 'clipboardRead': result = ui.clipboardRead(); break;
      case 'clipboardWrite': ui.clipboardWrite(a[0]); break;
      case 'chooseFile': result = ui.chooseFile(req.args[0] as Parameters<SyncUi['chooseFile']>[0]); break;
      case 'secretGet': result = ui.secretGet(a[0]); break;
      case 'secretSet': ui.secretSet(a[0], req.args[1] as string | null); break;
    }
    port.postMessage({ id: req.id, result });
  }
}
