// EXEC of a Windows helper program from FAND code, by the platform policy of
// src/helpers/dispatch.ts: the original .exe on Windows; on macOS/Linux the original .NET
// helper under the bundled Mono, a TypeScript port for native helpers, or a "not available"
// message. It runs in the helper worker while the engine thread blocks (runHelperSync), so
// dialogs of ports and messages are drawn on the FAND screen (the engine owns it); OS
// services go to the host. The FANDDOS/RUNPROC EXEC path calls execHelper() before falling
// back to the DOS shell.

import type { Crt } from './console/crt.ts';
import { K } from './console/keys.ts';
import { hostCall } from './hostbridge.ts';
import { runHelperSync, type SyncUi } from '../helpers/sync.ts';
import { routeOf } from '../helpers/registry.ts';
import { routeTimeoutMs } from '../helpers/dispatch.ts';
import { displayEnv } from '../helpers/mono.ts';

const ATTR_MSG = 0x4f; // white on red for errors, like FAND's error line
const ATTR_BOX = 0x70;

function box(crt: Crt, title: string, lines: string[], attr: number, footer: string): { restore: () => void; x: number; y: number; w: number } {
  const s = crt.screen;
  const w = Math.min(s.cols - 4, Math.max(title.length + 4, footer.length + 4, ...lines.map((l) => l.length + 4)));
  const h = lines.length + 4;
  const x1 = Math.floor((s.cols - w) / 2);
  const y1 = Math.max(0, Math.floor((s.rows - h) / 2));
  const r = { x1, y1, x2: x1 + w - 1, y2: y1 + h - 1 };
  const saved = s.saveRect(r);
  s.fillRect(r, ' ', attr);
  s.drawBox(r, attr, '╔═╗║╚╝', title);
  lines.forEach((l, i) => s.writeAt(x1 + 2, y1 + 1 + i, l.slice(0, w - 4), attr));
  s.writeAt(x1 + 2, r.y2 - 1, footer.slice(0, w - 4), attr);
  return { restore: () => s.restoreRect(r, saved), x: x1 + 2, y: r.y2 - 2, w: w - 4 };
}

const wrap = (text: string, width = 70) =>
  text.split(/\r?\n/).flatMap((line) => {
    const out: string[] = [];
    let l = line;
    while (l.length > width) {
      const cut = l.lastIndexOf(' ', width) > 20 ? l.lastIndexOf(' ', width) : width;
      out.push(l.slice(0, cut));
      l = l.slice(cut).trimStart();
    }
    out.push(l);
    return out;
  });

export function crtSyncUi(crt: Crt): SyncUi {
  return {
    message(title, text, kind) {
      const b = box(crt, title, wrap(text), kind === 'error' ? ATTR_MSG : ATTR_BOX, 'Pokračujte klávesou Enter / Esc');
      for (let k = crt.readKey()!.code; k !== K.Enter && k !== K.Esc; k = crt.readKey()!.code);
      b.restore();
    },
    confirm(title, text) {
      const b = box(crt, title, wrap(text), ATTR_BOX, 'A = ano, N = ne');
      for (;;) {
        const k = crt.readKey()!;
        const c = crt.charOf(k).toLowerCase();
        if (c === 'a' || c === 'y' || k.code === K.Enter) return b.restore(), true;
        if (c === 'n' || k.code === K.Esc) return b.restore(), false;
      }
    },
    prompt(title, label, initial, secret) {
      const b = box(crt, title, [...wrap(label), ''], ATTR_BOX, 'Enter = potvrdit, Esc = zrušit');
      let v = initial;
      const s = crt.screen;
      s.cursorVisible = true;
      for (;;) {
        const shown = secret ? '*'.repeat(v.length) : v;
        s.writeAt(b.x, b.y, shown.slice(-b.w).padEnd(b.w), 0x1f);
        s.cx = b.x + Math.min(shown.length, b.w - 1);
        s.cy = b.y;
        const k = crt.readKey()!;
        if (k.code === K.Enter) return b.restore(), v;
        if (k.code === K.Esc) return b.restore(), null;
        if (k.code === K.Backspace) v = v.slice(0, -1);
        else if ((k.code & 0xff) >= 0x20) v += crt.charOf(k);
      }
    },
    open: (t) => void hostCall('open', t),
    print: (p, o) => hostCall('print', p, o) as boolean,
    clipboardRead: () => hostCall('clipboardRead') as string,
    clipboardWrite: (t) => void hostCall('clipboardWrite', t),
    chooseFile: (o) => hostCall('chooseFile', o) as string | null,
    secretGet: (k) => hostCall('secretGet', k) as string | null,
    secretSet: (k, v) => void hostCall('secretSet', k, v),
  };
}

/**
 * Run the helper `exeHostPath` (original program or replacement). Returns the exit code, or
 * null when the program is not a helper (the caller then treats it as a DOS program/BAT).
 */
export function execHelper(crt: Crt, exeHostPath: string, args: string[], cwd: string, appDir: string): number | null {
  const route = routeOf(exeHostPath);
  if (!route) return null;
  crt.flush();
  // Linux GUI helpers (WinForms under Mono) need an X display; on a pure Wayland session use
  // XWayland's. macOS and Windows need nothing.
  const env = { ...process.env, ...displayEnv(process.env) };
  return runHelperSync({ exePath: exeHostPath, args, cwd, appDir, env }, crtSyncUi(crt), routeTimeoutMs(route));
}

/** Split an EXEC parameter string like DOS does (quotes group, spaces separate). */
export function splitArgs(params: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|(\S+)/g;
  for (let m; (m = re.exec(params)); ) out.push(m[1] ?? m[2]);
  return out;
}
