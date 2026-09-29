// ACCESS package: TYPE.PAS (BCD/fix), FILEACC.PAS (TFile, prefixes, lock modes), RECACC.PAS
// (records, field access) and the ACCESS.PAS routines, on real Účto files (copies under
// work/tmp-access/) and checked against the independent readers in src/engine/fand.

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ref } from '../src/engine/pas/pasrt.ts';
import {
  BaseVars, FormatCache, SaveCache, OpenH, TruncH, IsUpdHandle, _isoldfile, _isoverwritefile, Exclusive,
} from '../src/engine/pas/base.ts';
import {
  AccessVars, FileD, FieldDescr, TFile, XFile, UnPack, Pack, RealFromFix, FixFromReal, CompLexStr,
  CompLexLongStr, CompLexLongShortStr, TranslateOrd, RdPrefix, RdPrefixes, WrPrefixes, CloseClearHCFile,
  GetRecSpace, ReadRec, WriteRec, CreateRec, DeleteRec, AssignNRecs, LinkLastRec, SeekRec, PutRec,
  _ShortS, _LongS, _R, _B, _T, S_, R_, B_, T_, LongS_, DelTFld, DelTFlds, ZeroAllFlds, CopyRecWithT, ClearRecSpace,
  DelDifTFld, NewLMode, OldLMode, TryLockN, UnLockN, ChangeLMode, CExtToT, CExtToX, CodingLongStr, Code,
  StoreInTWork, ReadDelInTWork, DeletedFlag, ResetCompilePars, T00Format, f_Stored, f_Encryp, f_Comma, LeftJust, ExclMode, RdMode,
  WrMode, NullMode,
} from '../src/engine/pas/access.ts';
import { DataFile } from '../src/engine/fand/datafile.ts';
import { TFile as RawTFile, parseTHeader } from '../src/engine/fand/tfile.ts';
import { readFix, writeFix, TAB_F, readReal48, dateToDayNumber } from '../src/engine/fand/numbers.ts';
import { decode852, encode852 } from '../src/engine/console/cp852.ts';
import { REF_FAND, RefFandDriver, copyTask } from '../src/engine/testing/refdriver.ts';
import { startUcto, UCTO_START_ANSWERS } from '../src/engine/testing/ucto.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const WORK = join(ROOT, 'work/tmp-access');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB'));

// ---------------------------------------------------------------- helpers

/** Byte string of a Unicode text (CP852). */
const B = (u: string): string => String.fromCharCode(...encode852(u));
const U = (b: string): string => decode852(Uint8Array.from(b, (c) => c.charCodeAt(0)));

/** Minimal RDFILDCL.RdFldDescr for stored fields of an F chapter (up to '#'). */
function parseDcl(src: string, isX: boolean): { fields: FieldDescr[]; recLen: number } {
  const body = src.split('#')[0];
  const fields: FieldDescr[] = [];
  let displ = isX ? 1 : 0;
  for (const part of body.split(';')) {
    const m = /^\s*([^:\s]+)\s*:\s*([ANFRDBT])\s*(.*)$/s.exec(part);
    if (!m) continue;
    const [, name, typ, restRaw] = m;
    const rest = restRaw.trim();
    const F = new FieldDescr();
    F.Name = B(name);
    F.Typ = typ;
    F.Flg = f_Stored;
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
        let L = +mm[1];
        const M = +mm[3];
        if (mm[2] === ',') F.Flg |= f_Comma;
        F.NBytes = TAB_F[L + M];
        L = M === 0 ? L + 1 : L + M + 2;
        F.L = L;
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
        const q = /^,\s*'([^']*)'\s*(!)?/.exec(rest);
        if (q) {
          F.L = q[1].replace(/[[\]]/g, '').length;
          F.M = LeftJust;
        } else {
          const mm = /^,\s*(\d+)\s*(R)?\s*(!)?/.exec(rest)!;
          F.L = +mm[1];
          F.M = mm[2] ? 0 : LeftJust;
        }
        F.NBytes = F.L;
        if (/!\s*$/.test(rest)) F.Flg |= f_Encryp;
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
        if (/!\s*$/.test(rest)) F.Flg |= f_Encryp;
        break;
    }
    F.Displ = displ;
    displ += F.NBytes;
    fields.push(F);
  }
  for (let i = 0; i < fields.length - 1; i++) fields[i].Chain = fields[i + 1];
  return { fields, recLen: displ };
}

function fieldOf(fd: FileD, name: string): FieldDescr {
  for (let f = fd.FldD; f !== null; f = f.Chain) if (U(f.Name) === name) return f;
  throw new Error(`no field ${name}`);
}

/** Opens a data file (and its T-file) like OACCESS.OpenF, exclusive, and reads the prefixes. */
function openFile(path: string, typ: string, dcl: string, tpath?: string): FileD {
  const { fields, recLen } = parseDcl(dcl, typ === 'X');
  const fd = new FileD();
  fd.Typ = typ;
  fd.Name = 'TEST';
  fd.RecLen = recLen;
  fd.FrstDispl = typ === '8' ? 4 : 6;
  fd.FldD = fields[0];
  fd.UMode = Exclusive;
  fd.LMode = ExclMode;
  BaseVars.CPath = path;
  fd.Handle = OpenH(_isoldfile, Exclusive);
  expect(BaseVars.HandleError).toBe(0);
  if (typ === 'X') fd.XF = new XFile(); // index not opened (Handle $FF)
  if (tpath) {
    fd.TF = new TFile();
    BaseVars.CPath = tpath;
    fd.TF.Handle = OpenH(_isoldfile, Exclusive);
    expect(BaseVars.HandleError).toBe(0);
  }
  AccessVars.CFile = fd;
  RdPrefixes();
  AccessVars.CRecPtr = GetRecSpace();
  return fd;
}

