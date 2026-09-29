// PAS: FANDPDF.PAS (FPC-only unit) – FAND print output (CP852 + printer control codes) to PDF.
//
// Porting notes:
// * Used by PRINTTXT: the spool file (PRINTER.TXT) becomes '<name>.pdf' and FandDeliverPdf hands
//   it to the host. No asm/DOS. The FPC port writes a minimal PDF 1.4 itself: A4 (landscape when
//   the longest line exceeds WideCols=96), Courier / Courier-Bold (Base14) with a WinAnsi
//   /Differences encoding mapping the used CP852 bytes $80..$FF to glyph names (private Glyphs
//   table; entries with F<>0, e.g. box drawing, are first replaced by byte F = '#' or '?'),
//   36 pt margins, font size fitted to the longest line (4.5..10 pt), leading 1.18. In the text:
//   ^L new sheet, ^B toggles bold, ^P <lo><hi> skips a binary block, CR LF, LF or a lone CR end a
//   line, other control chars (style codes) are dropped.
//   Walk(Emit=false) runs twice (measure, then count sheets) before Walk(Emit=true).
// * Private helpers: TBuf growable byte buffer (BufInit/BufNeed/BufByte/BufRaw/BufS/BufI/BufN
//   (Str(v:0:2) with trailing zeros cut)/BufPdfStr (escapes '(' ')' '\')). Here TBuf is a class
//   around a growing Uint8Array; the PDF bytes are written with node:fs (path via ToUnicode).
// * FandDeliverPdf (UNIX): FAND_PRINT env = 'none' | 'lpr' (FAND_PRINTER -> '-P') | else open
//   with xdg-open (macOS 'open'); default 'open' when WantOpen, else 'none'. TS: with a host attached
//   (the Electron app, src/engine/hostbridge.ts) 'open' asks the host to open the file
//   (shell.openPath); headless it runs the FPC command. Commands get argument arrays (no shell),
//   which replaces the FPC ShQ quoting.
// * No state, no unit initialization.

import * as fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { StrI, StrR, GetEnv, ToUnicode } from './pasrt.ts';
import { hostCall } from '../hostbridge.ts';

const MarginPt = 36.0;
const CourierW = 0.6;
const MaxSizePt = 10.0;
const MinSizePt = 4.5;
const LeadFactor = 1.18;
const WideCols = 96;
const A4w = 595.28;
const A4h = 841.89;
const cFF = 0x0c;
const cBold = 0x02;
const cBin = 0x10;

// PAS: FANDPDF.PAS TGlyph
interface TGlyph {
  G: string;
  F: number;
}
const g = (G: string): TGlyph => ({ G, F: 0 });
const f = (F: number): TGlyph => ({ G: '', F });
// PAS: FANDPDF.PAS Glyphs – array[$80..$FF]: index b-$80
const Glyphs: TGlyph[] = [
  g('Ccedilla'), g('udieresis'), g('eacute'), g('acircumflex'), g('adieresis'), g('uring'), g('cacute'), g('ccedilla'),
  g('lslash'), g('edieresis'), g('Ohungarumlaut'), g('ohungarumlaut'), g('icircumflex'), g('Zacute'), g('Adieresis'), g('Cacute'),
  g('Eacute'), g('Lacute'), g('lacute'), g('ocircumflex'), g('odieresis'), g('Lcaron'), g('lcaron'), g('Sacute'),
  g('sacute'), g('Odieresis'), g('Udieresis'), g('Tcaron'), g('tcaron'), g('Lslash'), g('multiply'), g('ccaron'),
  g('aacute'), g('iacute'), g('oacute'), g('uacute'), g('Aogonek'), g('aogonek'), g('Zcaron'), g('zcaron'),
  g('Eogonek'), g('eogonek'), g('logicalnot'), g('zacute'), g('Ccaron'), g('scedilla'), g('guillemotleft'), g('guillemotright'),
  f(46), f(58), f(35), f(124), f(43), g('Aacute'), g('Acircumflex'), g('Ecaron'),
  g('Scedilla'), f(43), f(124), f(43), f(43), g('Zdotaccent'), g('zdotaccent'), f(43),
  f(43), f(43), f(43), f(43), f(45), f(43), g('Abreve'), g('abreve'),
  f(43), f(43), f(43), f(43), f(43), f(61), f(43), g('currency'),
  g('dcroat'), g('Dcroat'), g('Dcaron'), g('Edieresis'), g('dcaron'), g('Ncaron'), g('Iacute'), g('Icircumflex'),
  g('ecaron'), f(43), f(43), f(35), f(95), g('Tcommaaccent'), g('Uring'), f(126),
  g('Oacute'), g('germandbls'), g('Ocircumflex'), g('Nacute'), g('nacute'), g('ncaron'), g('Scaron'), g('scaron'),
  g('Racute'), g('Uacute'), g('racute'), g('Uhungarumlaut'), g('yacute'), g('Yacute'), g('tcommaaccent'), f(63),
  g('hyphen'), f(63), f(63), f(63), f(63), g('section'), g('divide'), f(63),
  g('degree'), f(63), f(63), g('uhungarumlaut'), g('Rcaron'), g('rcaron'), f(35), f(63),
];
const glyph = (b: number): TGlyph => Glyphs[b - 0x80];

