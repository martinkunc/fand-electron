# FAND.CFG printers and the print spool (`{tisk}\PRINT#.PRN`, `{dbx2}\print#.prn`)

This is not an exe. It is the FAND mechanism behind the `UTISK*` and `UBOX` helpers. A
FAND.CFG printer whose TimeOut byte is **253** is a *print manager* printer (`ToMgr`).
FAND does not send the text to LPT. It copies the whole print job to a spool file and
runs an external program on it. Účto uses this for every "print" on Windows, so this is
the main print path of the application.

Paths are relative to `vendor/extracted/app`.

## Printer table in FAND.CFG

Source: `RdPrinter` in `vendor/reference/standa_pcfand/pas/RUNFAND.PAS`, and the constants
in `BASE.PAS` (`prName=0 … prClose=32`, `prMgrFileNm=15`, `prMgrProg=16`,
`prMgrParam=17`).

Layout, after the fixed header, colours, fonts and the sort/upcase tables:

```
prMax: byte
repeat prMax times:
  up to 33 × (len: byte, bytes[len])     -- strings 0..32; a len byte 0xFF ends the list early
  0xFF                                   -- terminator (mandatory)
  Typ: char   Kod: char   Lpti: byte   TmOut: byte
```

`TmOut` flags: 255 → `OpCls`, 254 → `ToHandle` (write to `LPTn.PRN`), 253 → `ToMgr`. Each
flag resets `TmOut` to 0. `Kod` selects the code-page translation for bytes ≥ 0x80
(`TranslateCodePage` in `OBASE.PAS`): `' '` none, `K`/`L` Kamenický↔Latin-2, `k`/`l`
strip diacritics.

The printers Účto ships (decoded with a small Python script over the files):

| File | # | Name | Typ | Kod | TmOut | [15] | [16] | [17] |
|---|---|---|---|---|---|---|---|---|
| `FAND.CFG`, `FANDCFG.25`, `FANDCFG.26` | 0 | `Windows3` | ` ` | ` ` | **253** | `{tisk}\PRINT#.PRN` | `{tisk}\UTISK04.EXE` | `$ #` |
| | 1 | `HPDJ Lat` | L | ` ` | 14 | PCL reset `ESC E ESC&l26a1E ESC(17U ESC(s0p3T` | | |
| | 2 | `HPLJ Lat` | L | ` ` | 14 | PCL (like HPDJ, typeface 4099) | | |
| | 3 | `EPS  Lat` | M | ` ` | 14 | ESC/P codes | | |
| | 4 | `IBM  Lat` | M | ` ` | 14 | IBM Proprinter codes | | |
| `{dbx1}\FAND.CFG`, `{dbx1}\FANDCFGD.2x` (DOSBox) | 0 | `DOSBox` | M | `l` | **253** | `{dbx2}\print#.prn` | `nic.exe` | (empty) |

Strings 1–14 are the on/off pairs that the text control characters are translated to
(`CtrlToESC`): `^S` underline, `^W` italic, `^Q` wide, `^D` double-strike, `^B` bold,
`^E` compressed, `^A` elite, `^X`/`^V`/`^T` user 1–3. For `Windows3` they are all empty.

The config editor (MODUL98 `UckoTisk_F10`, `0019_P_UckoTisk_F10.txt`) writes exactly these
values for a Windows printer. "Absolutní/Relativní cesta" sets `Reset` (= [15]) to
`{tisk}\PRINT#.PRN`, and `DelkaStr` (= [16]) to `UTISK04.EXE`, `UTISK01.EXE` or
`UTISK98.EXE`, depending on whether the name is `Windows3`, `Windows2` or anything else.
`FandCfg25_26` (`MODUL98_PRO/0052`) renames an old `Windows1` printer to `Windows3` +
`UTISK04.EXE` on vDos and Windows 7/8+.

## What FAND does with a ToMgr printer

`PrintTxtFBlk` / `CopyToMgr` / `ExecMgrPgm` in `pas/PRINTTXT.PAS`:

1. FAND reads the leading dot commands (`.cp .pl .po .ti .he .fo .ff .nm`) as usual. At the
   first non-dot line it checks `printer[prCurr].ToMgr`, and if set it calls `CopyToMgr`
   and stops. The job is **not** rendered by FAND: no page breaking, no `.ti` repeat, no
   control-code translation.
2. `OpenMgrOutput`: `prFileNr := (prFileNr+1) mod 100`. The `#` in [15] is replaced with
   `str(prFileNr)`, so the files are `PRINT1.PRN`, `PRINT2.PRN` … `PRINT99.PRN`,
   `PRINT0.PRN` (not zero-padded). The file is created with overwrite, relative to the
   current directory (the Účto program directory).
