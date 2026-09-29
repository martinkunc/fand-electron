import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { PDFDocument, PDFDict, PDFName } from 'pdf-lib';
import { parseFandText } from '../src/helpers/lib/fandtext.ts';
import { renderPdf } from '../src/helpers/lib/textpdf.ts';
import { parseParam, fand2pdf } from '../src/helpers/fand2pdf.ts';
import { parseUtiskIni, utisk04 } from '../src/helpers/utisk04.ts';
import { dosToHost } from '../src/helpers/util.ts';
import type { HelperContext } from '../src/helpers/types.ts';

const cp852 = (s: string) => iconv.encode(s, 'cp852');
const SPOOL = Buffer.concat([
  cp852('.po 5\r\n.ti 2\r\n.he nevypisuje se\r\n'),
  cp852('KNIHA DOKLADŮ\r\n'),
  cp852('Příjem '), Buffer.from([0x02]), cp852('tučně'), Buffer.from([0x02]), cp852(' konec\r\n'),
  Buffer.from([0x10, 0x03, 0x00, 0x1b, 0x45, 0x00]), cp852('za binárním během\r\n'),
  Buffer.from([0x0c]), cp852('druhá strana\r\n'), Buffer.from([0x0c]),
]);

describe('FAND print text parser', () => {
  it('reads dot commands, styles, binary runs and form feeds', () => {
    const d = parseFandText(SPOOL);
    expect(d.leftMargin).toBe(5);
    expect(d.copies).toBe(2);
    expect(d.pages.length).toBe(2);
    const [l1, l2, l3] = d.pages[0].lines;
    expect(l1.runs[0].text).toBe('KNIHA DOKLADŮ');
    expect(l2.runs.map((r) => [r.text, r.col, r.style.bold])).toEqual([['Příjem ', 0, false], ['tučně', 7, true], [' konec', 12, false]]);
    expect(l3.runs[0].text).toBe('za binárním během');
    expect(d.pages[1].lines[0].runs[0].text).toBe('druhá strana');
  });

  it('renders a PDF with embedded fonts and one page per form feed', async () => {
    const bytes = await renderPdf(parseFandText(SPOOL));
    const pdf = await PDFDocument.load(bytes);
    expect(pdf.getPageCount()).toBe(2);
    const embedded = pdf.context.enumerateIndirectObjects().some(([, o]) => o instanceof PDFDict && o.has(PDFName.of('FontFile2')));
    expect(embedded).toBe(true);
  });

  it('switches to landscape for wide reports', async () => {
    const pdf = await PDFDocument.load(await renderPdf(parseFandText(cp852('x'.repeat(132) + '\r\n'))));
    const { width, height } = pdf.getPage(0).getSize();
    expect(width).toBeGreaterThan(height);
  });
});

function ctx(app: string, exeDir: string, args: string[], rec: { opened: string[]; printed: { path: string; dialog: boolean; copies: number }[] }): HelperContext {
  return {
    name: 'x', exeDir, cwd: app, args, appDir: app,
    resolvePath: (p) => dosToHost(p, app, app),
    ui: {
      message: async () => {}, confirm: async () => true, prompt: async () => null,
      open: async (t) => { rec.opened.push(t); },
      print: async (p, o) => { rec.printed.push({ path: p, ...o }); return true; },
      clipboardRead: async () => '', clipboardWrite: async () => {}, chooseFile: async () => null, secretGet: async () => null, secretSet: async () => {},
    },
    fetch, now: () => new Date(), env: {},
  };
}

describe('FAND2PDF replacement', () => {
  it('parses the param line with spaces and the open flag', () => {
    expect(parseParam('C:\\A B\\UCTOTXT.UUU,+C:\\X\\SEST01.PDF\r\n')).toEqual({ input: 'C:\\A B\\UCTOTXT.UUU', output: 'C:\\X\\SEST01.PDF', open: true });
    expect(parseParam('a.txt,b.pdf')!.open).toBe(false);
  });
  it('converts the text and opens the PDF', async () => {
    const app = mkdtempSync(join(tmpdir(), 'ucto-'));
    mkdirSync(join(app, '{tisk}'));
    writeFileSync(join(app, 'UCTOTXT.UUU'), SPOOL);
    writeFileSync(join(app, 'UCTOTXT2.UUU'), cp852('UCTOTXT.UUU,+SEST01.PDF\r\n'));
    const rec = { opened: [] as string[], printed: [] };
    expect(await fand2pdf(ctx(app, join(app, '{tisk}'), ['$', 'UCTOTXT2.UUU'], rec))).toBe(0);
    expect(existsSync(join(app, 'SEST01.PDF'))).toBe(true);
    expect(rec.opened).toEqual([join(app, 'SEST01.PDF')]);
  });
});

describe('UTISK04 replacement', () => {
  it('reads UTISK98.INI with FAND empty-zero fields and defaults', () => {
    expect(parseUtiskIni('98,0.42,,,\r\n')).toEqual({ width: 98, top: 0.42, left: 0, bold: false, choose: false });
    expect(parseUtiskIni('')).toEqual({ width: 98, top: 0, left: 0, bold: false, choose: false });
    expect(parseUtiskIni('200,1,0.5,1,1').width).toBe(98);
  });
  it('prints the spool file with the copies from .ti and deletes it', async () => {
    const app = mkdtempSync(join(tmpdir(), 'ucto-'));
    const tisk = join(app, '{tisk}');
    mkdirSync(tisk);
    writeFileSync(join(tisk, 'UTISK98.INI'), '98,0.42,,,1\r\n');
    writeFileSync(join(tisk, 'PRINT1.PRN'), SPOOL);
    const rec = { opened: [] as string[], printed: [] as { path: string; dialog: boolean; copies: number }[] };
    expect(await utisk04(ctx(app, tisk, ['$', '{tisk}\\PRINT1.PRN'], rec))).toBe(0);
    expect(rec.printed[0].copies).toBe(2);
    expect(rec.printed[0].dialog).toBe(true);
    expect((await PDFDocument.load(readFileSync(rec.printed[0].path))).getPageCount()).toBe(2);
    expect(existsSync(join(tisk, 'PRINT1.PRN'))).toBe(false);
  });
});
