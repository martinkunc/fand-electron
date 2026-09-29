# Utisk04.exe – "ÚčtoTisk3": print FAND text on a Windows printer

`{tisk}\Utisk04.exe` (419 KB, 2004). It is a **native Delphi** Win32 GUI app (VCL, `TPrinter`,
`TPrinterSetupDialog`), not .NET, so there is no decompiled source. Everything below comes
from the calling FAND code, FAND.CFG, the FPC FAND sources and `strings` (ANSI/CP1250),
and inferences are marked. Internal name `UTisk4`, form `TfrmDialog` ("Vyber tiskárnu"),
started minimized.

It is the **main print path of Účto on Windows**: FAND.CFG printer 0 `Windows3` is a
print-manager printer that ends in this exe (see [print-spool.md](print-spool.md)).

## How Účto calls it

| | |
|---|---|
| Command line | `$ <spool file>`. The `$` is a guard, as in all the Tichý helpers. |
| Working dir | the Účto program dir (FAND `OSShell`) |
| Input | the spool file: raw FAND print text, CP852, with dot commands and control characters |
| Settings | `UTISK98.INI` in the exe directory (shared with UTISK98/UTISK01) |
| Output | a printout on the Windows printer; the spool file is deleted afterwards (inferred from "Nemohu zrušit soubor") |
| Exit code | read by `TxtExitT` (`exitcode<>0` → "Volání ÚčtoTisku3 skončilo chybou N"); ignored by FAND's ToMgr path |

Three call sites:

1. **FAND ToMgr printer** (every normal print, F6). FAND.CFG `Windows3`: [15]
   `{tisk}\PRINT#.PRN`, [16] `{tisk}\UTISK04.EXE`, [17] `$ #` → `UTISK04.EXE $
   {tisk}\PRINTn.PRN` (`pas/PRINTTXT.PAS`, `ExecMgrPgm`).
2. **Text viewer F10 menu → "Windows 3"** (`UCTO2026_RDB/0171_P_TxtExitT.txt`):
   ```
   'Windows 3          -','tiskárna windows',Path<>~UCTOTXT2.Path!:
     begin if filesize(UTISK04)<=0 then proc(Hlaseni,('Program '+UTISK04.Path+' nenalezen')) else begin
       proc(Dotaz,(true,'Vytisknout celý text programem ÚčtoTisk3 (jen pro Windows)'));
       if PARAM3.Ano then begin TXT.Path:=Path; if filesize(TXT)>0 then begin
         copyfile(TXT,UCTOTXT2,nocancel);
         if exitcode=0 then begin proc(ExecWin,(UTISK04.Path,'$ '+UCTOTXT2.Path));
           if exitcode<>0 & ^PARAM3.DOSBox then proc(Hlaseni,('Volání ÚčtoTisku3 skončilo chybou '+str(exitcode,'_'))); exit; end
         else proc(Hlaseni,('Zatím nelze tisknout, ještě nebyl zpracován předchozí tiskový soubor'));
   ```
   `UCTOTXT2` is the catalog file `UCTOTXT2.UUU` (a relative name, in the program dir).
   `UTISK04.Path` is set in `KatalogG` (`0556_P_KatalogG.txt`):
   `PROGRAM.Path+'{TISK}\UTISK04.EXE'`. Since `copyfile` fails when the target is locked, the
   message "ještě nebyl zpracován předchozí tiskový soubor" implies that the helper keeps
   the file open or deletes it after printing.
3. **DOSBox bridge**: `U64.BAT` / `U8.BAT` start `{tisk}\caller {tisk}\ubox $ {dbx2} 1000 500
   utisk04.exe`. UBOX then runs `utisk04.exe $ {dbx2}\printN.prn` for every spooled file
   (see [ubox.md](ubox.md)).

Settings editor: text viewer F10 → "Parametry Ww E" → `proc(UTiskIni)`
(`0170_P_UTiskIni.txt`), and MODUL98 → printer → "parametry Tisku" → `UckoWini_P1`. Both
edit `UTISK98.INI` as a FAND "var file" (CSV, one record):

```
Šířka:F,3.0; Shora:F,1.2; Zleva:F,1.2; Tučně:F,1.0; Volba:F,1.0
```

| Field | Meaning (prompt text) | Default | Valid |
|---|---|---|---|
| Šířka | "Šířka tisku v % (max. 100)" | 98 | 30..150 |
| Shora | "Posun tisku shora v cm" | 0.42 | ≥0 |
| Zleva | "Posun tisku zleva v cm" | 0.00 | ≥0 |
| Tučně | "Tisk (0=normální, 1=tučný)" | 0 | 0/1 |
| Volba | "Volba tiskárny (ne=0, ano=1)" | 0 | 0/1 |

The shipped file is `98,0.42,,,\r\n`: FAND writes zero numbers as empty fields.
`UpgradeCfg` copies it from the previous Účto year.

