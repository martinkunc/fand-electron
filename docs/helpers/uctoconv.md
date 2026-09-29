# UctoConv.exe – ČSSZ "seznam zaměstnanců" XML → CSV (import of OIČ and ID PPV)

`{ap05}\UctoConv.exe` (35 KB, .NET Framework 4.8 WinExe, assembly `UctoConv` 0.0.0.1,
"Aplikace pro převod xml do csv", © 2026 Martin Zemek / Tichý a spol.). It converts the
employee list that the employer downloads from the ČSSZ e-Portal (XML root
`ExportZamestnancu`) into a flat CSV that FAND can load with `copyfile(…/var, …)`.
Decompiled source: `work/decompiled/{ap05}_UctoConv/`.

## How Účto calls it

| | |
|---|---|
| Wrapper | procedure `UctoConv(InXml, OutCsv)`, `UCTO2026_RDB/0646_P_UctoConv.txt` |
| Parameter file | report `UctoConv` (`0645_R_UctoConv.txt`), written to `{AP05}\UctoConv.XML` (`replace('.EXE',EXE.Path,'.XML','u')`) |
| Command line | none |
| Input | the XML file picked by the user (any path) |
| Output | `OutCsv` = `ZAMOIC.CSV` next to the `ZAMOIC` data file (`replace('.094',ZAMOIC.Path,'.CSV')`), CP852; log `{AP05}\Logs\UctoConv.txt` |
| Sync | `ExecWin` (blocking on Windows); `WaitFor(OutCsv)` only under DOSBox/vDos (`PARAM3.SyncW`) |
| Result | none checked. `PARAM3.Ano` is set `true` **before** the call; Účto then loads whatever the CSV contains |
| Exit code | 0 OK, 1 error (not read by Účto) |

```
(InXml:string; OutCsv:string) var ap05,logs:string; begin
ap05:=PROGRAM.Path+'{AP05}\'; logs:=ap05+'Logs\';
EXE.Path:=ap05+'UctoConv.exe';
if filesize(EXE)=-1 then begin proc(Hlaseni,('Program '+EXE.Path+' nenalezen')); PARAM3.Ano:=false; exit end;
PARAM3.TTT:=InXml+'\13'+OutCsv+'\13'+logs+'UctoConv.txt\13';
TXT.Path:=replace('.EXE',EXE.Path,'.XML','u'); report(,UctoConv,assign=TXT);
FILE.Path:=OutCsv; puttxt(FILE,'');
PARAM3.Ano:=true; proc(ExecWin,(EXE.Path,''));
if PARAM3.SyncW then proc(WaitFor,(OutCsv,'UctoConv.exe')); end;
```

Parameter file (`encoding="ibm852"`, matching the CP852 FAND writes):

```xml
<?xml version="1.0" encoding="ibm852" ?>
<configuration>
  <startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" /></startup>
  <appSettings>
    <add key="inputXmlFileName" value="C:\Users\…\Downloads\zamestnanci.xml"/>
    <add key="outputCsvFileName" value="C:\UCTO2026\FIRMA\ZAMOIC.CSV"/>
    <add key="logFilename" value="C:\UCTO2026\{AP05}\Logs\UctoConv.txt" />
  </appSettings>
</configuration>
```

Optional keys that the exe reads but Účto does not write: `CsvDelimiter` (default `,`),
`CsvEncoding` (default `852`), `CsvIncludeHeader` (read, unused).

### Feature / menu
MODUL94 (JMHZ) → **Import OIČ a ID PPV** (`MODUL94_PRO/0010_P_ImportOic.txt`):

