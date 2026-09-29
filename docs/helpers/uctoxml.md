# UctoXml.exe – CSV → ČSSZ/MPSV XML generator, XSD check and ČSSZ online validation

`{ap05}\UctoXml.exe` (2.1 MB, .NET Framework 4.8 WinExe, assembly `UctoXml` 0.0.0.17,
title "Ucto XML creator", internal namespace `Demo01`). It reads CSV files that Účto's
reports write, builds a submission XML for ČSSZ or ÚP/MPSV, checks it against the XSDs in
`{ap05}\Xsd\`, can send it to the ČSSZ **ePodaniValidace** web service, and writes a
one-word status file (`OK` / `ERROR…`) that Účto reads back. It also has a
**validation-only** mode for JMHZ XML that FAND built itself.
Decompiled source: `work/decompiled/{ap05}_UctoXml/` (entry `Demo01/Program.cs`,
config `Demo01.Helpers/Configuration.cs`).

## How Účto calls it

| | |
|---|---|
| Wrapper | procedure `UctoXml2(Epo, CsvIn, Zkr, Eml)`, `UCTO2026_RDB/0644_P_UctoXml2.txt`; helper `UctoXml1(CsvIn)` (`0643`) points `TXT` at `{AP05}\Data\<CsvIn>.CSV` |
| Parameter file | report `UctoXml` (`0642_R_UctoXml.txt`), written to `{AP05}\UctoXml.xml` |
| Command line | none; `-d` only in FAND `testmode` (shows the console, waits for Enter) |
| Working dir | Účto's current dir; the exe finds `UctoXml.xml` via `APP_CONFIG_FILE` relative to its AppDomain base = the exe dir |
| Input | `{AP05}\Data\<name>.csv` (CP852, comma, 3 lines each), or an existing XML in validation-only mode |
| Output | `SEST.Path` (the generated XML, CP852), `{AP05}\Logs\<Zkr>_res.txt` (status, CP852) |
| Sync | `ExecWin` (blocking `exec` on Windows), then always `WaitFor(res.txt,'UctoXml.exe')` |
| Result | `copy(gettxt(res.txt),1,2)`: `OK` → `PARAM3.Ano:=true`; `ER` → "Chyby ve struktuře <xml>" and the file shown in the text viewer (`proc(Txt,…)`) |
| Exit code | not used |

```
(Epo:string; CsvIn:string; Zkr:string; Eml:string) ...
ap05:=PROGRAM.Path+'{AP05}\'; logs:=ap05+'Logs\';
CsvIn:=replace(',',CsvIn,cr);
for i:=1 to linecnt(CsvIn) do begin s:=ap05+'Data\'+copyline(CsvIn,i)+'.csv'; csv:=csv+cond(csv<>'':',')+s; end;
xsd:=ap05+'Xsd\'; xml:=SEST.Path; puttxt(SEST,''); Zkr:=Zkr+'_';
proc(GetParU,('03','CsszServiceValidation'));              { {STAN}\P03.UUU line CsszServiceValidation=A|N }
b11:=PARAM3.Ano & PARAM3.AAA=~'A';                         { online validation on }
b14:=Epo=~'JMHZ' & PARAM3.Param='V';                        { validation-only }
PARAM3.Param:=''; xml13:=FILE.Path;
TXT.Path:=ap05+'UctoXml.xml'; puttxt(TXT,'');
PARAM3.TTT:=Epo+'\13'+csv+'\13'+xsd+'\13'+xml+'\13'+
  logs+Zkr+'res.txt\13'+logs+Zkr+'log.txt\13'+logs+Zkr+'Mcsv.txt\13'+logs+Zkr+'Mxml.txt\13'+
  logs+Zkr+'err.txt\13'+Trail(Eml)+'\13'+TruFal(b11)+'\13'+TruFal(PARAM2.TestDS)+'\13'+
  xml13+'\13'+TruFal(b14)+'\13';
