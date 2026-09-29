// EXPIMP package: expimp.ts (COPYFILE import/export/copy, BACKUP/RESTORE, BACKUPM/RESTOREM,
// XEncode/CompressTxt/CodingCRdb, CheckFile, OldToNewCat). Real Účto files are copied to
// work/tmp-expimp/ (the pristine install is never written); the run-only UCTO2026.RDB texts are
// decoded by the independent fand/rdb.ts reader.

import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  ref, fref, FromUnicode, Output, TxtRewrite, getWord, StrToBytes, BytesToStr,
  NotImplementedError, GoExitSignal,
} from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, FormatCache, OpenH, ReadH, SeekH, PosH, OpenWorkH, InitBase, SizeOfResA, MsgIdxFromBytes,
  SaveCache, CloseClearH, _isoldfile, _isoverwritefile, Exclusive, ExitRecord, NewExit, RestoreExit,
} from '../src/engine/pas/base.ts';
import {
  AccessVars, FileD, FieldDescr, TFile, FrmlElem, _const, f_Stored, LeftJust, ExclMode, GetRecSpace, ReadRec, PutRec,
  S_, LongS_, _T, _ShortS, RdPrefixes, WrPrefixes, CloseClearHCFile, CodingLongStr,
} from '../src/engine/pas/access.ts';
import { CopyD, Instr, RdRunVars, EditD, cpFix, cpVar, cpTxt, _backup } from '../src/engine/pas/rdrun.ts';
import {
  CopyFile, OldToNewCat, Backup, BackupM, XEncode, CompressTxt, CodingCRdb, CheckFile,
} from '../src/engine/pas/expimp.ts';
import { SetDriversCrt, DriversVars, AssignCrt } from '../src/engine/pas/drivers.ts';
import { Crt } from '../src/engine/console/crt.ts';
import { KeyQueue } from '../src/engine/console/keyqueue.ts';
import { encode852, decode852 } from '../src/engine/console/cp852.ts';
import { DataFile } from '../src/engine/fand/datafile.ts';
import { Rdb } from '../src/engine/fand/rdb.ts';
import { xDecode, xorAA } from '../src/engine/fand/coding.ts';
import { TAB_F } from '../src/engine/fand/numbers.ts';

