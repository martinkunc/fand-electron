// DOS text-mode console. Renders the engine's cell grid exactly like VGA text mode:
// PC FAND's own 8x16 Latin-2 (CP852) font, 9-dot character cells (with the 9th column
// repeated for box-drawing characters C0h-DFh), the 16-colour VGA palette and a
// blinking underline cursor. Keystrokes are forwarded as BIOS key codes.

import { useEffect, useRef, useState } from 'react';
import type { Cell, ScreenDiff } from '../../engine/console/screen';
import type { FandApi } from '../../preload';
import { domToDos } from '../../engine/console/keys';
import { UNICODE_KEY } from '../../engine/console/crt';
import { charToByte } from '../../engine/console/cp852';

declare global {
  interface Window {
    fand: FandApi;
  }
}

// Standard VGA text palette as 0xAABBGGRR (little-endian ImageData words).
const VGA_RGB = [
  0x000000, 0x0000aa, 0x00aa00, 0x00aaaa, 0xaa0000, 0xaa00aa, 0xaa5500, 0xaaaaaa,
  0x555555, 0x5555ff, 0x55ff55, 0x55ffff, 0xff5555, 0xff55ff, 0xffff55, 0xffffff,
];
const VGA = VGA_RGB.map((c) => 0xff000000 | ((c & 0xff) << 16) | (c & 0xff00) | ((c >> 16) & 0xff));

const CELL_W = 9;
const CELL_H = 16;

function blank(cols: number, rows: number): Cell[] {
  return Array.from({ length: cols * rows }, () => ({ ch: ' ', attr: 7 }));
}

class TextRenderer {
  cols = 80;
  rows = 25;
  cells: Cell[] = blank(80, 25);
  cursor = { x: 0, y: 0, visible: true };
  private font: Uint8Array | null = null;
  private img: ImageData;
  private px: Uint32Array;
  private dirty = new Set<number>();
  private ctx: CanvasRenderingContext2D;
  blinkOn = true;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    this.img = this.resize();
    this.px = new Uint32Array(this.img.data.buffer);
  }

  private resize(): ImageData {
    this.canvas.width = this.cols * CELL_W;
    this.canvas.height = this.rows * CELL_H;
    this.img = this.ctx.createImageData(this.canvas.width, this.canvas.height);
    this.px = new Uint32Array(this.img.data.buffer);
    for (let y = 0; y < this.rows; y++) this.dirty.add(y);
    return this.img;
  }

  setFont(f: Uint8Array): void {
    this.font = f;
    for (let y = 0; y < this.rows; y++) this.dirty.add(y);
  }

  apply(d: ScreenDiff): void {
    if (d.size) {
      this.cols = d.size.cols;
      this.rows = d.size.rows;
      this.cells = blank(this.cols, this.rows);
      this.resize();
    }
    for (const r of d.rows) {
      for (let x = 0; x < r.cells.length; x++) this.cells[r.y * this.cols + x] = r.cells[x];
      this.dirty.add(r.y);
    }
    this.dirty.add(this.cursor.y);
    this.cursor = d.cursor;
    this.dirty.add(this.cursor.y);
  }

  touchCursor(): void {
    this.dirty.add(this.cursor.y);
  }

  draw(): void {
    if (!this.font || this.dirty.size === 0) return;
    const W = this.canvas.width;
    const font = this.font;
    for (const y of this.dirty) {
      for (let x = 0; x < this.cols; x++) {
        const c = this.cells[y * this.cols + x];
        const code = charToByte(c.ch);
        // Bit 7 is shown as bright background (blink disabled), as FAND sets up VGA.
        const fg = VGA[c.attr & 0x0f];
        const bg = VGA[(c.attr >> 4) & 0x0f];
        const box = code >= 0xc0 && code <= 0xdf;
        const cursorRow = this.cursor.visible && this.blinkOn && this.cursor.x === x && this.cursor.y === y;
        for (let gy = 0; gy < CELL_H; gy++) {
          let bits = font[code * CELL_H + gy];
          if (cursorRow && gy >= 13 && gy <= 14) bits = 0xff;
          let p = (y * CELL_H + gy) * W + x * CELL_W;
          for (let gx = 0; gx < 8; gx++) this.px[p++] = bits & (0x80 >> gx) ? fg : bg;
          this.px[p] = box && bits & 1 ? fg : cursorRow && gy >= 13 && gy <= 14 ? fg : bg;
        }
      }
    }
    this.dirty.clear();
    this.ctx.putImageData(this.img, 0, 0);
  }
}

export function Console() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [size, setSize] = useState({ w: 720, h: 400 });

  useEffect(() => {
    const r = new TextRenderer(canvasRef.current!);
    let raf = 0;
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(() => {
        raf = 0;
        r.draw();
      });
    };
    fetch('./fonts/8X16LAT')
      .then((res) => res.arrayBuffer())
      .then((b) => {
        r.setFont(new Uint8Array(b));
        schedule();
      });
    const offScreen = window.fand.onScreen((d: ScreenDiff) => {
      const resized = !!d.size;
      r.apply(d);
      if (resized) setSize({ w: r.cols * CELL_W, h: r.rows * CELL_H });
      schedule();
    });
    const offErr = window.fand.onError(setError);
    const blink = setInterval(() => {
      r.blinkOn = !r.blinkOn;
      r.touchCursor();
      schedule();
    }, 270);
    const onKey = (e: KeyboardEvent) => {
      const k = domToDos(e);
      e.preventDefault();
      if (!k) return;
      r.blinkOn = true;
      if (k.char !== undefined && k.char.length === 1) {
        window.fand.sendKey(UNICODE_KEY | ((k.code >> 8) << 16) | k.char.charCodeAt(0), k.shift);
      } else {
        window.fand.sendKey(k.code, k.shift);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      offScreen();
      offErr();
      clearInterval(blink);
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  // Scale the 720x400 VGA picture to the window, keeping the 4:3 CRT aspect ratio.
  const [scale, setScale] = useState({ x: 1, y: 1 });
  useEffect(() => {
    const fit = () => {
      const aspectH = size.w * 0.75; // a 720x400 mode was displayed on a 4:3 screen
      const k = Math.min(window.innerWidth / size.w, window.innerHeight / aspectH);
      setScale({ x: k, y: (k * aspectH) / size.h });
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [size]);

  return (
    <div className="screen" ref={wrapRef}>
      <canvas
        ref={canvasRef}
        className="vga"
        style={{ width: size.w * scale.x, height: size.h * scale.y }}
      />
      {error && (
        <pre className="error" onClick={() => setError(null)}>
          {error}
        </pre>
      )}
    </div>
  );
}
