import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import iconv from 'iconv-lite';
import { dosToHost } from '../src/helpers/util.ts';
import { runHelperSync } from '../src/helpers/sync.ts';
import type { HelperContext } from '../src/helpers/types.ts';

const noUi = { message: () => {}, confirm: () => true, prompt: () => null, open: () => {}, print: () => true, clipboardRead: () => '', clipboardWrite: () => {}, chooseFile: () => null, secretGet: () => null, secretSet: () => {} };

function ctxFor(app: string, exeDir: string, fetchImpl: typeof fetch, messages: string[]): HelperContext {
  return {
    name: 'uctoexp.exe', exeDir, cwd: app, args: [], appDir: join(app),
    resolvePath: (p) => dosToHost(p, app, app),
    ui: { message: async (_t, x) => { messages.push(x); }, confirm: async () => true, prompt: async () => null, open: async () => {}, print: async () => true, clipboardRead: async () => '', clipboardWrite: async () => {}, chooseFile: async () => null, secretGet: async () => null, secretSet: async () => {} },
    fetch: fetchImpl, now: () => new Date(2026, 8, 28, 10, 5), env: {},
  };
}

// Ares2 and Nepl2 are no longer ported: the originals run under Mono (test/helpers-mono.test.ts).
describe('helper worker', () => {
  it('runs a port synchronously from the engine thread and serves its UI', () => {
    const app = mkdtempSync(join(tmpdir(), 'ucto-'));
    mkdirSync(join(app, '{tisk}'));
    const shown: string[] = [];
    const code = runHelperSync({ exePath: join(app, '{tisk}', 'FAND2PDF.EXE'), args: [], cwd: app, appDir: app }, { ...noUi, message: (_t, x) => shown.push(x) });
    expect(code).toBe(1);
    expect(shown.join()).toContain('Chybné parametry');
    expect(runHelperSync({ exePath: join(app, 'NOPE.EXE'), args: [], cwd: app, appDir: app }, noUi)).toBeNull();
  });
});

import ExcelJS from 'exceljs';
import { uctoexp } from '../src/helpers/uctoexp.ts';
import { readDbf } from '../src/helpers/lib/dbf.ts';

/** dBASE III as FAND's WrDBaseHd writes it (CP852 names and text, no language driver). */
function fandDbf(fields: [string, string, number, number][], rows: string[][]): Buffer {
  const hdrLen = 32 + fields.length * 32 + 1;
  const recLen = 1 + fields.reduce((s, f) => s + f[2], 0);
  const b = Buffer.alloc(hdrLen + rows.length * recLen + 1, 0x20);
  b.fill(0, 0, hdrLen);
  b[0] = 0x03; b[1] = 126; b[2] = 9; b[3] = 28;
  b.writeUInt32LE(rows.length, 4); b.writeUInt16LE(hdrLen, 8); b.writeUInt16LE(recLen, 10);
  fields.forEach(([n, t, l, d], i) => {
    iconv.encode(n, 'cp852').copy(b, 32 + i * 32);
    b[32 + i * 32 + 11] = t.charCodeAt(0); b[32 + i * 32 + 16] = l; b[32 + i * 32 + 17] = d;
  });
  b[hdrLen - 1] = 0x0d;
  rows.forEach((r, ri) => {
    let p = hdrLen + ri * recLen + 1;
    r.forEach((v, i) => { const [, t, l] = fields[i]; const s = t === 'N' ? v.padStart(l) : v.padEnd(l); iconv.encode(s, 'cp852').copy(b, p); p += l; });
  });
  b[b.length - 1] = 0x1a;
  return b;
}

describe('UctoExp replacement', () => {
  const fields: [string, string, number, number][] = [['CISLO', 'N', 5, 0], ['FIRMA', 'C', 30, 0], ['DATUMPOř', 'D', 8, 0], ['ČÁSTKA', 'N', 12, 2], ['PLATDPH', 'L', 1, 0]];
  const dbf = fandDbf(fields, [['1', 'Škoda Auto a.s.', '20260928', '1234.50', 'T'], ['2', 'Žluťoučký kůň', '', '-5.00', 'F']]);
  it('reads FAND DBF values with CP852 text', () => {
    const t = readDbf(dbf);
    expect(t.fields.map((f) => f.name)).toEqual(['CISLO', 'FIRMA', 'DATUMPOř', 'ČÁSTKA', 'PLATDPH']);
    expect(t.rows[0]).toEqual([1, 'Škoda Auto a.s.', new Date(Date.UTC(2026, 8, 28)), 1234.5, true]);
    expect(t.rows[1]).toEqual([2, 'Žluťoučký kůň', null, -5, false]);
  });
  it('writes the XLSX named in UctoExp.xml with number/date formats', async () => {
    const app = mkdtempSync(join(tmpdir(), 'ucto-'));
    const ap04 = join(app, '{ap04}'); mkdirSync(ap04); mkdirSync(join(app, '{prik}'));
    writeFileSync(join(app, '{prik}', 'ADRESY.DBF'), dbf);
    const name = app.split('/').pop();
    writeFileSync(join(ap04, 'UctoExp.xml'), iconv.encode(`<?xml version="1.0" encoding="utf-8" ?><configuration><appSettings><add key="inputFilename" value="C:\\${name}\\{PRIK}\\ADRESY.DBF"/><add key="outputFilename" value="C:\\${name}\\{PRIK}\\ADRESY.XLSX"/><add key="runAfterDone" value="false"/></appSettings></configuration>`, 'cp852'));
    expect(await uctoexp({ ...ctxFor(app, ap04, fetch, []), resolvePath: (p) => dosToHost(p, app, app) })).toBe(0);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(join(app, '{prik}', 'ADRESY.XLSX'));
    const ws = wb.getWorksheet('Sheet1')!;
    expect(ws.getRow(1).values).toEqual([undefined, 'CISLO', 'FIRMA', 'DATUMPOř', 'ČÁSTKA', 'PLATDPH']);
    expect(ws.getCell('B2').value).toBe('Škoda Auto a.s.');
    expect(ws.getCell('D2').value).toBe(1234.5);
    expect(ws.getColumn(4).numFmt).toBe('#,##0.00');
    expect(ws.getColumn(3).numFmt).toBe('dd.mm.yyyy');
  });
});
