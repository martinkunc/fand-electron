// index-sort package: INDEX.PAS (index.ts: XString, XPage, XKey/XWKey, XScan, record index
// maintenance) and SORT.PAS (sort.ts: CreateIndexFile, work indexes, external merge sort).
//
// The .X files are compared byte for byte with those the reference FAND (FPC build) created for
// the same Účto data (work/tmp-index-sort/ref: a copy of Účto after the reference started it to
// the main menu and quit; made on the first run when the reference is built, else skipped). Our keys follow BP7, the reference
// is the FPC port; known differences (PORTING.md 1): R/D key fields (the FPC port stores 6 bytes of
// a double instead of the Real48) and CompLex keys containing 'ch' (the FPC port dropped the
// ligature). The Účto indexes compared here have neither, so they must be identical.
//
// Mocked: RUNFRML (formulas of computed fields and conditions are JS functions here); everything
// else is the real port, on a headless Crt in FandBatch mode (messages go to stderr and are
// counted, no key waits).

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ref, fref, FromUnicode, Output, TxtRewrite, GoExitSignal } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, FormatCache, SaveCache, OpenH, CloseClearH, _isoldfile, _isoverwritefile, Exclusive, SizeOfSpec, SizeOfVideo,
  SizeOfColors, SizeOfFonts, ReadH, SeekH, PosH, OpenWorkH, InitBase, SizeOfResA, MsgIdxFromBytes, RdMsg,
  ExitRecord, NewExit, RestoreExit,
} from '../src/engine/pas/base.ts';
import { getWord } from '../src/engine/pas/pasrt.ts';
import {
  AccessVars, FileD, FieldDescr, XFile, XKey, XWKey, XString, XPage, XScan, KeyFldD, KeyInD, FrmlListEl, LocVar,
  LinkD, f_Stored, f_Comma, LeftJust, ExclMode, GetRecSpace, ReadRec, WriteRec, IncNRecs, DeletedFlag,
  TestXFExist, XNRecs, WrPrefix, TryInsertAllIndexes, DeleteXRec, OverwrXRec, RecallRec, type FrmlPtr,
  FrmlElem, _const, _field, _compstr, _and, _ge, _lt,
} from '../src/engine/pas/access.ts';
import { CreateIndexFile, CreateWIndex, ScanSubstWIndex, CopyIndex, GetIndex } from '../src/engine/pas/sort.ts';
import { Instr, _getindex } from '../src/engine/pas/rdrun.ts';
import { SetDriversCrt, DriversVars, AssignCrt } from '../src/engine/pas/drivers.ts';
import { ObaseWWVars } from '../src/engine/pas/obaseww.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { K } from '../src/engine/console/keys.ts';
import { REF_FAND, RefFandDriver, copyTask } from '../src/engine/testing/refdriver.ts';
import { startUcto } from '../src/engine/testing/ucto.ts';
import { TAB_F, readReal48, writeReal48 } from '../src/engine/fand/numbers.ts';
import { encode852 } from '../src/engine/console/cp852.ts';

Error.stackTraceLimit = 60;

// formulas are { ts: () => value } objects
vi.mock('../src/engine/pas/runfrml.ts', async (orig) => {
  const m = await orig<typeof import('../src/engine/pas/runfrml.ts')>();
  type J = { ts: () => unknown } | null;
  return {
    ...m,
    // real FrmlElem nodes (no 'ts') go to the real routines
    RunShortStr: (Z: J) => (Z !== null && 'ts' in Z ? (Z.ts() as string) : m.RunShortStr(Z as never)),
    RunReal: (Z: J) => (Z !== null && 'ts' in Z ? (Z.ts() as number) : m.RunReal(Z as never)),
    RunInt: (Z: J) => (Z !== null && 'ts' in Z ? Math.trunc(Z.ts() as number) : m.RunInt(Z as never)),
    RunBool: (Z: J) => (Z === null ? true : 'ts' in Z ? (Z.ts() as boolean) : m.RunBool(Z as never)),
    RunEvalFrml: (Z: J) => (Z !== null && 'ts' in Z ? Z : m.RunEvalFrml(Z as never)),
  };
});

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const REF = join(ROOT, 'work/tmp-index-sort/ref');
const TMP = join(ROOT, 'work/tmp-index-sort/test');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB'));
// the reference's indexes: made once (about 10 s) when the reference FAND is built
const haveRef = haveApp && (existsSync(join(REF, 'TIPY.X00')) || existsSync(REF_FAND));

/** Runs the reference FAND on a copy of Účto to the main menu and back: it builds the .X files. */
async function ensureRef(): Promise<void> {
  if (existsSync(join(REF, 'TIPY.X00'))) return;
  const dir = copyTask(APP);
  const d = new RefFandDriver({ taskDir: dir, task: 'ucto2026' });
  try {
    await startUcto(d);
    d.press(K.Esc);
    await d.waitFor(/^(?![\s\S]*Peněžní deník)/);
    d.press(K.Esc);
    await d.waitFor('Ukončit program účto');
    d.press(K.Enter);
    expect(await d.exited).toBe(0);
    rmSync(REF, { recursive: true, force: true });
    cpSync(dir, REF, { recursive: true });
  } finally {
    await d.close();
    rmSync(dirname(dir), { recursive: true, force: true });
  }
}

/** Byte string of a Unicode text (CP852). */
const B = (u: string): string => String.fromCharCode(...encode852(u));
const frml = (ts: () => unknown): FrmlPtr => ({ ts }) as unknown as FrmlPtr;

// Real formula nodes. The mock above does not reach every importer of RUNFRML (vi.mock with
// importOriginal inside an import cycle: modules loaded while the original is imported bind to
// the original), so the conditions XScan evaluates are real FrmlElem trees.
const sConst = (u: string): FrmlPtr => Object.assign(new FrmlElem(_const), { S: B(u) });
const rConst = (r: number): FrmlPtr => Object.assign(new FrmlElem(_const), { R: r });
const fldF = (F: FieldDescr): FrmlPtr => Object.assign(new FrmlElem(_field), { Field: F });
const cmpS = (a: FrmlPtr, b: FrmlPtr, mask: string): FrmlPtr =>
  Object.assign(new FrmlElem(_compstr), { P1: a, P2: b, N21: mask.charCodeAt(0), N22: 0 });
/** F starts with the (ASCII) character c: F >= c and F < succ(c). */
const startsWithF = (F: FieldDescr, c: string): FrmlPtr =>
  Object.assign(new FrmlElem(_and), {
    P1: cmpS(fldF(F), sConst(c), _ge),
    P2: cmpS(fldF(F), sConst(String.fromCharCode(c.charCodeAt(0) + 1)), _lt),
  });

// ---------------------------------------------------------------- a minimal RDFILDCL

