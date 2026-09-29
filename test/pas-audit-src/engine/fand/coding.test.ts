// Audit of fand/coding.ts TpRandom (BP7 System.Random) and the System.Random/Randomize users,
// driven by a bring-up discrepancy (scenario C): the tip line under the company name after a
// company switch (UCTO2026 Osveta: `randomize; r:=int(1+random*5)`) differs from the reference
// FAND. Known and intentional: the reference is the FPC build, whose System.Random is FPC's
// Mersenne twister and whose Randomize seeds from the Unix clock; ours is BP7's linear congruential
// generator (PORTING.md: BP7 wins, T-file headers are XORed with this stream). Since Osveta calls
// randomize first, the tip is clock-dependent on both sides anyway - the bring-up masks that line.
//
// Findings fixed here:
// * TpRandom.next(0) returned NaN (x % 0); BP7 RandInt returns 0 for Range = 0, and Range is a Word.
// * System.Randomize put hour:min in the HIGH word; BP7 (INT 21h AH=2Ch) stores CX = hour:min in
//   RandSeed's low word and DX = sec:hund in the high word.
// * EXPIMP XEncode drew its padding from a private RandSeed starting at 0; in BP7 it is the one
//   System.RandSeed (not saved/restored there), shared with `randseed :=` / `random` of FAND programs.

import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { TpRandom, bp7NextRand, bp7RandomizeSeed, xDecode } from '../../../../src/engine/fand/coding.ts';
import { parseTHeader } from '../../../../src/engine/fand/tfile.ts';
import { Clock, ref, getWord } from '../../../../src/engine/pas/pasrt.ts';
import { Random, Randomize, RunFrmlVars } from '../../../../src/engine/pas/runfrml.ts';
import { XEncode } from '../../../../src/engine/pas/expimp.ts';

const APP = new URL('../../../../vendor/extracted/app/', import.meta.url).pathname;

// independent model of the BP7 RTL (NextRand / RandInt / RandReal) in BigInt arithmetic
const M32 = (1n << 32n) - 1n;
function modelNext(seed: bigint): bigint {
  return (seed * 0x08088405n + 1n) & M32;
}

describe('TpRandom = BP7 System.Random', () => {
  it('NextRand: RandSeed := RandSeed*$08088405+1 mod 2^32, result from the new seed', () => {
    for (const s0 of [0, 1, 0x7fffffff, -1, -0x80000000, 0x12345678, 0xdeadbeef]) {
      let m = BigInt(s0 >>> 0);
      let s = s0;
      for (let i = 0; i < 1000; i++) {
        m = modelNext(m);
        s = bp7NextRand(s);
        expect(s).toBe(Number(m));
      }
    }
  });
  it('Random(Range: Word) = hi word of the new seed mod Range; Range 0 gives 0 (still advances)', () => {
    const r = new TpRandom(0);
    let m = 0n;
    for (let i = 0; i < 500; i++) {
      const range = [255, 100, 72, 24, 1, 0xffff][i % 6];
      m = modelNext(m);
      expect(r.next(range)).toBe(Number((m >> 16n) % BigInt(range)));
    }
    const z = new TpRandom(5);
    expect(z.next(0)).toBe(0);
    expect(z.seed).toBe(bp7NextRand(5));
    // Range is a Word: $10000 wraps to 0, $10005 to 5
    expect(new TpRandom(7).next(0x10000)).toBe(0);
    expect(new TpRandom(7).next(0x10005)).toBe(new TpRandom(7).next(5));
  });
  it('Random: Real = unsigned new seed / 2^32 (0 <= x < 1, exact in Real48)', () => {
    const r = new TpRandom(0);
    expect(r.real()).toBe(1 / 4294967296);
    const h = new TpRandom(0x7fffffff); // next seed has the top bit set: must stay positive
    const x = h.real();
    expect(x).toBe(bp7NextRand(0x7fffffff) / 4294967296);
    expect(x >= 0 && x < 1).toBe(true);
  });
  it('real data: the password area of Účto help files decodes to "@" padding with this stream', () => {
    const f = APP + 'HELP02.T00';
    if (!existsSync(f)) return;
    const raw = readFileSync(f);
    expect((raw[11] | (raw[12] << 8)) >= 0x4000).toBe(true); // RandSeed := ML + T.Time stream
    const h = parseTHeader(raw, raw.length, false);
    expect(h.password1).toBe('');
    expect(h.password2).toBe('');
  });
});

describe('runfrml System.Random / Randomize (FAND `random`, `randomize`, `randseed :=`)', () => {
  const saved = Clock.now;
  afterEach(() => {
    Clock.now = saved;
  });
  it('Randomize: RandSeed.lo = hour:min (CX), RandSeed.hi = sec:hund (DX)', () => {
    Clock.now = () => new Date(2026, 8, 28, 12, 34, 56, 789);
    Randomize();
    expect(RunFrmlVars.RandSeed).toBe(((56 << 8) | 78) * 0x10000 + ((12 << 8) | 34));
    expect(bp7RandomizeSeed(new Date(2026, 0, 1, 23, 59, 59, 999))).toBe(((59 << 8) | 99) * 0x10000 + ((23 << 8) | 59));
    // seconds <= 59, so the high word stays < $8000 and the longint is never negative
    expect(bp7RandomizeSeed(new Date(2026, 0, 1, 0, 0, 0, 0))).toBe(0);
  });
  it('Random() follows the same stream as TpRandom.real()', () => {
    RunFrmlVars.RandSeed = -123456;
    const t = new TpRandom(-123456);
    for (let i = 0; i < 50; i++) expect(Random()).toBe(t.real());
    expect(RunFrmlVars.RandSeed >>> 0).toBe(t.seed);
  });
  it('Osveta: randseed fixed -> the tip index int(1+random*5) is deterministic', () => {
    // from RandSeed 0 the first seed is 1, so r = int(1 + 1/2^32*5) = 1
    RunFrmlVars.RandSeed = 0;
    expect(Math.trunc(1 + Random() * 5)).toBe(1);
  });
});

describe('EXPIMP XEncode padding uses the shared System.RandSeed', () => {
  it('pads with Random(255) from RunFrmlVars.RandSeed and leaves it advanced', () => {
    const s = Uint8Array.from(Buffer.from('x'.repeat(600) + 'konec'));
    RunFrmlVars.RandSeed = 0x1234;
    const r = ref<Uint8Array>(new Uint8Array(0));
    XEncode(s, r);
    const e = r.v;
    expect(xDecode(e)).toEqual(s);
    const displ = getWord(e, e.length - 2) ^ 0xcccc;
    expect(displ).toBeGreaterThan(0);
    const t = new TpRandom(0x1234);
    for (let i = 0; i < displ; i++) expect(e[i]).toBe(t.next(255));
    expect(RunFrmlVars.RandSeed >>> 0).toBe(t.seed);
  });
});
