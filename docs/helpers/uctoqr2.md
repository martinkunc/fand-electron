# UctoQR2.exe – batch "QR platby" sheet (5 numbered QR payment codes per A4 page)

`{tisk}\UctoQR2.exe` (56 KB, 2025). **.NET Framework 4.0** (x86), using **ZXing.Net**
(`zxing.dll`) for the QR codes and the COM library **PDF Creator Pilot**
(`PDFDocument4`, CLSID `465FE951-D267-4D90-A019-7994822E137E`, licence key in the source;
not reproduced here) for the PDF. Decompiled source: `work/decompiled/{tisk}_UctoQR2/`
(`UctoQR2/Program.cs`, `UctoQR2.Common/{Config,DataLoader,PdfBuilder,QrCodeService}.cs`,
`QrPaymentLib/{Platba,QrDrawing}.cs`, `QrPaymentLib.IBAN/IbanValidator.cs`).

## How Účto invokes it

1. FAND writes **`{TISK}\UctoQR2.csv`** with a report:
   * bank orders `QR2PkUcsv` (`MODUL08_PRO/0039_R_QR2PkUcsv.txt`), from `BANKA`
     (`0040_P_BANKA.txt`) and `PrikPSF6` (`0064`): F10 → "QR Platby W" (only when the
     order is not IBAN and has more than one item);
   * finance `QR2FinCsv` (`MODUL01_PRO/0226_P_QR2Fin.txt`);
   * QR payments editor `QRplatCsv` (`MODUL08_PRO/0076/0077`).

   Format (CP852, a header line, comma-separated, **no quoting**; FAND removes commas from
   the names and texts):
   ```
   prijemce,prefix,account,code,amount,currency,dueDate,msg,vs,ks,ss,rn
   Firma s r o,19,2000145399,0800,1234.50,CZK,20260315,Faktura 123,2026001,0308,,Firma s r o
   ```
   The report also leaves `PARAM3.F1` = the count and `PARAM3.F2` = the sum.
2. `UctoQR2(DatPrik, NazFirmy)` (`UCTO2026_RDB/0627_P_UctoQR2.txt`): optionally edit the
   CSV (`EditPdf3`), choose the output name (`P9aSoub('QR')` → `PARAM3.AA2`, default
   `{MAIL}\QR<YYMMDD>.PDF`), then report `UctoQR2` (`0626_R_UctoQR2.txt`) →
   **`{TISK}\UctoQR2.xml`** (declared `encoding="ibm852"`, which is correct):

   | key | value |
   |---|---|
   | inputDataFile | `{TISK}\UctoQR2.csv` |
   | inputDataFileEncoding | `852` (ignored, see below) |
   | skipFirstLine | `true` |
   | pdfTemplate | `ADR01\{PDF2}\BLANK.PDF` |
   | drawRectangleAndText | `false` |
   | outputPDF | the target |
   | qrImagesFolder | `ADR03\{TEMP}\` |
   | runAR | `TruFal(PARAM3.PdfOpen)` |
   | passwordPdf | empty |
   | headerText | `QR platby` |
   | showHeaderDate / headerDate | `true` / `DD.MM.YYYY` of `DatPrik` |
   | headerOnFirstPageOnly | `false` |
   | companyName | `HtmlTxt(NazFirmy)` |
   | errorLog | `{TISK}\UctoQR2.log` |
   | pocet / celkem | `PARAM3.F1` / `PARAM3.F2` (`.00` stripped) |

3. `ExecWin(PROGRAM.Path+'{TISK}\UctoQR2.exe','')`, with the config file `UctoQR2.xml`
   resolved relative to the cwd, as for UctoQR.

## What it does (decompiled C#)

* `Config`: reads the keys above. **Bug**: `InputDataFileEncoding` parses the
  `inputDataFile` key, so it always falls back to **852**, which happens to be right.
* `DataLoader`: `File.ReadAllLines(csv, CP852)`, skipping the first line; `Split(',')`,
  with no quote handling. The fields: `Prijemce` (max 35), `Prefix`, `Account` (with `-`
  removed), `BankCode`, `Ammount` (parsed with the en-US culture, 0 on failure),
  `Currency`, `DueDateString`, `Message` (diacritics removed) + `MessageWithDiacritics`,
  `Vs`, `Ks`, `Ss`, `Rn` (max 35, diacritics removed). A short line → exception → "Chyba
  při importu dat do hromadného příkazu…".
* It deletes `*.png` in `qrImagesFolder`, then for each row *i* (0-based):
  * `Platba.GetPlatba` → the same SPD string as [UctoQR](uctoqr.md) (IBAN from
    `prefix/account/code` + `123500`, **validated** by `IbanValidator`; an invalid IBAN →
    "Číslo účtu … není validní, QR kód se nevytvoří" aborts the whole run). Fields: `ACC,
    AM` (`ToString("G", en-US)`), `CC, DT, MSG, X-KS, X-SS, X-VS, RN`, not upper-cased
    here.
  * `QrDrawing`: ZXing `BarcodeWriterPixelData` QR, 600×600 px (400 with
    `drawRectangleAndText`), margin 1, **default error correction (L)**. `DrawLogo`
    overlays a **black 120×120 square with the white number i+1** (Arial 42 bold) in the
    centre. That covers about 4 % of the code at EC L, which relies on the decoder's
    tolerance; most bank apps cope. It is saved as `qr_payment_<i>.png`.
* `PdfBuilder.BuildPdf2`: Consolas fonts, flate compression; `UserPassword` =
  `passwordPdf`. 5 codes per page: a new template page (`Append(BLANK.PDF)`) for each
  page. For row *k* on page position *p* (1..5), `Top = 90 + (p−1)·150` and `Left = 50`,
  with the image drawn at 105×105 (90×90 with the rectangle option). The left column
  (x 230–330, right-aligned, Consolas 10) shows the labels "příjemce:, číslo účtu:,
  částka:, variabilní symbol:, konstantní symbol:, specifický symbol:, datum splatnosti:,
  zpráva příjemci:". The right column (x 335–540, left-aligned) shows the values:
  `[prefix-]account/code`, amount `F2` en-US, due date `dd.MM.yyyy` or **"ihned"**,
  message with diacritics. On the first code of each page it adds a header (Consolas 16
  `headerText` at (50,30), and "ze dne: dd.MM.yyyy" at 10 pt after it), then "plateb:
  n\ncelkem: s" on page 1 only (440,35), `companyName` at (50,50), and "Strana: p/N" at
  (504,820). The coordinates are PDF Creator Pilot's, origin **top-left**, in pt. Finally
  it deletes the initial empty page 0, saves, and opens if `runAR`.
* If `runAR` is false: MessageBox "PDF soubor byl vytvořen v <path>." Errors → MessageBox
  "V aplikaci nastala chyba…Generování hromadného příkazu se neprovede.", a log, and exit 1.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uctoqr2.ts`, key `uctoqr2.exe`. It reuses
