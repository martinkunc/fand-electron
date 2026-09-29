# UctoQR.exe – stamp a "QR Platba" code into a PDF (invoice / payment sheet)

`{tisk}\UctoQR.exe` (31 KB, 2024). **.NET Framework 4.0** console-less exe (x86) using
**iTextSharp** (`itextsharp.dll`, PdfReader/PdfStamper) and **MessagingToolkit.QRCode**.
Decompiled source: `work/decompiled/{tisk}_UctoQR/UctoQR/Program.cs`,
`UctoQR.BL/QrInvoice.cs`.

## How Účto invokes it

FAND procedure `UctoQR(...)` (`UCTO2026_RDB/0625_P_UctoQR.txt`) with 23 parameters. It
normalizes them (scale 1..5 else 2, left 1..999 else 25, bottom 1..999 else 55, defaults
`{MAIL}\UCTOQR.PDF`, `{PDF3}\BLANK1.PDF`, `{MAIL}\UCTOQR.JPG`, `konstanta:='123500'`,
currency `''`/`Kč` → `CZK`), puts them line by line into `PARAM3.TTT`, and prints
report `UctoQR` (`0624_R_UctoQR.txt`) into **`{TISK}\UCTOQR.XML`**:

```xml
<?xml version="1.0" encoding="utf-8" ?>
<configuration>
  <appSettings>
    <add key="scale" value="2"/>
    <add key="left" value="25"/>
    <add key="bottom" value="55"/>
    <add key="qrtype" value="1"/>                 <!-- hard-coded 1 = QR Platba only -->
    <add key="pageDisplay" value="1"/>            <!-- line 23: '1' → 1, else 2 -->
    <add key="outputPDF" value="C:\UCTO2026\{MAIL}\UCTOQR.PDF"/>
    <add key="inputPDF" value="C:\UCTO2026\{SEST}\SEST03.PDF"/>
    <add key="qrImage" value="C:\UCTO2026\{MAIL}\UCTOQR.JPG"/>
    <add key="runAR" value="N"/>
    <add key="overwriteSource" value="N"/>
    <add key="prefix" value="19"/>  <add key="account" value="2000145399"/>  <add key="code" value="0800"/>
    <add key="konstanta" value="123500"/>
    <add key="amount" value="1234.50"/>  <add key="currency" value="CZK"/>
    <add key="dueDate" value="20260315"/>          <!-- YYYYMMDD or empty -->
    <add key="msg" value="…"/>  <add key="vs" value="…"/>  <add key="ks" value="…"/>  <add key="ss" value="…"/>
    <add key="password" value="" />
    <add key="attachFilename" value="" />          <!-- PDF appended by PDFTISK2; the QR goes on the page before it -->
    <add key="rn" value="…"/>                      <!-- HtmlTxt(nodiakr(recipient name)) -->
  </appSettings>
</configuration>
```

The file is written in **CP852** despite `encoding="utf-8"`. It is harmless because `msg`
and `rn` go through `nodiakr`, but `msg` is **not** XML-escaped, so an invoice text with
`&` or `<` breaks the parse (an original bug). Then `ExecWin(PROGRAM.Path+'{TISK}\UCTOQR.EXE','')`
runs it with no args, and it reads `UctoQR.xml` from the **current directory**
(`APP_CONFIG_FILE="UctoQR.xml"`, a relative path. `ExecWin` runs with the Účto dir as
cwd, so that is presumably why this works; verify, since it may resolve against the exe
dir). `SyncW` → `WaitFor(outPdf,'UCTOQR.EXE')`.

Callers:

* **Invoice with a QR code** (`MODUL06_PRO/0098_P_FaktQR.txt`, from `FaktPdf1QR`, when
  `PAR06A4.QRkód`): PDFTISK2 makes `SESTnn.PDF`, UctoQR stamps it into
  `{MAIL}\UCTOQR.PDF`, and FAND copies it on (`CopyBat`). Parameters: `PAR06A4.QRscale/
  QRleft/QRbottom`, the supplier's account split by `Ucet123`, `VetaH.Celkem`, the
  currency, `DatumSpl` (unless `QRdDat0`), `nodiakr(VetaH.Text)`, VS (document number
  rule), KS, SS, the password and attachment from `PDFSEST[1]`, the supplier name,
  `PAR06A4.QRstr` (pageDisplay).
* **Payment QR sheet** `PlatbaQR` (`0630_P_PlatbaQR.txt`), called from bank orders
  (`MODUL08_PRO/0038_P_BankaQR.txt`, `0063_P_PrikQR.txt`) and finance (`MODUL01_PRO/0224_P_QRFin.txt`):
  report `PlatbaQR` (a text page "QR Platba / příjemce / číslo účtu / částka …") →
  `Txt2Pdf` → UctoQR with scale 3, left 30, bottom 600 → `{MAIL}\QR_<name>_(<amount>).PDF`
  → `CallPDF`.

## What it does (decompiled C#)

1. `ReadConfiguration`: keys are case-insensitive (`NameValueCollection`), so the report's
   `qrtype` matches `qrType`. The invoice keys `id, dd, am, tp, …, xurl` for "QR Faktura"
   are read too, but Účto never writes them (they stay null).
2. `scale` outside 1..5 → a message and exit 1. If `attachFilename` is set, count its
   pages.
