// UTISK04.EXE ("ÚčtoTisk3") replacement: print a FAND spool file on the OS printer.
// Called as `$ <spool file>` by the FAND.CFG print-manager printer "Windows3" and the
// text viewer. Settings: UTISK98.INI (one CSV record Šířka,Shora,Zleva,Tučně,Volba).
// The text is rendered to PDF and handed to the host print service; the spool file is
// deleted afterwards like the original. Spec: docs/helpers/utisk04.md, print-spool.md.

import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { HelperContext } from './types.ts';
import { findCaseInsensitive } from './util.ts';
import { parseFandText } from './lib/fandtext.ts';
import { renderPdf } from './lib/textpdf.ts';

export interface UtiskIni {
  width: number; // Šířka %, 30..150, default 98
  top: number; // Shora cm, default 0.42
  left: number; // Zleva cm
  bold: boolean; // Tučně
  choose: boolean; // Volba: show printer dialog
}

export function parseUtiskIni(text: string): UtiskIni {
  const f = text.split(/\r?\n/)[0].split(',').map((s) => s.trim());
  const num = (s: string | undefined, def: number) => (s === undefined || s === '' ? def : Number(s.replace(',', '.')));
  let width = num(f[0], 0);
  if (!(width >= 30 && width <= 150)) width = 98;
  let top = num(f[1], 0);
  if (!(top >= 0)) top = 0.42;
  let left = num(f[2], 0);
  if (!(left >= 0)) left = 0;
  return { width, top, left, bold: num(f[3], 0) === 1, choose: num(f[4], 0) === 1 };
}

export async function utisk04(ctx: HelperContext, opts: { forceDialog?: boolean } = {}): Promise<number> {
  if (ctx.args[0] !== '$' || !ctx.args[1]) {
    await ctx.ui.message('ÚčtoTisk', 'Pro tisk z programu ÚČTO.', 'info');
    return 1;
  }
  const spool = ctx.resolvePath(ctx.args[1]);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(spool);
  } catch {
    await ctx.ui.message('ÚčtoTisk', `Nemohu otevřít soubor ${ctx.args[1]}`, 'error');
    return 1;
  }
  const iniPath = findCaseInsensitive(join(ctx.exeDir, 'UTISK98.INI'));
  const ini = parseUtiskIni(existsSync(iniPath) ? readFileSync(iniPath, 'latin1') : '98,0.42,,,');
  const doc = parseFandText(bytes);
  const pdf = await renderPdf(doc, { widthPercent: ini.width, topCm: ini.top, leftCm: ini.left, forceBold: ini.bold, margin: 18 });
  const pdfPath = join(tmpdir(), `ucto-tisk-${process.pid}-${Date.now()}.pdf`);
  writeFileSync(pdfPath, pdf);
  const ok = await ctx.ui.print(pdfPath, { dialog: ini.choose || !!opts.forceDialog, copies: doc.copies });
  if (!ok) {
    await ctx.ui.message('ÚčtoTisk', 'Tisk zrušen.', 'info');
    return 1;
  }
  try {
    unlinkSync(spool);
  } catch {
    // "Nemohu zrušit soubor" – not fatal
  }
  return 0;
}
