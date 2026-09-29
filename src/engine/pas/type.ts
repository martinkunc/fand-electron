// PAS: TYPE.PAS (include of ACCESS) – packed BCD ('N' fields) and fixed point ('F' fields).
// Buffers are subarray views at the field (`var PackArr` -> Uint8Array). The byte formats are
// also implemented in src/engine/fand/numbers.ts (unpackBcd/packBcd/readFix/writeFix).
//
// Porting notes:
// * BP7 (not Coproc) computes in Real48: RealFromFix truncates the integer to the 40-bit Real48
//   mantissa, and FixFromReal adds 0.5 in Real48 before it truncates. We compute in double, so
//   FixFromReal first rounds its argument to Real48 precision (Real48Round), which keeps the BP7
//   rounding of values like 1.005*100 (a double gives 100.4999…, Real48 gives 100.5).
// * Overflow in FixFromReal leaves zero bytes (BP7 and FPC).

import { readReal48, writeReal48 } from '../fand/numbers.ts';
import type { float } from './base.ts';

// PAS: TYPE.PAS UnPack – NoDigits BCD nibbles -> ASCII digits
export function UnPack(PackArr: Uint8Array, NumArr: Uint8Array, NoDigits: number): void {
  let src = 0;
  let dst = 0;
  let i = NoDigits;
  while (i > 0) {
    const b = PackArr[src];
    NumArr[dst++] = (b >> 4) + 0x30;
    i--;
    if (i === 0) break;
    NumArr[dst++] = (b & 0x0f) + 0x30;
    i--;
    src++;
  }
}

// PAS: TYPE.PAS Pack – ASCII digits -> BCD nibbles
export function Pack(NumArr: Uint8Array, PackArr: Uint8Array, NoDigits: number): void {
  // source[k] = NumArr[k-1], target[k] = PackArr[k-1]
  for (let i = 1; i <= NoDigits >> 1; i++) {
    PackArr[i - 1] = (((NumArr[(i << 1) - 2] & 0x0f) << 4) | (NumArr[(i << 1) - 1] & 0x0f)) & 0xff;
  }
  if (NoDigits & 1) PackArr[NoDigits >> 1] = ((NumArr[NoDigits - 1] & 0x0f) << 4) & 0xff;
}

/** TS-only: round a double to the nearest Real48 value (BP7 float = real). */
export function Real48Round(r: float): float {
  if (r === 0 || !Number.isFinite(r) || Math.abs(r) >= 1.7e38) return r;
  const b = new Uint8Array(6);
  writeReal48(r, b, 0);
  return readReal48(b, 0);
}

// PAS: TYPE.PAS RealFromFix – big-endian two's complement, $80 00.. = 0 (null).
// BP7: the magnitude is truncated to the 40-bit Real48 mantissa.
export function RealFromFix(FixNo: Uint8Array, FLen: number): float {
  if (FLen < 1 || FLen > 8) return 0;
  const F = FixNo.subarray(0, FLen);
  const neg = (F[0] & 0x80) !== 0;
  if (neg && F[0] === 0x80) {
    let isnull = true;
    for (let i = 1; i < FLen; i++) if (F[i] !== 0) isnull = false;
    if (isnull) return 0; // NULL value
  }
  let v = 0n;
  for (let i = 0; i < FLen; i++) v = (v << 8n) | BigInt(F[i]);
  if (neg) v = (1n << BigInt(8 * FLen)) - v; // magnitude of the two's complement
  if (v === 0n) return 0;
  const bits = v.toString(2).length;
  if (bits > 40) v = (v >> BigInt(bits - 40)) << BigInt(bits - 40); // Real48 mantissa
  const r = Number(v);
  return neg ? -r : r;
}

// PAS: TYPE.PAS FixFromReal – rounds half away from zero; out of range leaves zeros
export function FixFromReal(r: float, FixNo: Uint8Array, flen: number): void {
  if (flen < 1 || flen > 8) return;
  FixNo.fill(0, 0, flen);
  r = Real48Round(r);
  if (r > 0) r = Real48Round(r + 0.5);
  else r = Real48Round(r - 0.5);
  const a = Math.abs(r);
  if (!(a >= 1)) return; // rexp<1: zero
  if (a >= 2 ** (flen * 8 - 1)) return; // rexp>fexp: overflow
  let v = BigInt(Math.trunc(a));
  if (r < 0) v = (1n << BigInt(8 * flen)) - v;
  for (let i = flen - 1; i >= 0; i--) {
    FixNo[i] = Number(v & 0xffn);
    v >>= 8n;
  }
}