/** Like OACCESS.CloseFile: prefixes, cache, truncation to the used size, close. */
function closeFile(fd: FileD): void {
  AccessVars.CFile = fd;
  WrPrefixes();
  SaveCache(0);
  if (IsUpdHandle(fd.Handle)) TruncH(fd.Handle, fd.UsedFileSize());
  if (fd.TF !== null && IsUpdHandle(fd.TF.Handle)) TruncH(fd.TF.Handle, fd.TF.UsedFileSize());
  CloseClearHCFile();
}

function freshDir(name: string): string {
  const d = join(WORK, name);
  rmSync(d, { recursive: true, force: true });
  mkdirSync(d, { recursive: true });
  return d;
}

/** Deterministic pseudo-random text bytes (CP852 letters, CR LF). */
function makeText(n: number, seed: number): Uint8Array {
  const a = new Uint8Array(n);
  let s = seed >>> 0;
  for (let i = 0; i < n; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const r = (s >>> 16) % 40;
    a[i] = r < 26 ? 0x61 + r : r < 30 ? 0xa0 + r : r < 38 ? 0x20 : r === 38 ? 0x0d : 0x0a;
  }
  return a;
}

beforeAll(() => {
  FormatCache();
});
beforeEach(() => {
  AccessVars.CFile = null;
  AccessVars.CRecPtr = null;
});

// ---------------------------------------------------------------- TYPE.PAS

describe('ACCESS TYPE: BCD and fixed point', () => {
  it('Pack/UnPack N fields', () => {
    const p = new Uint8Array(3);
    Pack(Uint8Array.from('12345', (c) => c.charCodeAt(0)), p, 5);
    expect([...p]).toEqual([0x12, 0x34, 0x50]);
    const n = new Uint8Array(5);
    UnPack(p, n, 5);
    expect(String.fromCharCode(...n)).toBe('12345');
    const n4 = new Uint8Array(4);
    UnPack(Uint8Array.of(0x98, 0x76), n4, 4);
    expect(String.fromCharCode(...n4)).toBe('9876');
  });
  it('RealFromFix: two’s complement, null, Real48 mantissa', () => {
    expect(RealFromFix(Uint8Array.of(0x80, 0, 0), 3)).toBe(0); // NULL
    expect(RealFromFix(Uint8Array.of(0x00, 0x30, 0x39), 3)).toBe(12345);
    expect(RealFromFix(Uint8Array.of(0xff, 0xff, 0xfe), 3)).toBe(-2);
    expect(RealFromFix(Uint8Array.of(0x80, 0, 1), 3)).toBe(-(2 ** 23) + 1);
    // BP7 keeps 40 significant bits: 2^50+1 -> 2^50
    const b = new Uint8Array(8);
    writeFix(2 ** 50 + 1, b, 0, 8);
    expect(RealFromFix(b, 8)).toBe(2 ** 50);
    for (const v of [0, 1, -1, 127, -128, 99999, -99999, 1234567890, -987654321]) {
      const x = new Uint8Array(5);
      writeFix(v, x, 0, 5);
      expect(RealFromFix(x, 5)).toBe(readFix(x, 0, 5));
    }
  });
  it('FixFromReal: halves away from zero (Real48), overflow -> zero', () => {
    const b = new Uint8Array(3);
    FixFromReal(123.5, b, 3);
    expect(RealFromFix(b, 3)).toBe(124);
    FixFromReal(-123.5, b, 3);
    expect(RealFromFix(b, 3)).toBe(-124);
    FixFromReal(-0.3, b, 3);
    expect([...b]).toEqual([0, 0, 0]);
    // 1.005*100 is 100.4999… in double but 100.5 in Real48 -> 101 as in BP7
    FixFromReal(1.005 * 100, b, 3);
    expect(RealFromFix(b, 3)).toBe(101);
    const w = new Uint8Array(2);
    FixFromReal(32767.4, w, 2);
    expect([...w]).toEqual([0x7f, 0xff]);
    FixFromReal(40000, w, 2);
    expect([...w]).toEqual([0, 0]);
    FixFromReal(-32768, w, 2);
    expect([...w]).toEqual([0, 0]); // |r| >= 2^15: overflow in BP7
  });
});

// ---------------------------------------------------------------- ACCESS.PAS

