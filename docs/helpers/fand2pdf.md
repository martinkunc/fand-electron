# FAND2PDF.EXE – FAND text → PDF (simple, non-embedded Courier)

`{tisk}\FAND2PDF.EXE` (88 KB, 2006). A **native VB6** app (`frmMAIN` "Převod: FAND -> PDF",
classes `clsData`, `cls1250` (`FandTo1250`), `clsPDF`, `clsElement*`, `clsTextStream`). It
writes the PDF by hand, with no PDF library. Description: "Převod Fandovských textů do
formátu PDF."

## How Účto invokes it

| | |
|---|---|
| Command line | `$ <param file>` (the param file is `UCTOTXT2.UUU`) |
| Param file | one line `<input txt>,[+]<output pdf>`. A `+` before the output path means "open the PDF when done". |
| Input | CP852 FAND text (a report or text-viewer file, copied to `UCTOTXT.UUU` first) |
| Output | a PDF at the given path |
| Exit code | `FandMail` treats `exitcode<>0` as "no PDF attachment". The others ignore it and wait for the file (`WaitFor` in DOSBox/vDos). |

`FAND2PDF.Path := PROGRAM.Path+'{TISK}\FAND2PDF.EXE'` (`KatalogG`, catalog `FAND2PDF`).

Callers:

1. **`Txt2Pdf`** (`UCTO2026_RDB/0180_P_Txt2Pdf.txt`), used by the text viewer F10 →
   **"PDF - Adobe Reader"** / **"PDF - s heslem"** (`MODUL01_PRO/0002_P_TxtExit.txt`), by
   `SestXXex`, `VyplMail` and `PlatbaQR`:
   ```
   FILE.Path:=TxtIn; if PARAM3.PdfNoDiak then copyfile(FILE ,UCTOTXT,mode='LN',nocancel)
                     else copyfile(FILE/TXT,UCTOTXT,nocancel);
   ... KAM.Path:=PdfOut; copyfile('NICNIC.$$$',KAM,nocancel);   { delete target; error if locked }
   b:=PARAM3.PdfFont | Pw;
   if b then proc(Pdf2Blank,(TxtIn,PdfOut,cond(Pw:Pwd)))          { → PDFTISK2 BLANK }
   else begin puttxt(UCTOTXT2,XPath(UCTOTXT.Path)+','+cond(PARAM3.PdfOpen:'+')+XPath(PdfOut));
              proc(ExecWin,(FAND2PDF.Path,'$ '+UCTOTXT2.Path)); end;
   ```
   So FAND2PDF is the **default** "text → PDF". PDFTISK2 `BLANK` is used instead when
   "PDF s fonty" (`PARAM3.PdfFont`) or a password is requested. With `PdfNoDiak`, FAND
   strips the diacritics first (`mode='LN'`).
2. **`FandMail`** (`UCTO2026_RDB/0183_P_FandMail.txt`): e-mailing a text as a PDF attachment
   `<prefix>UEMAIL.PDF`, with no `+` (do not open).
3. **`DopisyTisk1` / `DopisyTiskV`** (`MODUL02_PRO/0093`, `0094`): letters sent by e-mail as
   PDF (`PAR02A3.EmailPdf`), `SEST…TXT` → `SEST…PDF`.

## What it does (strings)

Literal PDF skeleton (UTF-16 BSTRs in the binary):

* `%PDF-1.3`, A4 `/MediaBox [0 0 595 842]`, `/ProcSet [/PDF /Text]`.
* Four **non-embedded TrueType** fonts `/F1 CourierNew`, `/F2 CourierNew,Bold`,
  `/F3 CourierNew,Italic`, `/F4 CourierNew,BoldItalic`. Their `/Encoding` is a dictionary
  with `/BaseEncoding /WinAnsiEncoding /Differences [131 /.notdef 136 /.notdef 140 /Sacute
  /Tcaron 143 /Zacute … 254 /tcommaaccent /dotaccent]`, i.e. **CP1250** glyph names. The
  text is converted CP852 → CP1250 (`FandTo1250`).
