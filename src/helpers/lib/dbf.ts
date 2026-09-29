// Minimal dBASE III reader for the DBF files FAND writes (WrDBaseHd, FILEACC.PAS):
// 32-byte header, 32-byte field descriptors, 0x0D, fixed-length records, 0x1A.
// Text is CP852 (FAND's code page); the language-driver byte is 0.

import iconv from 'iconv-lite';

export interface DbfField {
  name: string;
  type: 'C' | 'N' | 'D' | 'L' | 'M' | string;
  length: number;
  decimals: number;
}

export type DbfValue = string | number | Date | boolean | null;

export interface DbfTable {
  fields: DbfField[];
  rows: DbfValue[][];
}

export function readDbf(buf: Uint8Array, codepage = 'cp852'): DbfTable {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength);
  const nRecs = b.readUInt32LE(4);
  const hdrLen = b.readUInt16LE(8);
  const recLen = b.readUInt16LE(10);
  const fields: DbfField[] = [];
  for (let off = 32; off + 32 <= hdrLen && b[off] !== 0x0d; off += 32) {
    const nameEnd = b.indexOf(0, off);
    fields.push({
      name: iconv.decode(b.subarray(off, Math.min(nameEnd < 0 ? off + 11 : nameEnd, off + 11)), codepage),
      type: String.fromCharCode(b[off + 11]),
      length: b[off + 16],
      decimals: b[off + 17],
    });
  }
  const rows: DbfValue[][] = [];
  for (let r = 0; r < nRecs; r++) {
    const base = hdrLen + r * recLen;
    if (base + recLen > b.length) break;
    if (b[base] === 0x2a) continue; // deleted
    let p = base + 1;
    const row: DbfValue[] = [];
    for (const f of fields) {
      const raw = b.subarray(p, p + f.length);
      p += f.length;
      row.push(decodeValue(f, raw, codepage));
    }
    rows.push(row);
  }
  return { fields, rows };
}

function decodeValue(f: DbfField, raw: Buffer, codepage: string): DbfValue {
  const s = iconv.decode(raw, codepage);
  switch (f.type) {
    case 'C':
      return s.trimEnd();
    case 'N':
    case 'F': {
      const t = s.trim();
      if (!t || /^\*+$/.test(t)) return null;
      const n = Number(t.replace(',', '.'));
      return Number.isFinite(n) ? n : null;
    }
    case 'D': {
      const m = /^(\d{4})(\d{2})(\d{2})$/.exec(s.trim());
      return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
    }
    case 'L': {
      const c = s.trim().toUpperCase();
      return c === '' || c === '?' ? null : 'YT'.includes(c);
    }
    default:
      return s.trimEnd() || null; // M: block pointer only (memo text lives in .DBT/.FPT)
  }
}