report(,UctoXml,assign=TXT);
EXE.Path:=PROGRAM.Path+'{AP05}\UctoXml.exe';
if filesize(EXE)=-1 then begin proc(Hlaseni,('Program '+EXE.Path+' pro JMHZ nenalezen')); PARAM3.Ano:=false; exit; end;
TXT.Path:=logs+Zkr+'res.txt'; puttxt(TXT,'');
if testmode then with window(0,0,maxcol,maxrow) do proc(ExecWin,(EXE.Path,'-d')) else proc(ExecWin,(EXE.Path,''));
proc(WaitFor,(TXT.Path,'UctoXml.exe'));
PARAM3.Ano:=false; s:=copy(gettxt(TXT),1,2);
case s='OK': PARAM3.Ano:=true; s='ER': begin proc(Hlaseni,('Chyby ve struktuře '+xml)); proc(Txt,(TXT.Path)); end; end;
```

Report `UctoXml` fills the `_` placeholders in order with the 14 `TTT` lines. Its XML
declaration says `utf-8`, but FAND writes CP852. All values are ASCII paths or
`true`/`false`, except `emlNot` (an e-mail address), so this does not matter in practice.

```xml
<?xml version="1.0" encoding="utf-8" ?>
<configuration>
  <startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8"/></startup>
  <appSettings>
    <add key="xmlType" value="REGZEC25"/>                         <!-- 1  Epo -->
    <add key="csvEncoding" value="852"/>
    <add key="csvDelimiter" value=","/>
    <add key="csvHasHeaders" value="true" />
    <add key="inputCsvFiles" value="C:\UCTO2026\{AP05}\Data\REGZEC.csv"/>   <!-- 2 comma-joined -->
    <add key="xsdTemplates" value="C:\UCTO2026\{AP05}\Xsd\"/>     <!-- 3 -->
    <add key="outputXml" value="C:\UCTO2026\…\SEST…"/>            <!-- 4 SEST.Path -->
    <add key="outputXmlEncoding" value="852"/>
    <add key="resultsFile" value="…\{AP05}\Logs\RZC_res.txt"/>    <!-- 5 -->
    <add key="resultsFileEncoding" value="852"/>
    <add key="logFile" value="…\Logs\RZC_log.txt"/>               <!-- 6 -->
    <add key="csvMapFile" value="…\Logs\RZC_Mcsv.txt"/>           <!-- 7 (only dir checked) -->
    <add key="xmlMapFile" value="…\Logs\RZC_Mxml.txt"/>           <!-- 8 (only dir checked) -->
    <add key="validationErrosFile" value="…\Logs\RZC_err.txt"/>   <!-- 9 (only dir created) -->
    <add key="emlNot" value="mzdy@firma.cz"/>                     <!-- 10 SENDER.EmailNotifikace -->
    <add key="EnableCsszServiceValidation" value="true" />        <!-- 11 -->
    <add key="UseTestCsszService" value="false" />                <!-- 12 PARAM2.TestDS -->
    <add key="CsszServiceUrlTest" value="https://t-epodani.cssz.cz/ePodaniValidace.svc" />
    <add key="CsszServiceUrlProd" value="https://epodani.cssz.cz/ePodaniValidace.svc" />
    <add key="inputXml" value="…\{MAIL}\JMHZ.XML" />              <!-- 13 FILE.Path -->
    <add key="inputXmlEncoding" value="1250" />
    <add key="validationOnly" value="false" />                    <!-- 14 -->
  </appSettings>