describe('ACCESS: lexical compare (BP7 TranslateOrd with the Czech ch)', () => {
  it('ch sorts as one letter after h', () => {
    const saved = BaseVars.CharOrdTab;
    try {
      const tab = Uint8Array.from({ length: 256 }, (_, i) => i);
      for (const [c, o] of [['c', 0x43], ['C', 0x43], ['h', 0x49], ['H', 0x49], ['i', 0x4b], ['I', 0x4b]] as const) {
        tab[c.charCodeAt(0)] = o;
      }
      BaseVars.CharOrdTab = tab;
      expect([...TranslateOrd(Uint8Array.from('cch', (c) => c.charCodeAt(0)), 3)]).toEqual([0x43, 0x4a]);
      expect(CompLexStr('chata', 'hrad')).toBe(4);
      expect(CompLexStr('cesta', 'hrad')).toBe(2);
      expect(CompLexStr('Ch', 'ci')).toBe(4);
      expect(CompLexStr('CH', 'ch')).toBe(1);
      expect(CompLexStr('ch', 'cha')).toBe(2);
      const L = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
      expect(CompLexLongStr(L('chata'), L('hrad'))).toBe(4);
      expect(CompLexLongShortStr(L('hrad'), 'chata')).toBe(2);
      expect(CompLexLongStr(L('x'.repeat(300) + 'a'), L('x'.repeat(255) + 'b'))).toBe(1); // max 255
    } finally {
      BaseVars.CharOrdTab = saved;
    }
  });
  it('CodingLongStr: XOR $AA without a licence number', () => {
    const fd = new FileD();
    fd.TF = new TFile();
    AccessVars.CFile = fd;
    const s = Uint8Array.of(1, 2, 0xaa);
    expect([...CodingLongStr(s)]).toEqual([0xab, 0xa8, 0]);
  });
});

// ---------------------------------------------------------------- data files

const TYPDOKL_DCL = "TypD:A,'!!!'; Název:A,30; Vyb:B; #K @ ~TypD;";
const PRACSML_DCL = 'Datum:D; Název:A,30; Smlouva:T; Koment:A,30; CtrlL:B; #I Datum:=today;';
const TIPY_DCL = "Klíč:A,5; Oddíl:A,20; Téma:A,40; Text:T; Modul:N,2; Help:A,30;   Datum:D; Autor:A,'!!'; Posl:D; #C K1";

describe.skipIf(!haveApp)('ACCESS: reading Účto data files', () => {
  it('X file (TYPDOKL.001): prefix, deleted flags, A and B fields', () => {
    const path = join(APP, '{nova}/TYPDOKL.001');
    const fd = openFile(path, 'X', TYPDOKL_DCL);
    const df = new DataFile(path);
    expect(fd.NRecs).toBe(df.nRecs);
    expect(fd.RecLen).toBe(df.recLen);
    const TypD = fieldOf(fd, 'TypD');
    const Nazev = fieldOf(fd, 'Název');
    const Vyb = fieldOf(fd, 'Vyb');
    for (let i = 1; i <= fd.NRecs; i++) {
      ReadRec(i);
      const raw = df.readRecord(i);
      expect(DeletedFlag()).toBe(raw[0] !== 0);
      expect(_ShortS(TypD)).toBe(String.fromCharCode(...raw.subarray(1, 4)));
      expect(_ShortS(Nazev)).toBe(String.fromCharCode(...raw.subarray(4, 34)));
      expect(_B(Vyb)).toBe(raw[34] !== 0 && raw[34] !== 0xff);
    }
    ReadRec(2);
    expect(U(_ShortS(Nazev)).trim()).toBe('dobropis');
    df.close();
    closeFile(fd);
  });
  it("'6' file with a T-file (PRACSML.004/.T04): texts equal the independent reader", () => {
    const dir = join(APP, '{nova}');
    const fd = openFile(join(dir, 'PRACSML.004'), '6', PRACSML_DCL, join(dir, 'PRACSML.T04'));
    const raw = new RawTFile(join(dir, 'PRACSML.T04'));
    const tf = fd.TF!;
    expect(tf.MaxPage).toBe(raw.header.maxPage);
    expect(tf.FreePart).toBe(raw.header.freePart);
    expect(tf.FreeRoot).toBe(raw.header.freeRoot);
    expect(tf.IRec).toBe(raw.header.irec);
    expect(tf.LicenseNr).toBe(0);
    // PwCode is kept XOR $AA: 20 x '@'
    expect(tf.PwCode).toBe(String.fromCharCode(0x40 ^ 0xaa).repeat(20));
    const Smlouva = fieldOf(fd, 'Smlouva');
    const Datum = fieldOf(fd, 'Datum');
    const CtrlL = fieldOf(fd, 'CtrlL');
    let texts = 0;
    for (let i = 1; i <= fd.NRecs; i++) {
      ReadRec(i);
      const pos = _T(Smlouva);
      const s = _LongS(Smlouva);
      expect([...s]).toEqual(pos === 0 ? [] : [...raw.read(pos)]);
      expect(_ShortS(Smlouva)).toBe(String.fromCharCode(...s.subarray(0, 255)));
      expect(_R(Datum)).toBe(0);
      expect(typeof _B(CtrlL)).toBe('boolean'); // set by #I only
      if (s.length > 0) texts++;
    }
    expect(texts).toBeGreaterThan(10);
    ReadRec(1);
    expect(U(String.fromCharCode(..._LongS(Smlouva)))).toContain('P R A C O V N Í  S M L O U V U');
    raw.close();
    closeFile(fd);
  });
  it('N, F, D fields of a parameter file (PARAM2.000)', () => {
    const srcDir = join(ROOT, 'work/source/UCTO2026_RDB');
    const src = existsSync(srcDir) ? readdirSync(srcDir).find((f) => /_F_PARAM2\.txt$/.test(f)) : undefined;
    if (!src) return; // decoded sources not present
    const dcl = readFileSync(join(srcDir, src), 'utf8');
    const path = join(APP, '{nova}/PARAM2.000');
    const { recLen } = parseDcl(dcl, false);
    const df = new DataFile(path);
    expect(df.recLen).toBe(recLen);
    const fd = openFile(path, '6', dcl, join(APP, '{nova}/PARAM2.T00'));
    ReadRec(1);
    const raw = df.readRecord(1);
    const Psc = fieldOf(fd, 'Psc');
    const Barva = fieldOf(fd, 'Barva');
    const AutUdrP = fieldOf(fd, 'AutUdrP');
    const n = _ShortS(Psc);
    expect(n).toMatch(/^( {5}|\d{5})$/);
    expect(_R(Barva)).toBe(readFix(raw, Barva.Displ, Barva.NBytes));
    expect(_R(AutUdrP)).toBe(readReal48(raw, AutUdrP.Displ));
    df.close();
    closeFile(fd);
  });
});