* Page content: `BT 12 TL 14 820 Td /F1 12 Tf` (12 pt font, 12 pt leading, origin
  x=14 pt / y=820 pt), then per line `(<text>) Tj T*`, with ` Tz ` (horizontal scaling,
  most likely to squeeze long lines) and font switches `/Fn 12 Tf` for FAND style control
  characters (inferred: `^B` bold, `^W` italic). `ET`.
* A new page on `^L` or a full page (the page class `NovaStrana`/`KonecStrany`). `/Info`:
  `/Creator (Tichy a spol, ucto - danova evidence) /Producer (program FAND2PDF.EXE)`.
* After writing, if `+`: `ShellExecute "open"`. Errors: "Chybné parametry.", "Nelze otevřít
  FAND soubor.", "Nelze otevřít PDF soubor.", "Nelze zavřít soubor.", "PDF soubor byl
  vytvořen, ale nelze spustit Acrobat Reader.", "Chyba programu FAND2PDF.EXE."
* The literals `T I A E Q` are probably dot-command or control-character handling
  (unknown).

The FPC port contains a clean-room equivalent, `FandTxtToPdf` in
`vendor/reference/standa_pcfand/pas/FANDPDF.PAS`: Courier, a CP852 → glyph-name table,
`^B` bold toggle, `^L` page break, `^P` binary skip, auto font size 4.5–10 pt to fit
`max(96, longest line)` columns, 36 pt margins, and A4.

## Replacement design (Node/TypeScript)

Two shared library modules, reused by UTISK04, PDFTISK2 and the ToMgr fallback:

* `src/engine/helpers/lib/fandtext.ts`: parse CP852 FAND print text into a document
  model: lines of styled runs (bold/italic/underline/wide/compressed from the control
  characters listed in [print-spool.md](print-spool.md)), page breaks (`^L`), `^P` binary
  runs skipped, and the dot commands `.po .ti .pl .cp .he .fo .ff .nm` with header/footer
  expansion like FAND's `PrintHeFo` (`__.__.____` date, `__:__` time, `___` page number).
* `src/engine/helpers/lib/textpdf.ts`: render the model with **`pdf-lib`** +
  **`@pdf-lib/fontkit`**. Embed **Liberation Mono** Regular/Bold/Italic/BoldItalic (SIL
  OFL, metric-compatible with Courier New, full Latin-2), subset. A4, 12 pt / 12 pt leading
  at x=14, y=820 to match FAND2PDF's layout. For lines longer than 80 columns, use
  horizontal scaling (`Tz`, which pdf-lib does not wrap; write the operator via
  `pushOperators`) or reduce the font size as FANDPDF does. Metadata: Creator "Účto",
  Producer "fand-electron".

Module `src/engine/helpers/fand2pdf.ts`, key `fand2pdf.exe`:

1. `args[0]==='$'`. Read the param file (CP852) and split at the **first comma** (paths
   may contain spaces). A leading `+` on the second part → `open=true`. Map both paths.
2. `textpdf.render(fandtext.parse(bytes))` → write the file. If the target is locked
   (Windows), report "Nelze otevřít PDF soubor." and return 1.
3. `open` → `ctx.host.openPath(pdf)`. Return 0.

Improvement over the original: the fonts are embedded, so there are no missing glyphs
for Ř/ů on systems without Courier New. That makes the separate "PDF s fonty" PDFTISK2
path redundant, but keep it because the FAND code chooses it.

Still needed: **yes, high** (PDF export, e-mail attachments). Effort **M** (the text model
is shared).

## Test approach

* Fixtures in `test/fixtures/helpers/fand2pdf/`: a `{prik}` report printed by the engine
  (e.g. Kniha dokladů), a text with `^B…^B` and `^W`, `^L`, a 132-column line, all CP852
  letters, and the `.he`/`.fo` dot commands.
* Assertions: parse the output with `pdfjs-dist` (dev dependency). Page count, the text
  per page equal to the decoded input lines (after dot-command removal), fonts embedded,
  and bold runs using the bold font.
* Param parsing: `C:\A B\UCTOTXT.UUU,+C:\X\SEST01.PDF` → open=true, and paths with spaces.
* Golden visual (optional): render page 1 to PNG with `pdfjs-dist` + `canvas`, and
  compare against the original FAND2PDF output rendered the same way (Wine/VM run, stored
  as a fixture) with a tolerance.
