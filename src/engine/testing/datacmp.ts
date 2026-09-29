// Comparing what two FAND runs left on disk (bring-up: the reference PC FAND versus our
// engine, each on its own copy of a task at the same path). Data files are compared record by
// record and field by field, using the task's own file declarations (F chapters of its .RDB and
// .PRO projects), so a difference is reported with the file, record and field it is in. Text
// fields (T) are compared by the texts they point to, not by the .Txx bytes: a .Txx keeps freed
// pages with stale text, and its header is XORed with a Random stream that differs between builds.
//
// Noise that is masked (see docs/REFERENCE.md and docs/PORTING.md for the reasons):
// * clock: D/R values that are both date+time (or both short durations) within `clockTolerance`
//   days of each other (today+currtime stamps, session times);
// * Real48 precision: values equal to 1e-6 relative (the FPC reference computes time literals in
//   Single precision: COMMONFPC.PAS RDate `360000.0*hh/8640000.0` with Single-typed constants);
// * catalogs (.CAT): path separators and case ('/' and '{prik}' in the reference, '\' and '{PRIK}'
//   in ours, as the DOS build writes them).
// Index files (.Xnn) are only compared by existence: their key bytes legitimately differ (BP7 'ch'
// collation and Real48 keys, which the FPC reference gets wrong).

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { DataFile } from '../fand/datafile.ts';
import { TFile } from '../fand/tfile.ts';
import { Rdb } from '../fand/rdb.ts';
import { readReal48, readFix, unpackBcd, TAB_F } from '../fand/numbers.ts';
import { decode852 } from '../console/cp852.ts';

export interface FieldDecl {
  name: string;
  typ: string; // A N F R D B T
  ofs: number;
  len: number;
  dec: number; // F: decimals
}

export interface FileDecl {
  name: string; // chapter name without the '.X' suffix
  project: string;
  indexed: boolean; // X file: 1-byte deleted flag before the fields
  fields: FieldDecl[];
  recLen: number;
}

export interface Difference {
  file: string; // path relative to the task directory
  what: string;
}

// ---------------------------------------------------------------- declarations

const TabF = TAB_F;

/** Length of an A field with a mask (RDFILDCL.RdFldDescr): '(a|bc)' counts its widest variant. */
function maskLen(s: string): number {
  let L = 0;
  let c = '?';
  let n = 0;
  let n1 = 0;
  for (const ch of s) {
    if (ch === '[' || ch === ']') continue;
    if (ch === '(') (c = '('), (n1 = 0), (n = 0);
    else if (ch === ')') (c = '?'), (L += Math.max(n1, n));
    else if (ch === '|') (n = Math.max(n1, n)), (n1 = 0);
    else if (c === '(') n1++;
    else L++;
  }
  return L;
}