// PAS: FANDPDF.PAS TBuf (+ BufInit/BufNeed/BufByte/BufRaw/BufS/BufI/BufN/BufPdfStr)
class TBuf {
  P = new Uint8Array(0);
  Len = 0;
  // PAS: FANDPDF.PAS BufNeed
  Need(n: number): void {
    if (this.Len + n <= this.P.length) return;
    let c = this.P.length;
    if (c === 0) c = 8192;
    while (c < this.Len + n) c *= 2;
    const q = new Uint8Array(c);
    q.set(this.P.subarray(0, this.Len));
    this.P = q;
  }
  // PAS: FANDPDF.PAS BufByte
  Byte(v: number): void {
    this.Need(1);
    this.P[this.Len++] = v;
  }
  // PAS: FANDPDF.PAS BufRaw
  Raw(src: Uint8Array): void {
    if (src.length <= 0) return;
    this.Need(src.length);
    this.P.set(src, this.Len);
    this.Len += src.length;
  }
  // PAS: FANDPDF.PAS BufS – s is a byte string
  S(s: string): void {
    this.Need(s.length);
    for (let i = 0; i < s.length; i++) this.P[this.Len++] = s.charCodeAt(i) & 0xff;
  }
  // PAS: FANDPDF.PAS BufI
  I(v: number): void {
    this.S(StrI(v));
  }
  // PAS: FANDPDF.PAS BufN – Str(v:0:2) without trailing zeros (and '.')
  N(v: number): void {
    const s = StrR(v, 0, 2);
    let i = s.length;
    while (i > 1 && s[i - 1] === '0') i--;
    if (i > 1 && s[i - 1] === '.') i--;
    this.S(s.slice(0, i));
  }
  // PAS: FANDPDF.PAS BufPdfStr
  PdfStr(src: Uint8Array): void {
    for (const v of src) {
      if (v === 40 || v === 41 || v === 92) this.Byte(92);
      this.Byte(v);
    }
  }
}

