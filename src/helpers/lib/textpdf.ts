// Render a FandDoc to PDF with embedded Liberation Mono (metric-compatible with
// Courier New, full Latin-2), so Czech letters print on every OS.
// Layout follows FANDPDF.PAS: A4, landscape above 96 columns, font size fitted to the
// widest line (4.5..10 pt, or 12 pt like FAND2PDF when it fits), leading 1.18.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { FandDoc, Style } from './fandtext.ts';

// Packaged builds set UCTO_RESOURCES (see src/main/index.ts); in development the repo copy is used.
export const FONT_DIR = process.env.UCTO_RESOURCES ? join(process.env.UCTO_RESOURCES, 'fonts') : join(import.meta.dirname, '../../../resources/fonts');

const A4 = { w: 595.28, h: 841.89 };
const CM = 72 / 2.54;
const COURIER_W = 0.6;
const LEAD = 1.18;
const WIDE_COLS = 96;

export interface RenderOptions {
  /** Maximum font size in points (FAND2PDF uses 12, FANDPDF 10). */
  maxSize?: number;
  minSize?: number;
  margin?: number; // points
  /** UTISK98.INI: width in % of printable area, offsets in cm, bold. */
  widthPercent?: number;
  topCm?: number;
  leftCm?: number;
  forceBold?: boolean;
  title?: string;
  fontDir?: string;
}

export async function renderPdf(doc: FandDoc, o: RenderOptions = {}): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  const dir = o.fontDir ?? FONT_DIR;
  const load = (f: string) => pdf.embedFont(readFileSync(join(dir, f)), { subset: true });
  const fonts = {
    r: await load('LiberationMono-Regular.ttf'),
    b: await load('LiberationMono-Bold.ttf'),
    i: await load('LiberationMono-Italic.ttf'),
    bi: await load('LiberationMono-BoldItalic.ttf'),
  };
  const fontFor = (s: Style): PDFFont => {
    const bold = s.bold || !!o.forceBold;
    return bold && s.italic ? fonts.bi : bold ? fonts.b : s.italic ? fonts.i : fonts.r;
  };

  const cols = Math.max(doc.maxCols + doc.leftMargin, 80);
  const landscape = cols > WIDE_COLS;
  const pw = landscape ? A4.h : A4.w;
  const ph = landscape ? A4.w : A4.h;
  const margin = o.margin ?? 36;
  const avail = (pw - 2 * margin) * ((o.widthPercent ?? 100) / 100);
  const size = Math.max(o.minSize ?? 4.5, Math.min(o.maxSize ?? 10, avail / (cols * COURIER_W)));
  const lead = size * LEAD;
  const x0 = margin + (o.leftCm ?? 0) * CM;
  const top = ph - margin - (o.topCm ?? 0) * CM - size;
  const perPage = doc.pageLength ?? Math.max(1, Math.floor((top - margin) / lead) + 1);

  let page: PDFPage | null = null;
  let lineNo = 0;
  const newPage = () => {
    page = pdf.addPage([pw, ph]);
    lineNo = 0;
  };
  for (const p of doc.pages) {
    newPage();
    for (const line of p.lines) {
      if (lineNo >= perPage) newPage();
      const y = top - lineNo * lead;
      for (const run of line.runs) {
        const font = fontFor(run.style);
        const fs = run.style.compressed ? size * 0.6 : size;
        const hScale = run.style.wide ? 2 : 1;
        const x = x0 + (run.col + doc.leftMargin) * COURIER_W * size;
        // Wide/compressed runs are drawn per character on their own column pitch.
        const step = COURIER_W * size * hScale * (run.style.compressed ? 0.6 : 1);
        const text = run.text;
        if (hScale === 1 && !run.style.compressed) {
          page!.drawText(text, { x, y, size: fs, font });
        } else {
          for (let i = 0; i < text.length; i++) page!.drawText(text[i], { x: x + i * step, y, size: fs, font });
        }
        if (run.style.underline) {
          const w = run.style.compressed || hScale !== 1 ? text.length * step : font.widthOfTextAtSize(text, fs);
          page!.drawLine({ start: { x, y: y - size * 0.15 }, end: { x: x + w, y: y - size * 0.15 }, thickness: size * 0.05, color: rgb(0, 0, 0) });
        }
      }
      lineNo++;
    }
  }
  if (pdf.getPageCount() === 0) newPage();
  pdf.setTitle(o.title ?? 'účto');
  pdf.setCreator('Tichý a spol., účto');
  pdf.setProducer('fand-electron');
  return pdf.save();
}
