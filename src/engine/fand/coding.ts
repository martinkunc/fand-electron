// Obfuscation used by PC FAND. None of it is keyed by the password: passwords only
// gate editing. Reference: pas/ACCESS.PAS (Code, XDecode, CodingLongStr) and
// pas/FILEACC.PAS (TFile.RdPrefix / WrPrefix).

/**
 * Borland Pascal 7 System.Random: linear congruential generator on RandSeed (a longint).
 * BP7 RTL NextRand: RandSeed := RandSeed*$08088405+1 (mod 2^32); the result is taken from the NEW
 * seed. PORTING.md: this is the generator FAND uses (the FPC reference uses FPC's Mersenne twister,
 * so anything drawn from Random differs from the reference - intentionally).
 */
export class TpRandom {
  /** RandSeed as an unsigned 32-bit value */
  seed: number;
  constructor(seed: number) {
    this.seed = seed >>> 0;
  }
  /** Random(Range: Word): Word - BP7 RandInt: (hi word of the new seed) mod Range; Range = 0 gives 0 */
  next(range: number): number {
    this.seed = bp7NextRand(this.seed);
    range &= 0xffff; // Range: Word
    return range === 0 ? 0 : (this.seed >>> 16) % range;
  }
  /** Random: Real - BP7 RandReal: the new seed (unsigned) / 2^32, exact in Real48, 0 <= x < 1 */
  real(): number {
    this.seed = bp7NextRand(this.seed);
    return this.seed / 4294967296;
  }
}

/** BP7 RTL NextRand: the next RandSeed (unsigned 32-bit) after `seed`. */
export function bp7NextRand(seed: number): number {
  return (Math.imul(seed | 0, 0x08088405) + 1) >>> 0;
}

/**
 * BP7 System.Randomize: INT 21h AH=2Ch (CH=hour, CL=minute, DH=second, DL=hundredths), then
 * RandSeed.lo := CX, RandSeed.hi := DX, i.e. seconds/hundredths in the HIGH word. Returns the
 * seed as a signed longint.
 */
export function bp7RandomizeSeed(d: Date): number {
  const cx = (d.getHours() << 8) | d.getMinutes();
  const dx = (d.getSeconds() << 8) | Math.trunc(d.getMilliseconds() / 10);
  return ((dx << 16) | cx) | 0;
}

/** Code: XOR every byte with 0xAA (used for '!' fields and unlicensed chapter texts). */
export function xorAA(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ 0xaa;
  return out;
}

/**
 * XDecode: LZ77-style decompression with a rotating XOR mask, used for chapter texts
 * of licence-locked ("Alt-F10" coded) projects. `a` is the stored text body (the bytes
 * after the 2-byte length word).
 *
 * Layout: [Displ padding][flag byte, 8 items]... [t:byte][Displ xor $CCCC : word]
 * A clear flag bit = literal byte XOR mask (mask = rol(mask,1) before each literal,
 * starting at rol($9C, t and 3)). A set bit = back reference (len:byte, pos:word),
 * where pos is an offset relative to the LongStr start (2 bytes before output[0]).
 */
export function xDecode(a: Uint8Array): Uint8Array {
  const ll = a.length;
  if (ll === 0) return a;
  if (ll < 3) throw new Error('XDecode: text too short');
  const bound = ll - 3; // index of t byte == exclusive input bound
  const displ = (a[ll - 2] | (a[ll - 1] << 8)) ^ 0xcccc;
  const rol = (v: number, n: number) => ((v << n) | (v >> (8 - n))) & 0xff;
  let mask = rol(0x9c, a[bound] & 3);
  const out: number[] = [];
  let si = displ;
  outer: while (si < bound) {
    let flags = a[si++];
    for (let bit = 0; bit < 8; bit++) {
      if (si >= bound) break outer;
      if ((flags & 1) === 0) {
        mask = rol(mask, 1);
        out.push(a[si++] ^ mask);
      } else {
        const len = a[si++];
        const pos = (a[si] | (a[si + 1] << 8)) - 2;
        si += 2;
        for (let k = 0; k < len; k++) out.push(out[pos + k]);
      }
      flags >>= 1;
    }
  }
  return Uint8Array.from(out);
}
