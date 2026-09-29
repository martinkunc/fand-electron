// Driver for the reference PC FAND (standa/pcfand fpc-migration build, a native
// Free Pascal port of the original sources). Runs it in a pseudo-terminal with a
// headless xterm so tests can compare its screens and resulting data files with
// our engine (same press/waitFor/text API as EngineDriver).

import { createRequire } from 'node:module';
import { cpSync, existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fKey, K } from '../console/keys.ts';

const require = createRequire(import.meta.url);

export const REF_FAND = resolve(import.meta.dirname, '../../../vendor/reference/standa_pcfand/bin/fand');

// Copies a task (e.g. vendor/extracted/app) to a fresh temp dir the reference may
// change. The path stays short (/tmp rather than macOS's long $TMPDIR): FAND refuses a
// task dir longer than the catalogue's 79 characters.
export function copyTask(srcDir: string): string {
  const dir = join(mkdtempSync(join(existsSync('/tmp') ? '/tmp' : tmpdir(), 'fandref-')), 'task');
  cpSync(srcDir, dir, { recursive: true });
  return dir;
}

// The RDB's name as it is on disk (Linux is case-sensitive: 'ucto2026' -> 'UCTO2026').
function taskOnDisk(dir: string, task: string): string {
  const rdb = readdirSync(dir).find((f) => f.toUpperCase() === `${task.toUpperCase()}.RDB`);
  return rdb ? rdb.slice(0, -4) : task;
}

function minimalEnv(): Record<string, string> {
  const e: Record<string, string> = { TERM: 'xterm' };
  for (const n of ['PATH', 'HOME', 'LANG']) if (process.env[n] !== undefined) e[n] = process.env[n]!;
  return e;
}

// BIOS key code -> xterm input sequence.
const SEQ: Record<number, string> = {
  [K.Esc]: '\x1b', [K.Enter]: '\r', [K.Tab]: '\t', [K.ShiftTab]: '\x1b[Z', [K.Backspace]: '\x7f',
  [K.Up]: '\x1b[A', [K.Down]: '\x1b[B', [K.Right]: '\x1b[C', [K.Left]: '\x1b[D',
  [K.Home]: '\x1b[H', [K.End]: '\x1b[F', [K.PgUp]: '\x1b[5~', [K.PgDn]: '\x1b[6~', [K.Ins]: '\x1b[2~', [K.Del]: '\x1b[3~',
};
const F_SEQ = ['\x1bOP', '\x1bOQ', '\x1bOR', '\x1bOS', '\x1b[15~', '\x1b[17~', '\x1b[18~', '\x1b[19~', '\x1b[20~', '\x1b[21~', '\x1b[23~', '\x1b[24~'];
for (let n = 1; n <= 12; n++) SEQ[fKey(n)] = F_SEQ[n - 1];
// Ctrl+navigation and Shift/Ctrl/Alt+Fn as xterm modifier sequences (1;m / n;m), which the
// reference's ReadTermKey (DRIVERS.PAS) decodes: m = 2 shift, 5 ctrl, 3 alt.
Object.assign(SEQ, {
  [K.CtrlLeft]: '\x1b[1;5D', [K.CtrlRight]: '\x1b[1;5C', [K.CtrlHome]: '\x1b[1;5H', [K.CtrlEnd]: '\x1b[1;5F',
  [K.CtrlPgUp]: '\x1b[5;5~', [K.CtrlPgDn]: '\x1b[6;5~', [0x8d00]: '\x1b[1;5A', [0x9100]: '\x1b[1;5B',
});
const F_NUM = [11, 12, 13, 14, 15, 17, 18, 19, 20, 21, 23, 24];
for (const [mod, m] of [[1, 2], [2, 5], [3, 3]] as const) {
  for (let n = 1; n <= 12; n++) SEQ[fKey(n, mod)] = `\x1b[${F_NUM[n - 1]};${m}~`;
}

export class RefFandDriver {
  private pty: { write(s: string): void; kill(): void; onExit(cb: (e: { exitCode: number }) => void): void; onData(cb: (d: string) => void): void };
  private term: { write(d: string, cb?: () => void): void; buffer: { active: { getLine(y: number): { translateToString(trim: boolean): string } | undefined } }; rows: number };
  exited: Promise<number>;
  exitCode: number | undefined;

  /**
   * `cleanEnv`: start from a minimal environment (PATH, HOME, LANG, TERM) instead of the whole host
   * one. Účto runs `set` and uses its output (OS detection, PARAM3.TTT), so a comparison with our
   * engine, whose `set` shows a small virtual DOS environment, should not feed it the host's.
   */
  constructor(opts: { taskDir: string; task: string; cols?: number; rows?: number; env?: Record<string, string>; cleanEnv?: boolean }) {
    if (!existsSync(REF_FAND)) throw new Error(`reference FAND not built: ${REF_FAND} (scripts/build-ref-fand.sh)`);
    const { Terminal } = require('@xterm/headless');
    const pty = require('node-pty');
    const cols = opts.cols ?? 80;
    const rows = opts.rows ?? 25;
    this.term = new Terminal({ cols, rows, allowProposedApi: true });
    this.pty = pty.spawn(REF_FAND, opts.task ? [taskOnDisk(opts.taskDir, opts.task)] : [], { // '' = the FAND desktop
      name: 'xterm',
      cols,
      rows,
      cwd: opts.taskDir,
      // FAND.RES must match the binary: take it from bin/; FAND.CFG is the task's own
      env: { ...(opts.cleanEnv ? minimalEnv() : process.env), FAND_SIZE: `${cols}x${rows}`, FAND_ENCODING: 'utf8', FANDRES: join(REF_FAND, '..'), ...opts.env },
    });
    this.pty.onData((d) => this.term.write(d));
    this.exited = new Promise((r) => this.pty.onExit((e) => r((this.exitCode = e.exitCode))));
  }

  text(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.term.rows; y++) lines.push(this.term.buffer.active.getLine(y)?.translateToString(true) ?? '');
    return lines.join('\n');
  }

  press(...keys: (string | number)[]): this {
    for (const k of keys) this.pty.write(typeof k === 'string' ? k : (SEQ[k] ?? String.fromCharCode(k & 0xff)));
    return this;
  }

  async waitFor(what: string | RegExp, timeoutMs = 10000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, 100));
      const t = this.text();
      if (typeof what === 'string' ? t.includes(what) : what.test(t)) return t;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${what}\n--- screen ---\n${t}`);
    }
  }

  async close(): Promise<void> {
    if (this.exitCode === undefined) this.pty.kill();
  }
}
