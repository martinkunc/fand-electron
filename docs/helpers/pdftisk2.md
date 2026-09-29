# PDFTISK2.EXE – FAND report text onto a PDF letterhead (invoice, delivery note, order, postal sheet, blank)

`{tisk}\PDFTISK2.EXE` (109 KB, 2020). A **native VB6** app using the COM library **PDF
Creator Pilot** (`PDFCreatorPilot.PDFDocument4`, `C:\WINNT\system32\PDFCreatorPilot.dll`,
installed by `{tisk}\SETUPCP.EXE`, with a licence key embedded; not reproduced). Classes:
`clsPDFFaktura`, `clsPDFDodList`, `clsPDFObjednavka`, `clsPDFZasilky`, `clsPDFZasilkyPA`,
`clsPDFFandReport`, `clsPDFTiskopis` (properties `FandText`, `PDFVzor`, `VodoznakFile`,
`PrilohaFile`, `Heslo`, `PDFDoc`, `MakePDF`), and `cls1250` (`ToWinChr`/`ToWinText`).

It takes a FAND report that is laid out for a **pre-printed form** (a character grid)
and writes it in Courier New over a PDF template (the "letterhead"/`vzor`). Optional extras
are a text colour, a logo/watermark image, an attached PDF, and a password.

## How Účto invokes it

| | |
|---|---|
| Command line | `$ <param file>` |
| Param file | 9 lines, separated by `\13` (CR) as FAND writes them (`puttxt` of a string with `\13`) |
| Output | a PDF file, optionally opened |
| Exit code | not checked. Callers use `WaitFor(pdf,'PDFTISK2.EXE')` in DOSBox/vDos. |

Param lines:

| # | Content | PdfSest (`0593_P_PdfSest.txt`) | Pdf2Blank (`0596_P_Pdf2Blank.txt`) |
|---|---|---|---|
| 1 | form type | `Fakt`, `DodL`, `Obje`, `Szas`, `PA` (matched case-insensitively against `FAKT DODL OBJE SZAS PA BLANK`) | `BLANK` |
| 2 | input FAND text (CP852) | `SEST.Path` = `{SEST}\SESTnn.TXT` | the text file |
| 3 | template PDF (page 1) | `ADR01\{PDF2}\<šabl>.PDF` | `ADR01\{PDF2}\BLANK.PDF` |
| 4 | output PDF | `ADR03\{SEST}\SESTnn.PDF` | the target PDF |
| 5 | `A` = open when done | `PARAM3.PdfOpen` | `PARAM3.PdfOpen` |
| 6 | text colour `R G B` (0–255) | `PDFSEST.Barvy6` (validated by FAND) | `0 0 0` |
| 7 | image `"<path> <n>"` | `PDFSEST.VodoZn7` + `Obr1234` | empty |
| 8 | attachment PDF | `PDFSEST.Příl8` | empty |
| 9 | user password | `PDFSEST.Heslo9` (ASCII only, `#L` check) | `Pwd` |

Template names (`šabl`): invoice `FAGR` / `FABL` / `FABW` / `FA03`–`FA09` for
`Šablona` 1 / 2 / 0 / 3–9. Delivery note `DLGR`/`DLBL`/`DLBW`. Order `OBGR`/`OBBL`/`OBBW`.
`Szas` → `SZAS`, `PA` → `PA`. The edit form (`0592_E_PdfSest.txt`) says `Šablona`
"0-černá, 1-zelená, 2-modrá". For pages 2 onwards the helper uses `<šabl>2.PDF` (the
literal `2.PDF`; `{pdf2}` contains `fabw.pdf` + `fabw2.pdf` and so on). `FA03`–`FA09` are
user-supplied custom letterheads.

