// DOS BIOS keyboard codes (INT 16h): low byte ASCII, high byte scan code.
// FAND works with "KbdChar" words where extended keys have ASCII 0 (e.g. F1 = $3B00).
// Shared by the renderer (DOM KeyboardEvent -> code) and the engine.

export interface DosKey {
  code: number; // (scan << 8) | ascii
  shift: number; // BIOS shift flags: 1 RShift, 2 LShift, 4 Ctrl, 8 Alt
}

export const K = {
  Esc: 0x011b,
  Enter: 0x1c0d,
  Tab: 0x0f09,
  ShiftTab: 0x0f00,
  Backspace: 0x0e08,
  Up: 0x4800,
  Down: 0x5000,
  Left: 0x4b00,
  Right: 0x4d00,
  Home: 0x4700,
  End: 0x4f00,
  PgUp: 0x4900,
  PgDn: 0x5100,
  Ins: 0x5200,
  Del: 0x5300,
  CtrlLeft: 0x7300,
  CtrlRight: 0x7400,
  CtrlHome: 0x7700,
  CtrlEnd: 0x7500,
  CtrlPgUp: 0x8400,
  CtrlPgDn: 0x7600,
  CtrlEnter: 0x1c0a,
  F1: 0x3b00,
} as const;

// Scan codes for F1..F10 plain / shift / ctrl / alt, and F11/F12.
const F_BASE = [0x3b, 0x54, 0x5e, 0x68]; // + (n-1), n = 1..10
const F11 = [0x85, 0x87, 0x89, 0x8b];
const F12 = [0x86, 0x88, 0x8a, 0x8c];

export function fKey(n: number, mod: 0 | 1 | 2 | 3 = 0): number {
  if (n === 11) return F11[mod] << 8;
  if (n === 12) return F12[mod] << 8;
  return (F_BASE[mod] + n - 1) << 8;
}

// Scan codes of the US layout keys, for Alt+letter / Ctrl+letter combos.
const SCAN: Record<string, number> = {
  q: 0x10, w: 0x11, e: 0x12, r: 0x13, t: 0x14, y: 0x15, u: 0x16, i: 0x17, o: 0x18, p: 0x19,
  a: 0x1e, s: 0x1f, d: 0x20, f: 0x21, g: 0x22, h: 0x23, j: 0x24, k: 0x25, l: 0x26,
  z: 0x2c, x: 0x2d, c: 0x2e, v: 0x2f, b: 0x30, n: 0x31, m: 0x32,
  '1': 0x02, '2': 0x03, '3': 0x04, '4': 0x05, '5': 0x06, '6': 0x07, '7': 0x08, '8': 0x09, '9': 0x0a, '0': 0x0b,
  '-': 0x0c, '=': 0x0d, ' ': 0x39,
};
const ALT_DIGIT: Record<string, number> = { '1': 0x78, '2': 0x79, '3': 0x7a, '4': 0x7b, '5': 0x7c, '6': 0x7d, '7': 0x7e, '8': 0x7f, '9': 0x80, '0': 0x81 };

export interface DomKeyLike {
  key: string;
  code: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

/**
 * Translate a DOM keyboard event into a DOS key. Printable characters are returned
 * as Unicode in `char` (the engine converts to CP852); `null` means "ignore".
 */
export function domToDos(e: DomKeyLike): { code: number; char?: string; shift: number } | null {
  const shift = (e.shiftKey ? 2 : 0) | (e.ctrlKey ? 4 : 0) | (e.altKey ? 8 : 0);
  const mod: 0 | 1 | 2 | 3 = e.altKey ? 3 : e.ctrlKey ? 2 : e.shiftKey ? 1 : 0;
  const fm = /^F(\d{1,2})$/.exec(e.key);
  if (fm) return { code: fKey(Number(fm[1]), mod), shift };
  const ext = (plain: number, ctrl?: number) => ({ code: e.ctrlKey && ctrl ? ctrl : plain, shift });
  switch (e.key) {
    case 'Escape': return ext(K.Esc);
    case 'Enter': return ext(K.Enter, K.CtrlEnter);
    case 'Tab': return { code: e.shiftKey ? K.ShiftTab : K.Tab, shift };
    case 'Backspace': return ext(K.Backspace, 0x0e7f);
    case 'ArrowUp': return ext(K.Up, 0x8d00);
    case 'ArrowDown': return ext(K.Down, 0x9100);
    case 'ArrowLeft': return ext(K.Left, K.CtrlLeft);
    case 'ArrowRight': return ext(K.Right, K.CtrlRight);
    case 'Home': return ext(K.Home, K.CtrlHome);
    case 'End': return ext(K.End, K.CtrlEnd);
    case 'PageUp': return ext(K.PgUp, K.CtrlPgUp);
    case 'PageDown': return ext(K.PgDn, K.CtrlPgDn);
    case 'Insert': return ext(K.Ins, 0x9200);
    case 'Delete': return ext(K.Del, 0x9300);
  }
  if (e.key.length !== 1) return null; // Shift, Control, Dead keys...
  const lower = e.key.toLowerCase();
  if (e.altKey && !e.ctrlKey) {
    if (ALT_DIGIT[e.key]) return { code: ALT_DIGIT[e.key] << 8, shift };
    const sc = SCAN[lower] ?? SCAN[e.code.replace(/^Key/, '').toLowerCase()];
    return sc ? { code: sc << 8, shift } : null;
  }
  if (e.ctrlKey && !e.altKey) {
    const letter = /^Key([A-Z])$/.exec(e.code)?.[1];
    if (letter) {
      const l = letter.toLowerCase();
      return { code: (SCAN[l] << 8) | (letter.charCodeAt(0) - 64), shift };
    }
    return null;
  }
  // AltGr (Ctrl+Alt on Windows) and plain printable keys produce a character.
  const sc = SCAN[lower] ?? 0;
  return { code: sc << 8, char: e.key, shift };
}

export function keyName(code: number): string {
  const lo = code & 0xff;
  if (lo >= 0x20 && lo !== 0x7f) return String.fromCharCode(lo);
  for (const [n, v] of Object.entries(K)) if (v === code) return n;
  const sc = code >> 8;
  for (let mod = 0; mod < 4; mod++)
    for (let n = 1; n <= 12; n++)
      if (fKey(n, mod as 0 | 1 | 2 | 3) === code) return ['', 'Shift', 'Ctrl', 'Alt'][mod] + 'F' + n;
  return `0x${code.toString(16).padStart(4, '0')}(sc ${sc})`;
}