/** Stored fields of an F chapter up to '#' (RDFILDCL.RdFldDescr, CompileRecLen). */
function parseFields(src: string, isX: boolean): FieldDescr[] {
  const fields: FieldDescr[] = [];
  let displ = isX ? 1 : 0;
  for (const part of src.split('#')[0].split(';')) {
    const m = /^\s*([^:\s]+)\s*:\s*([ANFRDBT])\s*(.*)$/s.exec(part);
    if (!m) continue;
    const F = newField(m[1], m[2], m[3].trim(), true);
    F.Displ = displ;
    displ += F.NBytes;
    fields.push(F);
  }
  return fields;
}
function newField(name: string, typ: string, rest: string, stored: boolean): FieldDescr {
  const F = new FieldDescr();
  F.Name = B(name);
  F.Typ = typ;
  F.Flg = stored ? f_Stored : 0;
  F.FrmlTyp = 'S';
  switch (typ) {
    case 'N': {
      const mm = /^,\s*(\d+)\s*(L)?/.exec(rest)!;
      F.L = +mm[1];
      F.NBytes = (F.L + 1) >> 1;
      if (mm[2]) F.M = LeftJust;
      break;
    }
    case 'F': {
      const mm = /^,\s*(\d+)\s*([.,])\s*(\d+)/.exec(rest)!;
      const L = +mm[1];
      const M = +mm[3];
      if (mm[2] === ',') F.Flg |= f_Comma;
      F.NBytes = TAB_F[L + M];
      F.L = M === 0 ? L + 1 : L + M + 2;
      F.M = M;
      F.FrmlTyp = 'R';
      break;
    }
    case 'R':
      F.NBytes = 6;
      F.L = 17;
      F.M = 5;
      F.FrmlTyp = 'R';
      break;
    case 'A': {
      const q = /^,\s*'([^']*)'/.exec(rest);
      if (q) {
        F.L = q[1].length;
        F.M = LeftJust;
      } else {
        const mm = /^,\s*(\d+)\s*(R)?/.exec(rest)!;
        F.L = +mm[1];
        F.M = mm[2] ? 0 : LeftJust;
      }
      F.NBytes = F.L;
      break;
    }
    case 'D':
      F.NBytes = 6;
      F.FrmlTyp = 'R';
      F.L = 8;
      break;
    case 'B':
      F.L = 1;
      F.NBytes = 1;
      F.FrmlTyp = 'B';
      break;
    case 'T':
      F.L = 1;
      F.NBytes = 4;
      break;
  }
  return F;
}

type KeySpec = { dupl: boolean; flds: string[] }; // '~Name' CompLex, '>Name' descending
type Computed = { name: string; typ: string; rest: string; fn: (get: (n: string) => string) => string };

/** Opens a copy of an X data file with its keys; the index file (new) is set not valid. */
function openX(dataPath: string, xPath: string, dcl: string, keys: KeySpec[], computed: Computed[] = []): FileD {
  const fields = parseFields(dcl, true);
  const fd = new FileD();
  const byName = new Map<string, FieldDescr>();
  for (const f of fields) byName.set(f.Name, f);
  const get = (n: string): string => {
    const f = byName.get(B(n))!;
    const cr = AccessVars.CRecPtr!;
    return String.fromCharCode(...cr.subarray(f.Displ, f.Displ + f.NBytes));
  };
  for (const c of computed) {
    const F = newField(c.name, c.typ, c.rest, false);
    F.Frml = frml(() => c.fn(get));
    fields.push(F);
    byName.set(F.Name, F);
  }
  for (let i = 0; i < fields.length - 1; i++) fields[i].Chain = fields[i + 1];
  fd.Typ = 'X';
  fd.Name = 'TEST';
  fd.FldD = fields[0];
  fd.RecLen = fields.filter((f) => f.Flg & f_Stored).reduce((n, f) => n + f.NBytes, 1);
  fd.FrstDispl = 6;
  fd.UMode = Exclusive;
  fd.LMode = ExclMode;
  BaseVars.CPath = FromUnicode(dataPath);
  fd.Handle = OpenH(_isoldfile, Exclusive);
  expect(BaseVars.HandleError).toBe(0);
  const h = new Uint8Array(6);
  SeekH(fd.Handle, 0);
  ReadH(fd.Handle, 6, h);
  const dv = new DataView(h.buffer);
  fd.NRecs = Math.abs(dv.getInt32(0, true));
  expect(dv.getUint16(4, true)).toBe(fd.RecLen);
  let prev: XKey | null = null;
  keys.forEach((ks, i) => {
    const k = new XKey();
    k.Duplic = ks.dupl;
    k.IndexRoot = i + 1;
    let last: KeyFldD | null = null;
    for (const s of ks.flds) {
      const kf = new KeyFldD();
      kf.Descend = s.includes('>');
      kf.CompLex = s.includes('~');
      kf.FldD = byName.get(B(s.replace(/[~>]/g, '')))!;
      expect(kf.FldD).toBeTruthy();
      if (last) last.Chain = kf;
      else k.KFlds = kf;
      last = kf;
      k.IndexLen += kf.FldD!.NBytes;
    }
    if (prev) prev.Chain = k;
    else fd.Keys = k;
    prev = k;
  });
  fd.XF = new XFile();
  BaseVars.CPath = FromUnicode(xPath);
  fd.XF.Handle = OpenH(_isoverwritefile, Exclusive);
  expect(BaseVars.HandleError).toBe(0);
  AccessVars.CFile = fd;
  fd.XF.SetNotValid(); // OACCESS.OpenF on a missing .X
  return fd;
}
function closeX(fd: FileD): void {
  SaveCache(0);
  CloseClearH(fref(fd.XF!, 'Handle')); // the cache pages of a closed handle must go (handles are reused)
  CloseClearH(fref(fd, 'Handle'));
}
/** The used part of an .X file (CloseFile truncates to XF.UsedFileSize). */
function xBytes(path: string): Uint8Array {
  const b = readFileSync(path);
  const maxPage = b.readInt32LE(6);
  return new Uint8Array(b.subarray(0, (maxPage + 1) * 1024));
}

/** The items of an .X page: N (RecNr or count), DownPage, the whole key. */
function decodePage(pg: Uint8Array): { n: number; down: number; key: string }[] {
  const dv = new DataView(pg.buffer, pg.byteOffset);
  const leaf = pg[0] !== 0;
  const o = leaf ? 3 : 7;
  const items: { n: number; down: number; key: string }[] = [];
  let x = 7;
  let key = '';
  for (let i = 0; i < dv.getUint16(5, true); i++) {
    const m = pg[x + o];
    const l = pg[x + o + 1];
    key = key.slice(0, m) + String.fromCharCode(...pg.subarray(x + o + 2, x + o + 2 + l));
    items.push({ n: pg[x] | (pg[x + 1] << 8) | (pg[x + 2] << 16), down: leaf ? 0 : dv.getInt32(x + 3, true), key });
    x += o + 2 + l;
  }
  return items;
}

/** All (key, recnr) of a key in index order, via the XKey routines. */
function keyItems(k: XKey): string[] {
  const out: string[] = [];
  const n = k.NRecs();
  for (let i = 1; i <= n; i++) out.push(`${JSON.stringify(k.NrToStr(i))}:${k.NrToRecNr(i)}`);
  return out;
}

