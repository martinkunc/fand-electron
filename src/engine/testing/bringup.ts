// Bring-up comparisons: the same keys are typed into the reference PC FAND (RefFandDriver) and
// into our engine (EngineDriver), each on a fresh copy of the task, and the screens after every
// step are compared. Runs happen one after the other on the SAME path (the task directory is
// renamed away after each run), so paths the application stores or shows are equal on both sides.
//
// Screen noise that is normalized:
// * trailing blanks (xterm keeps written spaces, our screen text trims them);
// * clock times hh:mm[:ss] (reports and status lines print the time);
// * CP852 characters below 0x20: the reference writes them raw to its terminal, where xterm drops
//   them (◄┘, ↑F6 ...) and the rest of that write moves one column left, leaving one stale cell
//   (glyphAligned); failing that, a line where ours shows such a glyph is compared without those
//   glyphs, without blanks and with repeated characters collapsed;
// * whatever the caller's `mask` rewrites on both sides (known differences, see diffScreens).

import { CP852_TO_UNICODE } from '../console/cp852.ts';
import { K, fKey } from '../console/keys.ts';

export interface ScreenDriver {
  text(): string;
  press(...keys: (string | number)[]): unknown;
  waitFor(what: string | RegExp, timeoutMs?: number): Promise<string>;
}

export interface Step {
  /** what the step does (reported with a difference) */
  name: string;
  /** keys: strings are typed, numbers are BIOS key codes */
  keys: (string | number)[];
  /** wait until the screen shows this before settling (both sides) */
  wait?: string | RegExp;
  /** quiet time the screen must stay unchanged (ms, default 500) */
  settle?: number;
  /** pause between keys (ms, default 150): menus may flush keys typed ahead */
  gap?: number;
  /**
   * type the keys only when the screen matches (a dialog one side shows and the other does not,
   * for a known reason); the step's screen is recorded either way
   */
  onlyIf?: RegExp;
}