</configuration>
```

`ConfigurationManager.AppSettings` keys are case-insensitive, so `EnableCsszServiceValidation`
matches the code's `enableCsszServiceValidation`. The option is set in
**Údržba → P03 → CsszServiceValidation** ("Odeslání dat k online validaci" /
"UctoXml bez online validace", `MODUL01_PRO/0584_P_Udrzba.txt`).

### Call sites (all "e-Podání … »" menu items; the "-"- postaru" siblings are the old FAND-only path)

| Menu (chapter) | FAND steps before the call | `UctoXml2(...)` | Then |
|---|---|---|---|
| Mzdy → Registrace zaměstnance → Shift+F6 / Tisk → **e-Podání REGZEC** (`MODUL97_PRO/0310_P_RegZecSF6.txt`, `0322_P_RegZecTisk.txt`) | `KoRegZec` check, `UctoXml1('REGZEC')`, `report(RegZecC, UCTOTXT)`, `FixTxt` → `Data\REGZEC.CSV` | `('REGZEC25','REGZEC','RZC',PAR97A2.KontMail)` | `eVrep2('REGZEC')` |
| Registrace zaměstnavatele → **e-Podání REGZELDOPL** (`0023_P_RegZelDo.txt`) | `UctoXml1('REGZELDO')`, `report(RegZelC)`, `FixTxt` | `('REGZELDOPL25','REGZELDO','RZL',…)` | `eVrep2('REGZELDO')` |
| Přehled o pojistném → **e-Podání PVPOJ25** (`0110_P_PrehlSoc25.txt`) | `KoPVPOJ25`, `PvPoj26C1` → `PVPOJ1.CSV`, `PvPoj26C2` → `PVPOJ2.CSV` | `('PVPOJ25','PVPOJ1,PVPOJ2','PP',…)` | `eVrep2('J25')` |
| Příjmy pro ÚP → **e-Podání POPRIJ** (`0130_P_PoPrijUP.txt`) | `KoPOPRIJ`, `PoPrijC1`/`C2` → `POPRIJ1/2.CSV` | `('POPRIJ','POPRIJ1,POPRIJ2','PR',…)` | `eVrep2('POPRIJ')` |
| e-Podání PREZEC menu → **Kontroly XML** (`0262_P_eVrep2.txt`) | FAND already wrote `{MAIL}\PREZEC.XML` (CP1250) | `PARAM3.Param:='V'; FILE.Path:=xp;` `('JMHZ','','PZ',…)` | "Kontroly PREZEC.XML: bez chyb" |
| JMHZ (MODUL94) e-Podání menu → **Kontroly XML** (`MODUL94_PRO/0115_P_eVrep94.txt`) | FAND built `{MAIL}\JMHZ.XML` from XML snippets | `('JMHZ','','JH',PAR94A2.KontMail)` with `Param='V'` | "Kontroly JMHZ.XML: bez chyb" |

So Účto uses UctoXml in two modes:

1. **Generate** (REGZEC25, REGZELDOPL25, PVPOJ25, POPRIJ): CSV → XML into `SEST`. `eVrep2`
   then fixes it (`OprXml`), converts it to CP1250 (`eVrepXml`, `copyfile … mode='LW'`), and
   offers VREP (`UctoApep.exe`), the data box, or the portal.
2. **Validate only** (`xmlType=JMHZ`, `validationOnly=true`): the JMHZ/PREZEC XML is sent
   to ePodaniValidace, and nothing is generated. JMHZ XML generation from CSV exists in the
   exe (`ProcessJMHZ`, `CsvImport.ImportJMHZ*`), but **Účto 2026 does not use it**.

`FixTxt` (`0641_P_FixTxt.txt`): the reports emit CSV lines split over several text lines
with blank-line separators. `FixTxt` joins the non-empty lines up to each blank line and
writes one CRLF-terminated CSV line to `TXT`.

## Input CSV format (written by FAND)

* CP852, comma-separated, **no quoting**. `CsvS(s) = Trail(replace(',',s,' '))+','`
  replaces commas with spaces (`MODUL97_PRO/0001_D_noname.txt`). Dates are `YYYY-MM-DD`
  (`CsvD`, `DatXml`), booleans are `true`/`false` (`TruFal`), numbers are `str(r,'0')` or
  `str(r,0,2)`.
* Line 1: the column keys (`t1`), ending in a marker column such as `#PvPoj25_1`,
  `#RegZec`, `#RegZelDopl`, `#PoPrij_1`.
