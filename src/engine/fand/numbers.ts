// Binary encodings used by PC FAND (Borland Pascal 7) data files.
// Reference: pas/Type.pas (Pack/UnPack/RealFromFix), pas/RECACC.PAS (_R, _B, _T).

/** FAND dates are Real48 day numbers counted from 1.1.0001 (day 1). 1.1.1900 = 693596. */
export const FIRST_DATE = 6.97248e5; // used by '8' (8-bit) files: stored integer + FirstDate

/** Is a stored field value NULL? FAND marks nulls with all bytes = 0xFF (IsNullValue). */
export function isNull(buf: Uint8Array, off: number, len: number): boolean {
  for (let i = 0; i < len; i++) if (buf[off + i] !== 0xff) return false;
  return true;
}

/** Turbo Pascal 6-byte Real: byte0 exponent (bias 129), bytes1..5 mantissa LE, sign in byte5 bit7. */
export function readReal48(buf: Uint8Array, off = 0): number {
  const exp = buf[off];
  if (exp === 0) return 0;
  const hi = buf[off + 5];
  const sign = hi & 0x80 ? -1 : 1;
  let mant = hi & 0x7f;
  for (let i = 4; i >= 1; i--) mant = mant * 256 + buf[off + i];
  return sign * (1 + mant / 2 ** 39) * 2 ** (exp - 129);
}

export function writeReal48(value: number, buf: Uint8Array, off = 0): void {
  buf.fill(0, off, off + 6);
  if (value === 0 || !Number.isFinite(value)) return;
  const sign = value < 0 ? 0x80 : 0;
  let v = Math.abs(value);
  let exp = Math.floor(Math.log2(v));
  let frac = v / 2 ** exp; // [1,2)
  if (frac >= 2) {
    frac /= 2;
    exp++;
  } else if (frac < 1) {
    frac *= 2;
    exp--;
  }
  let mant = Math.round((frac - 1) * 2 ** 39);
  if (mant >= 2 ** 39) {
    mant = 0;
    exp++;
  }
  const e = exp + 129;
  if (e <= 0) return; // underflow -> 0
  if (e > 255) throw new RangeError('Real48 overflow');
  buf[off] = e;
  for (let i = 1; i <= 4; i++) {
    buf[off + i] = mant % 256;
    mant = Math.floor(mant / 256);
  }
  buf[off + 5] = (mant & 0x7f) | sign;
}

/** Bytes used by an F,l.m field (TabF in RDFILDCL.PAS), indexed by l+m. */
export const TAB_F = [0, 1, 1, 2, 2, 3, 3, 4, 4, 4, 5, 5, 6, 6, 6, 7, 7, 8, 8];

/** F fields: big-endian two's-complement integer scaled by 10^m. 0x80 00.. is the "empty" value. */
export function readFix(buf: Uint8Array, off: number, len: number): number {
  if (buf[off] === 0x80) {
    let rest = 0;
    for (let i = 1; i < len; i++) rest |= buf[off + i];
    if (rest === 0) return 0;
  }
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + buf[off + i];
  if (buf[off] & 0x80) v -= 2 ** (8 * len);
  return v;
}

export function writeFix(value: number, buf: Uint8Array, off: number, len: number): void {
  // FixFromReal rounds half away from zero.
  let v = value > 0 ? Math.floor(value + 0.5) : Math.ceil(value - 0.5);
  if (v < 0) v += 2 ** (8 * len);
  for (let i = len - 1; i >= 0; i--) {
    buf[off + i] = v % 256;
    v = Math.floor(v / 256);
  }
}

/** N,n fields: packed BCD, two digits per byte, high nibble first. */
export function unpackBcd(buf: Uint8Array, off: number, digits: number): string {
  let s = '';
  for (let i = 0; i < digits; i++) {
    const b = buf[off + (i >> 1)];
    s += String.fromCharCode(0x30 + (i & 1 ? b & 0x0f : b >> 4));
  }
  return s;
}

export function packBcd(digits: string, buf: Uint8Array, off: number, n: number): void {
  for (let i = 0; i < n; i += 2) {
    const a = digits.charCodeAt(i) & 0x0f;
    const b = i + 1 < n ? digits.charCodeAt(i + 1) & 0x0f : 0;
    buf[off + (i >> 1)] = (a << 4) | b;
  }
}

// ---- calendar (FAND day numbers; 1.1.0001 = 1, proleptic Gregorian like FAND) ----

export function dateToDayNumber(y: number, m: number, d: number): number {
  // Days before year y, then before month m, plus d.
  const leap = (yy: number) => (yy % 4 === 0 && yy % 100 !== 0) || yy % 400 === 0;
  const cum = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const py = y - 1;
  let n = py * 365 + Math.floor(py / 4) - Math.floor(py / 100) + Math.floor(py / 400);
  n += cum[m - 1] + (m > 2 && leap(y) ? 1 : 0) + d;
  return n;
}

export function dayNumberToDate(n: number): { y: number; m: number; d: number } {
  let days = Math.floor(n);
  let y = Math.floor(days / 365.2425) + 1;
  while (dateToDayNumber(y, 1, 1) > days) y--;
  while (dateToDayNumber(y + 1, 1, 1) <= days) y++;
  let m = 12;
  while (dateToDayNumber(y, m, 1) > days) m--;
  return { y, m, d: days - dateToDayNumber(y, m, 1) + 1 };
}
