# TOUTF8.EXE – convert a FAND (CP852) text file to UTF-8

`{tisk}\TOUTF8.EXE` (42 KB, 2010). A **native VB6** app (`frmMAIN`, `clsUTF8` with the
properties `FandText`/`UTF8Text`, `mdlGLOB`). Version comment: "určreno k programu účto;
převod fand -> utf8".

## How Účto invokes it

Wrapper `Utf8(InTxt, OutUtf)`, `UCTO2026_RDB/0501_P_Utf8.txt`:

```
FILE.Path:=PROGRAM.Path+'{TISK}\TOUTF8.EXE';
if filesize(FILE)=-1 then begin proc(Hlaseni,('Program '+FILE.Path+' neexistuje')); exit end;
InTxt:=Trail(InTxt); OutUtf:=Trail(OutUtf);
puttxt(UCTOTXT,('"'+XPath(InTxt)+'","'+XPath(OutUtf)+'"'));
proc(ExecWin,(FILE.Path,UCTOTXT.Path));
```

| | |
|---|---|
| Command line | the path of the parameter file `UCTOTXT.UUU` (no `$` guard) |
| Parameter file | one line `"<input path>","<output path>"` (read with VB `Input #`) |
| Input | a FAND report output (CP852) |
| Output | the same text as UTF-8 |
| Exit code | not checked. Callers read the output file afterwards. |

Callers (all XML that FAND writes as CP852 and that must be UTF-8):

| Chapter | Input → output | Feature |
|---|---|---|
| `MODUL06_PRO/0097_P_FakturaI.txt` | report `FakturaI` (`SEST` / `POSLSEST`) → `{MAIL}\<name>.isdoc` | **invoice export ISDOC**, single and batch |
| `UCTO2026_RDB/0613_P_EpoDS.txt` | report `EpoDS`/`EpoDS2` → `{AP02}\UCTODS.XML`/`UCTODS2.XML` | parameter file for the data-box sender (UctoDS/UctoDS2), only when the data-box password has diacritics (`nodiakr(pwd)<>pwd`) |
| `UCTO2026_RDB/0614_P_EpoFu.txt` | e-submission to the tax office | EPO XML |
| `MODUL97_PRO/0367_P_DsHOZ.txt`, `0387_P_DsPPZ.txt`, `0391_P_IczHOZ.txt`, `0393_P_IczPPZ.txt` | reports `HOZxml`/`PPPZxml` → `{MAIL}\HOZ_xxx.XML` / `PPZ_xxx.XML` | ČSSZ e-submissions "Data XML" |
| `MODUL03_PRO/0290_P_Vzp25I.txt`, `0298_P_DsVzp25.txt` | health-insurance reports | VZP XML |
| `MODUL08_PRO/0079_P_QRPlatEx.txt` | QR payment export | export |

## What it does (inferred)

* It reads the parameter line with `Input #` (two quoted fields), then reads the whole
  input file.
* It converts every byte through a **table of CP852 → UTF-8 byte sequences**. The binary
  contains about 128 literals such as `"Ã¼"`, `"Å¯"`, `"â"…`: two-byte sequences for
  letters, and three-byte `E2 …` sequences for box-drawing and other symbols. ASCII passes
  through unchanged.
* It writes the result with `Print #` into the output path. `Print #` without `;`
  appends CRLF, so the file probably ends with an extra `\r\n`. There is **no BOM**:
  there is no `EF BB BF` literal (inferred; verify against a real ISDOC export if
  possible).
* On error: a MessageBox "Chyba TOUTF8:\r\n<number> - <description>".

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/toutf8.ts`, key `toutf8.exe`. Effort **S**.

1. Read `ctx.mapPath(args[0])` and decode it as CP852. Parse one CSV line with two
   `"`-quoted fields. Map both paths.
2. Read the input bytes and decode them with the **existing CP852 table**:
   `decode852(bytes, true)` from `src/engine/console/cp852.ts`. It is a full 256-entry
   Unicode map with box drawing, and `keepControls=true` keeps CR/LF/TAB as control
   characters instead of turning them into CP437 glyphs.
   Encode as UTF-8 with no BOM and keep the line endings (CRLF) unchanged. Match the
   original's trailing CRLF only if the golden test shows it (ISDOC/XML parsers do not
   care either way).
3. On error, `ctx.ui.message('TOUTF8', 'Chyba TOUTF8:\n…', 'error')` and return 1. Otherwise
   return 0.

An alternative that removes the helper entirely: a FAND-level `Utf8` override, i.e. the
EXEC layer writes the file itself. That is not worth it; the helper is 20 lines.

Still needed: **yes, high**. ISDOC export and all ČSSZ/VZP XML submissions depend on it.

## Test approach

* Unit: a CP852 fixture with all 128 upper bytes → the expected UTF-8. Cross-check with
  `iconv -f cp852 -t utf-8`, which is the same mapping.
* The parameter file with Czech characters in the path (`C:\ÚČTO\{MAIL}\faktura č.1.isdoc`)
  is decoded as CP852 before mapping.
* An ISDOC round-trip: run `FakturaI` on the `{prik}` sample invoice in the engine, and
  parse the `.isdoc` with `fast-xml-parser`. It must be well-formed and contain `Účto` in
  UTF-8.
* Golden, if possible: run the real TOUTF8.EXE under Wine once on the fixture and compare
  bytes, which settles the trailing CRLF and BOM questions.