* Line 2: XSD field IDs (`t2`, e.g. `10014,10004,…` or `?10004`, `A10221`), ending in `-`.
  UctoXml **skips** this line (`startLine=2`). It exists for humans/ID mapping.
* Line 3+: data rows. REGZEC has one row per employee; PVPOJ2/POPRIJ1 have one row per employee.

Example header (`MODUL97_PRO/0117_R_PvPoj26C1.txt`):
```
version,xmlns,prodNam,prodVer,emlNot,iRprt,verPtk,typPr,verPr,corr,kodOSSZ,nazOSSZ,mesic,rok,vs,ic,nazZtl,aUlice,aCp,aObec,aPSC,aStat,zaklA,pojA,…,datVyp,pozn,#PvPoj25_1
```

## What it does (decompiled C#)

### Startup (`Program.Main`)
1. Deletes and recreates `<exeDir>\app.log`. Sets `APP_CONFIG_FILE=UctoXml.xml`.
   `AllocConsole()` and hides it unless `-d` is given.
2. Refuses to run below Windows 7 / .NET 4.8 (writes the error to the status file).
3. `Configuration` (`Demo01.Helpers/Configuration.cs`) validates keys. It collects messages
   such as "Chybí povinný atribut: <key>", "Adresář pro <key> neexistuje: …",
   "Vstupní CSV soubor nebyl nalezen: …", "XSD šablona nebyla nalezena: …" and
   "Režim validationOnly je podporován pouze pro xmlType=JMHZ." Any error → a
   `ValidationException`, and the status file becomes `ERROR` + messages.
   * `xmlType` ∈ `PVPOJ25, MPSV_PRIJMY_ZAMESTNANCE, POPRIJ, JMHZ, REGZEC25, REGZELDOPL25,
     PPPZ, HOZ, PREHLED_OSVC_ZP` (case-insensitive). Účto uses the 5 listed above.
   * `csvEncoding` ∈ {852, 1250, 65001}; `csvDelimiter` must be exactly one char.
   * XSD file lists per type (joined to `xsdTemplates`):
     * PVPOJ25: `baseTypes2.xsd`, `PVPOJ25.XSD`
     * POPRIJ: `POPRIJ.XSD`
     * REGZEC25: `baseTypes2.xsd`, `RegZec25.xsd`
     * REGZELDOPL25: `baseTypes2.xsd`, `RegZelDopl25.xsd`
     * JMHZ: `baseTypes2.xsd, form.xsd, formBezPriznaku.xsd, formCinnostKS.xsd,
       formCommonTypes.xsd, formJinyPrijem.xsd, formMezinarodniPronajemSily.xsd,
       formOdlozenyPrijem.xsd, formOzpTpp.xsd, formPestoun.xsd, formVezen.xsd,
       jmhzPodani.xsd, PVPOJ.XSD, souhrn.xsd`

     The files on disk use other letter cases (`REGZEC25.xsd`, `poprij.xsd`,
     `PVPOJ25.xsd`…). **The replacement must look them up case-insensitively.** `DZMH25.xsd`,
     `PREZEC26.xsd` and `REGZELDOPL25.xsd` are shipped too, but only the list above is loaded.
   * Optional keys with defaults: `partialAccept`=`N`, `iRprt`=`3` (SENDER.ISDSreport),
     `verPtk`=`2.0` (SENDER.VerzeProtokolu), `emlNot` (SENDER.EmailNotifikace).
4. `DeleteUnNeededFiles`: deletes `outputXml` and `resultsFile` first, so Účto's `WaitFor`
   only sees the new status.

### Generate mode (`ChooseEpodToProcess`)
All paths share the same pattern: build an object graph from the CSV, serialize it with
`XmlSerializer` to `outputXml` (`StreamWriter` in `outputXmlEncoding` = CP852, so the
declaration says `encoding="ibm852"`), validate that XML against the XSDs, and for REGZEC
also call the ČSSZ web service.