describe('ACCESS: field setters on a record buffer', () => {
  it('S_/R_/B_ round trip all stored types', () => {
    const { fields, recLen } = parseDcl(
      "A1:A,5; A2:A,5R; A3:A,4!; N1:N,5; N2:N,3L; F1:F,7.2; F2:F,5,2; F3:F,4.0; R1:R; D1:D; B1:B; T1:T;",
      false,
    );
    const fd = new FileD();
    fd.Typ = '6';
    fd.RecLen = recLen;
    fd.FldD = fields[0];
    AccessVars.CFile = fd;
    AccessVars.CRecPtr = GetRecSpace();
    const f = (n: string) => fieldOf(fd, n);
    ZeroAllFlds();
    expect(_ShortS(f('A1'))).toBe('     ');
    S_(f('A1'), 'ab');
    expect(_ShortS(f('A1'))).toBe('ab   ');
    S_(f('A1'), 'abcdefg');
    expect(_ShortS(f('A1'))).toBe('abcde');
    S_(f('A2'), 'ab');
    expect(_ShortS(f('A2'))).toBe('   ab');
    S_(f('A2'), 'abcdefg');
    expect(_ShortS(f('A2'))).toBe('cdefg');
    S_(f('A3'), 'tajn');
    const r = AccessVars.CRecPtr;
    expect(r[f('A3').Displ]).toBe(0x74 ^ 0xaa); // stored XOR $AA
    expect(_ShortS(f('A3'))).toBe('tajn');
    expect(String.fromCharCode(..._LongS(f('A3')))).toBe('tajn');
    S_(f('N1'), '42');
    expect(_ShortS(f('N1'))).toBe('00042');
    S_(f('N2'), '7');
    expect(_ShortS(f('N2'))).toBe('700');
    r.fill(0xff, f('N1').Displ, f('N1').Displ + 3);
    expect(_ShortS(f('N1'))).toBe('     '); // null
    expect(_LongS(f('N1')).length).toBe(0);
    R_(f('F1'), 12345.678);
    expect(_R(f('F1'))).toBe(12345.68);
    R_(f('F1'), -1.125);
    expect(_R(f('F1'))).toBe(-1.13);
    R_(f('F2'), 314); // with comma: stored as is
    expect(_R(f('F2'))).toBe(314);
    R_(f('F3'), 2.5);
    expect(_R(f('F3'))).toBe(3);
    R_(f('R1'), Math.PI);
    expect(_R(f('R1'))).toBeCloseTo(Math.PI, 11);
    const day = dateToDayNumber(2026, 9, 28);
    R_(f('D1'), day + 0.5);
    expect(_R(f('D1'))).toBe(day + 0.5);
    r.fill(0xff, f('D1').Displ, f('D1').Displ + 6);
    expect(_R(f('D1'))).toBe(0);
    B_(f('B1'), true);
    expect(_B(f('B1'))).toBe(true);
    B_(f('B1'), false);
    expect(_B(f('B1'))).toBe(false);
    r[f('B1').Displ] = 0xff;
    expect(_B(f('B1'))).toBe(false);
    T_(f('T1'), 12345);
    expect(_T(f('T1'))).toBe(12345);
    r.fill(0xff, f('T1').Displ, f('T1').Displ + 4);
    expect(_T(f('T1'))).toBe(0);
  });
  it("'8' files: D is a day offset from FirstDate", () => {
    const { fields, recLen } = parseDcl('D1:D;', false);
    fields[0].NBytes = 2;
    const fd = new FileD();
    fd.Typ = '8';
    fd.RecLen = recLen;
    fd.FldD = fields[0];
    AccessVars.CFile = fd;
    AccessVars.CRecPtr = GetRecSpace();
    R_(fields[0], 697248 + 100.7);
    expect(_R(fields[0])).toBe(697248 + 100);
    R_(fields[0], 0);
    expect(_R(fields[0])).toBe(0);
  });
});

// ---------------------------------------------------------------- T-files