## What it does (inferred from strings and the callers)

* It checks for `$` and reads `UTISK98.INI` (strings `UTISK98.INI`, `Pro tisk z programu
  ÚČTO.`, which is shown when started without `$`). If `Volba=1` it shows
  `TPrinterSetupDialog` "Vyber tiskárnu"; otherwise it uses the default printer.
* It reads the spool file (`Nemohu číst soubor …`, `Nemohu otevřít soubor …`), converts
  CP852 → CP1250 (a 128-byte translation table is visible at 0x5564D), and handles the
  dot commands **`.ti` (copies)** and **`.po` (left margin in characters)**. Other lines
  starting with `.` are skipped (the literals `.ti`, `.po` and `.`).
* It prints in **Courier New**, bold when `Tučně=1`. The font size is chosen so that the
  text fills `Šířka` % of the printable width. The origin is shifted by `Zleva`/`Shora`
  cm. (Inferred from the INI prompts; the exact column basis is unknown. The FPC
  `FandTxtToPdf` uses `max(line length, 96)` columns, which is a sensible stand-in.)
* `^L` (form feed) starts a new page, and lines past the bottom margin flow to the next
  page. FAND control characters (`^B` bold, `^S` underline …) are most likely dropped or
  mapped to font styles; **verify on Windows**.
* ESC during printing → "Tisk zrušen."; on errors it shows "Chyba: …". At the end it
  deletes the spool file ("Nemohu zavřít/zrušit soubor").

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/utisk04.ts`, keys `utisk04.exe`, plus the aliases
`utisk01.exe`, `utisk98.exe` (with `forceDialog` for UTISK01, see
[utisk01.md](utisk01.md)).

```ts
export async function utisk04(ctx: HelperContext, opts?: { forceDialog?: boolean }): Promise<number>
```

1. Args: `args[0]==='$'`, and `args[1]` is the spool path → `ctx.mapPath`. A missing `$`
   → `ctx.ui.message('ÚčtoTisk', 'Pro tisk z programu ÚČTO.')`, return 1.
2. INI: `<exeDir>/UTISK98.INI` (case-insensitive). Parse one CSV record with a `.`
   decimal point, where empty means 0, and apply the FAND defaults and valid ranges above.
3. Parse the text with the shared **`fandtext.ts`** parser (CP852 via
   `src/engine/console/cp852.ts`): the dot commands `.ti .po .pl .cp .he .fo .ff .nm`, the
   control characters as style toggles (`^B`/`^D` bold, `^W` italic, `^S` underline, `^E`
   compressed, `^Q` wide), `^L` page break, and `^P` binary runs skipped. This is the
   same parser that FAND2PDF and PDFTISK2 use.
4. Render it in one of two ways:
   * **Primary: Chromium print.** Build an HTML document (`<pre>` per page, CSS
     `@page { size: A4; margin: <Shora>cm … <Zleva>cm }`, the embedded **Liberation
     Mono** font, which is metric-compatible with Courier New and has full Latin-2 cover,
     `font-weight: bold` if `Tučně`, and a font size computed from `Šířka`). Print it
     through the host: `ctx.host.printHtml(html, { silent: !Volba && !forceDialog,
     copies: ti })`. In Electron this is a hidden `BrowserWindow` +
     `webContents.print({ silent, deviceName, copies, margins })`.
   * **Alternative: PDF.** `textpdf.render()` → `ctx.host.printPdf(pdf, {dialog})`. On
     Windows use `pdf-to-printer` (bundled SumatraPDF); on macOS/Linux use `lp` (CUPS).
     Use this for headless mode and when no printer is present (open the PDF instead).
5. Delete the spool file after a successful print, as the original does. Return 0, or 1 if
   the user cancelled or the print failed ("Tisk zrušen." / "Chyba tiskárny: …").

The worker blocks until the promise resolves (the common EXEC contract). The print dialog is
modal in the host.

Still needed: **yes, top priority**. Without it, F6 printing, the most used function,
does nothing.

## Test approach

* Parser golden tests in `test/fixtures/helpers/utisk04/`: spool files with `.po 5`, `.ti
  2`, `^B…^B`, `^L`, a 150-column line, and all Czech CP852 letters. Assert the page and
  line model (JSON snapshot).
* INI tests: the shipped `98,0.42,,,`, an empty file (defaults), and out-of-range values
  (fallback as in `UTiskIni`).
* Render snapshot: the generated HTML (deterministic) and page count. For the PDF path,
  extract the text with `pdf-lib`/`pdfjs-dist` and compare it.
* Host mock: assert `printHtml` options (`silent`, `copies`) for `Volba=0/1`, and that the
  spool file is gone afterwards.
* Manual: print a Účto "Kniha dokladů" on a real printer on Windows, macOS and Linux, and
  compare against the original UTISK04 output (Wine or a VM) for margins and scale.
