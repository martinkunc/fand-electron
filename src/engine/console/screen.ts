// Virtual DOS text-mode screen modelled on the Turbo Pascal CRT unit that PC FAND
// was written against. Coordinates in the public API are 1-based like CRT
// (GotoXY(1,1) is the top-left corner of the current window).

export interface Cell {
  ch: string; // one Unicode character (already converted from CP852)
  attr: number; // VGA attribute: low nibble fg, bits 4-6 bg, bit 7 blink
}

export interface ScreenSnapshot {
  cols: number;
  rows: number;
  cells: Cell[]; // row-major, rows*cols
  cursor: { x: number; y: number; visible: boolean }; // 0-based absolute
}

export interface ScreenDiff {
  rows: { y: number; cells: Cell[] }[];
  cursor: { x: number; y: number; visible: boolean };
  size?: { cols: number; rows: number };
}

export interface WindowRect {
  x1: number; // 0-based inclusive absolute coordinates
  y1: number;
  x2: number;
  y2: number;
}

export const BOX_SINGLE = '┌─┐│└┘';
export const BOX_DOUBLE = '╔═╗║╚╝';

export class Screen {
  cols: number;
  rows: number;
  private cells: Cell[];
  private dirty: Set<number> = new Set();
  private sizeChanged = false;
  /** Current text attribute (CRT TextAttr). */
  textAttr = 0x07;
  /** Current window (CRT WindMin/WindMax), absolute 0-based. */
  win: WindowRect;
  /** Cursor position, absolute 0-based. */
  cx = 0;
  cy = 0;
  cursorVisible = true;
  private listeners = new Set<() => void>();

  constructor(cols = 80, rows = 25) {
    this.cols = cols;
    this.rows = rows;
    this.cells = Screen.blank(cols * rows);
    this.win = { x1: 0, y1: 0, x2: cols - 1, y2: rows - 1 };
    this.markAll();
  }

  private static blank(n: number, attr = 0x07): Cell[] {
    return Array.from({ length: n }, () => ({ ch: ' ', attr }));
  }