describe('ACCESS FILEACC: TFile Store/Read/Delete', () => {
  it('a new T-file: stores, deletes, reuses pages; independent reader agrees', () => {
    const dir = freshDir('tnew');
    const tpath = join(dir, 'NEW.T00');
    const fd = new FileD(); // CFile for TFile.NotCached/Err
    fd.Typ = '6';
    fd.UMode = Exclusive;
    fd.LMode = ExclMode;
    AccessVars.CFile = fd;
    const tf = new TFile();
    BaseVars.CPath = tpath;
    tf.Create();
    expect(tf.MaxPage).toBe(1);
    expect(tf.FreePart).toBe(512);
    const lens = [1, 5, 100, 300, 507, 508, 509, 510, 511, 512, 1000, 1015, 1016, 1017, 1020, 2040, 5000, 65000, 65001, 70000];
    const live = new Map<number, Uint8Array>();
    let seed = 1;
    for (let round = 0; round < 3; round++) {
      for (const l of lens) {
        const s = makeText(l, seed++);
        const pos = tf.Store(s);
        expect(pos).toBeGreaterThanOrEqual(512);
        expect(live.has(pos)).toBe(false);
        live.set(pos, s.length > 65000 ? s.subarray(0, 65000) : s);
      }
      // delete every second text
      let k = 0;
      for (const pos of [...live.keys()]) {
        if (k++ % 2 === round % 2) {
          tf.Delete(pos);
          live.delete(pos);
        }
      }
      for (const [pos, s] of live) expect(tf.Read(1, pos)).toEqual(s);
    }
    expect(tf.Store(new Uint8Array(0))).toBe(0);
    // freed long-text pages are reused before the file grows
    const before = tf.MaxPage;
    const big = [...live.entries()].find(([, s]) => s.length > 3000)!;
    tf.Delete(big[0]);
    live.delete(big[0]);
    const pos = tf.Store(makeText(big[1].length, 999));
    live.set(pos, makeText(big[1].length, 999));
    expect(tf.MaxPage).toBe(before);
    tf.WrPrefix();
    SaveCache(0);
    // header and texts with the independent reader
    expect(statSync(tpath).size).toBeGreaterThanOrEqual(tf.UsedFileSize()); // the cache writes 4 kB pages
    TruncH(tf.Handle, tf.UsedFileSize()); // as OACCESS.CloseFile
    expect(statSync(tpath).size).toBe((tf.MaxPage + 1) * 512);
    const raw = new RawTFile(tpath);
    expect(raw.header.maxPage).toBe(tf.MaxPage);
    expect(raw.header.freePart).toBe(tf.FreePart);
    expect(raw.header.freeRoot).toBe(tf.FreeRoot);
    expect(raw.header.irec).toBe(1);
    expect(raw.header.version).toBe('4.20');
    expect(raw.header.password1).toBe('');
    expect(raw.header.password2).toBe('');
    for (const [p, s] of live) expect(raw.read(p)).toEqual(s);
    raw.close();
    // reopen with RdPrefix(true)
    const tf2 = new TFile();
    BaseVars.CPath = tpath;
    tf2.Handle = OpenH(_isoldfile, Exclusive);
    tf2.RdPrefix(true);
    expect([tf2.MaxPage, tf2.FreePart, tf2.FreeRoot, tf2.IRec, tf2.MLen]).toEqual([tf.MaxPage, tf.FreePart, tf.FreeRoot, 1, tf.MLen]);
    expect(tf2.PwCode).toBe(tf.PwCode);
    for (const [p, s] of live) expect(tf2.Read(1, p)).toEqual(s);
    // deleting everything frees every page
    for (const p of live.keys()) tf2.Delete(p);
    const free = new Set<number>();
    for (let pg = tf2.FreeRoot; pg !== 0; ) {
      expect(free.has(pg)).toBe(false);
      free.add(pg);
      const b = new Uint8Array(4);
      tf2.RdWr(true, pg * 512, 4, b);
      pg = new DataView(b.buffer).getInt32(0, true);
    }
    const freePartPage = tf2.FreePart >> 9;
    for (let pg = 1; pg <= tf2.MaxPage; pg++) if (pg !== freePartPage) expect(free.has(pg)).toBe(true);
    tf2.Handle = 0xff;
  });
  it('licensed header: LicenseNr shifts positions, random password 1', () => {
    const dir = freshDir('tlic');
    const tpath = join(dir, 'LIC.TTT');
    const fd = new FileD();
    fd.Typ = '0'; // RDB: LicNr is read back
    AccessVars.CFile = fd;
    const tf = new TFile();
    BaseVars.CPath = tpath;
    tf.Create();
    tf.LicenseNr = 1234;
    const pos = tf.Store(makeText(40, 7));
    tf.WrPrefix();
    SaveCache(0);
    const t = readFileSync(tpath);
    const h = parseTHeader(t, t.length, true);
    expect(h.licenseNr).toBe(1234);
    expect(h.irec).toBe(1);
    const tf2 = new TFile();
    tf2.Handle = OpenH(_isoldfile, Exclusive);
    tf2.RdPrefix(false);
    expect(tf2.LicenseNr).toBe(1234);
    expect(tf2.Read(1, pos + 1234)).toEqual(makeText(40, 7));
  });
  it('TWork: StoreInTWork / ReadDelInTWork', () => {
    const dir = freshDir('twork');
    const tw = AccessVars.TWork;
    tw.IsWork = true;
    BaseVars.CPath = join(dir, 'FANDWORK.$$$');
    BaseVars.FandWorkTName = BaseVars.CPath;
    tw.Create();
    const s = makeText(2000, 3);
    const p = StoreInTWork(s);
    expect(ReadDelInTWork(p)).toEqual(s);
    expect(tw.FreeRoot).not.toBe(0); // pages released
  });
});