/** The stored fields of an F chapter (the part before the first '#'). */
export function parseFileDecl(name: string, project: string, text: string): FileDecl | null {
  const indexed = /\.X$/i.test(name);
  let src = text.replace(/\{[^}]*\}/g, ' ');
  // cut at the first '#' outside quotes
  let q = false;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === "'") q = !q;
    else if (!q && src[i] === '#') {
      src = src.slice(0, i);
      break;
    }
  }
  if (/^\s*like\b/i.test(src)) return null;
  const parts: string[] = [];
  let cur = '';
  q = false;
  for (const ch of src) {
    if (ch === "'") q = !q;
    if (!q && ch === ';') {
      parts.push(cur);
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const fields: FieldDecl[] = [];
  let ofs = indexed ? 1 : 0;
  for (const p of parts) {
    const m = /^\s*([^:\s]+)\s*:\s*([A-Za-z])\s*(?:,\s*(.*?))?\s*$/s.exec(p);
    if (!m) {
      if (p.trim()) return null;
      continue;
    }
    const typ = m[2].toUpperCase();
    const spec = (m[3] ?? '').replace(/!\s*$/, '').trim();
    let len = 0;
    let dec = 0;
    switch (typ) {
      case 'A': {
        const qm = /^'(.*)'$/s.exec(spec);
        len = qm ? maskLen(qm[1].replace(/''/g, "'")) : parseInt(spec, 10);
        break;
      }
      case 'N':
        len = (parseInt(spec, 10) + 1) >> 1;
        break;
      case 'F': {
        const fm = /^(\d+)\s*[.,]\s*(\d+)/.exec(spec);
        if (!fm) return null;
        dec = +fm[2];
        len = TabF[+fm[1] + dec];
        break;
      }
      case 'R':
      case 'D':
        len = 6;
        break;
      case 'B':
        len = 1;
        break;
      case 'T':
        len = 4;
        break;
      default:
        return null;
    }
    if (!(len > 0)) return null;
    fields.push({ name: m[1], typ, ofs, len, dec });
    ofs += len;
  }
  return { name: name.replace(/\.X$/i, '').toUpperCase(), project, indexed, fields, recLen: ofs };
}

/** All file declarations of the task's projects (.RDB and .PRO in `appDir`), by file name. */
export function loadFileDecls(appDir: string): Map<string, FileDecl[]> {
  const out = new Map<string, FileDecl[]>();
  const projects = readdirSync(appDir).filter((f) => /\.(rdb|pro)$/i.test(f));
  // the task's own project first: its declarations win when names repeat
  projects.sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  for (const p of projects) {
    let rdb: Rdb;
    try {
      rdb = new Rdb(join(appDir, p));
    } catch {
      continue;
    }
    try {
      for (const ch of rdb.chapters) {
        if (ch.typ !== 'F') continue;
        let d: FileDecl | null = null;
        try {
          d = parseFileDecl(ch.name, p, rdb.text(ch));
        } catch {
          d = null;
        }
        if (!d) continue;
        const l = out.get(d.name) ?? [];
        l.push(d);
        out.set(d.name, l);
      }
    } finally {
      rdb.close();
    }
  }
  return out;
}
function rank(p: string): number {
  if (/^UCTO\d*\.RDB$/i.test(p)) return 0;
  if (/^MODUL/i.test(p)) return 1;
  if (/\.RDB$/i.test(p)) return 3;
  return 2;
}

// ---------------------------------------------------------------- values

function fieldValue(f: FieldDecl, rec: Uint8Array): string {
  const b = rec.subarray(f.ofs, f.ofs + f.len);
  if (b.every((x) => x === 0xff)) return 'null';
  switch (f.typ) {
    case 'A':
      return JSON.stringify(decode852(b));
    case 'N':
      return unpackBcd(rec, f.ofs, f.len * 2);
    case 'F':
      return String(readFix(rec, f.ofs, f.len) / 10 ** f.dec);
    case 'R':
    case 'D':
      return String(readReal48(rec, f.ofs));
    case 'B':
      return b[0] === 0 ? 'false' : 'true';
    case 'T':
      return `@${new DataView(b.buffer, b.byteOffset, 4).getInt32(0, true)}`;
  }
  return Buffer.from(b).toString('hex');
}

const DATE_LO = 600000; // day numbers of dates (1.1.0001 = 1); 1.1.1900 = 693596
const DATE_HI = 800000;

function sameReal(a: number, b: number, clockTolerance: number): boolean {
  if (a === b) return true;
  if (Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b))) return true; // precision
  const isStamp = (x: number) => x >= DATE_LO && x < DATE_HI;
  const isSpan = (x: number) => x >= 0 && x < 1;
  if ((isStamp(a) && isStamp(b)) || (isSpan(a) && isSpan(b))) return Math.abs(a - b) <= clockTolerance;
  return false;
}

// ---------------------------------------------------------------- files

function textFileOf(dataPath: string): string | null {
  const ext = extname(dataPath);
  if (ext.length < 2) return null;
  const stem = dataPath.slice(0, dataPath.length - ext.length);
  for (const e of ['T' + ext.slice(2), 't' + ext.slice(2)]) if (existsSync(`${stem}.${e}`)) return `${stem}.${e}`;
  return null;
}

