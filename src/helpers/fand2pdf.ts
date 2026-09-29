// FAND2PDF.EXE replacement: `$ <param file>`; the param file holds one line
// `<input txt>,[+]<output pdf>` (CP852); '+' = open the PDF afterwards.
// Spec: docs/helpers/fand2pdf.md.

import { readFileSync, writeFileSync } from 'node:fs';
import type { HelperContext } from './types.ts';
import { decodeCp } from './util.ts';
import { parseFandText } from './lib/fandtext.ts';
import { renderPdf } from './lib/textpdf.ts';

export function parseParam(line: string): { input: string; output: string; open: boolean } | null {
  const l = line.replace(/[\r\n\x1a]+$/g, '').split(/\r?\n/)[0];
  const i = l.indexOf(',');
  if (i < 0) return null;
  let output = l.slice(i + 1).trim();
  const open = output.startsWith('+');
  if (open) output = output.slice(1);
  return { input: l.slice(0, i).trim(), output, open };
}

export async function fand2pdf(ctx: HelperContext): Promise<number> {
  const param = ctx.args[0] === '$' && ctx.args[1] ? parseParam(decodeCp(readFileSync(ctx.resolvePath(ctx.args[1])), 852)) : null;
  if (!param) {
    await ctx.ui.message('FAND2PDF', 'Chybné parametry.', 'error');
    return 1;
  }
  let src: Uint8Array;
  try {
    src = readFileSync(ctx.resolvePath(param.input));
  } catch {
    await ctx.ui.message('FAND2PDF', 'Nelze otevřít FAND soubor.', 'error');
    return 1;
  }
  const out = ctx.resolvePath(param.output);
  try {
    // FAND2PDF.EXE used 12 pt Courier; keep that size when the text fits.
    writeFileSync(out, await renderPdf(parseFandText(src), { maxSize: 12 }));
  } catch {
    await ctx.ui.message('FAND2PDF', 'Nelze otevřít PDF soubor.', 'error');
    return 1;
  }
  if (param.open) await ctx.ui.open(out);
  return 0;
}