describe.skipIf(!haveApp)('ACCESS FILEACC: TFile.RdPrefix on every Účto text file', () => {
  it('agrees with the independent header parser (incl. licence numbers of project texts)', () => {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (/\.(T\d\d|TTT|TRO)$/i.test(e.name) && statSync(join(d, e.name)).size > 512) files.push(join(d, e.name));
      }
    };
    walk(APP);
    expect(files.length).toBeGreaterThan(20);
    let licensed = 0;
    for (const path of files) {
      const isRdb = /\.(TTT|TRO)$/i.test(path);
      const fd = new FileD();
      fd.Typ = isRdb ? '0' : '6';
      AccessVars.CFile = fd;
      const tf = new TFile();
      BaseVars.CPath = path;
      tf.Handle = OpenH(_isoldfile, Exclusive);
      tf.RdPrefix(false);
      const t = readFileSync(path);
      const h = parseTHeader(t, t.length, isRdb);
      expect([tf.MaxPage, tf.FreePart, tf.FreeRoot, tf.IRec, tf.LicenseNr], path).toEqual([
        h.maxPage, h.freePart, h.freeRoot, h.irec, h.licenseNr,
      ]);
      const pw2 = String.fromCharCode(...Uint8Array.from(tf.Pw2Code, (c) => c.charCodeAt(0) ^ 0xaa));
      if (h.password2 !== null) expect(pw2.replace(/@+$/, ''), path).toBe(h.password2);
      if (tf.LicenseNr !== 0) licensed++;
      fd.TF = tf;
      CloseClearHCFile();
    }
    expect(licensed).toBeGreaterThan(0);
  });
});

describe('ACCESS FILEACC/RECACC: dBase files', () => {
  it('WrPrefix writes the .DBF header, RdPrefix reads it; D/B/T fields as text', () => {
    const dir = freshDir('dbf');
    BaseVars.CPath = join(dir, 'ADR.DBF');
    const h = OpenH(_isoverwritefile, Exclusive); // a new handle is marked updated
    const { fields } = parseDcl('Nazev:A,10; Datum:D; Plat:B;', false);
    // dBase: 1 byte deleted flag, then the fields; D as YYYYMMDD
    fields[0].Displ = 1;
    fields[1].Displ = 11;
    fields[1].NBytes = 8;
    fields[2].Displ = 19;
    const fd = new FileD();
    fd.Typ = 'D';
    fd.RecLen = 20;
    fd.FrstDispl = 32 * 4 + 1;
    fd.FldD = fields[0];
    fd.Handle = h;
    fd.UMode = Exclusive;
    fd.LMode = ExclMode;
    fd.NRecs = 0;
    AccessVars.CFile = fd;
    AccessVars.CRecPtr = GetRecSpace();
    AccessVars.CRecPtr.fill(0x20, 0, 20);
    S_(fields[0], 'Novak');
    R_(fields[1], dateToDayNumber(2026, 9, 28));
    B_(fields[2], true);
    expect(String.fromCharCode(...AccessVars.CRecPtr.subarray(0, 20))).toBe(' Novak     20260928T');
    expect(_R(fields[1])).toBe(dateToDayNumber(2026, 9, 28));
    expect(_B(fields[2])).toBe(true);
    SeekRec(0);
    PutRec();
    WrPrefixes();
    SaveCache(0);
    const b = readFileSync(join(dir, 'ADR.DBF'));
    expect(b[0]).toBe(0x03);
    expect(b.readInt32LE(4)).toBe(1);
    expect(b.readUInt16LE(8)).toBe(129);
    expect(b.readUInt16LE(10)).toBe(20);
    expect(b.subarray(32, 38).toString('latin1')).toBe('NAZEV\0');
    expect(String.fromCharCode(b[32 + 11], b[64 + 11], b[96 + 11])).toBe('CDL');
    expect(b[64 + 16]).toBe(8);
    expect(b[128]).toBe(0x0d);
    expect(b[129 + 20]).toBe(0x1a);
    fd.NRecs = 0;
    fd.FrstDispl = 0;
    expect(RdPrefix()).toBe(0xffff);
    expect([fd.NRecs, fd.FrstDispl]).toEqual([1, 129]);
    CloseClearHCFile();
  });
});

describe('ACCESS: compiler parameters', () => {
  it('ResetCompilePars', () => {
    AccessVars.FileVarsAllowed = false;
    AccessVars.FDLocVarAllowed = true;
    AccessVars.RdFunction = () => null;
    ResetCompilePars();
    expect(AccessVars.RdFldNameFrml).toBeTypeOf('function');
    expect(AccessVars.RdFunction).toBeNull();
    expect(AccessVars.FileVarsAllowed).toBe(true);
    expect(AccessVars.FDLocVarAllowed).toBe(false);
  });
});

// ---------------------------------------------------------------- records and texts on copies

