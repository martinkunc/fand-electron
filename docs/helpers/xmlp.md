# XmlP.exe – embed attachments (base64) into NEMPRI / ONZ e-Podání XML

`{tisk}\XmlP.exe` (100 KB, .NET Framework 4.0 WinExe, assembly `XmlP` 1.0.0.5,
© Martin Zemek). It takes the list of files that the user marked in Účto's **XMLP** table,
checks their type and size, and inserts them base64-encoded as attachments into an e-Podání
XML that FAND has already generated. It patches **two** files: the XML that is sent (with a
declaration) and the "UUU" copy of the same XML (without a declaration).
Decompiled source: `work/decompiled/{tisk}_XmlP/`.

## How Účto calls it

| | |
|---|---|
| Wrapper | procedure `XmlP(Mode, Form)`, `UCTO2026_RDB/0622_P_XmlP.txt`, `Mode='X'` |
| Parameter file | report `XmlPpar` (`0620_R_XmlPpar.txt`) → `{TISK}\XMLP.XML` (`encoding="IBM852"`) |
| Data file | report `XmlPdat` (`0619_R_XmlPdat.txt`) → `{TISK}\XMLP.CSV`, CP852 |
| Command line | none |
| Files patched | `InputXmlFile` = `FILE.Path` (e.g. `{MAIL}\NEMPRI25.XML`, CP1250 with declaration); `InputUUUFile` = `UCTOTXT5.Path` (`UCTOTXT5.UUU`, CP1250, same XML without declaration) |
| Sync | `ExecWin` (blocking), then `clearkeybuf`; no `WaitFor` |
| Result / exit code | not checked; on error a MessageBox and exit 1, and the files stay unchanged |

```
Mode=~'X': begin
  př:=0; forall VetaX (Ozn & Cesta<>~'') do př+=1; if př=0 then exit;
  PARAM3.Ano:=true; report(,XmlP,assign=SEST); proc(Ses);                      { preview of the list }
  proc(Dotaz,(false,'Připojit k e-Podání přílohy ('+str(př,'0')+')'));
  if ^PARAM3.Ano then exit;
  pgmp:=PROGRAM.Path; EXE.Path:=pgmp+'{TISK}\XMLP.EXE';
  if filesize(EXE)<=0 then begin proc(Hlaseni,('Program '+EXE.Path+' nenalezen')); exit end;
  PARAM3.TTT:=PARAM3.TTT+'\13\10'+ pgmp+'{TISK}\XMLP.CSV'+'\13\10'+ pgmp+'{TISK}\XMLP.LOG'+'\13\10'+
              cond(Form='N20':'NEMPRI', Form='N25':'NEMPRI25', Form='O22':'ONZ22');
  TXT.Path:=pgmp+'{TISK}\XMLP.XML'; report(,XmlPpar,assign=TXT);
  TXT.Path:=pgmp+'{TISK}\XMLP.CSV'; report(,XmlPdat,assign=TXT);
  proc(ExecWin,(EXE.Path,'')); clearkeybuf; end;
```

The caller (`MODUL97_PRO/0262_P_eVrep2.txt`) sets `PARAM3.TTT` first:

```
proc(eVrepXml); if ^PARAM3.Ano then exit;
if Form in ['N20','N25','O22'] then begin
  PARAM3.TTT:=FILE.Path+'\13\10'+UCTOTXT5.Path; proc(XmlP,('X',Form)); end;
```

`eVrepXml` (`0261_P_eVrepXml.txt`) has just built both targets from `UCTOTXT4` (the FAND
XML in CP852): `UCTOTXT5` = CP852→CP1250 conversion with the first line (declaration)
removed, and `FILE` = `<?xml version="1.0" encoding="windows-1250"?>` CRLF + `UCTOTXT5`.
The same `XmlP('X',Form)` call follows **"Opravit XML"** (manual edit) in the eVrep2 menu.

`XMLP.XML`:
```xml
<?xml version="1.0" encoding="IBM852"?>
<configuration>
  <appSettings>
    <add value="C:\UCTO2026\FIRMA\{MAIL}\NEMPRI25.XML" key="InputXmlFile"/>
    <add value="C:\UCTO2026\UCTOTXT5.UUU" key="InputUUUFile"/>
    <add value="C:\UCTO2026\{TISK}\XMLP.CSV" key="InputDataFile"/>
    <add value="1250" key="InputXmlEncoding"/>
    <add value="1250" key="InputUUUEncoding"/>
    <add value="852" key="InputDataEncoding"/>
    <add value="," key="Delimiter"/>
    <add value="C:\UCTO2026\{TISK}\XMLP.LOG" key="ErrorLog"/>
    <add value="NEMPRI25" key="DocType"/>         <!-- NEMPRI | NEMPRI25 | ONZ22 -->
  </appSettings>
</configuration>
```