* **Column → property mapping.** `ObjectImporter.SetValueByPathOldVersion` maps a column key
  through a header map to a dotted property path, creates intermediate objects, and converts
  the value (`Convert.ChangeType`, enum parse). Columns with no mapping or property are
  ignored silently. The **last column (the `#…` marker) is skipped** (`j < headers.Length-1`).
  Header maps (port them verbatim):
  * PVPOJ25: `Demo01.Helpers/BuildHeaderMapPvpojPodani.cs`, e.g. `mesic→prehled.obdobi.mesic`,
    `kodOSSZ→prehled.okres.kodOSSZ`, `zaklA→prehled.pojistne.zakladZamestnavateleA`,
    `typPr→prehled.typPrehledu` (enum: `' '→N`, `O→Z`, `S→S`), `datVyp→prehled.datumVyplneni`.
    The second file (`PVPOJ2.CSV`) is read by `CsvImport.ImportEmployeeFile` with fixed
    columns `zRodCis, zPrij, zJmen, zDatNar, zZakl, zDuvSl, zPrDob` →
    `prehled.slevaZamestnanci[]`. Root `pvpoj` in ns `http://schemas.cssz.cz/POJ/PVPOJ2025`
    (prefix `pvpoj` = `http://www.cssz.cz/xml/schemas/pvpoj/2025` is declared as well).
    `VENDOR.productName="UctoXml"`, `productVersion="0.0.0.17"`.
  * POPRIJ (`MPSV_PRIJMY_ZAMESTNANCE` path): `BuildHeaderMapMpsvPrijmyZamestnance.cs`
    (`UUID, cisJed→cisloJednaci, bylZam→bylZamestnancem, rodCis→zamestnanec.rodneCislo,
    jmeno, prijmeni, datNar, ikMPSV`) plus the month rows of `POPRIJ2.CSV`
    (`mesic, rok, prijOd, prijDo, prijA1, menaA1, prijAB, menaAB`) through
    `CsvImport.ImportEmployeeFile(PoskytnutiPrijmuRequest…)`. Root `PoskytnutiPrijmuRequest`,
    ns `cz.mpsv.sehravaniPrijmu`, types from `Demo01.Common.MPSV.PoskytnutiPrijmuV1`.
  * REGZELDOPL25: `BuildHeaderMapRegZelDoplPodani.cs` (`Ossz→formular.hlavicka.kodPracovisteCSSZ`,
    `FU, UzP, VarSymO→formular.zamestnavatel.vs, VCP, idDS, SocPodnik, AgentPrace,
    ChranTrh`). `partialAccept="false"`, `version="1.2"`, root `REGZELDOPL`,
    ns `http://schemas.cssz.cz/REGZELDOPL/2025`. Uses `XsdScanner` metadata for types.
  * REGZEC25 (`ProcessRegzecNew`): `BuildHeaderMapRegZecPodani.cs` (133 pairs, e.g.
    `sqnrE→@sqnr`, `actE→@act`, `bnoCN→client.@bno`, `surCN→client.name.@sur`,
    `strA→client.adr.@str`, `oidJ_→job.@oid`…; a trailing `_` marks an optional column).
    Only files ending in `regzec.csv` (main rows, one `employee` per row through
    `RegzecImportContext.StartNewEmployee`) and `regzeca.csv` (attachments,
    `AttachCsvImporter`) are accepted. Then `AttachmentsTechnicalValidator.Validate`.
    `version="2.0"`, `partialAccept` from config (`N`), SENDER as above. Root `REGZEC`,
    ns `http://schemas.cssz.cz/REGZEC/2025`. `RegzecXmlCleanupHelper`/`RegzecCleanupHelper`
    drop empty elements and attributes. The per-element builders are in
    `Demo01.Helpers/*Builder.cs` (ClientNameBuilder, JobTypeBuilder, PensTypeBuilder,
    UnemplcompTypeBuilder, …).
