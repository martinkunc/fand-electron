# UTISK01.EXE – "ÚčtoTisk2": print FAND text with a printer list

`{tisk}\UTISK01.EXE` (38 KB, 2003). It is a **native VB6** app (`D:\VB6pgm\UU031018\utisk01.vbp`,
"Autor: Pavel J. Panenka 2001"), version 5.02.0001. Its version comment reads "S výběrem
tiskárny ze seznamu" ("with printer selection from a list"). There is no .NET source; the
behaviour below comes from UTF-16 string literals and the callers.

## How Účto calls it

| | |
|---|---|
| Command line | `$ <file>` |
| Input | a copy of the viewed text in `UCTOTXT2.UUU` (CP852 FAND text) |
| Settings | `Utisk98.ini` (the same `UTISK98.INI` as UTISK04) |
| Exit code | `exitcode<>0` → "Volání ÚčtoTisku2 skončilo chybou N" |

1. Text viewer F10 → **"Windows 2"** (`UCTO2026_RDB/0171_P_TxtExitT.txt`). This is the same
   code as "Windows 3", but with `UTISK01.Path` and the prompt "Vytisknout celý text
   programem ÚčtoTisk2 (jen pro Windows)".
2. As a FAND.CFG print-manager program, when the user renames printer 0 to `Windows2` in
   the MODUL98 config editor (`UckoTisk_F10`: `Věta.Nazev=~'Windows2':'UTISK01.EXE'`).
   Then FAND runs `{tisk}\UTISK01.EXE $ {tisk}\PRINTn.PRN`.

`UTISK01.Path := PROGRAM.Path+'{TISK}\UTISK01.EXE'` (`KatalogG`).

## What it does (inferred)

String literals: `Utisk98.ini`, `Courier New`, `.po`, `.ti`, `.`, `' - výchozí'`
(default-printer marker in a list box `lstPrinters`), `Chybí písmo `, `Chyba tiskárny: `,
`Soubor … nenalezen: `, `Tisk stornován.`, and `Pouze pro tisk z programu ÚČTO` (shown when
started without `$`).

* It shows a form with the list of installed printers (the default marked " - výchozí"),
  so the user picks the printer every time.
* It prints the text in Courier New using the `Utisk98.ini` parameters (width %, top/left
  offset in cm, bold), handles `.po` / `.ti`, and skips other dot lines. It is the same
  engine as UTISK04, only in VB6. "Chybí písmo" appears when Courier New is missing.

## Replacement design

No separate module. Register `utisk01.exe` as an alias of `utisk04` with
`{ forceDialog: true }`, which always shows the host print dialog: in Electron,
`webContents.print({ silent: false })` has a printer list. Everything else, including the
INI, the dot commands and the spool deletion, is shared (see [utisk04.md](utisk04.md)).

Still needed: only as an alias, **low priority**, effort **S**. The FAND menu item stays
reachable, so it must not fail with "nenalezen". Keep the `.exe` in the app copy, or make
`filesize()` report a virtual size for registered helpers.

## Test approach

* Registry test: `utisk01.exe` resolves to `utisk04` with `forceDialog`.
* Host mock: `printHtml` is called with `silent:false` even when `Volba=0`.
* EngineDriver: text viewer F10 → "Windows 2" → confirm → assert the helper invocation
  with `$ <host path of UCTOTXT2.UUU>`.
