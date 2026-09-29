// FAND print text (CP852 with printer control characters and dot commands) -> page model.
// Shared by the FAND2PDF, UTISK04 and PDFTISK replacements and the print-manager fallback.
// Control characters are those FAND.CFG translates per printer (CtrlToESC, OBASE.PAS);
// ^P starts a binary run with a 2-byte length (skipped), ^L is a form feed.
// References: docs/helpers/print-spool.md, fand2pdf.md, utisk04.md; FANDPDF.PAS.

import { decode852 } from '../../engine/console/cp852.ts';

export interface Style {
  bold: boolean; // ^B, ^D (double strike)
  italic: boolean; // ^W
  underline: boolean; // ^S
  wide: boolean; // ^Q
  compressed: boolean; // ^E
}

export interface Run {
  text: string; // Unicode
  col: number; // starting column
  style: Style;
}

export interface Line {
  runs: Run[];
  cols: number;
}

export interface Page {
  lines: Line[];
}

export interface FandDoc {
  pages: Page[];
  copies: number; // .ti
  leftMargin: number; // .po, characters
  pageLength: number | null; // .pl, lines (null = fit to paper)
  maxCols: number;
}

const CTRL: Record<number, keyof Style> = { 0x02: 'bold', 0x04: 'bold', 0x17: 'italic', 0x13: 'underline', 0x11: 'wide', 0x05: 'compressed' };

export function parseFandText(bytes: Uint8Array): FandDoc {
  const doc: FandDoc = { pages: [{ lines: [] }], copies: 1, leftMargin: 0, pageLength: null, maxCols: 0 };
  const style: Style = { bold: false, italic: false, underline: false, wide: false, compressed: false };
  let line: Line = { runs: [], cols: 0 };
  let run: Run | null = null;
  let lineStart = 0;

  const page = () => doc.pages[doc.pages.length - 1];
  const flushRun = () => {
    if (run && run.text) line.runs.push(run);
    run = null;
  };
  const endLine = (rawEnd: number) => {
    flushRun();
    const raw = bytes.subarray(lineStart, rawEnd);
    if (!dotCommand(raw, doc)) {
      page().lines.push(line);
      doc.maxCols = Math.max(doc.maxCols, line.cols);
    }
    line = { runs: [], cols: 0 };
  };

  let k = 0;
  while (k < bytes.length) {
    const c = bytes[k++];
    if (c === 0x0d) {
      endLine(k - 1);
      if (bytes[k] === 0x0a) k++;
      lineStart = k;
    } else if (c === 0x0a) {
      endLine(k - 1);
      lineStart = k;
    } else if (c === 0x0c) {
      flushRun();
      if (line.runs.length) endLine(k - 1);
      doc.pages.push({ lines: [] });
      lineStart = k;
    } else if (c === 0x10) {
      flushRun();
      const n = k + 1 < bytes.length ? bytes[k] | (bytes[k + 1] << 8) : bytes.length;
      k = Math.min(bytes.length, k + 2 + n);
    } else if (c === 0x1a) {
      break; // ^Z end of text
    } else if (c < 0x20) {
      flushRun();
      const key = CTRL[c];
      if (key) style[key] = !style[key];
    } else {
      if (!run) run = { text: '', col: line.cols, style: { ...style } };
      run.text += decode852(Uint8Array.of(c));
      line.cols++;
    }
  }
  if (run || line.runs.length || lineStart < bytes.length) endLine(k);
  // Drop a trailing empty page produced by a final form feed.
  if (doc.pages.length > 1 && page().lines.length === 0) doc.pages.pop();
  return doc;
}

/** Handle `.ti N`, `.po N`, `.pl N`; other dot commands (.he .fo .cp .ff .nm ...) are skipped. */
function dotCommand(raw: Uint8Array, doc: FandDoc): boolean {
  if (raw.length < 3 || raw[0] !== 0x2e) return false;
  const s = String.fromCharCode(...raw.subarray(0, Math.min(raw.length, 40)));
  const m = /^\.([a-zA-Z]{2})\s*(\d*)/.exec(s);
  if (!m) return false;
  const n = m[2] ? Number(m[2]) : NaN;
  switch (m[1].toLowerCase()) {
    case 'ti': if (n > 0) doc.copies = n; break;
    case 'po': if (n >= 0) doc.leftMargin = n; break;
    case 'pl': if (n > 0) doc.pageLength = n; break;
  }
  return true;
}