3. **Payment string** `GetPlatba`, where the account = `GetIbanAccountFromCzechBankAccount`
   when `code` is non-empty:
   * pad `prefix` to 6 digits and `account` to 10 digits with leading zeros;
     `num = code + prefix + account + konstanta` (`123500` = "CZ00" converted to digits);
   * mod-97 in chunks (9 digits, then `rest+8`, or `rest+7` digits when rest > 9);
     `check = 98 − rest` (2 digits); `IBAN = "CZ" + check + code + prefix + account`;
   * `SPD*1.0*ACC:<IBAN>*AM:<amount>*CC:<currency>` [`*DT:<YYYYMMDD>`]
     [`*MSG:<msg>`] [`*X-KS:<ks>`] [`*X-SS:<ss>`] [`*X-VS:<vs>`] [`*RN:<rn>`]. `msg`
     is trimmed, upper-cased, and has its diacritics removed (NFD, non-spacing marks
     dropped). `rn` is the same, plus `,`→space and max 35 chars. `amount` is passed
     through as FAND formatted it (`str(amount,0,2)`, a `.` decimal point).
   * qrType 0 would add `*X-INV:` with `%2A`-escaped invoice fields, and 2 would give a pure
     `SID*1.0*…`. Both are unused.
4. **QR image**: MessagingToolkit `QRCodeEncoder`, `ALPHA_NUMERIC` mode, EC level **M**,
   `QRCodeScale = scale` (px per module). The version is the library default, most likely
   fixed at 7 = 45×45 modules, the ThoughtWorks lineage default (**verify**). The bitmap
   is placed on a white canvas (W+50)×(H+50) at (12,12), with a 0.5 px black frame
   rectangle (0,0,W+24,H+25), and the caption **"QR Platba"** (Arial 10 px, or 5 px when
   scale < 2) centred in the rectangle (12, H+10, W, 25). It is saved as **PNG** to
   `qrImage` (the `.JPG` name is misleading).
5. **Stamp**: `PdfReader(inputPDF[, password])` → `PdfStamper` (append mode when there is a
   password). Target page = `NumberOfPages − attachmentPages`; if that is > 1 and
   `pageDisplay == 1`, use page 1 instead. `Image.SetAbsolutePosition(left, bottom)`: 1 px
   = 1 pt, origin bottom-left. Written to `outputPDF`. `Thread.Sleep(3000)`. If
   `overwriteSource=="Y"`, replace the input. If `runAR=="Y"`, `Process.Start(pdf)`.
6. Errors → MessageBox "Chyba: …" titled "Účto QR - chyba", appended to
   `<exeDir>\uctoqr.log` as `dd.MM.yyyy - hh:mm | Chyba: … | Podrobnosti: …`, and exit 1. A
   missing iTextSharp or QR dll → offer `SETUPQR.EXE /DIR=<exeDir>` (not shipped).

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uctoqr.ts`, key `uctoqr.exe`. Effort **M**. Shared code in
`src/engine/helpers/lib/qrplatba.ts`, also used by UctoQR2:

* `czIban(prefix, account, code)`: the same padding and a **BigInt** mod-97 (the result
  is identical to the chunked algorithm). Validate: digits only, otherwise the message
  "číslo účtu … není pravděpodobně validní".
* `spd(fields)`: the exact field order above, `removeDiacritics` via
  `normalize('NFD').replace(/\p{Mn}/gu,'')`, upper-cased. Escape `*` in values as `%2A`
  per the SPD spec (an improvement: the original does not escape it).
* QR: npm **`qrcode`** (`QRCode.create(text, { errorCorrectionLevel: 'M', version: 7 })`,
  falling back to automatic versioning when it does not fit). Use alphanumeric segments
  when the text is in the alphanumeric set, otherwise byte mode.
* Drawing: **vector, straight into the PDF** with `@cantoo/pdf-lib` (no PNG step, since
  nothing reads `qrImage`; optionally write it for compatibility with `qrcode.toFile`).
  One module is `scale` pt. Draw the same frame and caption geometry in pt, with
  Liberation Sans for "QR Platba", at `(left, bottom)` on the page chosen by the same rule
  (count the attachment pages with pdf-lib).
* Config: read `UCTOQR.XML` from the cwd, falling back to the exe dir. Decode as CP852 and
  parse leniently: `fast-xml-parser` fails on the unescaped `&` in `msg`, so use a regex
  over `<add key="…" value="…"/>` tolerant of raw `&`. Keys are case-insensitive.
* Password: open with the password, re-encrypt the output with the same user password.
* Output handling: `overwriteSource`, `runAR` → `ctx.host.openPath`. No 3 s sleep.
* Errors → `ctx.ui.message('Účto QR - chyba', …)` + the `uctoqr.log` line format, exit 1.

Still needed: **yes, high**. QR payment on invoices is common and expected by Czech
customers.

## Test approach

* IBAN vectors: `19-2000145399/0800` → `CZ6508000000192000145399` (the ČNB example), an
  account without a prefix, and an account with leading zeros. Cross-check with an
  independent `ibantools` validation in the test only.
* SPD string snapshots for the invoice and PlatbaQR inputs, including diacritics removal
  and the 35-char RN cut.
* Decode test: render the output PDF page (pdfjs-dist + canvas), crop, decode with
  **`jsqr`** (dev dependency), and assert that the payload equals the SPD string.
* Geometry: QR bounding box at (left, bottom) with size 45·scale pt (version 7); the
  target page with an attachment of 2 pages and `pageDisplay` 1/2.
* Config parser: the real report output from the engine for a `{prik}` invoice, and a
  `msg` containing `&`.
* EngineDriver: invoice F10 → "Faktura PDF" with `QRkód` on → `{MAIL}\UCTOQR.PDF` has the
  code on page 1.
