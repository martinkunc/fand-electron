// Project manager: the RDB chapter list shown when a task is opened for
// development (PC FAND's "úloha" editing mode, pas/PROJMGR.PAS). Here it is read-only
// and doubles as a development tool until the interpreter runs the task itself.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Crt } from '../console/crt.ts';
import { K, fKey } from '../console/keys.ts';
import { Rdb, CHAPTER_TYPE_NAMES } from '../fand/rdb.ts';
import { ATTR, listBox, statusLine, textViewer, message } from '../ui/widgets.ts';

export function chooseProject(crt: Crt, appDir: string, initial?: string): string | null {
  const projects = readdirSync(appDir)
    .filter((f) => /\.(rdb|pro)$/i.test(f))
    .sort((a, b) => (/\.rdb$/i.test(b) ? 1 : 0) - (/\.rdb$/i.test(a) ? 1 : 0) || a.localeCompare(b));
  const s = crt.screen;
  s.textAttr = ATTR.desktop;
  s.fillRect({ x1: 0, y1: 0, x2: s.cols - 1, y2: s.rows - 1 }, '░', 0x17);
  statusLine(crt, [['Enter', 'Otevřít'], ['Esc', 'Konec']]);
  const idx = listBox(crt, {
    x1: 24, y1: 2, x2: 55, y2: s.rows - 3,
    title: 'Úlohy',
    items: projects.map((p) => ({ text: p })),
    initial: Math.max(0, projects.findIndex((p) => p.toLowerCase() === initial?.toLowerCase())),
  });
  return idx < 0 ? null : projects[idx];
}

export function projectManager(crt: Crt, appDir: string, project: string): void {
  let rdb: Rdb;
  try {
    rdb = new Rdb(join(appDir, project));
  } catch (e) {
    message(crt, `Chyba: ${(e as Error).message}`);
    return;
  }
  const s = crt.screen;
  let cur = 0;
  try {
    for (;;) {
      s.fillRect({ x1: 0, y1: 0, x2: s.cols - 1, y2: s.rows - 1 }, ' ', ATTR.desktop);
      statusLine(crt, [['Enter', 'Zobrazit'], ['F3', 'Hledat'], ['Esc', 'Zpět']]);
      const lic = rdb.tfile.licenseNr ? ` lic.${rdb.tfile.licenseNr}` : '';
      const items = rdb.chapters.map((c) => ({
        text: `${c.typ} ${c.name.padEnd(12)} ${(CHAPTER_TYPE_NAMES[c.typ] ?? '').padEnd(17)} ${firstLine(rdb, c)}`,
      }));
      let search = '';
      cur = listBox(crt, {
        x1: 0, y1: 0, x2: s.cols - 1, y2: s.rows - 2,
        title: `${project} (${rdb.chapters.length} kapitol${lic})`,
        items,
        initial: cur,
        onKey: (code, i) => {
          if (code === fKey(3)) {
            search = prompt(crt, 'Hledat text:', search);
            if (!search) return undefined;
            const needle = search.toLowerCase();
            for (let j = 1; j <= rdb.chapters.length; j++) {
              const n = (i + j) % rdb.chapters.length;
              const ch = rdb.chapters[n];
              if (ch.name.toLowerCase().includes(needle) || safeText(rdb, n).toLowerCase().includes(needle)) return -100 - n;
            }
            message(crt, `"${search}" nenalezeno`, 0x70);
          }
          return undefined;
        },
      });
      if (cur <= -100) {
        cur = -100 - cur;
        continue;
      }
      if (cur < 0) return;
      const ch = rdb.chapters[cur];
      textViewer(crt, `${ch.typ} ${ch.name || '(bez jména)'} - ${project}`, safeText(rdb, cur));
    }
  } finally {
    rdb.close();
  }
}

function safeText(rdb: Rdb, i: number): string {
  try {
    return rdb.text(rdb.chapters[i]);
  } catch (e) {
    return `*** ${(e as Error).message}`;
  }
}

function firstLine(rdb: Rdb, c: Rdb['chapters'][number]): string {
  try {
    return rdb.text(c).replace(/\s+/g, ' ').trim().slice(0, 40);
  } catch {
    return '?';
  }
}

/** One-line input box. */
export function prompt(crt: Crt, label: string, initial = ''): string {
  const s = crt.screen;
  const w = 50;
  const x1 = Math.floor((s.cols - w) / 2);
  const y1 = Math.floor(s.rows / 2) - 1;
  const r = { x1, y1, x2: x1 + w - 1, y2: y1 + 2 };
  const saved = s.saveRect(r);
  let v = initial;
  s.cursorVisible = true;
  for (;;) {
    s.fillRect(r, ' ', ATTR.menu);
    s.drawBox(r, ATTR.menu);
    s.writeAt(x1 + 2, y1 + 1, label, ATTR.menu);
    const fx = x1 + 3 + label.length;
    const fw = r.x2 - fx - 1;
    s.writeAt(fx, y1 + 1, v.slice(-fw).padEnd(fw), 0x1f);
    s.cx = fx + Math.min(v.length, fw - 1);
    s.cy = y1 + 1;
    const k = crt.readKey()!;
    if (k.code === K.Enter || k.code === K.Esc) {
      s.restoreRect(r, saved);
      s.cursorVisible = false;
      return k.code === K.Esc ? '' : v;
    }
    if (k.code === K.Backspace) v = v.slice(0, -1);
    else if ((k.code & 0xff) >= 0x20) v += crt.charOf(k);
  }
}
