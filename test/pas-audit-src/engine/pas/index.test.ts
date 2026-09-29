// Audit of INDEX.PAS XString.StoreD (with StoreReal, its only caller), driven by a bring-up
// difference:
//
// Screens with existing VAT records (Závazky a pohledávky in scenario B, the cash-book form) show
// the Sazba labels '21%'/'12%' in our engine and blank ones in the reference FAND. Účto finds the
// rate with Saz_Dph: `r:=recno(SAZDPH,dat)` on SAZDPH's key `@ <= >DatumOd` (descending date).
//
// Cause (reference side): the FPC branch rewrote the BP7 asm StoreD as `Move(R,buf,6)`, but under
// FPC `real` is a double, so the key gets 6 bytes of a double (its low mantissa bytes) instead of the
// Real48; keys of D/R fields then neither order by value nor match a Real48 search key. BP7 (the
// authoritative semantics, PORTING.md) stores the Real48 big-endian with the sign flipped into
// bit 7: `shl ah,1; cmc; rcr al,1; rcr ah,1` over the exponent byte and the high mantissa byte.
// Ours (index.ts XString.StoreD) matches the BP7 asm byte for byte - the tests below pin that with
// an instruction-level transliteration of the asm, and check the SAZDPH lookup on the shipped data.
// Nothing to fix on our side; the bring-up test masks the label column (maskVatRate).

import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FieldDescr, KeyFldD } from '../../../../src/engine/pas/access.ts';
import { XString } from '../../../../src/engine/pas/index.ts';
import { readReal48, writeReal48, readFix, dateToDayNumber } from '../../../../src/engine/fand/numbers.ts';

const ROOT = join(import.meta.dirname, '../../../..');
const SAZDPH = join(ROOT, 'vendor/extracted/app/{glob}/SAZDPH.000');

// ---------------------------------------------------------------- BP7 asm, instruction by instruction

/** PAS: INDEX.PAS (BP7) NegateESDI – `jcxz @2; @1: not es:[di].byte; inc di; loop @1` */
function negateESDI(S: number[], di: number, cx: number): void {
  for (; cx > 0; cx--, di++) S[di] = ~S[di] & 0xff;
}

/**
 * PAS: INDEX.PAS (BP7) XString.StoreD(var R; Descend) assembler – transliterated with the carry flag.
 * S is the string255 as bytes (S[0] = length), R the 6 bytes of the Real48.
 */
function bp7StoreD(S: number[], R: Uint8Array, Descend: boolean): void {
  let di = 0;
  let al = S[di]; // les di,Self; mov al,es:[di]
  const bl = al; // mov bl,al
  al = (al + 6) & 0xff; // add al,6
  if (al < bl) return; // cmp al,bl; jb @1
  S[di] = al; // mov es:[di],al
  const bx = bl; // xor bh,bh
  al = R[0]; // lds si,R; mov al,[si]
  let ah = R[5]; // mov ah,[si+5]
  di = di + 1 + bx; // inc di; add di,bx
  let cf = ah >> 7; // shl ah,1
  ah = (ah << 1) & 0xff;
  cf ^= 1; // cmc
  let nc = al & 1; // rcr al,1
  al = (cf << 7) | (al >> 1);
  cf = nc;
  nc = ah & 1; // rcr ah,1
  ah = (cf << 7) | (ah >> 1);
  cf = nc;
  S[di] = al; // mov es:[di].word,ax
  S[di + 1] = ah;
  let ax = R[3] | (R[4] << 8); // mov ax,[si+3]
  ax = ((ax & 0xff) << 8) | (ax >> 8); // xchg al,ah
  S[di + 2] = ax & 0xff; // mov es:[di+2].word,ax
  S[di + 3] = ax >> 8;
  ax = R[1] | (R[2] << 8); // mov ax,[si+1]
  ax = ((ax & 0xff) << 8) | (ax >> 8); // xchg al,ah
  S[di + 4] = ax & 0xff; // mov es:[di+4].word,ax
  S[di + 5] = ax >> 8;
  if (Descend) negateESDI(S, di, 6); // cmp Descend,0; je @1; mov cx,6; call NegateESDI
}

const toBytes = (x: XString): number[] => [x.S.length, ...Array.from(x.S, (c) => c.charCodeAt(0))];
const bp7 = (prefix: string, R: Uint8Array, desc: boolean): number[] => {
  const S = [prefix.length, ...Array.from(prefix, (c) => c.charCodeAt(0))];
  bp7StoreD(S, R, desc);
  return S.slice(0, S[0] + 1);
};

const kfD = (typ: 'D' | 'R', desc: boolean): KeyFldD => {
  const F = new FieldDescr();
  F.Typ = typ;
  F.FrmlTyp = 'R';
  F.NBytes = 6;
  F.L = typ === 'D' ? 10 : 17;
  const k = new KeyFldD();
  k.FldD = F;
  k.Descend = desc;
  return k;
};

// deterministic pseudo-random (xorshift32)
function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s;
  };
}

