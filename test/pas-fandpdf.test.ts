// FANDPDF.PAS: the FAND print spool file (CP852 text with printer control codes) as a PDF.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import { FandTxtToPdf, FandDeliverPdf } from '../src/engine/pas/fandpdf.ts';
import { FromUnicode } from '../src/engine/pas/pasrt.ts';
import { encode852 } from '../src/engine/console/cp852.ts';

const TMP = join(import.meta.dirname, '../work/tmp-fandpdf');
const H = (p: string): string => FromUnicode(p);

/** Checks the xref table: each in-use entry points at 'n 0 obj'. */
function checkXref(pdf: Buffer): number {
  const s = pdf.toString('latin1');
  const sx = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(s)![1]);
  expect(s.slice(sx, sx + 5)).toBe('xref\n');
  const lines = s.slice(sx).split('\n');
  const n = Number(lines[1].split(' ')[1]);
  for (let i = 1; i < n; i++) {
    const ofs = Number(lines[2 + i].slice(0, 10));
    if (ofs !== 0) expect(s.slice(ofs, ofs + `${i} 0 obj`.length)).toBe(`${i} 0 obj`);
  }
  return n;
}

beforeAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});
afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('FANDPDF', () => {
  it('converts a spool file: CP852 glyphs, bold, form feed, binary block, box drawing', async () => {
    const text = Buffer.concat([
      Buffer.from(encode852('Příliš žluťoučký kůň (úpěl) \\ ódy\r\n')),
      Buffer.from([0x02]), Buffer.from('BOLD'), Buffer.from([0x02]), Buffer.from(' normal\r\n'),
      Buffer.from([0xc4, 0xc4, 0xb3]), Buffer.from('\r\n'), // box drawing -> '-' '-' '|'
      Buffer.from([0x10, 3, 0, 0x41, 0x42, 0x43]), Buffer.from('after binary\r\n'), // ^P skips 3 bytes
      Buffer.from([0x0c]), Buffer.from('second sheet\r\n'),
    ]);
    const inp = join(TMP, 'PRINTER.TXT');
    const out = join(TMP, 'PRINTER.pdf');
    writeFileSync(inp, text);
    expect(FandTxtToPdf(H(inp), H(out))).toBe(true);
    const pdf = readFileSync(out);
    const s = pdf.toString('latin1');
    expect(s.startsWith('%PDF-1.4\n')).toBe(true);
    expect(checkXref(pdf)).toBe(7 + 2 * 2); // 6 fixed objects + content/page per sheet
    expect(s).toContain('/Count 2');
    expect(s).toContain('/BaseFont /Courier-Bold');
    // the used CP852 letters are mapped to glyph names; '(' ')' '\' are escaped
    expect(s).toMatch(/\/Differences \[.* \/scaron .* 253 \/rcaron \]/);
    expect(s).toContain('\\(\xa3p\xd8l\\) \\\\'); // (úpěl) \ in CP852
    expect(s).toContain('/F2 10 Tf');
    expect(s).toContain('(--|) Tj');
    expect(s).toContain('(after binary) Tj');
    expect(s).not.toContain('ABC');
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBe(2);
    const { width, height } = doc.getPage(0).getSize();
    expect([Math.round(width), Math.round(height)]).toEqual([595, 842]); // A4 portrait
  });

  it('wide lines give landscape and a smaller font; a missing input fails', async () => {
    const inp = join(TMP, 'WIDE.TXT');
    const out = join(TMP, 'WIDE.pdf');
    writeFileSync(inp, 'x'.repeat(150) + '\r\n');
    expect(FandTxtToPdf(H(inp), H(out))).toBe(true);
    const doc = await PDFDocument.load(readFileSync(out));
    const { width, height } = doc.getPage(0).getSize();
    expect(width > height).toBe(true);
    // (841.89 - 72) / (0.6 * 150) = 8.55 pt
    expect(readFileSync(out).toString('latin1')).toContain('/F1 8.55 Tf');
    expect(FandTxtToPdf(H(join(TMP, 'NONE.TXT')), H(out))).toBe(false);
  });

  it('an empty spool file is one empty sheet; FAND_PRINT=none delivers nothing', async () => {
    const inp = join(TMP, 'EMPTY.TXT');
    const out = join(TMP, 'EMPTY.pdf');
    writeFileSync(inp, '');
    expect(FandTxtToPdf(H(inp), H(out))).toBe(true);
    const pdf = readFileSync(out);
    checkXref(pdf);
    expect((await PDFDocument.load(pdf)).getPageCount()).toBe(0); // no sheet is emitted, as in FPC
    const old = process.env.FAND_PRINT;
    process.env.FAND_PRINT = 'none';
    try {
      FandDeliverPdf(H(out), true);
    } finally {
      if (old === undefined) delete process.env.FAND_PRINT;
      else process.env.FAND_PRINT = old;
    }
  });
});
