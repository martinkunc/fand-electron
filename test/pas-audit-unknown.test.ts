// Audit regressions for the bring-up discrepancies that are intentional (BP7 wins over the FPC
// reference FAND where data compatibility is concerned, docs/PORTING.md):
// * INDEX.PAS XString.StoreD: BP7 stores the Real48 (sign flipped to bit 7, exponent and mantissa
//   big-endian), the FPC port moves 6 bytes of a double – which breaks descending date keys such
//   as SAZDPH '#K @ <= >DatumOd' / SAZODP '>RokOd' in the reference (Sazba blank, VAT 0);
// * COMMON.PAS RDate: time literals (#I ÚkolSI:=2:0) keep the full Real48 precision (the FPC port
//   types 360000.0/8640000.0 as Single);
// * FILEACC.PAS TFile header: the BP7 Random stream (RandSeed*$08088405+1, hi word mod Range).

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { XString } from '../src/engine/pas/index.ts';
import { FieldDescr, KeyFldD } from '../src/engine/pas/access.ts';
import { RDate, ValDate } from '../src/engine/pas/common.ts';
import { readReal48, writeReal48, dateToDayNumber } from '../src/engine/fand/numbers.ts';
import { parseTHeader } from '../src/engine/fand/tfile.ts';
import { TpRandom } from '../src/engine/fand/coding.ts';

const ROOT = join(import.meta.dirname, '..');
const APP = join(ROOT, 'vendor/extracted/app');
const haveApp = existsSync(join(APP, 'UCTO2026.RDB'));

const hex = (s: string | Uint8Array): string =>
  (typeof s === 'string' ? Array.from(s, (c) => c.charCodeAt(0)) : Array.from(s))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join(' ');

function dateKF(desc: boolean): KeyFldD {
  const F = new FieldDescr();
  F.Typ = 'D';
  F.FrmlTyp = 'R';
  F.NBytes = 6;
  F.L = 8;
  const k = new KeyFldD();
  k.FldD = F;
  k.Descend = desc;
  return k;
}
function dKey(R: number, desc: boolean): string {
  const x = new XString();
  x.StoreReal(R, dateKF(desc));
  return x.S;
}

/** INDEX.PAS XString.StoreD, emulated instruction by instruction from the BP7 asm. */
function asmStoreD(R: number, Descend: boolean): string {
  const si = new Uint8Array(6);
  writeReal48(R, si);
  let al = si[0];
  let ah = si[5];
  // shl ah,1; cmc
  let cf = (ah >> 7) & 1;
  ah = (ah << 1) & 0xff;
  cf ^= 1;
  // rcr al,1
  const cf2 = al & 1;
  al = (al >> 1) | (cf << 7);
  // rcr ah,1
  ah = (ah >> 1) | (cf2 << 7);
  // word ax at di (al, ah); [si+3] xchg -> r4, r3; [si+1] xchg -> r2, r1
  const out = [al, ah, si[4], si[3], si[2], si[1]].map((b) => (Descend ? ~b & 0xff : b));
  return String.fromCharCode(...out);
}