`XMLP.CSV` (report `#DE Nazev,Cesta,Pozn;` over `XMLP` records with `Ozn & Cesta<>''`):
```
"Lékařská zpráva","C:\Doklady\zprava.pdf","doplnění k žádosti"
```

### Feature / menus
* Where it runs: e-Podání **NEMPRI20/NEMPRI25** (příloha k žádosti o dávku – nemocenská,
  `Form='N20'|'N25'`) and **ONZ22** (oznámení o nástupu/skončení zaměstnání,
  `Form='O22'`), right after FAND generates the XML and before the eVrep2 send menu.
* Where the attachment list is edited: `XmlP('D')` (`0623_P_XmlPedit.txt`), from
  `MODUL97_PRO/0263_P_PrihlTisk.txt` "Přílohy e-Podání »" and `0193_P_ZadDav.txt`. It opens
  the edit form `XmlP` (`0617_E_XmlP.txt`) over file `XMLP`
  (`Nazev:A,100; Cesta:A,80; Pozn:A,200; Ozn:B`) with F8 = mark, Tab = pick a file
  (`Paths('XmlP','*')`), Shift+F6 = list (report `XmlP`), and Shift+Tab = long-text editors
  (`XmlPEx`, `0621`).

## What it does (decompiled C#)

1. `APP_CONFIG_FILE=XmlP.xml`. `Config.LoadConfiguration` reads the keys above. `DocType`
   must parse to `ONZ22|NEMPRI|NEMPRI25`, else "Hodnota parametru docType (…) není
   povolena." `ErrorLog` is read but **not used**: `FileLogger` always appends to
   `<exeDir>\XmlPlog.txt` (default ANSI encoding, `dd.MM.yyyy - HH:mm;Chyba:…;Poznámka:…;`).
2. `CsvService.ParseCsv`: reads `InputDataFile` in CP852. Each line is split on `,` (no CSV
   quoting logic; a comma inside a name or comment breaks the columns). `"` is removed from
   each field. Columns: `Nazev, Cesta, Komentar`; `Typ` = the extension of `Cesta`.
   Validation, in order, all errors ending with "\r\nPřílohy nebudou připojeny.":
   * more than **9** rows → "Překročen počet příloh.\r\n(Můžete přidat maximálně 9 příloh)."
   * 0 rows → "Soubor neobsahuje žádné přílohy."
   * per file: must exist ("Soubor … neexistuje."); an empty `Nazev` → `Příloha_<n>`;
     the extension must be one of `.doc .docx .rtf .xls .xlsx .pdf .jpg .txt`
     (case-insensitive) → MIME `application/msword`,
     `application/vnd.openxmlformats-officedocument.wordprocessingml.document`,
     `application/rtf`, `application/vnd.ms-excel`,
     `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet`,
     `application/pdf`, `image/jpeg`, `text/plain`. Else: "Příloha .X není povolena.\r\nPovolené
     typy  příloh:\r\n.DOC, .DOCX, .RTF, .XLS, .XLSX, .PDF, .JPG, .TXT"
   * total size > **2 MB** (2 097 152 B) → "Byla překročena maximální velikost příloh 2MB."
   * duplicate names (`ToUpper().Trim()`) → "Názvy příloh nesmí být duplicitní.\r\nByly
     nalezeny tyto duplicity:\r\nNázev: X, duplicita: n x"
3. `XmlService` deserializes `InputXmlFile` (CP1250) with `XmlSerializer` into one of:
   * `NEMPRI` (ns `http://schemas.cssz.cz/nem/NEMPRI20`) → sets
     `datovaVeta[0]/prilohaStrana2/prilohy`
   * `NEMPRI` (ns `http://schemas.cssz.cz/nem/NEMPRI25`) → sets `datovaVeta[0]/prilohy`
   * `ONZ` (ns `http://schemas.cssz.cz/ONZ2022`) → sets `employee[0]/attachs`

   Failure → "Soubor <path> nelze načíst".