/** Checks the B-tree invariants of the tree under Page; returns [nrecs, last key]. */
function checkTree(xf: { RdPage(p: XPage, n: number): void }, page: number, leaves: number[]): [number, string] {
  const p = new XPage();
  xf.RdPage(p, page);
  const n = p.NItems;
  expect(p.EndOff()).toBeLessThanOrEqual(1024);
  let prev = '';
  for (let i = 1; i <= n; i++) {
    const s = p.StrI(i);
    expect(p.XI(i).GetM(p.Off())).toBeLessThanOrEqual(prev.length);
    expect(s >= prev).toBe(true);
    prev = s;
  }
  if (p.IsLeaf) {
    leaves.push(page);
    return [n, prev];
  }
  let sum = 0;
  for (let i = 1; i <= n; i++) {
    const x = p.XI(i);
    const [cn, last] = checkTree(xf, x.DownPage, leaves);
    expect(x.GetN()).toBe(cn);
    expect(last).toBe(p.StrI(i));
    sum += cn;
    xf.RdPage(p, page);
  }
  if (p.GreaterPage !== 0) {
    const [cn, last] = checkTree(xf, p.GreaterPage, leaves);
    sum += cn;
    prev = last;
  }
  return [sum, prev];
}

/** RUNFAND.InitRunFand: the FAND.RES message index (after BASE opened the file). */
function ReadResHeader(): void {
  const h = BaseVars.ResFile.Handle;
  const b = new Uint8Array(SizeOfResA);
  SeekH(h, 0);
  ReadH(h, 2, b);
  ReadH(h, SizeOfResA, b);
  BaseVars.ResFile.SetA(b);
  ReadH(h, 2, b);
  BaseVars.MsgIdxN = getWord(b, 0);
  const mi = new Uint8Array(5 * BaseVars.MsgIdxN);
  ReadH(h, mi.length, mi);
  BaseVars.MsgIdx = MsgIdxFromBytes(mi, BaseVars.MsgIdxN);
  BaseVars.FrstMsgPos = PosH(h);
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  if (haveApp) {
    process.env.FANDRES = APP;
    InitBase(); // (resets the handle table)
    ReadResHeader();
  }
  FormatCache();
  // progress (RunMsgOn: PushW -> TWork) and messages (FandBatch: stderr) without a UI
  SetDriversCrt(new Crt(new KeyQueue(), null, 80, 25));
  AssignCrt(Output);
  TxtRewrite(Output);
  DriversVars.FandBatch = true;
  const tw = AccessVars.TWork;
  tw.IsWork = true;
  BaseVars.CPath = FromUnicode(join(TMP, 'FANDWORK.T$$'));
  BaseVars.FandWorkTName = BaseVars.CPath;
  tw.Create();
  if (haveApp) {
    // RUNFAND.RdCFG: CharOrdTab of Účto's FAND.CFG (Czech collation)
    const cfg = readFileSync(join(APP, 'FAND.CFG'));
    const o = 4 + SizeOfSpec + (SizeOfVideo + SizeOfColors) * 2 + SizeOfVideo + SizeOfColors + SizeOfFonts;
    BaseVars.CharOrdTab.set(cfg.subarray(o, o + 256));
  }
  // OACCESS.OpenWorkH / OpenXWorkH
  BaseVars.FandWorkName = FromUnicode(join(TMP, 'FANDWORK.$$$'));
  BaseVars.FandWorkXName = FromUnicode(join(TMP, 'FANDWORK.X$$'));
  OpenWorkH();
  BaseVars.CPath = BaseVars.FandWorkXName;
  AccessVars.XWork.Handle = OpenH(_isoverwritefile, Exclusive);
  AccessVars.XWork.FreeRoot = 0;
  AccessVars.XWork.MaxPage = 0;
});

// ---------------------------------------------------------------- XString

describe('XString: key bytes (BP7)', () => {
  const kf = (typ: string, rest: string, opts: { cl?: boolean; desc?: boolean } = {}): KeyFldD => {
    const k = new KeyFldD();
    k.FldD = newField('X', typ, rest, true);
    k.CompLex = !!opts.cl;
    k.Descend = !!opts.desc;
    return k;
  };
  const hex = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).padStart(2, '0')).join(' ');

  it('StoreReal on R/D: the Real48, sign flipped into bit 7, big-endian; negative values negated', () => {
    const x = new XString();
    x.StoreReal(0, kf('R', ''));
    expect(hex(x.S)).toBe('80 00 00 00 00 00');
    x.Clear();
    x.StoreReal(1, kf('R', '')); // Real48 81 00 00 00 00 00
    expect(hex(x.S)).toBe('c0 80 00 00 00 00');
    x.Clear();
    x.StoreReal(-1, kf('R', ''));
    expect(hex(x.S)).toBe('3f 7f ff ff ff ff');
    x.Clear();
    x.StoreReal(739000, kf('D', '')); // a date
    const r = new Uint8Array(6);
    writeReal48(739000, r);
    expect(x.S.charCodeAt(0)).toBe(0x80 | (r[0] >> 1));
    expect(hex(x.S.slice(2))).toBe(hex(String.fromCharCode(r[4], r[3], r[2], r[1])));
    // order preserved (ascending and descending)
    const vals = [-1e10, -3.5, -1, -0.001, 0, 1e-5, 0.5, 1, 1.5, 2, 1000, 739000.25, 1e12];
    const keys = vals.map((v) => {
      const y = new XString();
      y.StoreReal(v, kf('R', ''));
      return y.S;
    });
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] < keys[i]).toBe(true);
    const dkeys = vals.map((v) => {
      const y = new XString();
      y.StoreReal(v, kf('R', '', { desc: true }));
      return y.S;
    });
    for (let i = 1; i < dkeys.length; i++) expect(dkeys[i - 1] > dkeys[i]).toBe(true);
    expect(readReal48(r)).toBe(739000);
  });

  it('StoreReal on F: fix number with the sign bit flipped; StoreStr on N: packed BCD, padded', () => {
    const x = new XString();
    const f = kf('F', ',8.2'); // NBytes 5
    x.StoreReal(-1.5, f);
    expect(hex(x.S)).toBe('7f ff ff ff 6a');
    x.Clear();
    x.StoreReal(12.34, f);
    expect(hex(x.S)).toBe('80 00 00 04 d2');
    x.Clear();
    x.StoreStr('123', kf('N', ',5')); // right justified: '  123' -> BCD of the chars' low nibbles
    expect(hex(x.S)).toBe('00 12 30');
    x.Clear();
    x.StoreStr('123', kf('N', ',5L'));
    expect(hex(x.S)).toBe('12 30 00');
    x.Clear();
    x.StoreBool(true, kf('B', ''));
    x.StoreBool(false, kf('B', '', { desc: true }));
    expect(hex(x.S)).toBe('01 ff');
  });

  it.skipIf(!haveApp)('StoreStr on A: trailing blanks -> $1F; CompLex through CharOrdTab with the ch ligature', () => {
    const x = new XString();
    x.StoreStr('AB', kf('A', ',5'));
    expect(hex(x.S)).toBe('41 42 1f');
    x.Clear();
    x.StoreStr('ABCDE', kf('A', ',5'));
    expect(hex(x.S)).toBe('41 42 43 44 45');
    x.Clear();
    x.StoreStr('AB', kf('A', ',5R')); // right justified: '   AB'
    expect(hex(x.S)).toBe('20 20 20 41 42');
    const lex = (u: string): string => {
      const y = new XString();
      y.StoreStr(B(u), kf('A', ',10', { cl: true }));
      return y.S;
    };
    expect(lex('chata').length).toBe(5); // 'ch' is one letter (+ $1F)
    expect(lex('Chata')).toBe(lex('CHATA'));
    const words = ['cesta', 'čáp', 'Hrad', 'hrách', 'chata', 'Chrudim', 'Ivan', 'Řím', 'Šimon', 'Žďár'];
    const sorted = [...words].sort((a, b) => (lex(a) < lex(b) ? -1 : 1));
    // Czech: hrad < hrách (d < ch) < chata (ch after h) < Ivan
    expect(sorted).toEqual(['cesta', 'čáp', 'Hrad', 'hrách', 'chata', 'Chrudim', 'Ivan', 'Řím', 'Šimon', 'Žďár']);
    // descending: all bytes negated
    const d = new XString();
    d.StoreStr('AB', kf('A', ',5', { desc: true }));
    expect(hex(d.S)).toBe('be bd e0');
  });

  it('keys longer than 255 bytes: the field that does not fit is skipped', () => {
    const x = new XString();
    x.S = 'x'.repeat(250);
    x.StoreStr('ABCDEFGHIJ', kf('A', ',10'));
    expect(x.S.length).toBe(250);
    x.StoreN(Uint8Array.of(1, 2, 3, 4, 5), 5, false);
    expect(x.S.length).toBe(255);
  });
});