```
'Načíst data pro import   -': begin
  proc(Dotaz,(true,'Načíst data z .XML do pracovního souboru pro import'));
  if PARAM3.Ano then begin
    ODKUD.Path:=replace('.094',ZAMOIC.Path,'.CSV');
    proc(UctoFOD,('','Soubory *.XML|*.XML',false,true,true,false,'Import OIČ'));   { file dialog, UctoFoD.exe }
    csvCSSZ:=copyline(PARAM3.TTT,1);
    if PARAM3.Ano then begin
      proc(HlaseniWw,(' '+csvCSSZ+' ->\13'+' '+ODKUD.Path));
      proc(UctoConv,(csvCSSZ,ODKUD.Path));
      if PARAM3.Ano then begin
        copyfile(ODKUD/var,ZAMOIC); deleterec(ZAMOIC,1);          { drop the CSV header row }
        forall VetaP/@ % do ... pair by RodCis / EvCisS → VetaO.Cislo ...
        proc(Hlaseni,('Pracovní soubor ZAMOIC, počet zaměstnanců: '+str(ZAMOIC.nrecs,'0')));
```

The menu also has "e-Portál ČSSZ" → `https://eportal.cssz.cz/web/portal/-/sluzby/seznam-zamestnancu`
(where the XML comes from), "Data pro import", "Párování zaměstnanců", "Kontrolní sestava",
and "Import do účta" (writes `PRACOV.OIC` and `PRACOV.PPV`).

`ZAMOIC` (`MODUL94_PRO/0005_F_ZAMOIC.txt`) takes the CSV columns positionally:
`RodCis:A,10; Prijmeni:A,20; Jmeno:A,20; VarSym:A,20; ZamDo:A,10; DrCinKod:A,2;
DrCinNaz:A,30; ZMR:B; IdZam:A,100; OIC:A,10; Cislo:N,5; Pocet:F,2.0`.

## What it does (decompiled C#)

1. `APP_CONFIG_FILE=UctoConv.xml` (resolved against the exe dir). `AppConfig.Initialize`:
   each of the three paths must be non-empty ("<popis>: cesta není nastavena."). Relative
   paths are resolved against the exe dir, missing directories are created, and a
   write-probe (`FileMode.Append`) runs on **all three**, including the input XML (so a
   read-only input fails with "XML soubor: nelze zapisovat do souboru …").
2. Logs `Start UctoConv - verze:0.0.0.1`. Deletes the old CSV.
3. `XmlSerializer<ExportZamestnancuType>` deserializes the input. The encoding comes from
   the XML declaration (UTF-8 in ČSSZ exports). Shape (no namespace, element names = C#
   property names):
   ```xml
   <ExportZamestnancu>
     <DatumGenerovani>2026-01-15T10:00:00</DatumGenerovani>
     <Zamestnanci>
       <Zamestnanec>
         <RodneCislo>8001011234</RodneCislo>           <!-- or <EvidencniCisloPojistence> -->
         <Prijmeni>Novák</Prijmeni>
         <Jmeno>Jan</Jmeno>
         <VariabilniSymbol>1234567890</VariabilniSymbol>
         <PojistnyVztahDo>2026-12-31</PojistnyVztahDo> <!-- xs:date, optional -->
         <KodDruhuCinnosti>1</KodDruhuCinnosti>
         <NazevDruhuCinnosti>Pracovní poměr</NazevDruhuCinnosti>
         <ZMR>N</ZMR>                                   <!-- enum N | A -->
         <IdZamestnani>123456789</IdZamestnani>
         <OIC>1234567890</OIC>
       </Zamestnanec>
     </Zamestnanci>
   </ExportZamestnancu>
   ```
   Element names are *inferred* from the XmlSerializer defaults plus the strings
   `ExportZamestnancu`, `Zamestnanec`, `RodneCislo`, `EvidencniCisloPojistence` in the
   assembly metadata (the attribute blobs did not decompile). `VariabilniSymbol`,
   `IdZamestnani` and `OIC` carry `[RegularExpression("[1-9].*|0")]` (not enforced by
   XmlSerializer). Confirm the names against a real e-Portal export before implementing.