class Texts {
  private t: TFile | null;
  constructor(path: string | null) {
    this.t = path ? new TFile(path) : null;
  }
  read(pos: number): string {
    if (!this.t || pos <= 0) return '';
    try {
      return decode852(this.t.read(pos), true);
    } catch (e) {
      return `<${(e as Error).message}>`;
    }
  }
  close(): void {
    this.t?.close();
  }
}

/** Compare two data files record by record with a declaration; null when none fits. */
function compareDataFile(rel: string, refPath: string, engPath: string, decls: FileDecl[] | undefined, clockTolerance: number): Difference[] | null {
  const r = new DataFile(refPath);
  const e = new DataFile(engPath);
  const rt = new Texts(textFileOf(refPath));
  const et = new Texts(textFileOf(engPath));
  try {
    const d = decls?.find((x) => x.recLen === r.recLen && x.indexed === (r.kind === 'X'));
    if (!d) return null;
    const out: Difference[] = [];
    if (r.kind !== e.kind || r.recLen !== e.recLen || r.nRecs !== e.nRecs) {
      out.push({ file: rel, what: `header: ref ${r.kind} ${r.nRecs}x${r.recLen}, ours ${e.kind} ${e.nRecs}x${e.recLen}` });
    }
    const n = Math.min(r.nRecs, e.nRecs);
    for (let i = 1; i <= n; i++) {
      const a = r.readRecord(i);
      const b = e.readRecord(i);
      if (d.indexed && a[0] !== b[0]) out.push({ file: rel, what: `rec ${i}: deleted flag ref ${a[0]} ours ${b[0]}` });
      for (const f of d.fields) {
        let same = true;
        for (let k = f.ofs; k < f.ofs + f.len; k++) if (a[k] !== b[k]) same = false;
        let rv = '';
        let ev = '';
        if (f.typ === 'T') {
          rv = rt.read(new DataView(a.buffer, a.byteOffset + f.ofs, 4).getInt32(0, true));
          ev = et.read(new DataView(b.buffer, b.byteOffset + f.ofs, 4).getInt32(0, true));
          if (rv === ev) continue;
          out.push({ file: rel, what: `rec ${i} ${d.name}.${f.name} (T): ref ${JSON.stringify(rv.slice(0, 120))} ours ${JSON.stringify(ev.slice(0, 120))}` });
          continue;
        }
        if (same) continue;
        if ((f.typ === 'D' || f.typ === 'R') && sameReal(readReal48(a, f.ofs), readReal48(b, f.ofs), clockTolerance)) continue;
        out.push({ file: rel, what: `rec ${i} ${d.name}.${f.name} (${f.typ}): ref ${fieldValue(f, a)} ours ${fieldValue(f, b)}` });
      }
    }
    // bytes after the last record (a file may keep a tail)
    const ra = readFileSync(refPath);
    const eb = readFileSync(engPath);
    const tail = r.frstDispl + r.nRecs * r.recLen;
    if (r.nRecs === e.nRecs && !ra.subarray(tail).equals(eb.subarray(tail))) {
      out.push({ file: rel, what: `bytes after the records differ (${ra.length - tail} / ${eb.length - tail})` });
    }
    return out;
  } finally {
    r.close();
    e.close();
    rt.close();
    et.close();
  }
}

function normCat(b: Buffer): Buffer {
  const c = Buffer.from(b);
  for (let i = 0; i < c.length; i++) {
    if (c[i] === 0x2f) c[i] = 0x5c;
    else if (c[i] >= 0x61 && c[i] <= 0x7a) c[i] -= 0x20;
  }
  return c;
}

function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...listFiles(dir, r));
    else out.push(r);
  }
  return out.sort();
}