// ---------------------------------------------------------------- B-tree operations

describe('XWKey: B-tree insert/delete against a model (XWork)', () => {
  it('random inserts and deletes keep order, counts, prefix compression and leaf chain', () => {
    // a file with one A,20 field; records are only CRecPtr buffers (Insert/Delete pack from CRecPtr)
    const fd = new FileD();
    const F = newField('K', 'A', ',20', true);
    F.Displ = 1;
    fd.FldD = F;
    fd.Typ = 'X';
    fd.RecLen = 21;
    fd.NRecs = 100000;
    AccessVars.CFile = fd;
    const kf = new KeyFldD();
    kf.FldD = F;
    const k = new XWKey();
    k.Open(kf, true, false);
    const xf = AccessVars.XWork;
    const rec = (s: string): void => {
      const r = GetRecSpace();
      r.fill(0x20, 1, 21);
      for (let i = 0; i < s.length; i++) r[1 + i] = s.charCodeAt(i);
      AccessVars.CRecPtr = r;
    };
    const keyOf = (s: string): string => s.replace(/ +$/, '') + (s.length < 20 ? '\x1f' : '');
    let seed = 12345;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const model: { key: string; nr: number; s: string }[] = [];
    const vals = new Map<number, string>();
    const prefixes = ['NOVAK ', 'NOVOTNY ', 'DVORAK ', 'A', 'CERNY', 'PROCHAZKA KAREL '];
    for (let nr = 1; nr <= 3000; nr++) {
      const s = (prefixes[rnd(prefixes.length)] + String(rnd(400))).slice(0, 20);
      rec(s);
      const i = k.InsertGetNr(nr);
      const key = keyOf(s);
      let pos = model.findIndex((m) => m.key > key);
      if (pos < 0) pos = model.length;
      expect(i).toBe(pos + 1);
      model.splice(pos, 0, { key, nr, s });
      vals.set(nr, s);
      if (nr % 3 === 0) {
        // delete a random earlier record
        const del = model[rnd(model.length)];
        rec(del.s);
        expect(k.Delete(del.nr)).toBe(true);
        k.NR--;
        model.splice(model.indexOf(del), 1);
      }
    }
    expect(k.NRecs()).toBe(model.length);
    const leaves: number[] = [];
    const [n] = checkTree(xf, k.IndexRoot, leaves);
    expect(n).toBe(model.length);
    expect(leaves.length).toBeGreaterThan(10);
    // leaf chain
    const p = new XPage();
    for (let i = 0; i < leaves.length; i++) {
      xf.RdPage(p, leaves[i]);
      expect(p.GreaterPage).toBe(i + 1 < leaves.length ? leaves[i + 1] : 0);
    }
    for (let i = 1; i <= model.length; i += 37) {
      expect(k.NrToRecNr(i)).toBe(model[i - 1].nr);
      expect(k.NrToStr(i)).toBe(model[i - 1].key);
    }
    // RecNrToNr, Search
    const m = model[500];
    rec(m.s);
    expect(k.RecNrToNr(m.nr)).toBe(501);
    const x = new XString();
    x.PackKF(kf);
    const nn = ref(0);
    expect(k.Search(x, false, nn)).toBe(true);
    expect(model[k.PathToNr() - 1].key).toBe(m.key);
    // delete everything: the root collapses back to an empty leaf
    for (const mm of [...model]) {
      rec(mm.s);
      expect(k.Delete(mm.nr)).toBe(true);
    }
    xf.RdPage(p, k.IndexRoot);
    expect(p.IsLeaf).toBe(true);
    expect(p.NItems).toBe(0);
    const maxPage = xf.MaxPage;
    k.Close();
    // all pages but the root are on the free list
    let free = 0;
    for (let pg = xf.FreeRoot; pg !== 0; pg = p.GreaterPage) {
      xf.RdPage(p, pg);
      free++;
    }
    expect(free).toBe(maxPage);
  });

  it('many equal keys: RecNrToPath walks the leaf chain (IncPath), InsertAtNr/DeleteAtNr, AddToRecNr', () => {
    const fd = new FileD();
    const F = newField('K', 'A', ',8', true);
    F.Displ = 1;
    fd.FldD = F;
    fd.Typ = 'X';
    fd.RecLen = 9;
    fd.NRecs = 100000;
    AccessVars.CFile = fd;
    const kf = new KeyFldD();
    kf.FldD = F;
    const k = new XWKey();
    k.Open(kf, true, false);
    const r = GetRecSpace();
    r.fill(0x20, 1, 9);
    r.set([0x53, 0x41, 0x4d, 0x45], 1); // 'SAME'
    AccessVars.CRecPtr = r;
    for (let nr = 1; nr <= 900; nr++) expect(k.InsertGetNr(nr)).toBe(nr);
    const order = Array.from({ length: 900 }, (_, i) => i + 1);
    expect(k.RecNrToNr(777)).toBe(777);
    let seed = 99;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    for (let t = 0; t < 300; t++) {
      const nr = order[rnd(order.length)];
      expect(k.Delete(nr)).toBe(true);
      k.NR--;
      order.splice(order.indexOf(nr), 1);
    }
    expect(k.Delete(order.length + 5000)).toBe(false);
    // positional insert/delete (XWKey as an ordered list of records)
    k.InsertAtNr(1, 5001);
    order.unshift(5001);
    k.DeleteAtNr(10);
    order.splice(9, 1);
    for (let i = 1; i <= order.length; i += 11) expect(k.NrToRecNr(i)).toBe(order[i - 1]);
    // AddToRecNr: records >= 400 shifted by +3 (records inserted in the file)
    k.AddToRecNr(400, 3);
    for (let i = 1; i <= order.length; i += 7) expect(k.NrToRecNr(i)).toBe(order[i - 1] >= 400 ? order[i - 1] + 3 : order[i - 1]);
    const leaves: number[] = [];
    expect(checkTree(AccessVars.XWork, k.IndexRoot, leaves)[0]).toBe(order.length);
    k.Release();
    expect(k.NRecs()).toBe(0);
    const p = new XPage();
    AccessVars.XWork.RdPage(p, k.IndexRoot);
    expect(p.IsLeaf && p.NItems === 0).toBe(true);
    k.OneRecIdx(kf, 42);
    expect(k.NrToRecNr(1)).toBe(42);
    k.Close();
  });

  it('XPage.Insert/Delete/SplitPage/AddPage keep the prefix compression consistent', () => {
    const p = new XPage();
    p.IsLeaf = true;
    const keys: string[] = [];
    for (let i = 0; i < 60; i++) keys.push('KEY' + String(i * 7919 % 1000).padStart(4, '0') + 'X'.repeat(i % 5));
    const xx = ref<ReturnType<XPage['XI']> | null>(null);
    const sorted: string[] = [];
    for (const [j, s] of keys.entries()) {
      let i = sorted.findIndex((t) => t > s);
      if (i < 0) i = sorted.length;
      p.Insert(i + 1, s, xx);
      xx.v!.PutN(j + 1);
      sorted.splice(i, 0, s);
    }
    expect(p.NItems).toBe(60);
    for (let i = 1; i <= 60; i++) expect(p.StrI(i)).toBe(sorted[i - 1]);
    const q = new XPage();
    p.SplitPage(q, 77);
    expect(q.NItems + p.NItems).toBe(60);
    expect(q.GreaterPage).toBe(77);
    for (let i = 1; i <= q.NItems; i++) expect(q.StrI(i)).toBe(sorted[i - 1]);
    for (let i = 1; i <= p.NItems; i++) expect(p.StrI(i)).toBe(sorted[q.NItems + i - 1]);
    expect(p.XI(1).GetM(3)).toBe(0);
    p.Delete(1);
    sorted.splice(q.NItems, 1);
    p.Delete(p.NItems);
    sorted.pop();
    q.AddPage(p);
    expect(q.NItems).toBe(sorted.length);
    for (let i = 1; i <= q.NItems; i++) expect(q.StrI(i)).toBe(sorted[i - 1]);
    // the bytes after the last item stay zero
    expect(q.Raw.subarray(q.EndOff(), 1024).every((b) => b === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------- CreateIndexFile on Účto data

const DCL = {
  CISDRUH: `Druh:A,'!!!'; NazevDruhu:A,30; Sloupec:N,2; Plat:A,'!'; DPH:B; Spec:A,'!!!'; Sp15:A,2; Krac:A,'!'; Oddil:A,'!!'; Ar:B; #K`,
  CISPOH: `Pohyb:A,'!!!'; Nazev:A,30; Prijem:B; Prenos:B; Text:A,20; Druh:A,'!!!'; #K`,
  CISVYKON: `Vykon:A,5; NazevVykonu:A,30; Zisk:F,9.2; #K`,
  EDITTAB: `Soubor:A,10; Použít:B; Tab:T; #K`,
  TIPY: `Klíč:A,5; Oddíl:A,20; Téma:A,40; Text:T; Modul:N,2; Help:A,30; Datum:D; Autor:A,'!!'; Posl:D; #C`,
  ADRESY: `Cislo:N,5; Kod:A,5; Firma:A,30; Oddeleni:A,20; Jmeno:A,30; Ulice:A,24; Psc:N,5L; Misto:A,20; Stat:A,4; Tlf:A,30; Mobil:A,30; Fax:A,40; EMail:A,40; Ico10:N,10; Dic:A,14; PlatDPH:B; Banka:A,20; Ucet:A,30; SpecSym:A,10; Pohl:F,8.2; Zav:F,8.2; Splat:F,2.0; Pozn:T; Ar:B; VykonF:A,5; RezervaA:A,50; #K`,
};
const trail = (s: string): string => s.replace(/ +$/, '');
// ADRESY #C: Prijm_:=copy(Jmeno,pos(' ',Jmeno)+1,30); Prijmeni:=copy(Prijm_,1,16);
// Nazev:=trailchar(' ',copy(trailchar(' ',cond(Firma<>~'':Firma,else:Prijmeni))+' '+Misto,1,30))
const prijmeni = (get: (n: string) => string): string => {
  const j = get('Jmeno');
  return j.slice(j.indexOf(' ') + 1).slice(0, 30).slice(0, 16);
};
const ADRESY_C: Computed[] = [
  { name: 'Prijmeni', typ: 'A', rest: ',16', fn: prijmeni },
  {
    name: 'Nazev',
    typ: 'A',
    rest: ',30',
    fn: (get) => {
      const f = get('Firma');
      return trail((trail(trail(f) !== '' ? f : prijmeni(get)) + ' ' + get('Misto')).slice(0, 30));
    },
  },
];
const CASES: { name: string; data: string; x: string; keys: KeySpec[]; computed?: Computed[]; chPages?: number[] }[] = [
  { name: 'CISDRUH', data: '{prik}/CISDRUH.001', x: '{prik}/CISDRUH.X01', keys: [{ dupl: false, flds: ['~Druh'] }, { dupl: false, flds: ['Sloupec', '~Druh'] }] },
  { name: 'CISPOH', data: '{prik}/CISPOH.001', x: '{prik}/CISPOH.X01', keys: [{ dupl: false, flds: ['~Pohyb'] }] },
  { name: 'CISVYKON', data: '{prik}/CISVYKON.001', x: '{prik}/CISVYKON.X01', keys: [{ dupl: false, flds: ['~Vykon'] }, { dupl: true, flds: ['~NazevVykonu'] }] },
  { name: 'EDITTAB', data: '{prik}/EDITTAB.000', x: '{prik}/EDITTAB.X00', keys: [{ dupl: false, flds: ['Soubor'] }] },
  {
    name: 'TIPY',
    data: 'TIPY.000',
    x: 'TIPY.X00',
    keys: [{ dupl: false, flds: ['Klíč'] }, { dupl: true, flds: ['K1'] }],
    computed: [{ name: 'K1', typ: 'A', rest: ',1', fn: (get) => get('Klíč').slice(0, 1) }],
  },
  {
    name: 'ADRESY',
    data: '{prik}/ADRESY.000',
    x: '{prik}/ADRESY.X00',
    keys: [
      { dupl: false, flds: ['Cislo'] },
      { dupl: true, flds: ['~Nazev'] },
      { dupl: true, flds: ['~Misto'] },
      { dupl: true, flds: ['~Prijmeni'] },
      { dupl: true, flds: ['Ico10'] },
      { dupl: true, flds: ['~Kod'] },
    ],
    computed: ADRESY_C,
    chPages: [2, 3, 4], // NAZEV, MISTO, JMENO: 'Kocián' is fine, but 'Dolní Ch..' / '..cha' differ
  },
];

function build(c: (typeof CASES)[number], label: string): { fd: FileD; xPath: string; dataPath: string } {
  const dir = join(TMP, label);
  mkdirSync(dir, { recursive: true });
  const dataPath = join(dir, c.data.replace(/.*\//, ''));
  cpSync(join(REF, c.data), dataPath);
  const xPath = join(dir, c.x.replace(/.*\//, ''));
  const fd = openX(dataPath, xPath, DCL[c.name as keyof typeof DCL], c.keys, c.computed);
  AccessVars.CRecPtr = GetRecSpace();
  TestXFExist(); // -> CreateIndexFile
  return { fd, xPath, dataPath };
}

describe.skipIf(!haveRef)('CreateIndexFile: .X byte-identical with the reference FAND', () => {
  beforeAll(ensureRef, 120_000);
  for (const c of CASES) {
    it(`${c.name}: ${c.keys.length} key(s)`, () => {
      const { fd, xPath } = build(c, c.name);
      expect(fd.XF!.NotValid).toBe(false);
      expect(XNRecs(fd.Keys)).toBe(fd.NRecs);
      closeX(fd);
      const ours = xBytes(xPath);
      const theirs = xBytes(join(REF, c.x));
      expect(ours.length).toBe(theirs.length);
      // pages differing only by the BP7 'ch' ligature in CompLex keys (see the header)
      const chPages: number[] = [];
      for (let pg = 0; pg < ours.length / 1024; pg++) {
        const a = ours.subarray(pg * 1024, pg * 1024 + 1024);
        const b = theirs.subarray(pg * 1024, pg * 1024 + 1024);
        if (a.every((v, i) => v === b[i])) continue;
        const da = decodePage(a);
        expect(da.some((it) => it.key.includes('\x4a'))).toBe(true);
        expect(da).toEqual(decodePage(b).map((it) => ({ ...it, key: it.key.replaceAll('\x43\x49', '\x4a') })));
        chPages.push(pg);
      }
      expect(chPages).toEqual(c.chPages ?? []);
    });
  }

});

// ---------------------------------------------------------------- a large file: merge sort, duplicates

describe('CreateIndexFile on 20000 records: sorted chains merged through FANDWORK.$$$', () => {
  it('4 keys (ascending, CompLex, descending, unique with duplicates): order, counts, deleted duplicates', () => {
    const N = 20000;
    const dcl = `Name:A,30; Nr:N,5; Code:A,4; #K`;
    const recLen = 1 + 30 + 3 + 4;
    let seed = 4711;
    const rnd = (n: number): number => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
    const syl = ['cha', 'ch', 'ko', 'ře', 'Ch', 'dub', 'hra', 'Čá', 'la', 'no', 'vá', 'ž', 'ci', 'H', 'Ivo ', ' '];
    const buf = new Uint8Array(6 + N * recLen);
    const dv = new DataView(buf.buffer);
    dv.setInt32(0, -N, true);
    dv.setUint16(4, recLen, true);
    const nrOf: number[] = [0];
    const codeOf: string[] = [''];
    for (let i = 1; i <= N; i++) {
      const o = 6 + (i - 1) * recLen;
      let name = '';
      const k = 1 + rnd(6);
      for (let j = 0; j < k; j++) name += syl[rnd(syl.length)];
      buf.fill(0x20, o + 1, o + 31);
      buf.set(encode852(name).subarray(0, 30), o + 1);
      // Nr unique except every 1000th record (repeats an earlier one: that later record is deleted)
      const nr = i % 1000 === 999 ? nrOf[i - 500] : 30000 + ((i * 7919) % 50000);
      nrOf.push(nr);
      const d = String(nr).padStart(5, '0');
      buf[o + 31] = ((d.charCodeAt(0) & 15) << 4) | (d.charCodeAt(1) & 15);
      buf[o + 32] = ((d.charCodeAt(2) & 15) << 4) | (d.charCodeAt(3) & 15);
      buf[o + 33] = (d.charCodeAt(4) & 15) << 4;
      // Code unique except every 700th record
      const code = i % 700 === 0 ? codeOf[i - 350] : (i * 37).toString(36).toUpperCase().padStart(4, '0').slice(-4);
      codeOf.push(code);
      buf.set(encode852(code), o + 34);
    }
    const dir = join(TMP, 'BIG');
    mkdirSync(dir, { recursive: true });
    const dataPath = join(dir, 'BIG.000');
    writeFileSync(dataPath, buf);
    const keys: KeySpec[] = [
      { dupl: false, flds: ['Nr'] },
      { dupl: true, flds: ['~Name'] },
      { dupl: false, flds: ['Code'] },
      { dupl: true, flds: ['>Name', 'Nr'] },
    ];
    const fd = openX(dataPath, join(dir, 'BIG.X00'), dcl, keys);
    const nMsg = ObaseWWVars.BatchMsgCount;
    AccessVars.CRecPtr = GetRecSpace();
    TestXFExist();
    expect(ObaseWWVars.BatchMsgCount).toBe(nMsg + 1); // WrLLF10Msg(828) once (MsgWritten)
    // expected: later duplicates of the unique keys are deleted, key by key in chain order
    const deleted = new Set<number>();
    const seenNr = new Set<number>();
    for (let i = 1; i <= N; i++) {
      if (seenNr.has(nrOf[i])) deleted.add(i);
      else seenNr.add(nrOf[i]);
    }
    const seenCode = new Set<string>();
    for (let i = 1; i <= N; i++) {
      if (deleted.has(i)) continue;
      if (seenCode.has(codeOf[i])) deleted.add(i);
      else seenCode.add(codeOf[i]);
    }
    expect(fd.XF!.NRecs).toBe(N - deleted.size);
    AccessVars.CRecPtr = GetRecSpace();
    for (let i = 1; i <= N; i++) {
      ReadRec(i);
      expect(DeletedFlag()).toBe(deleted.has(i));
    }
    // every key: (key bytes, recnr) ascending, all live records, a sound tree
    for (let k = fd.Keys, kn = 1; k !== null; k = k.Chain, kn++) {
      const exp: [string, number][] = [];
      const x = new XString();
      for (let i = 1; i <= N; i++) {
        if (deleted.has(i)) continue;
        ReadRec(i);
        x.PackKF(k.KFlds);
        exp.push([x.S, i]);
      }
      exp.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
      expect(k.NRecs()).toBe(exp.length);
      const got: [string, number][] = [];
      const s = new XScan().Init(fd, k, null, false);
      s.Reset(null, false);
      s.GetRec();
      while (!s.EOF) {
        got.push([k.NrToStr(s.IRec), s.RecNr]);
        s.GetRec();
      }
      expect(got).toEqual(exp);
      const leaves: number[] = [];
      expect(checkTree(fd.XF!, k.IndexRoot, leaves)[0]).toBe(exp.length);
    }
    closeX(fd);
  }, 60_000);
});

// ---------------------------------------------------------------- record maintenance

describe.skipIf(!haveRef)('CreateIndexFile failure', () => {
  beforeAll(ensureRef, 120_000);
  it('a duplicate in a test run and "no" at PromptYN(832): GoExit, XF not valid, NoCreate', () => {
    const c = CASES.find((cc) => cc.name === 'CISPOH')!;
    const dir = join(TMP, 'CISPOH-fail');
    mkdirSync(dir, { recursive: true });
    const dataPath = join(dir, 'CISPOH.001');
    const b = readFileSync(join(REF, c.data));
    const recLen = b.readUInt16LE(4);
    b.copy(b, 6 + recLen + 1, 7, 10); // record 2 gets the Pohyb of record 1
    writeFileSync(dataPath, b);
    const fd = openX(dataPath, join(dir, 'CISPOH.X01'), DCL.CISPOH, c.keys);
    AccessVars.IsTestRun = true; // FandBatch: PromptYN answers no
    const er = new ExitRecord();
    NewExit(null, er);
    let exited = false;
    try {
      TestXFExist();
    } catch (e) {
      if (!(e instanceof GoExitSignal)) throw e;
      exited = true;
    } finally {
      RestoreExit(er);
      AccessVars.IsTestRun = false;
    }
    expect(exited).toBe(true);
    expect(fd.XF!.NotValid).toBe(true);
    expect(fd.XF!.NoCreate).toBe(true);
    expect(fd.XF!.MaxPage).toBe(0);
    closeX(fd);
  });
});

describe.skipIf(!haveRef)('index maintenance of X files (INDEX.PAS unit routines)', () => {
  beforeAll(ensureRef, 120_000);
  it('TryInsertAllIndexes, DeleteXRec, OverwrXRec, RecallRec keep all keys equal to a rebuild', () => {
    const c = CASES.find((cc) => cc.name === 'ADRESY')!;
    const { fd, dataPath } = build(c, 'ADRESY-maint');
    const keysOf = (f: FileD): string[][] => {
      const r: string[][] = [];
      for (let k = f.Keys; k !== null; k = k.Chain) r.push(keyItems(k));
      return r;
    };
    const rec = GetRecSpace();
    AccessVars.CRecPtr = rec;
    ReadRec(5);
    // a new record: copy of 5 with another Cislo
    const r2 = rec.slice();
    const Cislo = fd.FldD!;
    r2.set([0x99, 0x99, 0x90], Cislo.Displ); // '99999'
    AccessVars.CRecPtr = r2;
    IncNRecs(1);
    WriteRec(fd.NRecs);
    TryInsertAllIndexes(fd.NRecs);
    expect(fd.XF!.NRecs).toBe(fd.NRecs);
    expect(DeletedFlag()).toBe(false);
    // a duplicate of the unique key: rolled back, record marked deleted
    const r3 = rec.slice();
    AccessVars.CRecPtr = r3;
    IncNRecs(1);
    WriteRec(fd.NRecs);
    fd.XF!.FirstDupl = true;
    const nMsg = ObaseWWVars.BatchMsgCount;
    TryInsertAllIndexes(fd.NRecs);
    expect(DeletedFlag()).toBe(true);
    expect(ObaseWWVars.BatchMsgCount).toBe(nMsg + 1); // WrLLF10Msg(828)
    const shown = BaseVars.MsgLine;
    RdMsg(828);
    expect(shown).toBe(BaseVars.MsgLine);
    expect(fd.XF!.FirstDupl).toBe(false);
    expect(fd.XF!.NRecs).toBe(fd.NRecs - 1);
    // overwrite record 7 (change Firma and Misto -> keys 2, 3 move)
    AccessVars.CRecPtr = GetRecSpace();
    ReadRec(7);
    const old7 = AccessVars.CRecPtr!.slice();
    const new7 = old7.slice();
    const firma = fd.FldD!.Chain!.Chain!;
    new7.fill(0x20, firma.Displ, firma.Displ + firma.NBytes);
    new7.set(encode852('Chmelnice s.r.o.'), firma.Displ);
    OverwrXRec(7, old7, new7);
    // delete record 3, then recall it
    AccessVars.CRecPtr = GetRecSpace();
    ReadRec(3);
    DeleteXRec(3, false);
    expect(fd.XF!.NRecs).toBe(fd.NRecs - 2);
    AccessVars.CRecPtr = GetRecSpace();
    ReadRec(3);
    expect(DeletedFlag()).toBe(true);
    RecallRec(3);
    expect(fd.XF!.NRecs).toBe(fd.NRecs - 1);
    const after = keysOf(fd);
    const leaves: number[] = [];
    for (let k = fd.Keys; k !== null; k = k.Chain) checkTree(fd.XF!, k.IndexRoot, leaves);
    AccessVars.CFile = fd;
    WrPrefix(); // NRecs of the data file
    closeX(fd);
    // rebuild from the changed data
    const fd2 = openX(dataPath, join(TMP, 'ADRESY-maint', 'REBUILD.X00'), DCL.ADRESY, c.keys, c.computed);
    AccessVars.CRecPtr = GetRecSpace();
    CreateIndexFile();
    // equal keys: a rebuild orders them by record number, incremental inserts by insertion time
    const bySet = (ks: string[][]): string[][] => ks.map((k) => [...k].sort());
    expect(bySet(keysOf(fd2))).toEqual(bySet(after));
    expect(keysOf(fd2)[0]).toEqual(after[0]); // the unique key: identical
    closeX(fd2);
  });
});

// ---------------------------------------------------------------- XScan and work indexes

describe.skipIf(!haveRef)('XScan, work indexes (SORT.PAS)', () => {
  beforeAll(ensureRef, 120_000);
  let fd: FileD;
  const get = (name: string): string => {
    for (let f = fd.FldD; f !== null; f = f.Chain) {
      if (f.Name === B(name)) return String.fromCharCode(...AccessVars.CRecPtr!.subarray(f.Displ, f.Displ + f.NBytes));
    }
    throw new Error(name);
  };
  const scanAll = (s: XScan, what = 'Klíč'): string[] => {
    const out: string[] = [];
    s.GetRec();
    while (!s.EOF) {
      out.push(get(what));
      s.GetRec();
    }
    return out;
  };
  beforeAll(() => {
    fd = build(CASES.find((c) => c.name === 'TIPY')!, 'TIPY-scan').fd;
  });

  it('Kind 0 (all records) and Kind 1 (by key) with a condition', () => {
    const s0 = new XScan().Init(fd, null, null, false);
    s0.Reset(null, false);
    expect(s0.NRecs).toBe(fd.NRecs);
    const all = scanAll(s0);
    expect(all.length).toBe(fd.NRecs);
    const s1 = new XScan().Init(fd, fd.Keys, null, false);
    s1.Reset(startsWithF(fd.FldD!, 'U'), false);
    const byKey = scanAll(s1);
    const expected = all.filter((k) => k.startsWith('U')).sort((a, b) => (trail(a) + '\x1f' < trail(b) + '\x1f' ? -1 : 1));
    expect(byKey).toEqual(expected);
    // SeekRec into the middle
    s1.Reset(null, false);
    s1.SeekRec(1000);
    s1.GetRec();
    expect(s1.IRec).toBe(1001);
    expect(s1.RecNr).toBe(fd.Keys!.NrToRecNr(1001));
  });

  it('Kind 2 with an owner work index (ResetOwnerIndex, NextIntvl); GETINDEX owner record', () => {
    const k2 = fd.Keys!.Chain!; // TIP * K1
    // the owner: a work index of TIPY by K1 holding one 'U' and one 'N' record
    const all = new XScan().Init(fd, null, null, false);
    all.Reset(null, false);
    const firstOf = (c: string): number => {
      all.SeekRec(0);
      all.GetRec();
      while (!all.EOF && !get('Klíč').startsWith(c)) all.GetRec();
      return all.RecNr;
    };
    const owner = new XWKey();
    owner.Open(k2.KFlds, true, false);
    AccessVars.CRecPtr = GetRecSpace();
    for (const c of ['U', 'N']) {
      ReadRec(firstOf(c));
      owner.InsertGetNr(all.RecNr);
    }
    const lv = new LocVar();
    lv.FD = fd;
    lv.RecPtr = owner;
    const ld = new LinkD();
    ld.ToFD = fd;
    ld.ToKey = k2;
    const s = new XScan().Init(fd, k2, null, false);
    s.ResetOwnerIndex(ld, lv, null);
    const got = scanAll(s);
    const s0 = new XScan().Init(fd, k2, null, false);
    s0.Reset(null, false);
    const byK1 = scanAll(s0);
    expect(got).toEqual([...byK1.filter((k) => k[0] === 'N'), ...byK1.filter((k) => k[0] === 'U')]);
    // GETINDEX w, owner record ('r'): the records with the key of lv2's record
    const w = new XWKey();
    w.Open(fd.Keys!.KFlds, true, false);
    const wlv = new LocVar();
    wlv.FD = fd;
    wlv.RecPtr = w;
    const lv2 = new LocVar();
    lv2.FD = fd;
    lv2.RecPtr = GetRecSpace();
    lv2.RecPtr.set(encode852('R'), 1);
    const pd = new Instr(_getindex);
    pd.giLV = wlv;
    pd.giMode = ' ';
    pd.giKD = k2;
    pd.giLD = ld;
    pd.giLV2 = lv2;
    pd.giOwnerTyp = 'r';
    GetIndex(pd);
    const sw = new XScan().Init(fd, w, null, false);
    sw.Reset(null, false);
    const rs = byK1.filter((k) => k[0] === 'R').sort();
    expect(scanAll(sw)).toEqual(rs); // ordered by giKFlds = nil -> the work key's own fields (Klíč)
    w.Close();
    owner.Close();
  });

  it('Kind 2: key intervals (KeyInD) and ResetOwner', () => {
    const k2 = fd.Keys!.Chain!; // TIP * K1
    const ki1 = new KeyInD();
    ki1.FL1 = new FrmlListEl();
    ki1.FL1.Frml = sConst('N');
    const ki2 = new KeyInD();
    ki2.FL1 = new FrmlListEl();
    ki2.FL1.Frml = sConst('M');
    ki2.FL2 = new FrmlListEl();
    ki2.FL2.Frml = sConst('P');
    ki1.Chain = ki2;
    const s = new XScan().Init(fd, k2, ki1, false);
    s.Reset(null, false);
    const got = scanAll(s);
    const s0 = new XScan().Init(fd, k2, null, false);
    s0.Reset(null, false);
    const all = scanAll(s0);
    const n = all.filter((k) => k[0] === 'N');
    const mp = all.filter((k) => k[0] >= 'M' && k[0] <= 'P');
    expect(got).toEqual([...n, ...mp]);
    expect(s.NRecs).toBe(n.length + mp.length);
    // owner: all records with key 'U'
    const x = new XString();
    x.S = 'U';
    const so = new XScan().Init(fd, k2, null, false);
    so.ResetOwner(x, null);
    expect(scanAll(so)).toEqual(all.filter((k) => k[0] === 'U'));
  });

  it('ScanSubstWIndex sorts a scan by other fields (descending); CopyIndex; GetIndex', () => {
    const s = new XScan().Init(fd, null, null, false);
    const BoolZ = ref<FrmlPtr>(startsWithF(fd.FldD!, 'N'));
    const sk = new KeyFldD();
    sk.FldD = fd.FldD!; // Klíč
    sk.Descend = true;
    s.ResetSort(sk, BoolZ, ExclMode, false);
    expect(BoolZ.v).toBe(null);
    const got = scanAll(s);
    const s0 = new XScan().Init(fd, fd.Keys, null, false);
    s0.Reset(null, false);
    const asc = scanAll(s0).filter((k) => k.startsWith('N'));
    expect(got).toEqual([...asc].reverse());
    s.Close();
    // CopyIndex: a work index as a copy of key 1 (Kind 1 scan with equal fields: XWorkFile.CopyIndex)
    const w = new XWKey();
    w.Open(fd.Keys!.KFlds, true, false);
    CopyIndex(w, fd.Keys);
    expect(w.NRecs()).toBe(fd.NRecs);
    const kk = fd.Keys!;
    for (let i = 1; i <= fd.NRecs; i += 97) {
      expect(w.NrToRecNr(i)).toBe(kk.NrToRecNr(i));
      expect(w.NrToStr(i)).toBe(kk.NrToStr(i));
    }
    // GETINDEX lv, '+'/'-' recnr
    const lv = new LocVar();
    lv.FD = fd;
    lv.RecPtr = w;
    const pd = new Instr(_getindex);
    pd.giLV = lv;
    pd.giMode = '-';
    pd.giCond = rConst(5);
    GetIndex(pd);
    expect(w.NRecs()).toBe(fd.NRecs - 1);
    pd.giMode = '+';
    GetIndex(pd);
    expect(w.NRecs()).toBe(fd.NRecs);
    // GETINDEX lv with a condition: a new work index
    pd.giMode = ' ';
    pd.giCond = startsWithF(fd.FldD!, 'M');
    pd.giKD = fd.Keys;
    pd.giOwnerTyp = '\0';
    GetIndex(pd);
    expect(w.NRecs()).toBe(asc.length === 0 ? 0 : scanAllCount(fd, 'M'));
    // a scan over the work index
    const sw = new XScan().Init(fd, w, null, false);
    sw.Reset(null, false);
    expect(scanAll(sw).every((k) => k.startsWith('M'))).toBe(true);
    w.Close();
  });

  function scanAllCount(f: FileD, c: string): number {
    const s = new XScan().Init(f, null, null, false);
    s.Reset(null, false);
    return scanAll(s).filter((k) => k.startsWith(c)).length;
  }

  it('CreateWIndex with a condition on a Kind 0 scan; XScan.ResetLV', () => {
    const k = new XWKey();
    k.Open(fd.Keys!.Chain!.KFlds, true, false);
    const s = new XScan().Init(fd, null, null, false);
    s.Reset(startsWithF(fd.FldD!, 'R'), false);
    CreateWIndex(s, k, 'X');
    expect(k.NRecs()).toBe(scanAllCount(fd, 'R'));
    k.Close();
    const lvRec = GetRecSpace();
    lvRec.set(encode852('ZZZZZ'), 1);
    const sl = new XScan().Init(fd, null, null, false);
    sl.ResetLV(lvRec);
    AccessVars.CRecPtr = GetRecSpace();
    expect(scanAll(sl)).toEqual(['ZZZZZ']);
  });

  it('ScanSubstWIndex on a Kind 1 scan with a condition goes through the sort', () => {
    const s = new XScan().Init(fd, fd.Keys, null, false);
    s.Reset(startsWithF(fd.FldD!, 'E'), false);
    const sk = new KeyFldD();
    sk.FldD = fd.FldD!.Chain!; // Oddíl
    sk.CompLex = true;
    ScanSubstWIndex(s, sk, 'S');
    const got: string[] = [];
    s.GetRec();
    while (!s.EOF) {
      got.push(get('Oddíl'));
      s.GetRec();
    }
    const lex = (u: string): string => {
      const y = new XString();
      y.StoreStr(u, sk);
      return y.S;
    };
    for (let i = 1; i < got.length; i++) expect(lex(got[i - 1]) <= lex(got[i])).toBe(true);
    expect(got.length).toBe(scanAllCount(fd, 'E'));
    s.Close();
  });
});