describe.skipIf(!haveApp)('ACCESS RECACC: record and text writes on a copy', () => {
  it('replaces texts (DelTFld/LongS_), inserts and deletes records', () => {
    const dir = freshDir('pracsml');
    cpSync(join(APP, '{nova}/PRACSML.004'), join(dir, 'PRACSML.004'));
    cpSync(join(APP, '{nova}/PRACSML.T04'), join(dir, 'PRACSML.T04'));
    const fd = openFile(join(dir, 'PRACSML.004'), '6', PRACSML_DCL, join(dir, 'PRACSML.T04'));
    const Smlouva = fieldOf(fd, 'Smlouva');
    const Nazev = fieldOf(fd, 'Název');
    const expected: Uint8Array[] = [];
    const n0 = fd.NRecs;
    for (let i = 1; i <= n0; i++) {
      ReadRec(i);
      const old = _LongS(Smlouva);
      const add = makeText(i * 97, i);
      const s = new Uint8Array(old.length + add.length);
      s.set(old);
      s.set(add, old.length);
      DelTFld(Smlouva);
      expect(_T(Smlouva)).toBe(0);
      LongS_(Smlouva, s);
      WriteRec(i);
      expected.push(s);
    }
    // insert a record at 1, delete the last one, append two empty (deleted-flag) ones
    AccessVars.CRecPtr = GetRecSpace();
    ZeroAllFlds();
    S_(Nazev, B('Nová věta'));
    LongS_(Smlouva, encode852('Text nové věty'));
    CreateRec(1);
    expected.unshift(encode852('Text nové věty'));
    expect(fd.NRecs).toBe(n0 + 1);
    ReadRec(fd.NRecs);
    DeleteRec(fd.NRecs); // also deletes its text
    expected.pop();
    AssignNRecs(true, 2);
    expected.push(new Uint8Array(0), new Uint8Array(0));
    const N = ref(0);
    expect(LinkLastRec(fd, N, true)).toBe(true);
    expect(N.v).toBe(n0 + 2);
    closeFile(fd);

    const df = new DataFile(join(dir, 'PRACSML.004'));
    expect(df.nRecs).toBe(n0 + 2);
    expect(statSync(join(dir, 'PRACSML.004')).size).toBeGreaterThanOrEqual(6 + df.nRecs * df.recLen);
    const raw = new RawTFile(join(dir, 'PRACSML.T04'));
    for (let i = 1; i <= df.nRecs; i++) {
      const rec = df.readRecord(i);
      const pos = new DataView(rec.buffer, rec.byteOffset).getInt32(Smlouva.Displ, true);
      expect(pos === 0 ? new Uint8Array(0) : raw.read(pos)).toEqual(expected[i - 1]);
    }
    expect(decode852(df.readRecord(1).subarray(Nazev.Displ, Nazev.Displ + 9))).toBe('Nová věta');
    raw.close();
    df.close();

    // the same through our reader again, then AssignNRecs(false, 0) empties the T-file
    const fd2 = openFile(join(dir, 'PRACSML.004'), '6', PRACSML_DCL, join(dir, 'PRACSML.T04'));
    for (let i = 1; i <= fd2.NRecs; i++) {
      ReadRec(i);
      expect(_LongS(Smlouva)).toEqual(expected[i - 1]);
    }
    AssignNRecs(false, 0);
    expect(fd2.NRecs).toBe(0);
    expect(fd2.TF!.MaxPage).toBe(1);
    closeFile(fd2);
    expect(new DataFile(join(dir, 'PRACSML.004')).nRecs).toBe(0);
    expect(statSync(join(dir, 'PRACSML.T04')).size).toBeGreaterThanOrEqual(1024);
  });
  it('DelDifTFld, ClearRecSpace with TWork texts', () => {
    const dir = freshDir('copyrec');
    cpSync(join(APP, '{nova}/PRACSML.004'), join(dir, 'PRACSML.004'));
    cpSync(join(APP, '{nova}/PRACSML.T04'), join(dir, 'PRACSML.T04'));
    const fd = openFile(join(dir, 'PRACSML.004'), '6', PRACSML_DCL, join(dir, 'PRACSML.T04'));
    const Smlouva = fieldOf(fd, 'Smlouva');
    const tw = AccessVars.TWork;
    if (tw.Handle === 0xff) {
      tw.IsWork = true;
      BaseVars.CPath = join(dir, 'FANDWORK.$$$');
      tw.Create();
    }
    AccessVars.CFile = fd;
    ReadRec(1);
    const p1 = AccessVars.CRecPtr!;
    const orig = _LongS(Smlouva);
    // p2: a copy of p1 with its own copy of the text (what CopyRecWithT does via OLONGSTR.CopyTFString)
    const p2 = GetRecSpace();
    p2.set(p1.subarray(0, fd.RecLen));
    AccessVars.CRecPtr = p2;
    LongS_(Smlouva, orig);
    expect(_T(Smlouva)).not.toBe(0);
    AccessVars.CRecPtr = p1;
    expect(_T(Smlouva)).not.toBe(0);
    DelDifTFld(p2, p2, Smlouva); // same position: kept
    AccessVars.CRecPtr = p2;
    expect(_LongS(Smlouva)).toEqual(orig);
    AccessVars.CRecPtr = p1;
    DelDifTFld(p2, p1, Smlouva); // different positions: p2's copy is deleted
    AccessVars.CRecPtr = p2;
    expect(_T(Smlouva)).toBe(0);
    // a record whose texts live in TWork (flag at RecLen)
    const p3 = GetRecSpace();
    p3[fd.RecLen] = 1;
    AccessVars.CRecPtr = p3;
    LongS_(Smlouva, makeText(700, 5));
    expect(_LongS(Smlouva)).toEqual(makeText(700, 5));
    ClearRecSpace(p3);
    expect(_T(Smlouva)).toBe(0);
    AccessVars.CRecPtr = p1;
    closeFile(fd);
  });
});

