# utisk98.exe – "ÚčtoTisk1": legacy Win16 text printer

`{tisk}\utisk98.exe` (17 KB, 2004). It is a **16-bit NE executable, Visual Basic 3**
(`VBRUN300.DLL`, `CMDIALOG.VBX`, form `UTISK98.FRM`, "Autor: Pavel J. Panenka"). It cannot
run on 64-bit Windows at all, and has not been used in practice for many years. The
behaviour below comes from strings and the callers.

## How Účto calls it

| | |
|---|---|
| Command line | `$ <file>` |
| Input | `UCTOTXT2.UUU` (a copy of the viewed text, CP852) |
| Settings | `Utisk98.ini` (`UTISK98.INI` in `{tisk}`, which it originally owned; UTISK01/04 reuse it) |
| Exit code | `exitcode<>0` → "Volání ÚčtoTisku1 skončilo chybou N" |

* Text viewer F10 → **"Windows 1"** (`UCTO2026_RDB/0171_P_TxtExitT.txt`). The item is
  **hidden** on DOSBox, vDos and Windows 7/8+:
  `^(PARAM3.DOSBox | PARAM3.vDos | PARAM3.WinVer in ['7','8'])`. The prompt is
  "Vytisknout celý text programem ÚčtoTisk1 (jen pro Windows)".
* As a print-manager program for any FAND.CFG printer not named `Windows2`/`Windows3`
  (`UckoTisk_F10`: `else:'UTISK98.EXE'`). On vDos and Win 7/8+, `FandCfg25_26` rewrites a
  `Windows1` printer to `Windows3`/`UTISK04.EXE` automatically.
* `UTISK98.Path := PROGRAM.Path+'{TISK}\UTISK98.EXE'` (`KatalogG`). The INI path is
  derived from it: `UTiskIni` uses `replace('UTISK98.EXE',UTISK98.Path,'UTISK98.INI')`.

## What it does (inferred)

Strings: `Utisk98.ini`, `Courier New CE`, `.po`, `.ti`, `Chybí písmo `, `Chyba tiskárny:
`, `Soubor … nenalezen: `, `Tisk stornován.`, `Pouze pro tisk z programu ÚČTO`, and a
`CommonDialog` (`PrtDialog`). It is the Win3.x predecessor of UTISK01/04: it prints the
text in "Courier New CE" with the INI parameters, and shows the common print dialog
when `Volba=1`.

## Replacement design

Register `utisk98.exe` as an alias of `utisk04` with the same options, so an old
FAND.CFG still prints. It needs no own logic. Whether the "Windows 1" item is visible
depends on the `PARAM3.WinVer` that `Program1`/`DosWin` derive from our environment. It is
hidden only for `7`/`8`. Either way it must work if a user reaches it.

Still needed: **low**, effort **S** (alias only). The Win16 binary is obsolete.

## Test approach

* Registry test: `utisk98.exe` → `utisk04`.
* EngineDriver: when the engine's `WinVer` is not `7`/`8`, text viewer F10 shows
  "Windows 1", and choosing it calls the helper with `$ <UCTOTXT2.UUU>`.