  /** Change the text mode size (e.g. 80x43), clearing the screen. */
  setMode(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    this.cells = Screen.blank(cols * rows);
    this.win = { x1: 0, y1: 0, x2: cols - 1, y2: rows - 1 };
    this.cx = this.cy = 0;
    this.sizeChanged = true;
    this.markAll();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  private markAll(): void {
    for (let y = 0; y < this.rows; y++) this.dirty.add(y);
    this.notify();
  }

  private put(x: number, y: number, ch: string, attr: number): void {
    if (x < 0 || y < 0 || x >= this.cols || y >= this.rows) return;
    const c = this.cells[y * this.cols + x];
    if (c.ch === ch && c.attr === attr) return;
    c.ch = ch;
    c.attr = attr;
    this.dirty.add(y);
  }

  // ---- direct (absolute, 0-based) access ------------------------------------

  getCell(x: number, y: number): Cell {
    return this.cells[y * this.cols + x];
  }

  setCell(x: number, y: number, ch: string, attr = this.textAttr): void {
    this.put(x, y, ch, attr);
    this.notify();
  }

  /** Write a string at an absolute position without moving the cursor. */
  writeAt(x: number, y: number, text: string, attr = this.textAttr): void {
    for (let i = 0; i < text.length; i++) this.put(x + i, y, text[i], attr);
    this.notify();
  }

  fillRect(r: WindowRect, ch = ' ', attr = this.textAttr): void {
    for (let y = r.y1; y <= r.y2; y++) for (let x = r.x1; x <= r.x2; x++) this.put(x, y, ch, attr);
    this.notify();
  }

  /** Change attributes only, keeping characters (used for highlight bars). */
  paintAttr(r: WindowRect, attr: number): void {
    for (let y = r.y1; y <= r.y2; y++)
      for (let x = r.x1; x <= r.x2; x++) this.put(x, y, this.getCell(x, y).ch, attr);
    this.notify();
  }

  drawBox(r: WindowRect, attr = this.textAttr, chars = BOX_SINGLE, title?: string): void {
    const [tl, h, tr, v, bl, br] = chars;
    for (let x = r.x1 + 1; x < r.x2; x++) {
      this.put(x, r.y1, h, attr);
      this.put(x, r.y2, h, attr);
    }
    for (let y = r.y1 + 1; y < r.y2; y++) {
      this.put(r.x1, y, v, attr);
      this.put(r.x2, y, v, attr);
    }
    this.put(r.x1, r.y1, tl, attr);
    this.put(r.x2, r.y1, tr, attr);
    this.put(r.x1, r.y2, bl, attr);
    this.put(r.x2, r.y2, br, attr);
    if (title) {
      const t = ` ${title} `.slice(0, Math.max(0, r.x2 - r.x1 - 1));
      const x = r.x1 + Math.max(1, Math.floor((r.x2 - r.x1 + 1 - t.length) / 2));
      for (let i = 0; i < t.length; i++) this.put(x + i, r.y1, t[i], attr);
    }
    this.notify();
  }

  saveRect(r: WindowRect): Cell[] {
    const out: Cell[] = [];
    for (let y = r.y1; y <= r.y2; y++)
      for (let x = r.x1; x <= r.x2; x++) out.push({ ...this.getCell(x, y) });
    return out;
  }

  restoreRect(r: WindowRect, saved: Cell[]): void {
    let i = 0;
    for (let y = r.y1; y <= r.y2; y++)
      for (let x = r.x1; x <= r.x2; x++) {
        const c = saved[i++];
        this.put(x, y, c.ch, c.attr);
      }
    this.notify();
  }

  // ---- CRT unit compatible API (1-based, window relative) -------------------

  window(x1: number, y1: number, x2: number, y2: number): void {
    this.win = { x1: x1 - 1, y1: y1 - 1, x2: x2 - 1, y2: y2 - 1 };
    this.cx = this.win.x1;
    this.cy = this.win.y1;
    this.notify();
  }

  gotoXY(x: number, y: number): void {
    const ax = this.win.x1 + x - 1;
    const ay = this.win.y1 + y - 1;
    if (ax > this.win.x2 || ay > this.win.y2 || x < 1 || y < 1) return;
    this.cx = ax;
    this.cy = ay;
    this.notify();
  }

  whereX(): number {
    return this.cx - this.win.x1 + 1;
  }

  whereY(): number {
    return this.cy - this.win.y1 + 1;
  }

  clrScr(): void {
    this.fillRect(this.win, ' ', this.textAttr);
    this.cx = this.win.x1;
    this.cy = this.win.y1;
    this.notify();
  }

  clrEol(): void {
    for (let x = this.cx; x <= this.win.x2; x++) this.put(x, this.cy, ' ', this.textAttr);
    this.notify();
  }

  textColor(c: number): void {
    this.textAttr = (this.textAttr & 0x70) | (c & 0x8f);
  }

  textBackground(c: number): void {
    this.textAttr = (this.textAttr & 0x8f) | ((c & 0x07) << 4);
  }

  /** Scroll the region up by n lines, filling with blanks of the current attribute. */
  scrollUp(r: WindowRect = this.win, n = 1): void {
    for (let y = r.y1; y <= r.y2; y++)
      for (let x = r.x1; x <= r.x2; x++) {
        const src = y + n <= r.y2 ? this.getCell(x, y + n) : { ch: ' ', attr: this.textAttr };
        this.put(x, y, src.ch, src.attr);
      }
    this.notify();
  }

  scrollDown(r: WindowRect = this.win, n = 1): void {
    for (let y = r.y2; y >= r.y1; y--)
      for (let x = r.x1; x <= r.x2; x++) {
        const src = y - n >= r.y1 ? this.getCell(x, y - n) : { ch: ' ', attr: this.textAttr };
        this.put(x, y, src.ch, src.attr);
      }
    this.notify();
  }

  insLine(): void {
    this.scrollDown({ ...this.win, y1: this.cy });
  }

  delLine(): void {
    this.scrollUp({ ...this.win, y1: this.cy });
  }

  /** CRT Write: handles CR, LF, BS, BEL, wraps and scrolls inside the window. */
  write(text: string): void {
    for (const ch of text) {
      switch (ch) {
        case '\r':
          this.cx = this.win.x1;
          continue;
        case '\n':
          this.lineFeed();
          continue;
        case '\b':
          if (this.cx > this.win.x1) this.cx--;
          continue;
        case '\x07':
          continue;
      }
      this.put(this.cx, this.cy, ch, this.textAttr);
      if (++this.cx > this.win.x2) {
        this.cx = this.win.x1;
        this.lineFeed();
      }
    }
    this.notify();
  }

  writeln(text = ''): void {
    this.write(text + '\r\n');
  }

  private lineFeed(): void {
    if (this.cy < this.win.y2) this.cy++;
    else this.scrollUp();
  }

  // ---- snapshots / diffs for the renderer and test drivers ------------------

  snapshot(): ScreenSnapshot {
    return {
      cols: this.cols,
      rows: this.rows,
      cells: this.cells.map((c) => ({ ...c })),
      cursor: { x: this.cx, y: this.cy, visible: this.cursorVisible },
    };
  }

  /** Collect rows changed since the last call. */
  takeDiff(): ScreenDiff | null {
    const cursor = { x: this.cx, y: this.cy, visible: this.cursorVisible };
    const rows = [...this.dirty].sort((a, b) => a - b).map((y) => ({
      y,
      cells: this.cells.slice(y * this.cols, (y + 1) * this.cols).map((c) => ({ ...c })),
    }));
    this.dirty.clear();
    const diff: ScreenDiff = { rows, cursor };
    if (this.sizeChanged) {
      diff.size = { cols: this.cols, rows: this.rows };
      this.sizeChanged = false;
    }
    return diff;
  }

  /** Plain-text dump, one line per row (used by test drivers). */
  text(): string {
    const lines: string[] = [];
    for (let y = 0; y < this.rows; y++) {
      let s = '';
      for (let x = 0; x < this.cols; x++) s += this.getCell(x, y).ch;
      lines.push(s.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }

  rowText(y: number): string {
    let s = '';
    for (let x = 0; x < this.cols; x++) s += this.getCell(x, y).ch;
    return s;
  }
}
