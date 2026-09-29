# UctoExp.exe – convert an exported DBF file to an Excel XLSX sheet

`{ap04}\UctoExp.exe` (1.4 MB, .NET Framework 4.0 WinExe, **x86 only**, assembly `UctoExp`
1.0.0.1, title "UcotExp", "Export do Microsoft Excel", © 2023 Martin Zemek). It reads the
DBF file written by Účto's "Export do DBF", then writes the same table as an `.xlsx`
workbook next to it. The SpreadsheetLight library is merged into the exe, and it writes
through `DocumentFormat.OpenXml.dll` (6 MB, shipped in `{ap04}`).
Decompiled source: `work/decompiled/{ap04}_UctoExp/` (the app code is in `UctoExp/` and
`UctoExp.Helpers/`; `SpreadsheetLight*/` is the library).

## How Účto calls it

| | |
|---|---|
| Wrapper | procedure `UctoExp(dbf)`, `UCTO2026_RDB/0639_P_UctoExp.txt` |
| Parameter file | report `UctoExp` (`UCTO2026_RDB/0638_R_UctoExp.txt`), written to `{AP04}\UctoExp.xml` |
| Command line | none |
| Working dir | Účto's current dir. The exe resolves `UctoExp.xml` through `APP_CONFIG_FILE`, relative to its AppDomain base, which is the exe dir |
| Input | the DBF file `EXPDBF.Path`, written by FAND just before the call |
| Output | `<same path>.XLSX` (`replace('.DBF',dbf,'.XLSX','u')`) |
| Sync | `ExecWin(EXE,'')`: a plain `exec` on Windows. In DOSBox/vDos mode a `RUNnnn.BAT` is queued instead. There is **no** `WaitFor` |
| Result | none is read back. Účto reports the file name whether or not the XLSX was created |
| Exit code | not used |

```
(dbf:string) begin
  TXT.Path:=PROGRAM.Path+'{AP04}\UctoExp.xml'; puttxt(TXT,'');
  PARAM3.TTT:=dbf+'\13'+replace('.DBF',dbf,'.XLSX','u')+'\13';
  report(,UctoExp,assign=TXT);
  EXE.Path:=PROGRAM.Path+'{AP04}\UctoExp.exe';
  if filesize(EXE)=-1 then begin proc(Hlaseni,('Program '+EXE.Path+' pro export do Excelu nenalezen')); exit end;
  proc(ExecWin,(EXE.Path,''));
end;
```

The parameter file is written by report `UctoExp` in FAND's CP852. The declaration says
`utf-8`, but the values are DOS paths, which are ASCII in practice:

```xml
<?xml version="1.0" encoding="utf-8" ?>
<configuration>
  <appSettings>
    <add key="inputFilename" value="C:\UCTO2026\{PRIK}\ADRESY.DBF"/>
    <add key="outputFilename" value="C:\UCTO2026\{PRIK}\ADRESY.XLSX"/>
    <add key="runAfterDone" value="false"/>
  </appSettings>
</configuration>
```

### Call sites

`UctoExp` runs only from the generic DBF export in `MODUL99`, and only when
**Ostatní → Parametry → Program → "Při Exportu do DBF generovat … Excel tabulka XLSX"**
(`PARAM3.ExpDbfXls`, default **true**, `UCTO2026_RDB/0033_E_ParPgm.txt`) is set:

* `MODUL99_PRO/0007_P_ExportDBF.txt` (`ExportDBF`, reached through `UCTO2026_RDB/0144_P_ExportDBF.txt`
  `call(MODUL99,ExportDBF)`). This is the "Export do DBF" item in the Shift+F6 menus of
  almost every file: Adresy, Deník, Faktury, Mzdy, Pracov, DPH, Majetek, Kniha jízd, Úkoly,
  Tržby … (about 40 `*SF6*`/`*Ex` chapters reference `ExportDBF`).
* `MODUL99_PRO/0008_P_ExportDBFx.txt` (`ExportDBFx`): the same flow for ADRESY with an index.

The flow is:
1. `ExpDeklCesta` (`0009`): the user picks the fields (F8) and the target `*.DBF` path,
   which must end in `.DBF` and pass `JménoOK` (an 8.3 name).
