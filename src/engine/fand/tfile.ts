// Text/memo files (.T00, .TTT and Účto's .TRO): 512-byte pages, page 0 is a header.
// A text at position Pos is `len:word` followed by the bytes; long texts continue on
// further pages, the last 4 bytes of each page holding the next page position.
// Reference: pas/FILEACC.PAS TFile.RdPrefix / RdWr / Read / Store.

import { openSync, readSync, fstatSync, closeSync, writeSync } from 'node:fs';
import { TpRandom } from './coding.ts';

export const MPAGE_SIZE = 512;
export const MAX_LSTR_LEN = 65000;

export interface TFileHeader {
  signum: number;
  oldMaxPage: number;
  freePart: number;
  irec: number;
  freeRoot: number;
  maxPage: number;
  version: string;
  licenseNr: number; // positions stored in records are shifted by this
  hasCoproc: boolean;
  /** Password 1 (protects chapters) and 2, decoded, without '@' padding. null = random (licensed). */
  password1: string | null;
  password2: string | null;
  time: number;
}

/** Decrypt and parse the 512-byte T-file header (TFile.RdPrefix). */
export function parseTHeader(raw: Uint8Array, fileSize: number, isRdbText: boolean): TFileHeader {
  const t = Uint8Array.from(raw.subarray(0, 512));
  const dv = new DataView(t.buffer);
  const oldMaxPage = dv.getUint16(2, true);
  let freePart = dv.getInt32(4, true);
  let irec = dv.getUint16(11, true);
  let freeRoot = dv.getInt32(13, true);
  let maxPage = dv.getInt32(17, true);
  let ml: number;
  if (oldMaxPage === 0xffff) {
    ml = (maxPage + 1) * MPAGE_SIZE;
  } else {
    freeRoot = 0;
    if (freePart > 0) {
      ml = fileSize;
      maxPage = Math.floor((fileSize - 1) / MPAGE_SIZE);
    } else {
      freePart = -freePart;
      maxPage = oldMaxPage;
      ml = (maxPage + 1) * MPAGE_SIZE;
    }
  }
  const version = String.fromCharCode(...t.subarray(53, 57));
  const hasCoproc = t[27] !== 0;
  let licenseNr = 0;
  if (irec >= 0x6000) {
    irec -= 0x2000;
    if (isRdbText) licenseNr = dv.getUint16(458, true);
  }
  let pw: Uint8Array;
  if (irec >= 0x4000) {
    irec -= 0x4000;
    const rnd = new TpRandom(ml + t[511]);
    for (let i = 13; i <= 510; i++) t[i] ^= rnd.next(255);
    pw = t.subarray(471, 511);
  } else {
    const rnd = new TpRandom(ml);
    for (let i = 13; i <= 52; i++) t[i] ^= rnd.next(255);
    pw = t.subarray(13, 53);
  }
  // PwCode is kept XOR $AA in memory; on disk it is plain '@'-padded text.
  const decodePw = (b: Uint8Array): string | null => {
    let s = '';
    for (const c of b) {
      if (c === 0x40) break;
      if (c < 0x20) return null;
      s += String.fromCharCode(c);
    }
    return s;
  };
  return {
    signum: dv.getUint16(0, true),
    oldMaxPage,
    freePart,
    irec,
    freeRoot,
    maxPage,
    version,
    licenseNr,
    hasCoproc,
    password1: decodePw(pw.subarray(0, 20)),
    password2: decodePw(pw.subarray(20, 40)),
    time: t[511],
  };
}

export class TFile {
  readonly path: string;
  private fd: number;
  header: TFileHeader;
  private size: number;

  constructor(path: string, opts: { isRdbText?: boolean; writable?: boolean } = {}) {
    this.path = path;
    this.fd = openSync(path, opts.writable ? 'r+' : 'r');
    this.size = fstatSync(this.fd).size;
    const hdr = Buffer.alloc(512);
    readSync(this.fd, hdr, 0, 512, 0);
    this.header = parseTHeader(hdr, this.size, !!opts.isRdbText);
  }

  get licenseNr(): number {
    return this.header.licenseNr;
  }

  private get mlen(): number {
    return (this.header.maxPage + 1) * MPAGE_SIZE;
  }

  private readAt(pos: number, n: number): Buffer {
    const b = Buffer.alloc(n);
    readSync(this.fd, b, 0, n, pos);
    return b;
  }

  /** TFile.RdWr (read direction): follow the page chain. */
  private readChain(pos: number, n: number): Uint8Array {
    const out = new Uint8Array(n);
    let o = 0;
    let rest = MPAGE_SIZE - (pos & (MPAGE_SIZE - 1));
    while (n > rest) {
      const l = rest - 4;
      out.set(this.readAt(pos, l), o);
      o += l;
      n -= l;
      const next = this.readAt(pos + l, 4).readInt32LE(0);
      pos = next;
      if (pos < MPAGE_SIZE || pos + MPAGE_SIZE > this.mlen) {
        throw new Error(`${this.path}: broken text chain`);
      }
      rest = MPAGE_SIZE;
    }
    out.set(this.readAt(pos, n), o);
    return out;
  }

  /** TFile.Read: `pos` as stored in the record (licence shift is removed here). */
  read(storedPos: number): Uint8Array {
    const pos = storedPos - this.header.licenseNr;
    if (pos <= 0) return new Uint8Array(0);
    if (pos < MPAGE_SIZE || pos >= this.mlen) throw new Error(`${this.path}: text position ${pos} out of range`);
    let l = this.readAt(pos, 2).readUInt16LE(0);
    if (l > MAX_LSTR_LEN + 1) throw new Error(`${this.path}: bad text length at ${pos}`);
    if (l === MAX_LSTR_LEN + 1) l--;
    return this.readChain(pos + 2, l);
  }

  close(): void {
    closeSync(this.fd);
  }

  // Writing (Store/NewPage/Delete) is implemented with the data layer write path.
  /** @internal */ writeRaw(pos: number, data: Uint8Array): void {
    writeSync(this.fd, data, 0, data.length, pos);
  }
}