4. No employees → `InvalidOperationException("XML neobsahuje žádné zaměstnance.")`.
5. `ZamestnanecCsvMapper.Map` → rows. `CsvExporter.ToCsvData(",", rows, ignore
   "TypIdentifikatoru")` writes a header line with the property names, then one line per
   employee. A value is quoted (`"…"`, with `"` doubled) only if it contains the delimiter,
   `"`, CR or LF.
   ```
   Identifikator,Prijmeni,Jmeno,VariabilniSymbol,PojistnyVztahDo,KodDruhuCinnosti,NazevDruhuCinnosti,ZMR,IdZamestnani,OIC
   8001011234,Novák,Jan,1234567890,2026-12-31,1,Pracovní poměr,N,123456789,1234567890
   ```
   * `Identifikator` = RodneCislo or EvidencniCisloPojistence (the type column is dropped).
   * `PojistnyVztahDo`: `yyyy-MM-dd`, empty if missing (`DateTime.MinValue`).
   * `ZMR`: `N`/`A` (enum name). FAND's `ZMR:B` accepts `A`/`N`.
   * `File.WriteAllText(path, content, Encoding.GetEncoding(852))`, CRLF line ends, no BOM.
6. Log lines: `yyyy-MM-dd HH:mm:ss [INFO|ERROR] msg` appended to `logFilename`. The default
   encoding is UTF-8.
7. Errors: during startup (config/bootstrap), MessageBox "Chyba konfigurace" (icon Stop) +
   the log, exit 1. During the run, the exception propagates to `Main`'s catch, which does
   the same, so the CSV stays missing or empty. Účto then imports 0 rows and reports
   "počet zaměstnanců: 0". The user sees the MessageBox with the reason.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uctoconv.ts`, key `uctoconv.exe`. It is small and pure.

* Read `<exeDir>/UctoConv.XML` (case-insensitive lookup), decoded as CP852, and take the
  three keys (plus optional `CsvDelimiter`/`CsvEncoding`). Map the paths with `ctx.mapPath`.
  The input XML path came from the file picker (UctoFoD replacement), so it is already a
  host path or a mapped DOS path.
* Parse the input with `fast-xml-parser` (`ignoreAttributes: false`, `removeNSPrefix: true`
  to tolerate a future namespace). Honour the XML declaration encoding (UTF-8 expected;
  support `windows-1250` via `iconv-lite` just in case). Force `Zamestnanec` to always be an
  array.
* Map exactly as above. Write CP852 via `iconv-lite` with CRLF and the same quoting rule.
  Characters outside CP852 (rare in names, e.g. `ő`) → `?`, as .NET's best-fit encoder
  would do. Log a warning.
* Errors → `ctx.ui.message('Chyba konfigurace', msg, 'error')`, delete the CSV (so Účto
  loads nothing, as today), and append to the log file. Exit code 1.
* No DOSBox `WaitFor` concern: the helper finishes before `ExecWin` returns.
* OS integration: none.

Still worth replacing: **yes, medium priority.** It is needed once per employee (JMHZ
requires the ČSSZ `OIC` and employment ID `PPV` on every monthly report). Without it, users
must type OIČ/ID PPV by hand. Effort is small.

## Test approach

* Fixtures: a hand-made `ExportZamestnancu` XML with 3 employees (RC, ECP, a missing
  `PojistnyVztahDo`, a name with a comma to exercise quoting, `ZMR=A`). Replace it with an
  anonymised real e-Portal export once available.
* Golden CSV bytes (CP852, CRLF), plus a round-trip through the engine: `copyfile(…/var,
  ZAMOIC)` then `deleterec(ZAMOIC,1)` must give the expected `ZAMOIC` records (field
  positions).
* Error cases: no `Zamestnanec` → the Czech message and an empty CSV; malformed XML; a
  missing config key.
* Engine integration: drive MODUL94 "Načíst data pro import" with the picker stubbed to the
  fixture path. Expect "Pracovní soubor ZAMOIC, počet zaměstnanců: 3".