describe('INDEX.PAS XString.StoreD: BP7 Real48 key bytes', () => {
  it('equals the BP7 asm for Real48 values of every exponent and mantissa, ascending and descending', () => {
    const next = rng(0x5a2d9f1);
    const R = new Uint8Array(6);
    for (let i = 0; i < 5000; i++) {
      for (let j = 0; j < 6; j++) R[j] = next() & 0xff;
      if (R[0] === 0) R[0] = 1; // exponent 0 is zero: writeReal48 normalizes it to all zero bytes
      const v = readReal48(R);
      const back = new Uint8Array(6);
      writeReal48(v, back);
      expect(Array.from(back)).toEqual(Array.from(R)); // the double carries the Real48 exactly
      for (const desc of [false, true]) {
        const x = new XString();
        x.StoreD(v, desc);
        expect(toBytes(x)).toEqual(bp7('', R, desc));
      }
    }
  });

  it('zero and a key already holding other fields (the value is appended at S[len+1])', () => {
    const x = new XString();
    x.StoreD(0, false);
    expect(toBytes(x)).toEqual(bp7('', new Uint8Array(6), false));
    expect(toBytes(x)).toEqual([6, 0x80, 0, 0, 0, 0, 0]);
    const R = new Uint8Array(6);
    writeReal48(dateToDayNumber(2024, 1, 1), R);
    for (const desc of [false, true]) {
      const y = new XString();
      y.S = 'AB\x1f';
      y.StoreD(readReal48(R), desc);
      expect(toBytes(y)).toEqual(bp7('AB\x1f', R, desc));
    }
  });

  it('skips the value when the key would pass 255 bytes (add al,6; jb), like the asm', () => {
    const R = new Uint8Array(6);
    writeReal48(12.5, R);
    for (const len of [248, 249, 250, 251, 255]) {
      const x = new XString();
      x.S = 'x'.repeat(len);
      x.StoreD(12.5, false);
      expect(toBytes(x)).toEqual(bp7('x'.repeat(len), R, false));
      expect(x.S.length).toBe(len <= 249 ? len + 6 : len);
    }
  });

  it('StoreReal on D/R: a negative value is stored as its absolute value with Descend toggled', () => {
    const R = new Uint8Array(6);
    for (const v of [-1, -0.001, -739000.5, -1e20]) {
      writeReal48(-v, R);
      for (const desc of [false, true]) {
        const x = new XString();
        x.StoreReal(v, kfD('R', desc));
        expect(toBytes(x)).toEqual(bp7('', R, !desc));
      }
    }
  });

  it('keys order like the values (ascending and descending, negatives included)', () => {
    const vals = [-1e30, -739000.25, -2, -1, -0.5, -1e-30, 0, 1e-30, 0.5, 1, 2, 739000.25, 1e30];
    for (const desc of [false, true]) {
      const keys = vals.map((v) => {
        const x = new XString();
        x.StoreReal(v, kfD('R', desc));
        return x.S;
      });
      for (let i = 1; i < keys.length; i++) expect(desc ? keys[i - 1] > keys[i] : keys[i - 1] < keys[i]).toBe(true);
    }
  });
});

describe.skipIf(!existsSync(SAZDPH))('SAZDPH (Saz_Dph: recno(SAZDPH,dat) on `@ <= >DatumOd`)', () => {
  // DatumOd:D; Zakladni:F,2.2; Snizena:F,2.2; Snizena2:F,2.2 - '0' file: header NRecs(4) RecLen(2)
  const b = new Uint8Array(readFileSync(SAZDPH));
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const nRecs = Math.abs(dv.getInt32(0, true));
  const recLen = dv.getUint16(4, true);
  const recs = Array.from({ length: nRecs }, (_, i) => {
    const o = 6 + i * recLen;
    return { recNr: i + 1, datumOd: readReal48(b, o + 1), zakl: readFix(b, o + 7, 2) / 100, sniz: readFix(b, o + 9, 2) / 100 };
  });
  const key = (d: number): string => {
    const x = new XString();
    x.StoreReal(d, kfD('D', true));
    return x.S;
  };

  it('the descending date keys sort the records newest first and find the rate in force', () => {
    expect(recLen).toBe(13);
    expect(nRecs).toBeGreaterThan(1);
    const sorted = [...recs].sort((a, b) => (key(a.datumOd) < key(b.datumOd) ? -1 : 1));
    for (let i = 1; i < sorted.length; i++) expect(sorted[i - 1].datumOd).toBeGreaterThan(sorted[i].datumOd);
    // a '<=' key search: the first item whose key is >= the search key = the newest DatumOd <= dat
    const lookup = (dat: number) => sorted.find((r) => key(r.datumOd) >= key(dat));
    const today = dateToDayNumber(2026, 9, 28);
    const r = lookup(today)!;
    expect(r.datumOd).toBe(Math.max(...recs.filter((x) => x.datumOd <= today).map((x) => x.datumOd)));
    expect(r.zakl).toBe(21);
    expect(r.sniz).toBe(12);
    // the exact day a rate starts belongs to that rate
    expect(lookup(r.datumOd)).toBe(r);
    expect(lookup(r.datumOd - 1)).not.toBe(r);
  });
});