Image placement `n` (`Obr1234`): 1 first page only, 2 last page only, 3 first and last, 4
all pages (the literals `[134]`, `[234]`, `[4]` are VB `Like` patterns for "on the first
page", "on the last page", "on the middle pages"). The image is a JPG/GIF/TIF ("např. logo
do sestavy").

Callers:

* **Invoice → PDF** (`MODUL06_PRO/0162_P_FaktPdf1.txt`, `0161_P_FaktPdf1QR.txt`,
  `0099_P_FaktPdfMail.txt`, `0131_P_FaktSF6x.txt`): the report `FakturaWW` → `SEST`,
  `PdfSest('Fakt')`, then optionally [UctoQR](uctoqr.md) stamps the QR code, then copy to
  `{MAIL}` / e-mail. This is **the invoice PDF of Účto**.
* Delivery note / order (`MODUL06_PRO/0258_P_DodLTisk1.txt` and others) → `DodL`, `Obje`.
* Address labels / postal sheets (`MODUL02_PRO/0143–0146_P_TiskAdr*`) → `Szas`, `PA`.
* Reminders (`MODUL02_PRO/0164_P_UpomFin1.txt`).
* `Pdf2Blank`: `Txt2Pdf` with "PDF s fonty" or a password, and `FandMail` → `BLANK`.
* Parameters: F10 → "Parametry PDF sestavy" → `PdfSestPar(Zkr)` edits the `PDFSEST`
  records 1–5 (Fakt, DodL, Obje, Szas/PA, VyplPas). `VyplPas` (`VPBW`) exists in FAND but is
  never called with PdfSest, and there is no `VPBW.pdf`, so it is dead.

## What it does (strings)

* The parameter parse errors are "Chyba při čtení parametrů." and "Nepodporovaný
  tiskopis." A missing template/image/attachment → "Chybí soubor předlohy (…)", "Chybí
  soubor s obrázkem (…)", "Chybí soubor přílohy (…)". If the PDF Creator Pilot COM class
  is missing, it offers to run `{TISK}\SETUPCP.EXE` ("Před prvním spuštěním …"). No PDF
  viewer → a hint to install Adobe Reader.
* `CtiFandFile` reads the text (CP852 → CP1250 via `ToWinText`) and interprets the dot
  commands **`.ti #`, `.po #`, `.cp #`, `.pl #` (1–2 digits), `.he *`, `.fo *`, `.ff`,
  `.nm`**. The `.he`/`.fo` headers and footers repeat on each page. `.pl` gives the page
  length in lines. `.po` is the left offset.
* `MakePDF`: for each output page, append the template (page 1 = `<šabl>.PDF`, later pages
  = `<šabl>2.PDF`) and write the page's lines in **Courier New**, in the RGB colour, at
  fixed positions. Draw the image according to `n`. Append the attachment's pages. Set
  `UserPassword`. Save, and optionally open (`FindExecutableA` + ShellExecute).
* Errors: "Chyba při čtení Fand souboru (CtiFandFile).", "Chyba při generování PDF
  souboru (MakePDF).", "Tiskopis se nevytvoří."

The exact font size, line pitch and origin per type are **not recoverable from strings**.
They must be calibrated, see the test approach.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/pdftisk2.ts`, key `pdftisk2.exe`. Effort **L** (mostly the
calibration).

1. `args[0]==='$'`. Read the param file (CP852), split on `\r\n|\r|\n`, and take 9 lines
   (missing lines are empty). Map the paths. Validate the type and check files as above,
   with the same Czech messages.
2. Text: `fandtext.parse()` (shared with [fand2pdf.md](fand2pdf.md)), with `.pl`, `.he`,
   `.fo`, `.po`, `.ti` handling and pagination.
3. Layout table per type, `{ fontSize, lineHeight, originX, originY, maxLines }` in pt
   (initial guess: Courier 10 pt / 12 pt lines, which gives the 72-line FAND pages on A4;
   BLANK like FAND2PDF). **Calibrate against original outputs** (see the tests).
4. Build with `@cantoo/pdf-lib` + fontkit:
   * load the template(s) and `copyPages` template page 0 for each page (page 1 from
     `<šabl>.PDF`, then `<šabl>2.PDF`, falling back to `<šabl>.PDF` when the `2` file is
     missing);
   * draw the lines with embedded **Liberation Mono** (metric-compatible with Courier New)
     in `rgb(r/255,g/255,b/255)`, bold runs from `^B` with Liberation Mono Bold;
   * image: `embedJpg`/`embedPng`, with GIF/TIF converted via `sharp` if we accept a
     native dependency; otherwise support only JPG/PNG and show a message for others. The
     placement and size are calibrated (the original most likely draws the logo in the
     page's top-left header area);
   * attachment: `copyPages` of all its pages at the end;
   * password: `encrypt({userPassword})`.
5. Save, then open if line 5 is `A` (`ctx.host.openPath`). Return 0 or 1.

Still needed: **yes, high**. It produces the invoice PDF, which Účto users rely on daily.

## Test approach

* **Calibration fixtures (one-off)**: on Windows or Wine with PDF Creator Pilot installed,
  run the original PDFTISK2 on the `{prik}` sample invoice (`FakturaWW` output), a
  delivery note, an order, `Szas`, `PA` and `BLANK`. Store those PDFs in
  `test/fixtures/helpers/pdftisk2/golden/`. Extract the text positions with `pdfjs-dist`
  (`getTextContent` → transform matrix) to derive the layout table.
* Automated: render the same inputs with our helper, then compare the text runs (string +
  x/y within ±1 pt), the page count, the template page used per page (1st vs `2.PDF`),
  and the image presence per `n` = 1..4 on a 3-page invoice.
* Colour: `0 0 255` → the text operators use the rgb fill 0 0 1.
* Password: the output cannot be opened without the password.
* Missing template/image/attachment → exact message, and no output.
