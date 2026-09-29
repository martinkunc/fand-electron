// UctoExp.exe replacement: the DBF that FAND just exported -> an Excel XLSX next to it.
// Config {AP04}\UctoExp.xml (inputFilename, outputFilename, runAfterDone).
// Spec: docs/helpers/uctoexp.md (original: Jet OLEDB + SpreadsheetLight ImportDataTable).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import type { HelperContext } from './types.ts';
import { findCaseInsensitive, readAppSettings } from './util.ts';
import { readDbf, type DbfTable } from './lib/dbf.ts';

const TITLE = 'UctoExp [1.0.0.1]';

export async function dbfToXlsx(t: DbfTable, outPath: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  ws.addRow(t.fields.map((f) => f.name));
  for (const r of t.rows) ws.addRow(r);
  t.fields.forEach((f, i) => {
    // SpreadsheetLight column styles: every numeric column '#,##0.00', dates 'dd.mm.yyyy'.
    if (f.type === 'N' || f.type === 'F') ws.getColumn(i + 1).numFmt = '#,##0.00';
    if (f.type === 'D') ws.getColumn(i + 1).numFmt = 'dd.mm.yyyy';
  });
  ws.getRow(1).numFmt = '@'; // header stays text
  await wb.xlsx.writeFile(outPath);
}

export async function uctoexp(ctx: HelperContext): Promise<number> {
  const cfgPath = findCaseInsensitive(join(ctx.exeDir, 'UctoExp.xml'));
  const fail = async (msg: string) => {
    await ctx.ui.message(TITLE, `Chyba: ${msg} Aplikace bude ukončena.`, 'error');
    return 1;
  };
  if (!existsSync(cfgPath)) return fail('Soubor se vstupními parametry nebyl nalezen.');
  const cfg = readAppSettings(cfgPath, 852);
  const input = ctx.resolvePath(cfg.get('inputFilename') ?? '');
  const output = ctx.resolvePath(cfg.get('outputFilename') ?? '');
  if (!existsSync(input)) return fail(`Soubor ${cfg.get('inputFilename')} nebyl nalezen.`);
  const t = readDbf(readFileSync(input));
  if (!t.rows.length) return fail('Vstupní DBF soubor neobsahuje žádná data.');
  try {
    await dbfToXlsx(t, output);
  } catch (e) {
    return fail((e as Error).message);
  }
  if (/^true$/i.test(cfg.get('runAfterDone') ?? '')) await ctx.ui.open(output);
  return 0;
}
