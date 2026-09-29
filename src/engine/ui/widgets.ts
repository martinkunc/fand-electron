// Small text-mode UI helpers in FAND's visual style, built on Crt.

import type { Crt } from '../console/crt.ts';
import { K } from '../console/keys.ts';

export const ATTR = {
  desktop: 0x17, // white on blue
  frame: 0x1f,
  status: 0x30, // black on cyan
  statusKey: 0x34,
  highlight: 0x70, // black on light grey
  menu: 0x70,
  menuSel: 0x0f,
  error: 0x4f,
  text: 0x07,
};

export interface ListItem {
  text: string;
  attr?: number;
}

/** Status line at the bottom: "F1 Help  Esc Konec" with highlighted key names. */
export function statusLine(crt: Crt, parts: [string, string][]): void {
  const s = crt.screen;
  const y = s.rows - 1;
  s.fillRect({ x1: 0, y1: y, x2: s.cols - 1, y2: y }, ' ', ATTR.status);
  let x = 1;
  for (const [key, label] of parts) {
    s.writeAt(x, y, key, ATTR.statusKey);
    x += key.length;
    s.writeAt(x, y, ' ' + label + '  ', ATTR.status);
    x += label.length + 3;
  }
}

export function message(crt: Crt, text: string, attr = ATTR.error): void {
  const s = crt.screen;
  const w = Math.min(s.cols - 4, text.length + 4);
  const x1 = Math.floor((s.cols - w) / 2);
  const y1 = Math.floor(s.rows / 2) - 1;
  const r = { x1, y1, x2: x1 + w - 1, y2: y1 + 2 };
  const saved = s.saveRect(r);
  s.fillRect(r, ' ', attr);
  s.drawBox(r, attr);
  s.writeAt(x1 + 2, y1 + 1, text.slice(0, w - 4), attr);
  crt.readKey();
  s.restoreRect(r, saved);
}

/**
 * Scrollable list inside a framed box. Returns the chosen index or -1 on Esc.
 * `onKey` may handle extra keys; returning a number ends the list with that result.
 */
export function listBox(
  crt: Crt,
  opts: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    title?: string;
    items: ListItem[];
    initial?: number;
    onKey?: (code: number, index: number) => number | undefined;
    onMove?: (index: number) => void;
  },
): number {
  const s = crt.screen;
  const { x1, y1, x2, y2, items } = opts;
  const h = y2 - y1 - 1;
  const w = x2 - x1 - 1;
  let cur = Math.min(opts.initial ?? 0, Math.max(0, items.length - 1));
  let top = Math.max(0, cur - h + 1);
  s.cursorVisible = false;
  const draw = () => {
    s.fillRect({ x1, y1, x2, y2 }, ' ', ATTR.desktop);
    s.drawBox({ x1, y1, x2, y2 }, ATTR.frame, '╔═╗║╚╝', opts.title);
    for (let i = 0; i < h; i++) {
      const it = items[top + i];
      if (!it) break;
      const sel = top + i === cur;
      s.writeAt(x1 + 1, y1 + 1 + i, (' ' + it.text).padEnd(w).slice(0, w), sel ? ATTR.highlight : (it.attr ?? ATTR.desktop));
    }
    if (items.length > h) {
      s.writeAt(x2 - 12, y2, ` ${cur + 1}/${items.length} `, ATTR.frame);
    }
  };
  for (;;) {
    draw();
    opts.onMove?.(cur);
    const k = crt.readKey()!.code;
    const r = opts.onKey?.(k, cur);
    if (r !== undefined) return r;
    switch (k) {
      case K.Up: cur = Math.max(0, cur - 1); break;
      case K.Down: cur = Math.min(items.length - 1, cur + 1); break;
      case K.PgUp: cur = Math.max(0, cur - h); break;
      case K.PgDn: cur = Math.min(items.length - 1, cur + h); break;
      case K.Home: case K.CtrlHome: cur = 0; break;
      case K.End: case K.CtrlEnd: cur = items.length - 1; break;
      case K.Enter: return cur;
      case K.Esc: return -1;
      default: {
        // Type-ahead: jump to the next item starting with the typed letter.
        const ch = String.fromCharCode(k & 0xff).toLowerCase();
        if ((k & 0xff) >= 0x20) {
          for (let i = 1; i <= items.length; i++) {
            const j = (cur + i) % items.length;
            if (items[j].text.trimStart().toLowerCase().startsWith(ch)) { cur = j; break; }
          }
        }
      }
    }
    if (cur < top) top = cur;
    if (cur >= top + h) top = cur - h + 1;
  }
}

/** Read-only text viewer (like FAND's editor in view mode). */
export function textViewer(crt: Crt, title: string, text: string): void {
  const s = crt.screen;
  const lines = text.split('\n');
  const r = { x1: 0, y1: 0, x2: s.cols - 1, y2: s.rows - 2 };
  const h = r.y2 - r.y1 - 1;
  const w = r.x2 - r.x1 - 1;
  let top = 0;
  let left = 0;
  statusLine(crt, [['Esc', 'Zpět'], ['↑↓ PgUp PgDn', 'Posun'], ['←→', 'Vodorovně']]);
  s.cursorVisible = false;
  for (;;) {
    s.fillRect(r, ' ', ATTR.desktop);
    s.drawBox(r, ATTR.frame, '╔═╗║╚╝', title);
    for (let i = 0; i < h && top + i < lines.length; i++) {
      // FAND highlight control chars ^A ^B ^D ^W ... are shown as colour switches.
      let x = r.x1 + 1;
      let attr = ATTR.desktop;
      const line = lines[top + i];
      let col = 0;
      for (const ch of line) {
        const c = ch.charCodeAt(0);
        if (c < 0x20 && c !== 9) {
          attr = attr === ATTR.desktop ? 0x1e : ATTR.desktop;
          continue;
        }
        if (col >= left && x <= r.x2 - 1) s.setCell(x++, r.y1 + 1 + i, c === 9 ? ' ' : ch, attr);
        col++;
      }
    }
    s.writeAt(r.x2 - 16, r.y2, ` ${top + 1}/${lines.length} `.padStart(12, '═'), ATTR.frame);
    const k = crt.readKey()!.code;
    switch (k) {
      case K.Esc: return;
      case K.Up: top = Math.max(0, top - 1); break;
      case K.Down: top = Math.min(Math.max(0, lines.length - h), top + 1); break;
      case K.PgUp: top = Math.max(0, top - h); break;
      case K.PgDn: top = Math.min(Math.max(0, lines.length - h), top + h); break;
      case K.CtrlHome: case K.Home: top = 0; left = 0; break;
      case K.CtrlEnd: case K.End: top = Math.max(0, lines.length - h); break;
      case K.Left: left = Math.max(0, left - 8); break;
      case K.Right: left += 8; break;
    }
    void w;
  }
}