export interface CompareOptions {
  /** relative paths (upper-cased, '/' separated) to leave out entirely */
  ignore?: (relUpper: string) => boolean;
  /** only report files missing on one side when this says so (e.g. not for reference limits) */
  reportMissing?: (relUpper: string, side: 'ref' | 'ours') => boolean;
  /** tolerance for clock values, in days (default 15 minutes) */
  clockTolerance?: number;
  /** only compare files that differ from the pristine task (both sides unchanged = skip quickly) */
  pristineDir?: string;
}

/**
 * Compare two task directories after a run. Returns the differences that remain after the
 * noise described at the top of this module is masked.
 */
export function compareTaskDirs(refDir: string, engDir: string, decls: Map<string, FileDecl[]>, opts: CompareOptions = {}): Difference[] {
  const tol = opts.clockTolerance ?? 15 / 1440;
  const ref = listFiles(refDir);
  const eng = listFiles(engDir);
  const engSet = new Set(eng);
  const refSet = new Set(ref);
  const out: Difference[] = [];
  const ignore = (r: string) => opts.ignore?.(r.toUpperCase()) ?? false;
  for (const f of ref) if (!engSet.has(f) && !ignore(f) && (opts.reportMissing?.(f.toUpperCase(), 'ours') ?? true)) out.push({ file: f, what: 'missing in ours' });
  for (const f of eng) if (!refSet.has(f) && !ignore(f) && (opts.reportMissing?.(f.toUpperCase(), 'ref') ?? true)) out.push({ file: f, what: 'missing in the reference' });
  for (const f of ref) {
    if (!engSet.has(f) || ignore(f)) continue;
    const rp = join(refDir, f);
    const ep = join(engDir, f);
    const ra = readFileSync(rp);
    const eb = readFileSync(ep);
    if (ra.equals(eb)) continue;
    const up = f.toUpperCase();
    const ext = extname(up);
    if (/^\.X\w\w$/.test(ext)) continue; // index: key bytes differ legitimately (see above)
    if (/^\.T\w\w$/.test(ext) && dataFileFor(refDir, f)) continue; // texts are compared via their data file
    if (ext === '.CAT') {
      if (!normCat(ra).equals(normCat(eb))) out.push({ file: f, what: 'catalog differs (beyond path separators and case)' });
      continue;
    }
    const stem = basename(up, ext);
    const decls1 = decls.get(stem);
    if (statSync(rp).size >= 6 && decls1) {
      const d = compareDataFile(f, rp, ep, decls1, tol);
      if (d) {
        out.push(...d);
        continue;
      }
    }
    // other files (report outputs ...): the same apart from clock times printed in them
    if (maskTimes(ra) === maskTimes(eb)) continue;
    out.push({ file: f, what: `bytes differ (${ra.length} / ${eb.length} bytes, ${countDiff(ra, eb)} differ)` });
  }
  return out;
}

/** The data file a .Txx belongs to (same stem, extension '.0xx' or any '.?xx'), if any. */
function dataFileFor(dir: string, rel: string): boolean {
  const ext = extname(rel);
  const stem = rel.slice(0, -ext.length);
  const tail = ext.slice(2);
  const d = join(dir, stem.includes('/') ? stem.slice(0, stem.lastIndexOf('/')) : '');
  const b = basename(stem).toUpperCase();
  try {
    return readdirSync(d).some((n) => {
      const e = extname(n);
      return basename(n, e).toUpperCase() === b && e.length === 4 && e.slice(2).toUpperCase() === tail.toUpperCase() && !/^\.[TX]/i.test(e);
    });
  } catch {
    return false;
  }
}

/** Clock times (hh:mm, hh:mm:ss) replaced by a placeholder of the same length. */
export function maskTimes(b: Buffer | string): string {
  const s = typeof b === 'string' ? b : b.toString('latin1');
  return s.replace(/\b\d{1,2}:\d\d(:\d\d)?\b/g, (m) => '#'.repeat(m.length));
}

function countDiff(a: Buffer, b: Buffer): number {
  let n = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++;
  return n;
}
