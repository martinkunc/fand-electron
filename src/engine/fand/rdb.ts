// Project catalogs (.RDB + .TTT; Účto also uses .PRO + .TRO for sub-projects).
// The RDB is an ordinary FAND data file; each record is one chapter (kapitola),
// declared in fandres/FANDMSG.TXT message 51:
//   TxtPos:F,4.0; Overit:B; StText:T; Typ:A,1; Nazev:A,12; Text:T
// Reference: pas/PROJMGR.PAS, pas/PROJMGR1.PAS, pas/LEXANAL.PAS (SetInpTTPos).

import { existsSync } from 'node:fs';
import { DataFile } from './datafile.ts';
import { TFile } from './tfile.ts';
import { xDecode, xorAA } from './coding.ts';
import { decode852 } from '../console/cp852.ts';
import { readFix } from './numbers.ts';

export type ChapterType = 'F' | 'D' | 'P' | 'E' | 'R' | 'M' | 'U' | 'L' | 'I' | ' ' | string;

export interface Chapter {
  recNr: number;
  typ: ChapterType;
  name: string;
  txtPos: number; // cursor position inside the text (editor state)
  verify: boolean;
  stTextPos: number; // compiled FD segment (F chapters) or 0
  textPos: number;
}

export const CHAPTER_TYPE_NAMES: Record<string, string> = {
  F: 'file declaration',
  D: 'declarations',
  P: 'procedure',
  E: 'edit form',
  R: 'report',
  M: 'merge',
  U: 'user/passwords',
  L: 'Prolog',
  I: 'comment',
  ' ': 'comment',
};

export class Rdb {
  readonly rdbPath: string;
  readonly tttPath: string;
  readonly chapters: Chapter[] = [];
  readonly tfile: TFile;
  /** Texts are encoded when password 1 is set (licensed files always have one). */
  readonly encrypted: boolean;

  constructor(rdbPath: string, tttPath?: string) {
    this.rdbPath = rdbPath;
    this.tttPath = tttPath ?? Rdb.textPathFor(rdbPath);
    const df = new DataFile(rdbPath);
    try {
      if (df.recLen !== 24) throw new Error(`${rdbPath}: not a FAND project (record length ${df.recLen})`);
      for (const { recNr, rec } of df.records()) {
        const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
        this.chapters.push({
          recNr,
          txtPos: readFix(rec, 0, 2),
          verify: rec[2] !== 0 && rec[2] !== 0xff,
          stTextPos: dv.getInt32(3, true),
          typ: String.fromCharCode(rec[7]),
          name: decode852(rec.subarray(8, 20)).trimEnd(),
          textPos: dv.getInt32(20, true),
        });
      }
    } finally {
      df.close();
    }
    this.tfile = new TFile(this.tttPath, { isRdbText: true });
    this.encrypted = this.tfile.header.password1 !== '';
  }

  static textPathFor(rdbPath: string): string {
    const m = /\.(\w+)$/.exec(rdbPath);
    const ext = m ? m[1] : '';
    // .RDB -> .TTT; otherwise the first extension letter becomes 'T' (.PRO -> .TRO, .000 -> .T00).
    const tExt = /^rdb$/i.test(ext) ? 'TTT' : 'T' + ext.slice(1);
    const cand = rdbPath.slice(0, rdbPath.length - ext.length) + tExt;
    if (existsSync(cand)) return cand;
    const lower = rdbPath.slice(0, rdbPath.length - ext.length) + tExt.toLowerCase();
    return existsSync(lower) ? lower : cand;
  }

  /** Raw (still encoded) chapter text bytes. */
  rawText(ch: Chapter): Uint8Array {
    return this.tfile.read(ch.textPos);
  }

  /** Decoded chapter source text bytes (CP852, CR LF line ends). */
  textBytes(ch: Chapter): Uint8Array {
    const raw = this.rawText(ch);
    if (!this.encrypted || raw.length === 0) return raw;
    return this.tfile.licenseNr === 0 ? xorAA(raw) : xDecode(raw);
  }

  /** Decoded chapter source as a Unicode string with \n line ends. */
  text(ch: Chapter): string {
    return decode852(this.textBytes(ch), true).replace(/\r\n?/g, '\n');
  }

  close(): void {
    this.tfile.close();
  }
}
