import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decode852, encode852 } from '../src/engine/console/cp852.ts';
import {
  readReal48, writeReal48, readFix, writeFix, unpackBcd, packBcd, dateToDayNumber, dayNumberToDate,
} from '../src/engine/fand/numbers.ts';
import { TpRandom, xorAA } from '../src/engine/fand/coding.ts';
import { Rdb } from '../src/engine/fand/rdb.ts';
import { DataFile } from '../src/engine/fand/datafile.ts';
import { TFile } from '../src/engine/fand/tfile.ts';
import { EngineDriver, K } from '../src/engine/testing/driver.ts';

const APP = join(import.meta.dirname, '../vendor/extracted/app');
const hasUcto = existsSync(join(APP, 'UCTO2026.RDB'));

describe('cp852', () => {
  it('round-trips Czech text', () => {
    const s = 'Příliš žluťoučký kůň úpěl ďábelské ódy ╔═╗';
    expect(decode852(encode852(s))).toBe(s);
    expect(encode852('ř')[0]).toBe(0xfd);
  });
});

describe('numbers', () => {
  it('Real48 round trip', () => {
    for (const v of [0, 1, -1, 0.5, 123456.789, -98765.4321, 1e-10, 739000.25]) {
      const b = new Uint8Array(6);
      writeReal48(v, b);
      expect(readReal48(b)).toBeCloseTo(v, 6);
    }
  });
  it('fixed point (F fields) is big-endian two complement', () => {
    const b = new Uint8Array(3);
    writeFix(100000, b, 0, 3);
    expect([...b]).toEqual([0x01, 0x86, 0xa0]);
    writeFix(-5, b, 0, 3);
    expect(readFix(b, 0, 3)).toBe(-5);
    expect(readFix(Uint8Array.of(0x80, 0, 0), 0, 3)).toBe(0);
  });
  it('BCD (N fields)', () => {
    const b = new Uint8Array(3);
    packBcd('12345', b, 0, 5);
    expect([...b]).toEqual([0x12, 0x34, 0x50]);
    expect(unpackBcd(b, 0, 5)).toBe('12345');
  });
  it('FAND day numbers', () => {
    expect(dateToDayNumber(1, 1, 1)).toBe(1);
    const n = dateToDayNumber(2026, 9, 28);
    expect(dayNumberToDate(n)).toEqual({ y: 2026, m: 9, d: 28 });
    expect(dayNumberToDate(dateToDayNumber(2000, 2, 29))).toEqual({ y: 2000, m: 2, d: 29 });
  });
});

describe('coding', () => {
  it('Borland Pascal Random is the seed*134775813+1 LCG', () => {
    const r = new TpRandom(0);
    r.next(255);
    expect(r.seed).toBe(1);
    r.next(255);
    expect(r.seed).toBe(134775814);
  });
  it('xorAA is an involution', () => {
    const a = Uint8Array.of(1, 2, 3, 0xaa);
    expect(xorAA(xorAA(a))).toEqual(a);
  });
});

describe.skipIf(!hasUcto)('Účto 2026 files', () => {
  it('decodes the licensed main task', () => {
    const r = new Rdb(join(APP, 'UCTO2026.RDB'));
    expect(r.tfile.header.version).toBe('4.20');
    expect(r.tfile.licenseNr).toBe(29140);
    expect(r.encrypted).toBe(true);
    expect(r.chapters.length).toBe(661);
    const sign = r.text(r.chapters[1]);
    expect(sign).toContain('function Sign(r:real):real;');
    const param2 = r.chapters.find((c) => c.typ === 'F' && c.name === 'PARAM2')!;
    expect(r.text(param2)).toMatch(/PlátceDph:B;\s*Firma:A,30;/);
    r.close();
  });
  it('decodes every chapter of every project', () => {
    const fs = require('node:fs') as typeof import('node:fs');
    let n = 0;
    for (const f of fs.readdirSync(APP).filter((x: string) => /\.(rdb|pro)$/i.test(x))) {
      const r = new Rdb(join(APP, f));
      for (const ch of r.chapters) {
        r.text(ch);
        n++;
      }
      r.close();
    }
    expect(n).toBe(5420);
  });
  it('decrypts T-file headers (TP Random stream verified by the @ padding)', () => {
    // Unlicensed memo file: both passwords empty ('@' x 20 each after decryption).
    const t = new TFile(join(APP, '{nova}/PRACSML.T04'));
    expect(t.header.password1).toBe('');
    expect(t.header.password2).toBe('');
    t.close();
    // Licensed task: password 1 is random bytes, password 2 empty.
    const u = new TFile(join(APP, 'UCTO2026.TTT'), { isRdbText: true });
    expect(u.header.password1).toBeNull();
    expect(u.header.password2).toBe('');
    u.close();
  });
  it('reads indexed data files with deleted flags', () => {
    const df = new DataFile(join(APP, '{nova}/TYPDOKL.001'));
    expect(df.kind).toBe('X');
    expect(df.nRecs).toBe(10);
    expect(df.recLen).toBe(35);
    expect(decode852(df.readRecord(2).subarray(1, 12))).toBe('DO dobropis');
    df.close();
  });
});

describe.skipIf(!hasUcto)('engine driver', () => {
  it('opens the task in the project browser (browse)', async () => {
    const d = new EngineDriver({ appDir: APP, project: 'UCTO2026', browse: true });
    await d.waitFor('UCTO2026.RDB');
    d.press(K.Enter);
    await d.waitFor('661 kapitol');
    d.press(K.Down, K.Enter);
    await d.waitFor(/D  - UCTO2026\.RDB|D \(bez jména\) - UCTO2026\.RDB/);
    d.press(K.Esc, K.Esc, K.Esc);
    expect(await d.exited).toBe(0);
    await d.close();
  });
});
