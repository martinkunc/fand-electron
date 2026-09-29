// Headless driver for the engine: start a task in a worker, send keys, read the
// screen as text. Used by tests and for scripted comparisons with reference FAND.

import { Worker } from 'node:worker_threads';
import { KeyQueue } from '../console/keyqueue.ts';
import { UNICODE_KEY } from '../console/crt.ts';
import { K, fKey } from '../console/keys.ts';
import type { Cell, ScreenDiff } from '../console/screen.ts';
import type { RunOptions } from '../runtime/fand.ts';
import { answerHost, type HostHandler, type HostOp, type HostRequest } from '../hostbridge.ts';

/**
 * Headless answers to the engine's host calls (hostbridge.ts): nothing is opened or printed, the
 * clipboard is empty, no file is chosen, no secret is stored. Without an answer the engine would
 * block (an EXEC'd helper such as FAND2PDF.EXE waits for the host synchronously).
 */
export const headlessHost: HostHandler = async (op) => (op === 'print' ? true : op === 'clipboardRead' ? '' : null);

export class EngineDriver {
  private worker: Worker;
  private keys = new KeyQueue();
  cols = 80;
  rows = 25;
  cells: Cell[] = [];
  cursor = { x: 0, y: 0, visible: true };
  exited: Promise<number>;
  errors: string[] = [];
  /** the host calls the engine made (open a PDF, print ...), in order */
  hostCalls: { op: HostOp; args: unknown[] }[] = [];
  private waiters: (() => void)[] = [];

  constructor(opts: RunOptions & { cols?: number; rows?: number; host?: HostHandler }) {
    const host = opts.host ?? headlessHost;
    this.cols = opts.cols ?? 80;
    this.rows = opts.rows ?? 25;
    this.cells = Array.from({ length: this.cols * this.rows }, () => ({ ch: ' ', attr: 7 }));
    this.worker = new Worker(new URL('../worker.ts', import.meta.url));
    this.exited = new Promise((resolve) => {
      this.worker.on('message', (m) => {
        if (m.type === 'host') {
          const req = m as HostRequest;
          this.hostCalls.push({ op: req.op, args: req.args });
          // always answer, even when the handler throws synchronously: the worker is blocked on it
          Promise.resolve().then(() => host(req.op, req.args)).then(
            (value) => answerHost(req, { ok: true, value: value ?? null }),
            (e) => answerHost(req, { ok: false, error: String((e as Error)?.message ?? e) }),
          );
          return;
        }
        if (m.type === 'screen') this.apply(m.diff);
        else if (m.type === 'error') this.errors.push(m.message);
        else if (m.type === 'exit') resolve(m.code);
        this.waiters.splice(0).forEach((w) => w());
      });
      this.worker.on('error', (e) => {
        this.errors.push(String(e));
        resolve(-1);
      });
    });
    const { host: _host, ...start } = opts;
    this.worker.postMessage({ type: 'start', sab: this.keys.sab, ...start });
  }

  private apply(d: ScreenDiff): void {
    if (d.size) {
      this.cols = d.size.cols;
      this.rows = d.size.rows;
      this.cells = Array.from({ length: this.cols * this.rows }, () => ({ ch: ' ', attr: 7 }));
    }
    for (const r of d.rows) for (let x = 0; x < r.cells.length; x++) this.cells[r.y * this.cols + x] = r.cells[x];
    this.cursor = d.cursor;
  }

  text(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      let s = '';
      for (let x = 0; x < this.cols; x++) s += this.cells[y * this.cols + x].ch;
      lines.push(s.trimEnd());
    }
    return lines.join('\n');
  }

  /** Send keys: strings are typed, numbers are BIOS key codes (see K / fKey). */
  press(...keys: (string | number)[]): this {
    for (const k of keys) {
      if (typeof k === 'number') this.keys.push(k);
      else for (const ch of k) this.keys.push(UNICODE_KEY | ch.charCodeAt(0));
    }
    return this;
  }

  /** Wait until the screen contains the text (or matches the regexp). */
  async waitFor(what: string | RegExp, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const t = this.text();
      if (typeof what === 'string' ? t.includes(what) : what.test(t)) return t;
      if (this.errors.length) throw new Error(this.errors.join('\n'));
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`timeout waiting for ${what}\n--- screen ---\n${t}`);
      await new Promise<void>((res) => {
        const timer = setTimeout(res, Math.min(left, 100));
        this.waiters.push(() => {
          clearTimeout(timer);
          res();
        });
      });
    }
  }

  async close(): Promise<number> {
    this.keys.close();
    const code = await Promise.race([this.exited, new Promise<number>((r) => setTimeout(() => r(-2), 2000))]);
    await this.worker.terminate();
    return code;
  }
}

export { K, fKey };
