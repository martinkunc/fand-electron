// Crt: the engine's view of the terminal (Turbo Pascal CRT unit + BIOS keyboard).
// Owns the Screen and the KeyQueue and pushes screen diffs to a sink (the Electron
// main process, or a test driver).

import { Screen, type ScreenDiff } from './screen.ts';
import { KeyQueue } from './keyqueue.ts';
import { charToByte, byteToChar } from './cp852.ts';

export type DiffSink = (diff: ScreenDiff) => void;

export interface KeyEvent {
  code: number; // BIOS word: (scan << 8) | CP852 char
  shift: number;
}

/** Encoding used in the queue for printable Unicode input: bit 30 set, low 16 bits = char code. */
export const UNICODE_KEY = 1 << 30;

export class Crt {
  readonly screen: Screen;
  readonly keys: KeyQueue;
  private sink: DiffSink | null;
  private lastFlush = 0;
  /** Flush interval while the engine is busy (not waiting for keys). */
  flushIntervalMs = 40;
  private pushedBack: KeyEvent[] = [];

  constructor(keys: KeyQueue, sink: DiffSink | null, cols = 80, rows = 25) {
    this.screen = new Screen(cols, rows);
    this.keys = keys;
    this.sink = sink;
    this.screen.onChange(() => {
      const now = Date.now();
      if (now - this.lastFlush >= this.flushIntervalMs) this.flush();
    });
  }

  flush(): void {
    this.lastFlush = Date.now();
    if (!this.sink) return;
    const d = this.screen.takeDiff();
    if (d && (d.rows.length || d.size)) this.sink(d);
    else if (d) this.sink(d); // cursor-only update
  }

  private decode(k: { code: number; shift: number }): KeyEvent {
    if (k.code & UNICODE_KEY) {
      const ch = String.fromCharCode(k.code & 0xffff);
      const scan = (k.code >> 16) & 0xff;
      return { code: (scan << 8) | charToByte(ch), shift: k.shift };
    }
    return { code: k.code & 0xffff, shift: k.shift };
  }

  /** KeyPressed */
  keyPressed(): boolean {
    return this.pushedBack.length > 0 || this.keys.available();
  }

  /** Blocking ReadKey as a BIOS word. Returns Esc when the queue was closed (shutdown). */
  readKey(timeoutMs = Infinity): KeyEvent | null {
    if (this.pushedBack.length) return this.pushedBack.shift()!;
    this.flush();
    const k = this.keys.read(timeoutMs);
    if (!k) {
      if (this.keys.closed) throw new EngineShutdown();
      return null;
    }
    return this.decode(k);
  }

  /** Unicode character of a printable key event. */
  charOf(k: KeyEvent): string {
    return byteToChar(k.code & 0xff);
  }

  /** Put a key back so the next readKey returns it (FAND's KbdBuffer handling). */
  unreadKey(k: KeyEvent): void {
    this.pushedBack.unshift(k);
  }

  /** Delay(ms) that still flushes the screen. */
  delay(ms: number): void {
    this.flush();
    const a = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(a, 0, 0, ms);
  }
}

export class EngineShutdown extends Error {
  constructor() {
    super('engine shutdown');
  }
}