describe('ACCESS FILEACC: lock modes and prefixes (single user)', () => {
  it('exclusive files change modes without locking; shared files lock through HANDLE', () => {
    const fd = new FileD();
    fd.Typ = '6';
    fd.Handle = 7;
    fd.UMode = Exclusive;
    AccessVars.CFile = fd;
    expect(ChangeLMode(WrMode, 0, false)).toBe(true);
    expect(fd.LMode).toBe(WrMode);
    fd.LMode = NullMode;
    const md = NewLMode(RdMode);
    expect(md).toBe(NullMode);
    expect(fd.LMode).toBe(RdMode);
    OldLMode(md);
    expect(fd.LMode).toBe(NullMode);
    expect(TryLockN(5, 2)).toBe(true);
    UnLockN(5);
  });
  it('CExtToT / CExtToX', () => {
    const fd = new FileD();
    fd.TF = new TFile();
    AccessVars.CFile = fd;
    BaseVars.CDir = '/d/';
    BaseVars.CName = 'PRACSML';
    BaseVars.CExt = '.004';
    CExtToT();
    expect(BaseVars.CPath).toBe('/d/PRACSML.T04');
    BaseVars.CExt = '.RDB';
    CExtToT();
    expect(BaseVars.CExt).toBe('.TTT');
    BaseVars.CExt = '.001';
    CExtToX();
    expect(BaseVars.CPath).toBe('/d/PRACSML.X01');
  });
  it('RdPrefix reports a record length mismatch', () => {
    if (!haveApp) return;
    const fd = openFile(join(APP, '{nova}/TYPDOKL.001'), 'X', TYPDOKL_DCL);
    fd.RecLen = 34;
    expect(RdPrefix()).toBe(35);
    fd.RecLen = 35;
    fd.Typ = '6'; // an X file is not a '6' file
    expect(RdPrefix()).toBe(35);
    fd.Typ = 'X';
    expect(RdPrefix()).toBe(0xffff);
    closeFile(fd);
  });
  it('SeekRec/PutRec append sequentially', () => {
    const dir = freshDir('putrec');
    BaseVars.CPath = join(dir, 'SEQ.000');
    const h = OpenH(_isoverwritefile, Exclusive);
    const { fields, recLen } = parseDcl('A:A,4;', false);
    const fd = new FileD();
    fd.Typ = '6';
    fd.RecLen = recLen;
    fd.FrstDispl = 6;
    fd.FldD = fields[0];
    fd.Handle = h;
    fd.UMode = Exclusive;
    fd.LMode = ExclMode;
    AccessVars.CFile = fd;
    AccessVars.CRecPtr = GetRecSpace();
    SeekRec(0);
    for (const s of ['abcd', 'efgh', 'ijkl']) {
      S_(fields[0], s);
      PutRec();
    }
    expect(fd.EOF).toBe(true);
    closeFile(fd);
    const df = new DataFile(join(dir, 'SEQ.000'));
    expect(df.nRecs).toBe(3);
    expect(String.fromCharCode(...df.readRecord(3))).toBe('ijkl');
    df.close();
  });
});

// ---------------------------------------------------------------- the reference FAND reads our T-file

const refReady = haveApp && existsSync(REF_FAND);

describe.skipIf(!refReady)('ACCESS: the reference FAND reads texts written by TFile.Store', () => {
  it('start-up notices U141 (short text, reused slot) and U002 (two pages) show our texts', async () => {
    const dir = copyTask(APP);
    try {
      const fd = openFile(join(dir, 'TIPY.000'), 'X', TIPY_DCL, join(dir, 'TIPY.T00'));
      const Klic = fieldOf(fd, 'Klíč');
      const Text = fieldOf(fd, 'Text');
      const long =
        'ZKOUSKA-A dlouhy text na dvou strankach\r\n' +
        Array.from({ length: 10 }, (_, i) => `radek ${i + 1} ${'x'.repeat(44)}\r\n`).join('') +
        'ZKOUSKA-Z konec dlouheho textu\r\n';
      const texts: Record<string, string> = {
        U141: 'ZKOUSKA-KRATKY prvni radek\r\nZKOUSKA-KRATKY druhy radek\r\n',
        U002: long,
      };
      expect(long.length).toBeGreaterThan(510);
      let done = 0;
      for (let i = 1; i <= fd.NRecs; i++) {
        ReadRec(i);
        const k = _ShortS(Klic).trim();
        if (!(k in texts)) continue;
        DelTFld(Text);
        LongS_(Text, encode852(texts[k]));
        WriteRec(i);
        done++;
      }
      expect(done).toBe(2);
      closeFile(fd);

      const d = new RefFandDriver({ taskDir: dir, task: 'ucto2026' });
      const seenTexts = new Set<string>();
      const spy = {
        text: () => {
          const t = d.text();
          for (const m of ['ZKOUSKA-KRATKY prvni', 'ZKOUSKA-KRATKY druhy', 'ZKOUSKA-A', 'ZKOUSKA-Z', 'radek 5']) {
            if (t.includes(m)) seenTexts.add(m);
          }
          return t;
        },
        press: (...k: (string | number)[]) => d.press(...k),
      };
      // the changed notices no longer carry their usual words: answer them by our markers
      UCTO_START_ANSWERS.unshift({ name: 'ZKOUSKA', when: /ZKOUSKA-(KRATKY|Z)/, keys: [13] });
      try {
        await startUcto(spy, 90000);
      } finally {
        UCTO_START_ANSWERS.shift();
        await d.close();
      }
      expect([...seenTexts].sort()).toEqual(
        ['ZKOUSKA-A', 'ZKOUSKA-KRATKY druhy', 'ZKOUSKA-KRATKY prvni', 'ZKOUSKA-Z', 'radek 5'].sort(),
      );
    } finally {
      rmSync(join(dir, '..'), { recursive: true, force: true });
    }
  }, 150_000);
});

void Code;
void DelTFlds;
void T00Format;
void CopyRecWithT;