// Other packages still stubbed: minimal fallbacks (constant formulas, string trims) and no-op merges
vi.mock('../src/engine/pas/runfrml.ts', async (orig) => {
  const m = await orig<typeof import('../src/engine/pas/runfrml.ts')>();
  const fb =
    <A extends unknown[], R>(f: (...a: A) => R, alt: (...a: A) => R) =>
    (...a: A): R => {
      try {
        return f(...a);
      } catch (e) {
        if (e instanceof NotImplementedError) return alt(...a);
        throw e;
      }
    };
  return {
    ...m,
    TrailChar: fb(m.TrailChar, (C: string, S: string) => {
      let i = S.length;
      while (i > 0 && S[i - 1] === C) i--;
      return S.slice(0, i);
    }),
    LeadChar: fb(m.LeadChar, (C: string, S: string) => {
      let i = 0;
      while (i < S.length && S[i] === C) i++;
      return S.slice(i);
    }),
    RunShortStr: fb(m.RunShortStr, (Z) => Z!.S),
    RunLongStr: fb(m.RunLongStr, (Z) => StrToBytes(Z!.S)),
  };
});
vi.mock('../src/engine/pas/rdmerg.ts', async (orig) => ({
  ...(await orig<typeof import('../src/engine/pas/rdmerg.ts')>()),
  ReadMerge: () => {},
}));
vi.mock('../src/engine/pas/runmerg.ts', async (orig) => ({
  ...(await orig<typeof import('../src/engine/pas/runmerg.ts')>()),
  RunMerge: () => {},
}));
vi.mock('../src/engine/pas/runedit1.ts', async (orig) => ({
  ...(await orig<typeof import('../src/engine/pas/runedit1.ts')>()),
  CRec: () => 1,
}));

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const TMP = join(ROOT, 'work/tmp-expimp');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB'));
const B = (u: string): string => String.fromCharCode(...encode852(u));
const H = (p: string): string => FromUnicode(p); // host path -> byte string
const bytes = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const str = (b: Uint8Array): string => BytesToStr(b);

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
function freshDir(name: string): string {
  const d = join(TMP, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}
/** Minimal RDFILDCL: the stored fields of a declaration (no '#' parts). */
function fields(dcl: string, displ0: number): { first: FieldDescr; recLen: number; byName: Map<string, FieldDescr> } {
  const list: FieldDescr[] = [];
  const byName = new Map<string, FieldDescr>();
  let displ = displ0;
  for (const part of dcl.split(';')) {
    const m = /^\s*([^:\s]+)\s*:\s*([ANFRDBT])\s*(.*)$/s.exec(part);
    if (!m) continue;
    const [, name, typ, rest] = m;
    const F = new FieldDescr();
    F.Name = B(name);
    F.Typ = typ;
    F.Flg = f_Stored;
    F.FrmlTyp = 'S';
    switch (typ) {
      case 'A': {
        const mm = /^,\s*(\d+)\s*(R)?/.exec(rest)!;
        F.L = +mm[1];
        F.M = mm[2] ? 0 : LeftJust;
        F.NBytes = F.L;
        break;
      }
      case 'N': {
        const mm = /^,\s*(\d+)/.exec(rest)!;
        F.L = +mm[1];
        F.NBytes = (F.L + 1) >> 1;
        break;
      }
      case 'F': {
        const mm = /^,\s*(\d+)\s*\.\s*(\d+)/.exec(rest)!;
        const L = +mm[1];
        const M = +mm[2];
        F.NBytes = TAB_F[L + M];
        F.L = M === 0 ? L + 1 : L + M + 2;
        F.M = M;
        F.FrmlTyp = 'R';
        break;
      }
      case 'D':
        F.NBytes = 6;
        F.L = 10;
        F.FrmlTyp = 'R';
        F.Mask = 'DD.MM.YYYY';
        break;
      case 'R':
        F.NBytes = 6;
        F.L = 17;
        F.M = 5;
        F.FrmlTyp = 'R';
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
    F.Displ = displ;
    displ += F.NBytes;
    list.push(F);
    byName.set(name, F);
  }
  for (let i = 0; i < list.length - 1; i++) list[i].Chain = list[i + 1];
  return { first: list[0], recLen: displ, byName };
}
/** Opens a '6' data file (with its T file) exclusively, like OACCESS.OpenF. */
function openFD(name: string, path: string, tpath: string | null, dcl: string): FileD {
  const { first, recLen } = fields(dcl, 0);
  const fd = new FileD();
  fd.Typ = '6';
  fd.Name = name;
  fd.RecLen = recLen;
  fd.FrstDispl = 6;
  fd.FldD = first;
  fd.UMode = Exclusive;
  fd.LMode = ExclMode;
  BaseVars.CPath = H(path);
  fd.Handle = OpenH(_isoldfile, Exclusive);
  expect(BaseVars.HandleError).toBe(0);
  if (tpath !== null) {
    fd.TF = new TFile();
    BaseVars.CPath = H(tpath);
    fd.TF.Handle = OpenH(_isoldfile, Exclusive);
    expect(BaseVars.HandleError).toBe(0);
  }
  AccessVars.CFile = fd;
  RdPrefixes();
  return fd;
}
function closeFD(fd: FileD): void {
  AccessVars.CFile = fd;
  WrPrefixes();
  SaveCache(0);
  CloseClearHCFile();
  if (fd.TF !== null) CloseClearH(fref(fd.TF, 'Handle'));
}
/** Runs f under an armed NewExit; true when it ended by GoExit. */
function goExits(f: () => void): boolean {
  const er = new ExitRecord();
  NewExit(null, er);
  try {
    f();
    return false;
  } catch (e) {
    if (e instanceof GoExitSignal) return true;
    throw e;
  } finally {
    RestoreExit(er);
  }
}
/** A COPYFILE descriptor between two host paths. */
function copyD(p1: string | null, p2: string | null, init: Partial<CopyD> = {}): CopyD {
  const cd = new CopyD();
  cd.Path1 = p1 === null ? null : H(p1);
  cd.Path2 = p2 === null ? null : H(p2);
  Object.assign(cd, init);
  return cd;
}
/** XDecode done in place in one buffer, as the BP7 asm does: fails when Displ is too small. */
function xDecodeInPlace(enc: Uint8Array): Uint8Array {
  const a = Uint8Array.from(enc);
  const ll = a.length;
  if (ll === 0) return a;
  const bound = ll - 3;
  const displ = (a[ll - 2] | (a[ll - 1] << 8)) ^ 0xcccc;
  const rol = (v: number, n: number): number => ((v << n) | (v >> (8 - n))) & 0xff;
  let mask = rol(0x9c, a[bound] & 3);
  let si = displ;
  let w = 0;
  outer: while (si < bound) {
    let flags = a[si++];
    for (let bit = 0; bit < 8; bit++) {
      if (si >= bound) break outer;
      if ((flags & 1) === 0) {
        mask = rol(mask, 1);
        const c = a[si++] ^ mask;
        a[w++] = c;
      } else {
        const len = a[si];
        const pos = (a[si + 1] | (a[si + 2] << 8)) - 2;
        si += 3;
        for (let k = 0; k < len; k++) a[w++] = a[pos + k];
      }
      if (w > si && si < bound) throw new Error(`output overtook input at ${w}/${si}`);
      flags >>= 1;
    }
  }
  return a.slice(0, w);
}
function encode(s: Uint8Array): Uint8Array {
  const r = ref<Uint8Array>(new Uint8Array(0));
  XEncode(s, r);
  return r.v;
}
function compress(s: string | Uint8Array, typ: string): string {
  const r = ref(typeof s === 'string' ? bytes(s) : s);
  CompressTxt(1, r, typ);
  return str(r.v);
}

let cwd0 = '';
beforeAll(() => {
  cwd0 = process.cwd();
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  if (haveApp) {
    process.env.FANDRES = APP;
    InitBase();
    ReadResHeader();
  }
  FormatCache();
  SetDriversCrt(new Crt(new KeyQueue(), null, 80, 25));
  AssignCrt(Output);
  TxtRewrite(Output);
  DriversVars.FandBatch = true; // messages -> stderr, prompts answer No
  const tw = AccessVars.TWork;
  tw.IsWork = true;
  BaseVars.CPath = H(join(TMP, 'FANDWORK.T$$'));
  BaseVars.FandWorkTName = BaseVars.CPath;
  tw.Create();
  BaseVars.FandWorkName = H(join(TMP, 'FANDWORK.$$$'));
  BaseVars.FandWorkXName = H(join(TMP, 'FANDWORK.X$$'));
  OpenWorkH();
});
afterEach(() => {
  process.chdir(cwd0);
});

// ---------------------------------------------------------------- XEncode

describe('EXPIMP XEncode (BP7 asm) is decoded by XDecode', () => {
  it('synthetic texts: empty, literals, long runs (> 255), repeats, all byte values', () => {
    const cases: Uint8Array[] = [
      new Uint8Array(0),
      bytes('a'),
      bytes('ab'),
      bytes('abcabcabcabc'),
      bytes('x'.repeat(1000)),
      bytes('proc begin end; '.repeat(300) + 'konec'),
      Uint8Array.from({ length: 5000 }, (_, i) => (i * 7919 + (i >> 5)) & 0xff),
      Uint8Array.from({ length: 256 * 3 }, (_, i) => i & 0xff),
    ];
    for (const s of cases) {
      const e = encode(s);
      expect(xDecode(e)).toEqual(s);
      expect(xDecodeInPlace(e)).toEqual(s);
      if (s.length === 0) expect(e.length).toBe(3);
    }
    // a 1000-byte run is a few items (matches of up to 255 bytes) after Displ padding bytes
    // (Displ keeps the in-place decoding from overtaking its input, so LL is about the text length)
    const e = encode(bytes('x'.repeat(1000)));
    const displ = getWord(e, e.length - 2) ^ 0xcccc;
    expect(e.length - displ).toBeLessThan(40);
    expect(displ).toBeGreaterThan(900);
  });
  it('decodes with the engine: ACCESS CodingLongStr of a licensed T file', () => {
    const fd = new FileD();
    fd.TF = new TFile();
    fd.TF.LicenseNr = 1234;
    AccessVars.CFile = fd;
    const s = bytes('#I1_UCTO #O1_UCTO {komentar} "x" '.repeat(50));
    expect(CodingLongStr(encode(s))).toEqual(s);
  });
  it.skipIf(!haveApp)('every chapter text of the run-only UCTO2026.RDB round-trips', () => {
    const r = new Rdb(join(APP, 'UCTO2026.RDB'));
    try {
      let n = 0;
      for (const ch of r.chapters) {
        const t = r.textBytes(ch);
        const e = encode(t);
        expect(xDecode(e)).toEqual(t);
        expect(xDecodeInPlace(e)).toEqual(t);
        n++;
      }
      expect(n).toBeGreaterThan(600);
    } finally {
      r.close();
    }
  });
});

// ---------------------------------------------------------------- CompressTxt

describe('EXPIMP CompressTxt (run-only chapter texts)', () => {
  it('comments become a blank, whitespace runs collapse, strings are kept', () => {
    expect(compress("proc  {komentar {vnoreny}} x;\r\n  y:='a  {b}'; ", 'P')).toBe("proc   x; y:='a  {b}'; ");
    expect(compress('a\tb\x00c', 'D')).toBe('a b c');
    expect(compress('', 'P')).toBe('');
    // R, U, E, H chapters keep their whitespace
    expect(compress('.head  {c}\r\n  x', 'R')).toBe('.head   \r\n  x');
    expect(compress('a   b', 'H')).toBe('a   b');
  });
  it('conditional directives are evaluated and removed', () => {
    expect(compress('{$define AB}x {$ifdef A}yes{$else}no{$endif} z', 'P')).toBe('x yes z');
    expect(compress('{$define B}x {$ifdef A}yes{$else}no{$endif} z', 'P')).toBe('x no z');
    expect(compress('{$ifndef A}n{$endif}.', 'P')).toBe('n.');
  });
  it('E chapters keep their headline lines up to #', () => {
    expect(compress('Nadpis  1\r\n Radek {x}\r\n#F  a', 'E')).toBe('Nadpis  1\r\n Radek {}\r\n#F  a');
    // SkipBlank(true) stops at the next non-blank of the same line: it starts a new headline
    expect(compress('Nadpis  1\r\n Radek {x} 2\r\n#F  a', 'E')).toBe('Nadpis  1\r\n Radek {}\r\n2\r\n#F  a');
    expect(compress('jen text', 'E')).toBe('jen text');
  });
  it('unterminated comments and strings stop at the end of the text', () => {
    expect(compress('a {neukonceny', 'P')).toBe('a  ');
    expect(compress("a 'text", 'P')).toBe("a 'text");
  });
  it.skipIf(!haveApp)('the Účto chapters: compressing is idempotent, blanks collapse outside strings', () => {
    // UCTO2026.RDB is already run-only: its texts are CompressTxt output (comments -> ' ', so blank
    // runs remain where comments were); a second pass only collapses those runs
    const r = new Rdb(join(APP, 'UCTO2026.RDB'));
    try {
      let n = 0;
      const bad: string[] = [];
      for (const ch of r.chapters) {
        const t = r.textBytes(ch);
        if (str(t).includes('{$')) continue; // directives would need their chapters
        const c = compress(t, ch.typ);
        if (compress(c, ch.typ) !== c) bad.push(`${ch.typ} ${ch.name}`);
        if (!'RUEH'.includes(ch.typ)) {
          const q = c.split("'"); // outside strings: single blanks, no control chars, no comments
          for (let i = 0; i < q.length; i += 2) if (/[\x00-\x19\x1b]| {2}|\{/.test(q[i])) bad.push(`${ch.typ} ${ch.name} ${q[i]}`);
        }
        n++;
      }
      expect(bad).toEqual([]);
      expect(n).toBeGreaterThan(600);
    } finally {
      r.close();
    }
  });
});

// ---------------------------------------------------------------- CodingCRdb

describe('EXPIMP CodingCRdb on a small chapter file', () => {
  const DCL = 'TxtPos:F,4.0; Overit:B; StText:T; Typ:A,1; Nazev:A,12; Text:T';
  type Ch = { typ: string; name: string; txt: string; old?: Uint8Array };
  let D = '';
  function makeRdb(chs: Ch[]): FileD {
    D = freshDir('rdb');
    const { first, recLen, byName } = fields(DCL, 0);
    const av = AccessVars;
    const Chpt = new FileD();
    Chpt.Typ = '0';
    Chpt.Name = 'TEST';
    Chpt.RecLen = recLen;
    Chpt.FrstDispl = 6;
    Chpt.FldD = first;
    Chpt.UMode = Exclusive;
    Chpt.LMode = ExclMode;
    BaseVars.CPath = H(join(D, 'TEST.RDB'));
    Chpt.Handle = OpenH(_isoverwritefile, Exclusive);
    Chpt.TF = new TFile();
    av.CFile = Chpt;
    BaseVars.CPath = H(join(D, 'TEST.TTT'));
    Chpt.TF.Create();
    av.Chpt = Chpt;
    av.ChptTF = Chpt.TF;
    av.ChptTxt = byName.get('Text')!;
    av.ChptOldTxt = byName.get('StText')!;
    av.ChptTyp = byName.get('Typ')!;
    av.ChptName = byName.get('Nazev')!;
    av.CRecPtr = GetRecSpace();
    for (const c of chs) {
      av.CRecPtr.fill(0);
      S_(av.ChptTyp, c.typ);
      S_(av.ChptName, c.name);
      LongS_(av.ChptTxt, bytes(c.txt));
      if (c.old) LongS_(av.ChptOldTxt, c.old);
      PutRec();
    }
    const e = new EditD();
    e.NewRecPtr = GetRecSpace();
    RdRunVars.EditDRoot = e;
    return Chpt;
  }
  function readBack(): { typ: string; name: string; txt: Uint8Array; old: Uint8Array | null }[] {
    const av = AccessVars;
    av.CFile = av.Chpt;
    av.CRecPtr = GetRecSpace();
    const res = [];
    for (let i = 1; i <= av.Chpt!.NRecs; i++) {
      ReadRec(i);
      const pt = _T(av.ChptTxt);
      const po = _T(av.ChptOldTxt);
      res.push({
        typ: _ShortS(av.ChptTyp),
        name: _ShortS(av.ChptName).trimEnd(),
        txt: av.ChptTF!.Read(1, pt),
        old: po === 0 ? null : av.ChptTF!.Read(1, po),
      });
    }
    return res;
  }
  it('Rotate: comments/blank chapters dropped, texts compressed + XEncoded, TxtPosUDLI set', () => {
    const img = new Uint8Array(60); // a BP7 FileD image with TxtPosUDLI at offset 36
    img.fill(0x55);
    const F = "A:A,5; {kl'ic} B:N,2;\r\n#K @ A\r\n#I B:='#D';\r\n";
    makeRdb([
      { typ: 'I', name: 'POZN', txt: 'poznamka' },
      { typ: 'F', name: 'DATA', txt: F, old: img },
      { typ: ' ', name: '', txt: 'nic' },
      { typ: 'P', name: 'MAIN', txt: 'proc  main;\r\n begin {x} end;' },
      { typ: 'R', name: 'SEST', txt: '.head  1\r\n  x' },
    ]);
    const cr = AccessVars.ChptTF!;
    cr.IRec = 7;
    cr.CompileAll = true;
    CodingCRdb(true);
    expect(cr.IRec).toBe(7);
    expect(cr.CompileAll).toBe(true);
    const r = readBack();
    expect(r.map((x) => [x.typ, x.name])).toEqual([['F', 'DATA'], ['P', 'MAIN'], ['R', 'SEST']]);
    const f = str(xDecode(r[0].txt));
    expect(f).toBe("A:A,5;   B:N,2; #K @ A #I B:='#D'; ");
    const o = xDecode(r[0].old!);
    expect(o.length).toBe(60);
    expect(getWord(o, 36)).toBe(f.indexOf('#I') + 1);
    expect(o[35]).toBe(0x55);
    expect(str(xDecode(r[1].txt))).toBe('proc main; begin   end;');
    expect(str(xDecode(r[2].txt))).toBe('.head  1\r\n  x');
  });
  it('password coding (Rotate=false): every text XOR $AA, nothing dropped', () => {
    makeRdb([
      { typ: 'I', name: 'POZN', txt: 'poznamka' },
      { typ: 'P', name: 'MAIN', txt: 'proc main;' },
    ]);
    CodingCRdb(false);
    const r = readBack();
    expect(r.map((x) => x.typ)).toEqual(['I', 'P']);
    expect(str(xorAA(r[0].txt))).toBe('poznamka');
    expect(str(xorAA(r[1].txt))).toBe('proc main;');
  });
});

// ---------------------------------------------------------------- COPYFILE

describe('EXPIMP CopyFile: text copies and code pages', () => {
  it('cpTxt (TxtCtrlJ): CR -> CR LF, LF dropped; append; a missing input ends by GoExit', () => {
    const D = freshDir('txt');
    const a = join(D, 'A.TXT');
    const b = join(D, 'B.TXT');
    writeFileSync(a, Buffer.from('r1\rr2\nr3\r\nr4', 'latin1'));
    CopyFile(copyD(a, b, { Opt1: cpTxt }));
    expect(BaseVars.LastExitCode).toBe(0);
    expect(readFileSync(b, 'latin1')).toBe('r1\r\nr2r3\r\nr4');
    CopyFile(copyD(a, b, { Opt1: cpTxt, Append: true }));
    expect(readFileSync(b, 'latin1')).toBe('r1\r\nr2r3\r\nr4'.repeat(2));
    // the output of an empty input is deleted (Size = 0)
    writeFileSync(join(D, 'E.TXT'), '');
    CopyFile(copyD(join(D, 'E.TXT'), join(D, 'F.TXT'), { Opt1: cpTxt }));
    expect(existsSync(join(D, 'F.TXT'))).toBe(false);
    // same input and output: RunError 660 -> GoExit; NoCancel keeps LastExitCode
    expect(goExits(() => CopyFile(copyD(a, a, {})))).toBe(true);
    expect(goExits(() => CopyFile(copyD(a, a, { NoCancel: true })))).toBe(false);
    expect(BaseVars.LastExitCode).toBe(2);
  });
  it('plain copy of a large binary file (Mode 0)', () => {
    const D = freshDir('bin');
    const data = Buffer.from(Uint8Array.from({ length: 70000 }, (_, i) => (i * 31) & 0xff));
    writeFileSync(join(D, 'X.BIN'), data);
    CopyFile(copyD(join(D, 'X.BIN'), join(D, 'Y.BIN')));
    expect(readFileSync(join(D, 'Y.BIN'))).toEqual(data);
  });
  it.skipIf(!haveApp)('code page modes: Latin2 <-> Windows 1250 (FAND.RES tables), Kamenický, no diacritics', () => {
    const D = freshDir('cp');
    const u = 'Příliš žluťoučký kůň ÚPĚL ďábelské ódy';
    writeFileSync(join(D, 'L2.TXT'), Buffer.from(encode852(u)));
    CopyFile(copyD(join(D, 'L2.TXT'), join(D, 'W.TXT'), { Mode: 5 }));
    expect(new TextDecoder('windows-1250').decode(readFileSync(join(D, 'W.TXT')))).toBe(u);
    CopyFile(copyD(join(D, 'W.TXT'), join(D, 'L2B.TXT'), { Mode: 7 }));
    expect(readFileSync(join(D, 'L2B.TXT'))).toEqual(readFileSync(join(D, 'L2.TXT')));
    CopyFile(copyD(join(D, 'L2.TXT'), join(D, 'K.TXT'), { Mode: 2 })); // Latin2 -> Kamenický
    expect(readFileSync(join(D, 'K.TXT'))).not.toEqual(readFileSync(join(D, 'L2.TXT')));
    CopyFile(copyD(join(D, 'K.TXT'), join(D, 'L2C.TXT'), { Mode: 1 }));
    expect(decode852(readFileSync(join(D, 'L2C.TXT')))).toBe(u);
    CopyFile(copyD(join(D, 'L2.TXT'), join(D, 'N.TXT'), { Mode: 4 }));
    expect(readFileSync(join(D, 'N.TXT'), 'latin1')).toBe('Prilis zlutoucky kun UPEL dabelske ody');
  });
});

const PRACSML_DCL = 'Datum:D; Název:A,30; Smlouva:T; Koment:A,30; CtrlL:B';

describe.skipIf(!haveApp)('EXPIMP CopyFile: data files (PRACSML.004 of Účto)', () => {
  let D = '';
  beforeAll(() => {
    D = freshDir('data');
    for (const f of ['PRACSML.004', 'PRACSML.T04']) cpSync(join(APP, '{nova}', f), join(D, f));
  });
  it('ExportFD: raw copy of the data and T file; ImportFD writes them back', () => {
    const fd = openFD('PRACSML', join(D, 'PRACSML.004'), join(D, 'PRACSML.T04'), PRACSML_DCL);
    try {
      CopyFile(copyD(null, join(D, 'EXP.004'), { FD1: fd }));
      expect(BaseVars.LastExitCode).toBe(0);
      const n = fd.UsedFileSize();
      expect(readFileSync(join(D, 'EXP.004'))).toEqual(readFileSync(join(APP, '{nova}', 'PRACSML.004')).subarray(0, n));
      const tsz = fd.TF!.UsedFileSize();
      expect(readFileSync(join(D, 'EXP.T04'))).toEqual(readFileSync(join(APP, '{nova}', 'PRACSML.T04')).subarray(0, tsz));
    } finally {
      closeFD(fd);
    }
    // a destination with garbage is overwritten and truncated
    cpSync(join(APP, '{nova}', 'PRACSML.004'), join(D, 'DST.004'));
    cpSync(join(APP, '{nova}', 'PRACSML.T04'), join(D, 'DST.T04'));
    writeFileSync(join(D, 'DST.004'), Buffer.concat([readFileSync(join(D, 'DST.004')), Buffer.alloc(5000, 7)]));
    const dst = openFD('DST', join(D, 'DST.004'), join(D, 'DST.T04'), PRACSML_DCL);
    CopyFile(copyD(join(D, 'EXP.004'), null, { FD2: dst }));
    expect(BaseVars.LastExitCode).toBe(0);
    expect(dst.Handle).toBe(0xff);
    expect(readFileSync(join(D, 'DST.004'))).toEqual(readFileSync(join(D, 'EXP.004')));
    expect(readFileSync(join(D, 'DST.T04'))).toEqual(readFileSync(join(D, 'EXP.T04')));
  });
  it('ExportTxt cpVar / ImportTxt cpVar round trip; cpFix too', () => {
    const src = openFD('PRACSML', join(D, 'PRACSML.004'), join(D, 'PRACSML.T04'), PRACSML_DCL);
    const df = new DataFile(join(APP, '{nova}', 'PRACSML.004'));
    const nRecs = df.nRecs;
    const nazev1 = decode852(df.readRecord(1).subarray(6, 36)).trimEnd();
    df.close();
    try {
      CopyFile(copyD(null, join(D, 'VAR.TXT'), { FD1: src, Opt2: cpVar }));
      expect(BaseVars.LastExitCode).toBe(0);
      CopyFile(copyD(null, join(D, 'FIX.TXT'), { FD1: src, Opt2: cpFix }));
    } finally {
      closeFD(src);
    }
    const varTxt = readFileSync(join(D, 'VAR.TXT'), 'latin1');
    const lines = varTxt.split('\r\n'); // (T texts contain CR LF too)
    expect(varTxt.endsWith('\r\n')).toBe(true);
    // 'DD.MM.YYYY','Název',' Smlouva ','Koment',A|N
    expect(lines[0]).toMatch(/^('\d\d\.\d\d\.\d{4}'|),'/);
    expect(lines[0].split(',')[1]).toBe("'" + B(nazev1).replace(/'/g, "''") + "'");
    const fixLines = readFileSync(join(D, 'FIX.TXT'), 'latin1').split('\r\n');
    expect(fixLines[0].length).toBe(10 + 30 + 30 + 1);
    // import into an emptied copy and export again
    cpSync(join(APP, '{nova}', 'PRACSML.004'), join(D, 'IMP.004'));
    cpSync(join(APP, '{nova}', 'PRACSML.T04'), join(D, 'IMP.T04'));
    for (const [opt, file] of [[cpVar, 'VAR.TXT'], [cpFix, 'FIX.TXT']] as const) {
      const imp = openFD('IMP', join(D, 'IMP.004'), join(D, 'IMP.T04'), PRACSML_DCL);
      try {
        CopyFile(copyD(join(D, file), null, { FD2: imp, Opt1: opt }));
        expect(BaseVars.LastExitCode).toBe(0);
        expect(imp.NRecs).toBe(nRecs);
        CopyFile(copyD(null, join(D, 'AGAIN.TXT'), { FD1: imp, Opt2: opt }));
      } finally {
        closeFD(imp);
      }
      expect(readFileSync(join(D, 'AGAIN.TXT'), 'latin1')).toBe(readFileSync(join(D, file), 'latin1'));
    }
    // cpVar with append adds the records again
    const imp = openFD('IMP', join(D, 'IMP.004'), join(D, 'IMP.T04'), PRACSML_DCL);
    try {
      CopyFile(copyD(join(D, 'VAR.TXT'), null, { FD2: imp, Opt1: cpVar, Append: true }));
      expect(imp.NRecs).toBe(2 * nRecs);
    } finally {
      closeFD(imp);
    }
  });
  it('the header line: HdFD/HdF gets the first line on import and is written first on export', () => {
    const src = openFD('PRACSML', join(D, 'PRACSML.004'), join(D, 'PRACSML.T04'), PRACSML_DCL);
    try {
      // HdF: a field of the (single-record) file itself, its value is the first text line
      const hd = src.FldD!.Chain!; // Název
      CopyFile(copyD(null, join(D, 'HD.TXT'), { FD1: src, Opt2: cpVar, HdFD: src, HdF: hd }));
      const txt = readFileSync(join(D, 'HD.TXT'), 'latin1');
      AccessVars.CFile = src;
      AccessVars.CRecPtr = GetRecSpace();
      ReadRec(src.NRecs);
      expect(txt).toBe(_ShortS(hd) + '\r\n' + readFileSync(join(D, 'VAR.TXT'), 'latin1'));
    } finally {
      closeFD(src);
    }
  });
});

describe('EXPIMP VarFixImp: formats of the export text', () => {
  it('F with decimals, N, R, B, quoted A with doubled quotes, short lines zero the rest', () => {
    const D = freshDir('fmt');
    const dcl = "Castka:F,8.2; Cislo:N,4; Real:R; Ano:B; Jmeno:A,10";
    const { first, recLen } = fields(dcl, 0);
    // an empty '6' data file
    const hdr = Buffer.alloc(6);
    hdr.writeInt32LE(0, 0);
    hdr.writeUInt16LE(recLen, 4);
    writeFileSync(join(D, 'F.000'), hdr);
    const fd = new FileD();
    fd.Typ = '6';
    fd.Name = 'F';
    fd.RecLen = recLen;
    fd.FrstDispl = 6;
    fd.FldD = first;
    fd.UMode = Exclusive;
    fd.LMode = ExclMode;
    BaseVars.CPath = H(join(D, 'F.000'));
    fd.Handle = OpenH(_isoldfile, Exclusive);
    AccessVars.CFile = fd;
    RdPrefixes();
    writeFileSync(join(D, 'IN.TXT'), "12.5,0042,1.5E+02,A,'it''s'\r\n-3,7\r\n,,,N,\"q\"\r\n");
    try {
      CopyFile(copyD(join(D, 'IN.TXT'), null, { FD2: fd, Opt1: cpVar }));
      expect(fd.NRecs).toBe(3);
      CopyFile(copyD(null, join(D, 'OUT.TXT'), { FD1: fd, Opt2: cpVar }));
      expect(readFileSync(join(D, 'OUT.TXT'), 'latin1')).toBe(
        "12.5,42, 1.5000000000E+02,A,'it''s'\r\n-3,7,,N,''\r\n,,,N,'q'\r\n",
      );
      CopyFile(copyD(null, join(D, 'OUTF.TXT'), { FD1: fd, Opt2: cpFix }));
      const l = readFileSync(join(D, 'OUTF.TXT'), 'latin1').split('\r\n');
      expect(l[0]).toBe("       12.500042 1.5000000000E+02Ait's      "); // F: Str(r:12:2), R: Str(r:17)
    } finally {
      closeFD(fd);
    }
  });
});

// ---------------------------------------------------------------- CheckFile, OldToNewCat

describe.skipIf(!haveApp)('EXPIMP CheckFile', () => {
  it('0 ok, 1 missing, 3 wrong record length, 4 missing T file', () => {
    const D = freshDir('check');
    cpSync(join(APP, '{nova}', 'PRACSML.004'), join(D, 'P.004'));
    const { recLen } = fields(PRACSML_DCL, 0);
    const fd = new FileD();
    fd.Typ = '6';
    fd.RecLen = recLen;
    fd.FrstDispl = 6;
    fd.TF = new TFile();
    BaseVars.CPath = H(join(D, 'P.004'));
    CheckFile(fd);
    expect(BaseVars.LastExitCode).toBe(4);
    cpSync(join(APP, '{nova}', 'PRACSML.T04'), join(D, 'P.T04'));
    BaseVars.CPath = H(join(D, 'P.004'));
    CheckFile(fd);
    expect(BaseVars.LastExitCode).toBe(0);
    fd.RecLen++;
    BaseVars.CPath = H(join(D, 'P.004'));
    CheckFile(fd);
    expect(BaseVars.LastExitCode).toBe(3);
    BaseVars.CPath = H(join(D, 'NENI.004'));
    CheckFile(fd);
    expect(BaseVars.LastExitCode).toBe(1);
  });
});

describe('EXPIMP OldToNewCat', () => {
  it('RecLen 106 -> 107: a zero byte after the first 16 bytes of each record', () => {
    const D = freshDir('cat');
    const n = 3;
    const b = Buffer.alloc(6 + n * 106);
    b.writeInt32LE(n, 0);
    b.writeUInt16LE(106, 4);
    for (let i = 0; i < n; i++) for (let j = 0; j < 106; j++) b[6 + i * 106 + j] = (i * 50 + j) & 0xff;
    writeFileSync(join(D, 'OLD.CAT'), b);
    const fd = new FileD();
    fd.Typ = 'C';
    fd.RecLen = 107;
    fd.FrstDispl = 6;
    fd.UMode = Exclusive;
    fd.LMode = ExclMode;
    BaseVars.CPath = H(join(D, 'OLD.CAT'));
    fd.Handle = OpenH(_isoldfile, Exclusive);
    AccessVars.CFile = fd;
    const sz = ref(0);
    expect(OldToNewCat(sz)).toBe(true);
    expect(sz.v).toBe(6 + n * 107);
    expect(fd.NRecs).toBe(n);
    expect(OldToNewCat(sz)).toBe(false); // already new
    SaveCache(0);
    CloseClearH(fref(fd, 'Handle'));
    const nb = readFileSync(join(D, 'OLD.CAT'));
    expect(nb.readUInt16LE(4)).toBe(107);
    for (let i = 0; i < n; i++) {
      const r = nb.subarray(6 + i * 107, 6 + (i + 1) * 107);
      const o = b.subarray(6 + i * 106, 6 + (i + 1) * 106);
      expect(r.subarray(0, 16)).toEqual(o.subarray(0, 16));
      expect(r[16]).toBe(0);
      expect(r.subarray(17)).toEqual(o.subarray(16));
    }
    fd.Typ = '6';
    expect(OldToNewCat(sz)).toBe(false);
  });
});

// ---------------------------------------------------------------- BACKUP / BACKUPM

/** A catalog (FAND.RES message 52 layout) with the given records, opened as AccessVars.CatFD. */
function makeCatalog(D: string, recs: [string, string, string, string, string][]): FileD {
  const b = Buffer.alloc(6 + recs.length * 107, 0x20);
  b.writeInt32LE(recs.length, 0);
  b.writeUInt16LE(107, 4);
  recs.forEach((r, i) => {
    const o = 6 + i * 107;
    const put = (s: string, at: number, l: number): void => {
      Buffer.from(s.padEnd(l).slice(0, l), 'latin1').copy(b, o + at);
    };
    put(r[0], 0, 8);
    put(r[1], 8, 8);
    put(r[2], 16, 1); // Ar:N,2 packed in 1 byte
    b[o + 16] = ((r[2].charCodeAt(0) - 48) << 4) | (r[2].charCodeAt(1) - 48);
    put(r[3], 17, 79);
    put(r[4], 96, 11);
  });
  writeFileSync(join(D, 'TEST.CAT'), b);
  const f = [
    ['NazUlohy', 0, 8, 'A'], ['NazSouboru', 8, 8, 'A'], ['Ar', 16, 2, 'N'], ['Cesta', 17, 79, 'A'], ['Navesti', 96, 11, 'A'],
  ].map(([n, displ, l, t]) => {
    const F = new FieldDescr();
    F.Name = n as string;
    F.Typ = t as string;
    F.FrmlTyp = 'S';
    F.L = l as number;
    F.NBytes = t === 'N' ? ((l as number) + 1) >> 1 : (l as number);
    F.M = LeftJust;
    F.Flg = f_Stored;
    F.Displ = displ as number;
    return F;
  });
  for (let i = 0; i < f.length - 1; i++) f[i].Chain = f[i + 1];
  const fd = new FileD();
  fd.Typ = 'C';
  fd.Name = 'Catalog';
  fd.RecLen = 107;
  fd.FrstDispl = 6;
  fd.FldD = f[0];
  fd.UMode = Exclusive;
  fd.LMode = ExclMode;
  BaseVars.CPath = H(join(D, 'TEST.CAT'));
  fd.Handle = OpenH(_isoldfile, Exclusive);
  const av = AccessVars;
  [av.CatRdbName, av.CatFileName, av.CatArchiv, av.CatPathName, av.CatVolume] = f;
  av.CatFD = fd;
  av.CFile = fd;
  RdPrefixes();
  av.CFile = null;
  return fd;
}

describe('EXPIMP Backup/Restore (catalog archives)', () => {
  it('backs up the files of archive 01 (compressed and not) and restores them', () => {
    const D = freshDir('backup');
    mkdirSync(join(D, 'ARCH'));
    const text = Buffer.from('Účto zaloha '.repeat(3000), 'latin1');
    const bin = Buffer.from(Uint8Array.from({ length: 20000 }, (_, i) => (i * i) & 0xff));
    writeFileSync(join(D, 'A.TXT'), text);
    writeFileSync(join(D, 'B.DAT'), bin);
    const cat = makeCatalog(D, [
      ['ARCHIVES', 'ARCH', '01', H(join(D, 'ARCH', 'ARCH.000')), ''],
      ['UCTO', 'A', '01', H(join(D, 'A.TXT')), ''],
      ['UCTO', 'B', '01', H(join(D, 'B.DAT')), ''],
      ['UCTO', 'C', '02', H(join(D, 'C.DAT')), ''],
    ]);
    try {
      for (const NoCompress of [false, true]) {
        Backup(true, NoCompress, 1, false);
        expect(BaseVars.LastExitCode).toBe(0);
        expect(readdirSync(join(D, 'ARCH')).sort()).toEqual(['A.001', 'B.002']);
        if (!NoCompress) expect(readFileSync(join(D, 'ARCH', 'A.001')).length).toBeLessThan(text.length / 4);
        else expect(readFileSync(join(D, 'ARCH', 'B.002'))).toEqual(bin);
        rmSync(join(D, 'A.TXT'));
        writeFileSync(join(D, 'B.DAT'), 'zmeneno');
        Backup(false, NoCompress, 1, false);
        expect(BaseVars.LastExitCode).toBe(0);
        expect(readFileSync(join(D, 'A.TXT'))).toEqual(text);
        expect(readFileSync(join(D, 'B.DAT'))).toEqual(bin);
        rmSync(join(D, 'ARCH'), { recursive: true });
        mkdirSync(join(D, 'ARCH'));
      }
      // restore from a missing archive: an error, NoCancel keeps going
      Backup(false, false, 1, true);
      expect(BaseVars.LastExitCode).not.toBe(0);
    } finally {
      CloseClearH(fref(cat, 'Handle'));
      AccessVars.CatFD = null;
    }
  });
});

describe('EXPIMP BackupM/RestoreM (directory archives)', () => {
  function constFrml(s: string): FrmlElem {
    const z = new FrmlElem(_const);
    z.S = s;
    return z;
  }
  function instr(isBackup: boolean, dir: string, masks: string, subDir: boolean, overwr: boolean, noCompress = false): Instr {
    const pd = new Instr(_backup);
    pd.IsBackup = isBackup;
    pd.NoCompress = noCompress;
    pd.BrCatIRec = 1;
    pd.bmDir = constFrml(H(dir));
    pd.bmMasks = constFrml(masks);
    pd.bmSubDir = subDir;
    pd.bmOverwr = overwr;
    pd.BrNoCancel = false;
    return pd;
  }
  it('a directory tree with masks and subdirectories, restored into another directory', () => {
    const D = freshDir('backupm');
    const S = join(D, 'src');
    mkdirSync(join(S, 'SUB', 'DEEP'), { recursive: true });
    const files: Record<string, Buffer> = {
      'A.TXT': Buffer.from('prvni soubor\r\n'.repeat(100), 'latin1'),
      'B.DAT': Buffer.from(Uint8Array.from({ length: 9000 }, (_, i) => (i * 13) & 0xff)),
      'C.BAK': Buffer.from('vynechat', 'latin1'),
      'SUB/D.TXT': Buffer.from('druhy', 'latin1'),
      'SUB/DEEP/E.DAT': Buffer.alloc(0),
    };
    for (const [n, b] of Object.entries(files)) writeFileSync(join(S, n), b);
    const cat = makeCatalog(D, [['ARCHIVES', 'ZAL', '01', H(join(D, 'ZAL.ARC')), '']]);
    const w0 = BaseVars.MaxWSize;
    try {
      BackupM(instr(true, S, '*.TXT, *.DAT', true, false));
      expect(BaseVars.LastExitCode).toBe(0);
      expect(BaseVars.MaxWSize).toBe(w0);
      expect(process.cwd()).toBe(cwd0);
      expect(existsSync(join(D, 'ZAL.ARC'))).toBe(true);
      const T = join(D, 'dst');
      mkdirSync(T);
      BackupM(instr(false, T, '', true, true));
      expect(BaseVars.LastExitCode).toBe(0);
      expect(readFileSync(join(T, 'A.TXT'))).toEqual(files['A.TXT']);
      expect(readFileSync(join(T, 'B.DAT'))).toEqual(files['B.DAT']);
      expect(existsSync(join(T, 'C.BAK'))).toBe(false);
      expect(readFileSync(join(T, 'SUB', 'D.TXT'))).toEqual(files['SUB/D.TXT']);
      expect(readFileSync(join(T, 'SUB', 'DEEP', 'E.DAT')).length).toBe(0);
      // no overwrite: existing files are kept (PromptYN(780) answers No in batch mode)
      writeFileSync(join(T, 'A.TXT'), 'moje');
      BackupM(instr(false, T, '', true, false));
      expect(readFileSync(join(T, 'A.TXT'), 'latin1')).toBe('moje');
      expect(readFileSync(join(T, 'B.DAT'))).toEqual(files['B.DAT']);
      // without subdirectories only the top directory, all files
      BackupM(instr(true, S, '', false, false, true));
      const T2 = join(D, 'dst2');
      mkdirSync(T2);
      BackupM(instr(false, T2, '', false, true, true));
      expect(readdirSync(T2).sort()).toEqual(['A.TXT', 'B.DAT', 'C.BAK']);
      // a missing target directory without SubDir: RunError 703 -> GoExit
      expect(goExits(() => BackupM(instr(false, join(D, 'neni'), '', false, true, true)))).toBe(true);
      expect(process.cwd()).toBe(cwd0);
    } finally {
      CloseClearH(fref(cat, 'Handle'));
      AccessVars.CatFD = null;
    }
  });
});