`lib/qrplatba.ts` (IBAN, SPD) from [uctoqr.md](uctoqr.md). Effort **M**.

1. Config: `UctoQR2.xml` in the cwd, else the exe dir. CP852; parse with the lenient
   `<add key value>` regex; case-insensitive keys.
2. CSV: CP852, skip the header, split on `,`. Keep the no-quote behaviour, because FAND
   strips commas, but trim a trailing `\r`. Apply the same field rules and truncations.
3. Validate every IBAN first and abort with the original message on the first invalid one.
4. QR: npm `qrcode`, EC **M** instead of L (a deliberate improvement that keeps the
   number overlay safely decodable), margin 1 module. Draw it **as vectors** in pdf-lib,
   105 pt square, and draw the black number badge (120/600 of the size) in the centre
   with Liberation Sans Bold.
5. Page layout: identical coordinates, converting top-left y to pdf-lib's bottom-left
   (`y = pageHeight − top − height`). Liberation Mono replaces Consolas. The template is
   `BLANK.PDF` via `copyPages`. Header, footer, totals and "Strana p/N" as above.
6. Password → `encrypt`. Save, then `openPath` if `runAR`, or else a
   `ctx.ui.message('UctoQR2', 'PDF soubor byl vytvořen v …')`. Do not write the PNGs into
   `{TEMP}`; they are unnecessary.

Still needed: **yes, medium**: bulk payment QR sheets from bank orders.

## Test approach

* CSV fixture (header + 7 rows, CP852 with diacritics in `msg`) → a 2-page PDF: page 1
  with 5 codes, page 2 with 2, "Strana 1/2" and "2/2", totals only on page 1.
* Decode every QR (pdfjs-dist render + `jsqr`), even with the number badge, and compare
  it with the expected SPD strings.
* An invalid account (bad checksum from a wrong bank code) → abort message, no output.
* Snapshot of the text runs (labels/values) with positions within ±1 pt of the
  original's coordinates.
* The engine report `QR2PkUcsv` on the `{prik}` bank order `BANKA1.008` produces a CSV the
  helper accepts.