// PAS: FANDPDF.PAS FandTxtToPdf – false when InPath can't be read or OutPath written
export function FandTxtToPdf(InPath: string, OutPath: string): boolean {
  let src: Uint8Array;
  try {
    src = new Uint8Array(fs.readFileSync(ToUnicode(InPath)));
  } catch {
    return false;
  }
  const srcLen = src.length;
  const used = new Array<boolean>(256).fill(false);
  let maxcols = 0;
  let size = 0, lead = 0, pw = 0, ph = 0, y = 0;
  let perpage = 0, sheets = 0;
  const objOfs: number[] = []; // objOfs[n-1] = file offset of object n
  let nObj = 0;
  const pagesObj = 2, f1 = 4, f2 = 5, infoObj = 6, firstPage = 7;
  let encObj = 3;
  const pdf = new TBuf(), pg = new TBuf();

  function StartObj(n: number): void {
    objOfs[n - 1] = pdf.Len;
    pdf.I(n);
    pdf.S(' 0 obj\n');
  }
  function EndObj(): void {
    pdf.S('\nendobj\n');
  }
  function Walk(Emit: boolean): void {
    let col = 0, startcol = 0, bold = false, inrun = false, runStart = 0, lineNo = 0;
    function FlushRun(e: number): void {
      if (!inrun) return;
      if (Emit) {
        pg.S('BT /F');
        pg.S(bold ? '2' : '1');
        pg.S(' ');
        pg.N(size);
        pg.S(' Tf ');
        pg.N(MarginPt + startcol * CourierW * size);
        pg.S(' ');
        pg.N(y);
        pg.S(' Td (');
        pg.PdfStr(src.subarray(runStart, e));
        pg.S(') Tj ET\n');
      }
      inrun = false;
    }
    function NewSheet(): void {
      if (!Emit) {
        sheets++;
        return;
      }
      StartObj(nObj);
      pdf.S('<< /Length ');
      pdf.I(pg.Len);
      pdf.S(' >>\nstream\n');
      pdf.Raw(pg.P.subarray(0, pg.Len));
      pdf.S('\nendstream');
      EndObj();
      nObj++;
      StartObj(nObj);
      pdf.S('<< /Type /Page /Parent ');
      pdf.I(pagesObj);
      pdf.S(' 0 R /MediaBox [0 0 ');
      pdf.N(pw);
      pdf.S(' ');
      pdf.N(ph);
      pdf.S('] /Resources << /Font << /F1 ');
      pdf.I(f1);
      pdf.S(' 0 R /F2 ');
      pdf.I(f2);
      pdf.S(' 0 R >> >> /Contents ');
      pdf.I(nObj - 1);
      pdf.S(' 0 R >>');
      EndObj();
      nObj++;
      pg.Len = 0;
      y = ph - MarginPt - size;
      lineNo = 0;
    }
    function EndLine(e: number): void {
      FlushRun(e);
      lineNo++;
      col = 0;
      startcol = 0;
      if (Emit) {
        y = y - lead;
        if (lineNo >= perpage) NewSheet();
      } else if (lineNo >= perpage) {
        sheets++;
        lineNo = 0;
      }
    }

    if (Emit) {
      pg.Len = 0;
      y = ph - MarginPt - size;
    } else sheets = 0;
    let k = 0;
    while (k < srcLen) {
      const c = src[k];
      k++;
      switch (c) {
        case 13:
          if (k < srcLen && src[k] === 10) FlushRun(k - 1);
          else EndLine(k - 1);
          break;
        case 10:
          EndLine(k - 1);
          break;
        case cFF:
          FlushRun(k - 1);
          if (Emit) {
            if (lineNo > 0 || pg.Len > 0) NewSheet();
          } else if (lineNo > 0) {
            sheets++;
            lineNo = 0;
          }
          col = 0;
          startcol = 0;
          break;
        case cBin:
          FlushRun(k - 1);
          if (k + 1 < srcLen) {
            const cnt = src[k] | (src[k + 1] << 8);
            k += 2 + cnt;
          } else k = srcLen;
          break;
        case cBold:
          FlushRun(k - 1);
          bold = !bold;
          startcol = col;
          break;
        default:
          if (c < 32) {
            FlushRun(k - 1);
            startcol = col;
          } else {
            if (!inrun) {
              inrun = true;
              runStart = k - 1;
              startcol = col;
            }
            if (!Emit) {
              used[c] = true;
              col++;
              if (col > maxcols) maxcols = col;
            } else col++;
          }
      }
    }
    FlushRun(Math.min(k, srcLen)); // TS: k may pass srcLen after a ^P block
    if (Emit) {
      if (lineNo > 0 || pg.Len > 0) NewSheet();
    } else if (lineNo > 0) sheets++;
    if (!Emit && sheets === 0) sheets = 1;
  }
  function WriteEncoding(): void {
    let any = false;
    for (let b = 0x80; b <= 0xff; b++) if (used[b] && glyph(b).G !== '') any = true;
    if (!any) {
      encObj = 0;
      return;
    }
    StartObj(encObj);
    pdf.S('<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [');
    let prev = -2;
    for (let b = 0x80; b <= 0xff; b++) {
      if (used[b] && glyph(b).G !== '') {
        if (b !== prev + 1) {
          pdf.S(' ');
          pdf.I(b);
        }
        pdf.S(' /');
        pdf.S(glyph(b).G);
        prev = b;
      }
    }
    pdf.S(' ]>>');
    EndObj();
  }
  function WriteFont(n: number, nm: string): void {
    StartObj(n);
    pdf.S('<< /Type /Font /Subtype /Type1 /BaseFont /');
    pdf.S(nm);
    if (encObj !== 0) {
      pdf.S(' /Encoding ');
      pdf.I(encObj);
      pdf.S(' 0 R');
    } else pdf.S(' /Encoding /WinAnsiEncoding');
    pdf.S(' >>');
    EndObj();
  }

  for (let i = 0; i < srcLen; i++) {
    const n = src[i];
    if (n >= 0x80 && glyph(n).F !== 0) src[i] = glyph(n).F;
  }
  Walk(false);
  if (maxcols > WideCols) {
    pw = A4h;
    ph = A4w;
  } else {
    pw = A4w;
    ph = A4h;
  }
  const avail = pw - 2 * MarginPt;
  if (maxcols === 0) size = MaxSizePt;
  else {
    size = avail / (CourierW * maxcols);
    if (size > MaxSizePt) size = MaxSizePt;
    if (size < MinSizePt) size = MinSizePt;
  }
  lead = size * LeadFactor;
  perpage = Math.trunc((ph - 2 * MarginPt) / lead);
  if (perpage < 1) perpage = 1;
  Walk(false);
  nObj = firstPage;
  pdf.S('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  StartObj(1);
  pdf.S('<< /Type /Catalog /Pages ');
  pdf.I(pagesObj);
  pdf.S(' 0 R >>');
  EndObj();
  WriteEncoding();
  WriteFont(f1, 'Courier');
  WriteFont(f2, 'Courier-Bold');
  StartObj(infoObj);
  pdf.S('<< /Producer (PC FAND) /Title (');
  pdf.PdfStr(Uint8Array.from(OutPath, (ch) => ch.charCodeAt(0) & 0xff));
  pdf.S(') >>');
  EndObj();
  Walk(true);
  StartObj(pagesObj);
  pdf.S('<< /Type /Pages /Count ');
  pdf.I(Math.trunc((nObj - firstPage) / 2));
  pdf.S(' /Kids [');
  for (let n = firstPage + 1; n < nObj; n += 2) {
    pdf.S(' ');
    pdf.I(n);
    pdf.S(' 0 R');
  }
  pdf.S(' ]>>');
  EndObj();
  const xref = pdf.Len;
  pdf.S('xref\n0 ');
  pdf.I(nObj);
  pdf.S('\n');
  pdf.S('0000000000 65535 f \n');
  for (let i = 1; i <= nObj - 1; i++) {
    const n = objOfs[i - 1] ?? 0; // encObj unused: offset 0, as the zeroed FPC table
    pdf.S(String(n).padStart(10, '0'));
    pdf.S(' 00000 n \n');
  }
  pdf.S('trailer\n<< /Size ');
  pdf.I(nObj);
  pdf.S(' /Root 1 0 R /Info ');
  pdf.I(infoObj);
  pdf.S(' 0 R >>\n');
  pdf.S('startxref\n');
  pdf.I(xref);
  pdf.S('\n%%EOF\n');
  try {
    fs.writeFileSync(ToUnicode(OutPath), pdf.P.subarray(0, pdf.Len));
    return true;
  } catch {
    return false;
  }
}

// PAS: FANDPDF.PAS FandDeliverPdf
export function FandDeliverPdf(Path: string, WantOpen: boolean): void {
  let act = GetEnv('FAND_PRINT');
  if (act === '') act = WantOpen ? 'open' : 'none';
  if (act === 'none') return;
  const p = ToUnicode(Path);
  if (act === 'lpr') {
    const printer = GetEnv('FAND_PRINTER');
    const args = printer !== '' ? ['-P', ToUnicode(printer), p] : [p];
    spawnSync('lpr', args, { stdio: 'ignore' });
    return;
  }
  // TS: the Electron host opens the file (shell.openPath); headless: the FPC command
  try {
    hostCall('open', p);
    return;
  } catch {
    // no host attached, or the host could not open it
  }
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
    const child = spawn(cmd, [p], { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // fpSystem ignores failures
  }
}