* **XSD validation** (`XmlValidationHelper`, `Demo01.Helpers/XmlValidationHelper.cs`):
  `XmlReaderSettings` with all schemas, collecting every `ValidationEventArgs`. Messages are
  rewritten into Czech from the XSD `xs:element` names and annotations
  (`LoadSchemasAndGenerateDictionary`, `GetMessage`), e.g.
  `Hodnota pole „Rodné číslo“ musí odpovídat stanovenému formátu\n(aktuální hodnota: …).`,
  `Chybí povinný údaj „…“.\nCesta: /REGZEC/employee[2]/client/@bno`,
  `V části „…“ chybí povinný údaj „…“.` REGZEC messages carry
  `Zaměstnanec (sqnr=N)\n`, and `BuildTxtReport` groups them per employee
  ("VALIDACE XML DOKUMENTU REGZEC25 … Zaměstnanec č. N … Umístění: …").
  `EnableRegzecAnnotations` adds the XSD `documentation`/`ID` text so a message reads
  "(…, ID 10057)".
* **ČSSZ online validation** (REGZEC25 only in generate mode, and only if the XSD check
  passed): see below. Errors are grouped as `Pořadí zaměstnance: <FormularIdentifikace>`
  followed by wrapped `[kkk] popis` lines.

### Validation-only mode (`ValidationOnly()`)
1. Reads `inputXml` in `inputXmlEncoding` (1250) and strips the `<?xml …?>` declaration
   (regex `^\s*<\?xml.*?\?>\s*`).
2. Calls ePodaniValidace (if enabled; if disabled, the result is always `OK`).
3. No messages → log "Podání je plně validní." and create `<inputXml minus ext>.zip`
   containing the XML (`ZipFile.Open(…Create)` + `CreateEntryFromFile`). Účto does not use
   the zip; it is a by-product for manual portal upload.
4. With messages → `BuildWsValidationReport`:
   ```
   JMHZ - VÝSLEDKY VALIDACE
   ========================

   XML SCHÉMA                       (messages whose Popis contains "XML schématu")
   --------------------------------------------------------------------------------
   GUID zaměstnance: 3f2c…           (group key has '-') or the key itself or "OBECNÉ CHYBY"
     [012] popis wrapped at 80 cols, continuation indented 2
   LOGICKÉ KONTROLY
   --------------------------------------------------------------------------------
   …
   ```

### ČSSZ ePodaniValidace call (`Demo01.Helpers.CsszValidationWS/EPodaniValidaceClient.cs`)
* POST to `CsszServiceUrlProd` = `https://epodani.cssz.cz/ePodaniValidace.svc` (or
  `…t-epodani…` when `UseTestCsszService=true`, i.e. `PARAM2.TestDS`).
* SOAP 1.1: `Content-Type: text/xml; charset=utf-8`, header `SOAPAction: "ePodaniValidace"`,
  30 s timeout, 2 retries 1500 ms apart on timeout or network error. No client certificate
  and no auth.
* Body (the submission XML is embedded **raw, without its declaration**):
  ```xml
  <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
    <s:Body>
      <ValidujPodani xmlns="urn:cz:isvs:cssz:schemas:ePodaniValidace:v1">
        <PozadavekId>{new GUID}</PozadavekId>
        <PozadavekCas>{UtcNow:yyyy-MM-ddTHH:mm:ss.fff}</PozadavekCas>
        {REGZEC / JMHZ root element}
      </ValidujPodani>
    </s:Body>
  </s:Envelope>
  ```
* Response (ns `urn:cz:isvs:cssz:schemas:ePodaniValidace:v1`): `PozadavekId`, `OdpovedCas`,
  `VysledekKod` (`OK` = valid; empty → "Invalid validation response format."), and zero or
  more `Chyba { Kategorie, Kod, Popis, FormularIdentifikace }`. `Kod` is re-formatted `D3`.
  `EnrichWithXsdId` appends `, ID nnnnn` from the XSD to a `(path)` in `Popis`.
  Control characters except CR/LF/TAB are removed (`CleanText`).