4. **Writes the XML file**: re-serializes the whole object graph with `XmlSerializer`,
   `XmlWriterSettings{Indent=true, Encoding=1250}` into a `Windows1250StringWriter`, so the
   declaration is `<?xml version="1.0" encoding="windows-1250"?>`. It is saved in CP1250.
   Side effects of the round trip: indentation changes, unknown elements or attributes (not
   in the C# model) are **dropped**, and namespace prefixes are normalised.
5. **Patches the UUU file textually** (no XML parse). It reads it in CP1250 and replaces
   **every** occurrence of the closing tag with the attachment block plus the closing tag,
   then writes CP1250:
   * NEMPRI20: `</prilohaStrana2>` →
     ```
     <prilohy coun="N">\r\n<priloha>\r\n<nazev>…</nazev>\r\n<typ>mime</typ>\r\n<komentar>…</komentar>\r\n<base64data>…</base64data>\r\n</priloha>\r\n…</prilohy>\r\n</prilohaStrana2>\r\n
     ```
   * NEMPRI25: the same block inside `</datovaVeta>`.
   * ONZ22: `</employee>` →
     ```
     <attachs>\r\n<attach \r\nname="file.pdf" desc="…" data="base64…"></attach>\r\n</attachs>\r\n</employee>\r\n
     ```
     For ONZ the attachment name is the **file name** (`Path.GetFileName(Cesta)`), not
     `Nazev`, and the data goes in an attribute.

   `nazev`, `komentar`, `name` and `desc` are inserted **without XML escaping** here, while
   the XML file (step 4) escapes them properly. A `&` or `<` in a name makes the UUU file
   invalid.
6. Errors anywhere: MessageBox "Chyba:\r\n<msg>" titled `XmlP [1.0.0.5]` (icon Stop), a
   log line, exit 1.

Why two files: `ELPODPIS.EXE` (the legacy VREP sender) signs `UCTOTXT5` (no declaration),
while `UctoApep.exe` and the data box/portal use `FILE` (`xp`). Both must carry the
attachments.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/xmlp.ts`, key `xmlp.exe`.

* Config: read `<exeDir>/XMLP.XML` (case-insensitive), decoded as CP852, as flat
  `<add value key>` pairs (note: `value` comes **before** `key` here, so parse attributes by
  name). Map paths with `ctx.mapPath`.
* CSV: CP852, a real CSV parse (`"`-quoted fields, since FAND `#DE` quotes every field),
  which fixes the comma bug. Same validations, limits (9 files, 2 MB total), MIME table
  and Czech messages.
* **Do not round-trip through a data model.** Insert the attachment block **textually** into
  both files, in the same places as the original UUU patch, but with proper XML escaping of
  names and comments. This keeps FAND's XML byte-identical apart from the insertion, which
  is safer than the .NET re-serialization and matches what `ELPODPIS`/`UctoApep` sign. Rules:
  * Decode both files as CP1250 (`iconv-lite`).
  * NEMPRI20: insert before the first `</prilohaStrana2>` of the first `datovaVeta`.
    NEMPRI25: before the first `</datovaVeta>`. ONZ22: before the first `</employee>`.
    Detect the flavour from `DocType`, and check the root namespace. If the anchor is
    missing, show "Soubor … nelze načíst" as the original does.
  * If the document already contains `<prilohy`/`<attachs` (the user ran "Opravit XML" after
    an earlier XmlP run), **replace** the existing block instead of adding a second one. The
    original's full re-serialization overwrote it too.
  * Element-vs-attribute layout and element order exactly as above. Base64 without line
    breaks (`Buffer.toString('base64')`), as .NET `Convert.ToBase64String` produces.
  * Characters in names that CP1250 cannot encode → numeric character references
    (`&#x…;`), which is legal XML and survives the encoding.
* After patching, optionally validate the XML with the NEMPRI/ONZ XSD if we ship them (not
  in `{ap05}\Xsd`; skip until available).
* Errors → `ctx.ui.message('XmlP', 'Chyba:\n'+msg, 'error')`, leave both files untouched, and
  append to `<exeDir>/XmlPlog.txt` (keep the name for support).
* OS integration: none. The file list is chosen in FAND (the `Paths` picker, i.e. the UctoFoD
  replacement).

Still worth replacing: **yes, medium priority.** Attachments are mandatory for some NEMPRI
cases (medical reports) and common for ONZ. The logic is small.

## Test approach

* Fixtures: minimal NEMPRI20, NEMPRI25 and ONZ22 XMLs in CP1250 (from the engine running
  `eVrep2` on the `{prik}` sample, or hand-made from the XSD), plus their UUU twins, and 3
  attachment files (pdf, jpg, txt).
* Golden outputs: run the real `XmlP.exe` (Wine/VM) once per flavour and commit the UUU
  output. Our UUU output must match byte-for-byte for names without special characters. For
  the XML file, compare the attachment subtree semantically (the .NET re-indentation
  differs by design).
* Negative tests: 10 files, 2 MB + 1 B, `.png`, duplicate names (case/space-insensitive),
  a missing file, an empty CSV. Each must produce the exact message and leave the targets
  unchanged.
* Escaping: a name with `&`, `<` and `"` must yield well-formed XML (parse the outputs with
  `fast-xml-parser` in the test).
* Idempotence: running twice replaces the block instead of duplicating it.