describe('INDEX.PAS XString.StoreD (BP7 Real48 keys)', () => {
  it('matches the BP7 asm byte for byte, ascending and descending', () => {
    const vals = [0, 1e-11, 1 / 12, 0.5, 1, 2, 3.75, 728294, 731702, 738886, 739999.5, 1e12];
    for (const v of vals) {
      for (const d of [false, true]) {
        const x = new XString();
        x.StoreD(v, d);
        expect(hex(x.S)).toBe(hex(asmStoreD(v, d)));
      }
    }
  });

  it('negative values: StoreReal negates R and flips Descend (INDEX.PAS StoreReal)', () => {
    expect(hex(dKey(-731702, false))).toBe(hex(asmStoreD(731702, true)));
    expect(hex(dKey(-731702, true))).toBe(hex(asmStoreD(731702, false)));
  });

  it('skips the value when the key would exceed 255 bytes (asm: add al,6; jb)', () => {
    const x = new XString();
    x.S = 'x'.repeat(249);
    x.StoreD(1, false);
    expect(x.S.length).toBe(255);
    x.S = 'x'.repeat(250);
    x.StoreD(1, false);
    expect(x.S.length).toBe(250);
  });

  it('descending date keys order newest first (FPC 6 bytes of a double do not)', () => {
    const dates = [0, 728294, 731702, 733042, 733773, 734503, 734869, 735599, 738886];
    const keys = dates.map((d) => dKey(d, true));
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1] > keys[i]).toBe(true);
    // what the FPC reference stores: the low 6 bytes of the double, in memory order
    const fpc = (d: number): string => {
      const b = new Uint8Array(new Float64Array([d]).buffer);
      return String.fromCharCode(...b.subarray(0, 6).map((c) => ~c & 0xff));
    };
    const fk = dates.map(fpc);
    expect(fk.every((k, i) => i === 0 || fk[i - 1] > k)).toBe(false); // not in date order
  });

  it.skipIf(!haveApp)("SAZDPH '#K @ <= >DatumOd': the rate valid on a date is found (Saz_Dph)", () => {
    // {glob}/SAZDPH.000: DatumOd:D; Zakladni:F,2.2; Snizena:F,2.2; Snizena2:F,2.2 (13-byte records)
    const b = readFileSync(join(APP, '{glob}/SAZDPH.000'));
    const recLen = b.readUInt16LE(4);
    expect(recLen).toBe(13);
    const recs: { recNr: number; datumOd: number; key: string }[] = [];
    for (let o = 6, n = 1; o + recLen <= b.length; o += recLen, n++) {
      const datumOd = readReal48(b, o + 1);
      recs.push({ recNr: n, datumOd, key: dKey(datumOd, true) });
    }
    expect(recs.length).toBe(9);
    // the index order (XKey ascending on the key bytes, duplicates by RecNr)
    const idx = [...recs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.recNr - b.recNr));
    // '<=' on a descending key: XKey.Search lands on the first key >= key(date)
    const lookup = (y: number, m: number, d: number): number => {
      const k = dKey(dateToDayNumber(y, m, d), true);
      const r = idx.find((e) => e.key >= k);
      return r ? r.datumOd : -1;
    };
    expect(lookup(2026, 1, 30)).toBe(dateToDayNumber(2024, 1, 1));
    expect(lookup(2026, 1, 15)).toBe(dateToDayNumber(2024, 1, 1));
    expect(lookup(2024, 1, 1)).toBe(dateToDayNumber(2024, 1, 1));
    expect(lookup(2023, 12, 31)).toBe(dateToDayNumber(2015, 1, 1));
    expect(lookup(2012, 6, 30)).toBe(dateToDayNumber(2012, 1, 1));
    expect(lookup(2004, 4, 30)).toBe(dateToDayNumber(1995, 1, 1));
    expect(lookup(1990, 1, 1)).toBe(0); // the empty DatumOd row sorts last
  });
});

describe('COMMON.PAS RDate / LEXANAL time literals (BP7 precision)', () => {
  it('#I ÚkolSI:=2:0 stores Real48 7d ab aa aa aa 2a (not the FPC Single 7d 00 00 ab aa 2a)', () => {
    const r = ValDate('2:0', 'hh:mm:ss.tt');
    expect(r).toBe(RDate(0, 0, 0, 2, 0, 0, 0));
    expect(r).toBe(1 / 12);
    const b = new Uint8Array(6);
    writeReal48(r, b);
    expect(hex(b)).toBe('7d ab aa aa aa 2a');
  });
  it('TipI1:=1:0:0 is 1/24 at Real48 precision', () => {
    const r = ValDate('1:0:0', 'hh:mm:ss.tt');
    expect(r).toBe(1 / 24);
    const b = new Uint8Array(6);
    writeReal48(r, b);
    expect(hex(b)).toBe('7c ab aa aa aa 2a');
  });
});

describe('FILEACC.PAS TFile header (BP7 Random)', () => {
  it('Random: RandSeed*$08088405+1, hi word mod Range', () => {
    const r = new TpRandom(0);
    expect([r.next(255), r.next(255), r.next(255)]).toEqual([0, 0x0808 % 255, ((Math.imul(0x08088406, 134775813) + 1) >>> 16) % 255]);
  });
  it.skipIf(!haveApp)('pristine Účto .T00 headers decode with the BP7 stream (passwords readable)', () => {
    for (const f of ['TIPY.T00', 'HELP02.T00', 'UFANDHLP.T00']) {
      const b = readFileSync(join(APP, f));
      const h = parseTHeader(new Uint8Array(b.subarray(0, 512)), b.length, false);
      expect(h.version).toBe('4.20');
      expect(h.password1).not.toBeNull();
      expect(h.password2).not.toBeNull();
    }
  });
});