* HTTP non-2xx → an exception "Validation service HTTP error N". Timeouts or HTTP errors
  are **logged and swallowed**: the result is then treated as "no WS errors", so the status
  can be `OK` even though the service was unreachable.

### Status file (`resultsFile`, CP852, CRLF) – the only thing Účto parses
* All OK: a single line `OK`.
* Otherwise the first line starts with `ERROR` (Účto checks only the first 2 chars `ER`):
  * **REGZEC25 with errors** (`SaveToJmhzStatusFile`): `ERROR`, then either
    `APLIKAČNÍ CHYBY:` + each error wrapped at 80 cols (indent 4) + an 80×`-` line, or
    `CHYBY VALIDACE XML:` + the same for XSD errors, or the WS lines verbatim.
  * **JMHZ**: same as above; the WS lines are the `BuildWsValidationReport` text.
  * **PVPOJ25 / POPRIJ / REGZELDOPL25** (`SaveToStatusFile` 4-arg): `ERROR`, then the
    app errors, or else the XSD errors, one per line.
  * Config broken before `_config` exists: `MessageBox("Chyba:…")` and the status goes to
    `<exeDir>\<_defaultConfigErrFile>`, which Účto never sees. It waits in `WaitFor` and
    asks "Účto čeká na výsledek programu UctoXml.exe. Čekat dál".
* The `logFile` / `app.log` (UTF-8) hold the detailed trace. `csvMapFile`, `xmlMapFile` and
  `validationErrosFile` only have their directories checked or created; nothing is written.