export interface StepScreen {
  step: string;
  screen: string;
  /** set when `wait` did not show up */
  timeout?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the screen text has not changed for `quietMs` (at most `maxMs`). */
export async function settle(d: ScreenDriver, quietMs = 500, maxMs = 30000): Promise<string> {
  const deadline = Date.now() + maxMs;
  let t = d.text();
  let since = Date.now();
  for (;;) {
    await sleep(100);
    const u = d.text();
    if (u !== t) {
      t = u;
      since = Date.now();
    } else if (Date.now() - since >= quietMs || Date.now() > deadline) return u;
  }
}

/** Type the steps' keys and record the screen after each step. */
export async function runSteps(d: ScreenDriver, steps: Step[]): Promise<StepScreen[]> {
  const out: StepScreen[] = [];
  for (const s of steps) {
    const keys = s.onlyIf && !s.onlyIf.test(d.text()) ? [] : s.keys;
    for (const k of keys) {
      d.press(k);
      await sleep(s.gap ?? 150);
    }
    let timeout: string | undefined;
    if (s.wait) {
      try {
        await d.waitFor(s.wait, 30000);
      } catch (e) {
        timeout = (e as Error).message.split('\n')[0];
      }
    }
    out.push({ step: s.name, screen: await settle(d, s.settle ?? 500), timeout });
  }
  return out;
}

/** Press Esc until the quit question shows, then confirm it. */
export async function quitUcto(d: ScreenDriver & { exited: Promise<number> }, maxEsc = 8): Promise<number> {
  for (let i = 0; i < maxEsc; i++) {
    if (/Ukončit program účto/.test(d.text())) break;
    d.press(K.Esc);
    await settle(d, 400, 5000);
  }
  if (!/Ukončit program účto/.test(d.text())) throw new Error(`no quit question\n--- screen ---\n${d.text()}`);
  d.press(K.Enter);
  return Promise.race([d.exited, sleep(20000).then(() => -2)]);
}

const CTRL_GLYPHS = new Set(CP852_TO_UNICODE.slice(1, 32));

export function normalizeScreen(t: string): string[] {
  return t.split('\n').map((l) => l.trimEnd().replace(/\b\d{1,2}:\d\d(:\d\d)?\b/g, (m) => '#'.repeat(m.length)));
}

/**
 * Aligns our line with the reference's where the reference dropped the glyphs: a dropped glyph
 * takes no cell, and the write that held it ends one column early, so somewhere after it one cell
 * of the reference keeps its old content (a blank, a frame, a character of a closed popup). A glyph
 * may also sit in a cell of its own (cursor positioned): then the reference's cell is stale.
 */
function glyphAligned(ref: string, ours: string): boolean {
  const r = [...ref];
  const o = [...ours];
  const seen = new Set<string>();
  const go = (i: number, j: number, debt: number): boolean => {
    if (i === o.length) return j === r.length || debt >= r.length - j || r.slice(j).every((c) => c === ' ');
    const key = `${i},${j},${debt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const c = o[i];
    if (CTRL_GLYPHS.has(c)) {
      if (go(i + 1, j, debt + 1)) return true; // dropped: a stale cell follows later
      if (j < r.length && go(i + 1, j + 1, debt)) return true; // own cell: stale
      if (j >= r.length && go(i + 1, j, debt)) return true;
    } else if (c === (r[j] ?? ' ') && go(i + 1, j + 1, debt)) return true;
    // pay a debt: the reference's cell j is a stale one
    return debt > 0 && j < r.length && go(i, j + 1, debt - 1);
  };
  return go(0, 0, 0);
}

function sameLine(ref: string, ours: string): boolean {
  if (ref === ours) return true;
  if (![...ours].some((c) => CTRL_GLYPHS.has(c))) return false;
  if (glyphAligned(ref, ours)) return true;
  // fallback: without glyphs, without blanks and with repeated characters collapsed
  const strip = (s: string) => [...s].filter((c) => !CTRL_GLYPHS.has(c) && c !== ' ').join('').replace(/(.)\1+/g, '$1');
  return strip(ref) === strip(ours);
}

export interface ScreenDiff {
  step: string;
  lines: { y: number; ref: string; ours: string }[];
}

/**
 * The lines that differ (after normalization) between the reference's and our screens. `mask`
 * rewrites both sides' lines before they are compared (known, explained differences).
 */
export function diffScreens(ref: StepScreen[], ours: StepScreen[], mask?: (line: string, y: number) => string): ScreenDiff[] {
  const out: ScreenDiff[] = [];
  const n = Math.max(ref.length, ours.length);
  const norm = (t: string) => normalizeScreen(t).map((l, y) => (mask ? mask(l, y) : l));
  for (let i = 0; i < n; i++) {
    const r = norm(ref[i]?.screen ?? '');
    const o = norm(ours[i]?.screen ?? '');
    const lines: ScreenDiff['lines'] = [];
    for (let y = 0; y < Math.max(r.length, o.length); y++) {
      if (!sameLine(r[y] ?? '', o[y] ?? '')) lines.push({ y, ref: r[y] ?? '', ours: o[y] ?? '' });
    }
    if (lines.length || ref[i]?.timeout || ours[i]?.timeout) {
      const step = ref[i]?.step ?? ours[i]?.step ?? `#${i}`;
      if (ref[i]?.timeout) lines.unshift({ y: -1, ref: ref[i].timeout!, ours: '' });
      if (ours[i]?.timeout) lines.unshift({ y: -1, ref: '', ours: ours[i].timeout! });
      out.push({ step, lines });
    }
  }
  return out;
}

export function formatScreenDiffs(d: ScreenDiff[]): string {
  return d
    .map((s) => `step "${s.step}":\n` + s.lines.map((l) => `  ${String(l.y).padStart(2)} ref |${l.ref}\n  ${String(l.y).padStart(2)} ours|${l.ours}`).join('\n'))
    .join('\n');
}

export { K, fKey };