2. A dynamically compiled FAND procedure declares `EXPDBF:file.DBF[<fields>]` and copies the
   records (`eRec:=sRec; writerec`). FAND writes a dBASE III file (see below).
3. Optionally, it writes a CSV next to it (`ExpDbfCsv`, done by FAND itself).
4. `if PARAM3.ExpDbfXls then proc(UctoExp,(EXPDBF.Path))`.
5. A message box: "Proběhl export do souboru … .DBF / .CSV / .XLSX, počet vět: N".

## Input: the DBF that FAND writes

FAND's `WrDBaseHd` (`vendor/reference/standa_pcfand/pas/FILEACC.PAS`) writes:

* Version byte `0x03` (no memo), `0x83` (memo in `.DBT`) or `0xF5` (FoxPro `.FPT` memo).
  The date of the last update is today. The header is 32 bytes, then 32-byte field
  descriptors, then `0x0D`. The data ends with `0x1A`. The language-driver byte (offset 29)
  stays 0.
* The field names are the FAND names in upper case, truncated to 11 bytes. They are
  **CP852** and may contain Czech letters (`upcase` changes only a–z, so `DatumPoř` becomes
  `DATUMPOř`).
* Types: `F` becomes `N` with `Dec=M`, `N` becomes `N`, `A` becomes `C`, `D` becomes `D`
  (`YYYYMMDD`), `B` becomes `L`, and `T` becomes `M` (memo).
* Text content is **CP852**, which is FAND's internal code page.

## What it does (decompiled C#)

1. `Program.Main`: sets `APP_CONFIG_FILE=UctoExp.xml`. If the file does not exist, it shows
   the MessageBox "Chyba: Soubor se vstupními parametry nebyl nalezen. …" and exits.
2. `ConfigHelper`: reads `inputFilename`, `outputFilename` and `runAfterDone`
   (`bool.TryParse`, default false).