### UI
A hidden console, visible with `-d` (a banner "Generátor XML dokumentů z XSD schémat …
T E S T O V A C Í  D E M O", progress lines, "KONEC APLIKACE / STISKNI <<ENTER>>").
A MessageBox appears only for fatal config errors. No other dialogs.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uctoxml.ts`, key `uctoxml.exe`. The EXEC layer runs it
in-process and synchronously. It writes `res.txt` before returning, so Účto's `WaitFor`
returns on its first check (it loops with 1 s `delay` only while the file is empty or still
growing).

* **Config**: read `<exeDir>/UctoXml.xml`. Decode as CP852 regardless of the declaration,
  because FAND writes CP852. Parse the flat `<add key value>` pairs with `fast-xml-parser`,
  using **case-insensitive keys**. Map DOS paths with `ctx.mapPath` (including the
  comma-separated `inputCsvFiles`).
* **Validation** of config: the same checks and Czech messages as `Configuration.cs`, so the
  status file text stays familiar to hot-line support.
* **CSV**: `iconv-lite` (`cp852`), split lines on CRLF, fields on `,` (no quoting, as FAND
  never quotes), skip line 2, and ignore the last column. Share the reader with other helpers
  (`src/engine/helpers/lib/fandcsv.ts`).
* **Model and serialization**: do **not** port the XmlSerializer classes (thousands of lines).
  Build the output XML **schema-driven**:
  * Port the header maps as plain `Record<string,string>` tables (column → path; `@x` =
    attribute).
  * Build a small ordered tree builder that knows element order from the XSD: parse the
    `xs:sequence` order once with `fast-xml-parser`, as `XsdScanner`/`JmhzXsdOrderProvider`
    do. Emit elements in schema order and omit empty elements and attributes (as the C#
    cleanup helpers do).
  * Types: dates as `YYYY-MM-DD`, decimals with `.`, booleans `true/false`, the
    `typPrehledu` enum map above.
  * Write with `xmlbuilder2` or a hand-written serializer. Output encoding CP852 with an
    `encoding="ibm852"` declaration (as .NET writes it), because `eVrep2`/`OprXml` expect
    CP852 in `SEST`. Keep `VENDOR productName="UctoXml" productVersion="0.0.0.17"` (or our
    own name) consistently.
* **XSD validation**: use `libxml2-wasm` (pure WebAssembly, no native build; it has
  `XsdValidator`) or `xmllint-wasm`. Load the schema set from `{ap05}/Xsd` with a
  case-insensitive resolver for `xs:include`/`xs:import`. Translate libxml2 messages
  ("Element '…': [facet 'pattern'] The value '…' is not accepted by the pattern '…'",
  "Element '…': Missing child element(s). Expected is ( … )", "The attribute '…' is required
  but missing") into the same Czech templates as `GetMessage`. Build the display-name/ID
  dictionary from the XSD `xs:annotation/xs:documentation` exactly as
  `LoadSchemasAndGenerateDictionary` and `EnableRegzecAnnotations` do. Wording can differ
  slightly from .NET; the category, field name, value and path must stay the same.
* **ePodaniValidace**: `fetch` with the SOAP 1.1 envelope above, `AbortSignal.timeout(30000)`,
  and 2 retries. Parse the response with `fast-xml-parser` (`removeNSPrefix`). **Improvement:**
  when the service is unreachable, add a warning line to the log and show a non-blocking
  `ctx.ui.message` note ("Online validace ČSSZ nedostupná"), but keep writing `OK` so Účto
  behaves as before.
* **Zip** (validation-only success): `fflate` `zipSync` → `<name>.zip` next to the XML.
* **Status file**: reproduce the exact line layouts (80-col wrap, `ERROR` first line) in
  CP852 CRLF. Účto shows it with its own text viewer.
* **Logs**: write `logFile` (UTF-8) with `yyyy-MM-dd HH:mm:ss [LEVEL] msg` lines. `app.log`
  in `{ap05}` is optional.
* **UI**: none. `-d` only enables verbose logging to the engine's debug log.
* **JMHZ CSV generation** (`ProcessJMHZ`, `ProcessMh*`): not ported, since Účto does not call it.
  PPPZ/HOZ/PREHLED_OSVC_ZP: also not called by Účto (they belong to other ZP flows, and
  `ProcessPPPZ` is even empty).

Still worth replacing: **yes, high priority.** Without it, REGZEC (employee registration,
mandatory since 2026 JMHZ), REGZELDOPL, PVPOJ25 and POPRIJ cannot be produced, and the JMHZ
"Kontroly XML" check is lost.

## Test approach

* **Fixtures from Účto itself**: run the sample company in `{prik}` (payroll data MZDY,
  PRACOV, PRIHL) through the engine's reports `RegZecC`, `RegZelC`, `PvPoj26C1/C2`,
  `PoPrijC1/C2` + `FixTxt` to get real CSVs. Store them under `test/fixtures/uctoxml/`.
* **Golden XML**: for each fixture, produce the reference XML once with the real
  `UctoXml.exe` (Wine or a Windows VM, config pointed at a copy under `work/tmp-*/`). Commit
  the output and compare element-by-element (canonicalized: attribute order, whitespace).
* **XSD**: every golden XML must validate with our validator against `{ap05}/Xsd`. Negative
  fixtures (missing `bnoCN`, bad PSČ pattern, missing required child) must produce the
  expected Czech messages and an `ERROR` status.
* **Status file**: byte-exact tests for the `OK` and `ERROR` layouts (CP852, CRLF, 80-col wrap).
* **ePodaniValidace**: mock `fetch` with recorded SOAP responses: `VysledekKod=OK`, errors
  with `FormularIdentifikace` GUIDs (schema and logic categories), HTTP 500, and a timeout
  with retries (fake timers). An optional live test against `t-epodani.cssz.cz` behind
  `CSSZ_LIVE=1`.
* **Config**: the report `UctoXml` rendered by the engine → parse → assert paths and flags,
  including `validationOnly` with `xmlType≠JMHZ` → the Czech error.
* **Engine integration** (headless `EngineDriver`): menu e-Podání REGZEC → expect the eVrep2
  menu (OK path), and an error fixture → the "Chyby ve struktuře" dialog + text viewer.
