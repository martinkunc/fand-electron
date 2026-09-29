// FAND data files (.000 and any extension): 6-byte header `NRecs:longint; RecLen:word`
// followed by fixed-length records. NRecs < 0 marks an indexed ('X') file whose records
// start with a 1-byte deleted flag. '8' files use a 4-byte header (word, word).
// Reference: pas/FILEACC.PAS RdPrefix / WrPrefix.

import { openSync, readSync, writeSync, fstatSync, closeSync } from 'node:fs';

export type FileKind = '0' | 'X' | '8';

export class DataFile {
  readonly path: string;
  private fd: number;
  kind: FileKind;
  nRecs: number;
  recLen: number;
  frstDispl: number;

  constructor(path: string, opts: { writable?: boolean; kind8?: boolean } = {}) {
    this.path = path;
    this.fd = openSync(path, opts.writable ? 'r+' : 'r');
    const h = Buffer.alloc(6);
    readSync(this.fd, h, 0, 6, 0);
    if (opts.kind8) {
      this.kind = '8';
      this.nRecs = h.readUInt16LE(0);
      this.recLen = h.readUInt16LE(2);
      this.frstDispl = 4;
    } else {
      const n = h.readInt32LE(0);
      this.kind = n < 0 ? 'X' : '0';
      this.nRecs = Math.abs(n);
      this.recLen = h.readUInt16LE(4);
      this.frstDispl = 6;
    }
  }

  get fileSize(): number {
    return fstatSync(this.fd).size;
  }

  /** Read record n (1-based like FAND's RecNr). */
  readRecord(n: number): Uint8Array {
    if (n < 1 || n > this.nRecs) throw new RangeError(`${this.path}: record ${n} of ${this.nRecs}`);
    const b = Buffer.alloc(this.recLen);
    readSync(this.fd, b, 0, this.recLen, this.frstDispl + (n - 1) * this.recLen);
    return b;
  }

  writeRecord(n: number, rec: Uint8Array): void {
    writeSync(this.fd, rec, 0, this.recLen, this.frstDispl + (n - 1) * this.recLen);
  }

  isDeleted(rec: Uint8Array): boolean {
    return this.kind === 'X' && rec[0] !== 0;
  }

  *records(): Generator<{ recNr: number; rec: Uint8Array }> {
    for (let i = 1; i <= this.nRecs; i++) yield { recNr: i, rec: this.readRecord(i) };
  }

  writeHeader(): void {
    const h = Buffer.alloc(this.frstDispl);
    if (this.kind === '8') {
      h.writeUInt16LE(this.nRecs, 0);
      h.writeUInt16LE(this.recLen, 2);
    } else {
      h.writeInt32LE(this.kind === 'X' ? -this.nRecs : this.nRecs, 0);
      h.writeUInt16LE(this.recLen, 4);
    }
    writeSync(this.fd, h, 0, h.length, 0);
  }

  close(): void {
    closeSync(this.fd);
  }
}