3. `DbfImportService.GetDataFromDbfFile`: checks that the file exists ("Soubor … nebyl
   nalezen."). It then opens it through **Jet OLEDB 4.0** (`Provider=Microsoft.Jet.OLEDB.4.0;
   Data Source=<dir>; Extended Properties=dBASE IV`) with `SELECT * FROM <file name>`, filling
   a `DataTable`. This is why the exe is x86: Jet exists only as a 32-bit component. Because
   the language-driver byte is 0, Jet decodes text with the system OEM code page, which is
   CP852 on Czech Windows. Types (inferred from how Jet maps dBASE types): `C`/`M` become
   String, `N` becomes Double (with or without decimals), `D` becomes DateTime, and `L`
   becomes Boolean. Jet right-trims `C` values (inferred).
   An unused alternative, `GetDataFromDbfFileMyClass`, parses the DBF itself with
   `DBFReader(filename, CP852)`.
4. If the table has 0 rows, it throws "Vstupní DBF soubor neobsahuje žádná data. Aplikace
   bude ukončena.". Any error shows a MessageBox titled `UctoExp [1.0.0.1]` with
   "Chyba: <msg> Aplikace bude ukončena.", and the XLSX is not written.
5. `ExcelExportService.ExportToExcel`: `new SLDocument()` (one sheet, SpreadsheetLight
   default name `Sheet1`, default style Calibri 11), then
   `ImportDataTable(1, 1, dt, includeHeader: true)`:
   * Row 1 holds the column names, which are the DBF field names.
   * Rows 2… hold the values: strings as strings, doubles as numbers, dates as date
     serials, booleans as booleans, and DBNull as empty cells.
   * For each `DateTime` column, `SetColumnStyle(col, FormatCode "dd.mm.yyyy")`.
   * For each `Double` column, `SetColumnStyle(col, FormatCode "#,##0.00")`. This applies
     to every numeric column, including integers such as the record number.
   * No auto-fit, freeze panes, filter or column widths.
   * `SaveAs(outputFilename)` overwrites the file if it exists.
6. `runAfterDone=true` would call `Process.Start(xlsx)`. Účto always writes `false`.

UI: none on success. MessageBoxes appear only on errors.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uctoexp.ts`, key `uctoexp.exe`. The EXEC layer calls it
in-process and synchronously, so the XLSX already exists when Účto shows "Proběhl export".

* **Config**: find `<exeDir>/UctoExp.xml` case-insensitively, decode it as CP852
  (`iconv-lite`, as FAND writes it), and parse the flat `<add key value>` pairs with
  `fast-xml-parser`. Share this `appSettings` reader with the other .NET helper
  replacements (`src/engine/helpers/lib/appconfig.ts`). Map both DOS paths with
  `ctx.mapPath`.
* **DBF reader**: a small reader of our own in `src/engine/helpers/lib/dbf.ts`, about
  120 lines. Its reference is `ACCESS.PAS DBaseHd/DBaseFld`, which is already mirrored in
  `src/engine/pas/access.ts`. It reads the header and descriptors and skips deleted records
  (`*`). It decodes `C`/field names with `decode852` (`src/engine/console/cp852.ts`),
  parses `N` numbers from ASCII (blank means null), `D` as `YYYYMMDD` (blank means null)
  and `L` as `T/t/Y/y`, `F/f/N/n`, or `?`/blank as null. `M` memos come from `.DBT` (dBASE
  III 512-byte blocks, terminated by `0x1A 0x1A`) or `.FPT` (FoxPro block header), with
  the memo file name taken from the DBF name. Do not use the npm package `dbffile`: FAND's
  files use CP852, carry a zero language-driver byte, and store non-ASCII field names, so
  we would have to patch it anyway.
* **Types, the way Jet exposes them**: every `N` column is a number and gets
  `#,##0.00`; `D` is a date with `dd.mm.yyyy`; `L` is a boolean; `C` is a string,
  right-trimmed; `M` is a string.
* **XLSX**: use `exceljs` (MIT). Create one worksheet named `Sheet1`. Row 1 holds the
  header names as strings. Write data rows with native types. Set
  `column.numFmt = '#,##0.00'` or `'dd.mm.yyyy'`. Write dates as JS `Date` at UTC midnight,
  so that exceljs does not shift them across time zones. Then call `workbook.xlsx.writeFile`.
  `exceljs` is the best-maintained writer that supports column styles. `xlsx`/SheetJS CE
  would also work, but its npm build is outdated.
* **Errors**: show the original texts through `ctx.ui.message` (a FAND-style box titled
  "UctoExp"), e.g. "Vstupní DBF soubor neobsahuje žádná data." and "Soubor … nebyl
  nalezen.". Return 0 (Účto ignores the exit code).
* `runAfterDone=true`: `ctx.host.openPath(xlsx)` (Electron `shell.openPath`). Účto never
  sets it, but the cost is one line.
* **Optional improvement**: auto-fit column widths from the longest value, and freeze the
  header row. These are cosmetic. Keep them behind a constant so golden tests can stay
  exact.
* Still worth replacing: **yes**. `ExpDbfXls` is on by default, and users expect the
  `.XLSX` file. A missing replacement would silently leave only the DBF/CSV.

## Test approach

* **Unit, DBF reader**: generate DBF fixtures with the engine itself (the `ExportDBF`
  procedure on sample data in `{prik}`: ADRESY with Czech names, DENIK with `F` amounts and
  dates, UKOLY with a `T` memo). Also hand-build a 3-record DBF in the test with a deleted
  record, a blank date and a CP852 field name. Assert the decoded rows.
* **Unit, XLSX**: write, then read back with `exceljs`. Check the header row, cell types
  (number, Date, boolean, string), `numFmt` per column, the sheet name `Sheet1`, and the
  row count. A zero-row DBF must produce no file and show the error message.
* **Golden check (manual, once)**: run the original UctoExp.exe under Windows or Wine+Jet
  on the same DBF, then compare cell values and formats (not bytes) with our output.
* **Engine integration** (`EngineDriver`): Adresy → Shift+F6 → Export do DBF, select
  fields, and confirm. Expect the "Proběhl export …XLSX" message, and the `.XLSX` exists
  in the temp copy under `work/tmp-*/`.