3. The **raw** text is copied into it: the whole report work file, or the marked block for
   "print block". This is CP852 with FAND control characters (`^B`, `^S`, `^L` …) and the
   dot-command lines kept.
4. `ExecMgrPgm`: the program is [16], and the parameters are [17] with `#` replaced by the
   spool path, e.g. `{tisk}\UTISK04.EXE $ {tisk}\PRINT3.PRN`. It runs through `OSShell`
   (synchronous, with a 1-line window saved and restored).
5. The FPC port adds a fallback: if the program returned a non-zero exit code, it
   converts the spool file itself with `FandTxtToPdf` (`pas/FANDPDF.PAS`) and delivers the
   PDF with `FandDeliverPdf`. Delivery is `$FAND_PRINT` = `open` (xdg-open/open), `lpr`
   (with `$FAND_PRINTER`) or `none`.

In DOSBox mode the program is `nic.exe`, a no-op stub (in the app root). The real work is
done by `UBOX` on the Windows side, which watches `{dbx2}` for `*.PRN` (see
[ubox.md](ubox.md)).

## How Účto uses it

* Every F6/"Tisk" of a report or text (`TxtExitT` → `setkeybuf('\0\64')` "Celý soubor
  F6", the report output window and so on) goes to the current FAND printer. On Windows
  installs that is printer 0 = `Windows3`, which ends in `UTISK04.EXE`. See
  [utisk04.md](utisk04.md).
* `TxtExitT` (`UCTO2026_RDB/0171_P_TxtExitT.txt`) inserts `.po N` (left margin) and
  `.ti N` (copies) lines at the start of the text on request ("Levý okraj .po", "Počet
  výtisků .ti"). These only take effect in the helper, because FAND does not render ToMgr
  jobs.

## Replacement design

This belongs in the engine, not in a helper module:

* **Keep the FAND.CFG parser faithful** (`src/engine/fand/` next to the other codecs),
  including strings 15–17 and the `TmOut` flags, so that `SETPRINTER`, the printer menu
  (`spec.ChoosePrMsg`) and the MODUL98 config editor keep working on the real file.
* **Implement `ToMgr` exactly as FAND does**: counter, `#` substitution, a raw copy to the
  mapped host path, then dispatch [16] + [17] through the EXEC layer. [16] is
  `{tisk}\UTISK04.EXE`, which the helper registry resolves to the `utisk04` module. Any
  other program (`nic.exe`, `UTISK01`, `UTISK98`) resolves too: `nic.exe` → no-op
  returning 0, the others → aliases of `utisk04` (see their docs).
* **Fallback like the FPC port**: an unknown program or a non-zero exit code →
  `textpdf.render(spool)` (the shared FAND-text → PDF renderer, see
  [fand2pdf.md](fand2pdf.md)) → `ctx.host.openPath(pdf)`, so the user can always print
  from a PDF viewer.
* **Printers LPT/ToHandle (`HPDJ`/`HPLJ`/`EPS`/`IBM`)**: without a parallel port, write
  `LPTn.PRN` as the FPC port does (`OpenLPTHandle` → `LPT1.PRN`). Optionally offer "raw
  print to a CUPS/Windows queue" later. This is low priority, since nobody has an LPT
  printer any more.
* **DOSBox spool (`{dbx2}`)**: obsolete. Our runtime never sets `PARAM3.DOSBox` (env
  `uctodbox` is not set), so `ExecWin` never writes `RUNnnn.BAT` and no `print#.prn`
  appears. We must not ship `{dbx1}\FAND.CFG` as the active config.
* The spool files are left in `{tisk}` as in the original. UTISK04 deletes them after
  printing, and our helper does the same.

Priority **high**, effort **S** in the engine: the config reader is shared with the
colours and the rest, and the ToMgr path is about 40 lines.

## Test approach

* Unit test: parse `FAND.CFG`, `FANDCFG.26` and `{dbx1}/FAND.CFG` from the pristine app,
  and assert the table above: names, `TmOut` 253/14, strings 15–17, `Kod` `l` for DOSBox.
* Round-trip: parse → serialize gives identical bytes (the MODUL98 editor rewrites
  FAND.CFG through `UlozCFG`).
* Engine test with EngineDriver in a `work/tmp-<name>/` copy: open a text in the viewer,
  F10 → "Celý soubor", with the `utisk04` helper stubbed. Assert that
  `{tisk}\PRINT1.PRN` holds the raw CP852 bytes, including `.po`/`.ti` lines and `^B`, and
  that the stub got `['$', '<host path of PRINT1.PRN>']`. A second print → `PRINT2.PRN`.
* Fallback test: the stub returns 1 → a PDF next to the spool file and an `openPath` call
  are recorded.
