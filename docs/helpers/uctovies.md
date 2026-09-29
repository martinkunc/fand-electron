# UctoVIES.exe – EU VAT number check (VIES) with an HTML report

`{tisk}\UctoVIES.exe` (47 KB, .NET Framework 4.8 WinExe, version 1.0.1 per the report
title). It checks one EU VAT number against the European Commission's VIES service,
renders an HTML page with the result, and opens it in the default browser.
Decompiled source: `work/decompiled/{tisk}_UctoVIES/`.

## How Účto calls it

| | |
|---|---|
| Wrapper | procedure `UctoVies(VetaA:record of ADRESY)`, `UCTO2026_RDB/0246_P_UctoVies.txt` |
| Parameter file | report `UctoVies`, `0245_R_UctoVies.txt`, writes `{tisk}\UctoVIES.XML` |
| Command line | none |
| Config lookup | `UctoVIES.xml` relative to the exe directory (`APP_CONFIG_FILE`). If it is missing: MessageBox "Soubor se vstupními parametry nebyl nalezen." |
| Output | `{tisk}\UctoVIES.HTM` (UTF-8 **with BOM**, `Encoding.UTF8`), then `Process.Start(html)` |
| Exit code | not used |

Menu: address book Shift+F6 (print menu, `0256_P_AdresySF6.txt`) →
**"Plátce DPH v EU?"** → `proc(UctoVies,(VetaA))`.

```
if VetaA.Dic=~'' then begin proc(Hlaseni,('Nevyplněné DIČ')); exit end;
TXT.Path:=PROGRAM.Path+'{TISK}\UctoVIES.XML'; puttxt(TXT,'');
FILE.Path:=PROGRAM.Path+'{TISK}\UctoVIES.HTM'; puttxt(FILE,'');
PARAM3.AAA:=FILE.Path;
report(VetaA,UctoVies,assign=TXT);
EXE.Path:=PROGRAM.Path+'{TISK}\UctoVIES.EXE';
proc(Vypocet1); proc(ExecWin,(EXE.Path,''));
if PARAM3.SyncW then proc(WaitFor,(FILE.Path,'UctoVIES.EXE'));
s:=gettxt(FILE); proc(Vypocet2);
```

Report `UctoVies` (`#RF Dic,PARAM3.AAA;`), in CP852 as written by FAND:

```xml
<?xml version="1.0" encoding="utf-8" ?>
<configuration>
<appSettings>
<add key="vat" value="CZ27082440    "/>      <!-- ADRESY.Dic, A14, may carry trailing spaces -->
<add key="outputFilename" value="C:\UCTO2026\{TISK}\UctoVIES.HTM"/>
</appSettings>
</configuration>
```

Účto reads the HTML only to wait for it (`gettxt(FILE)`, result unused).

## What it does (decompiled C#)

1. `LoadConfig`: `vat` and `outputFilename` must be present, and the directory of
   `outputFilename` must exist. Otherwise it shows a MessageBox
   "Chyba při čtení parametrů.\n\rDetail:…" and exits with 1. `VatParser(vat.ToUpper())`:
   the country is `Trim()[0..2]` and the number is `Trim()[2..]`. Inner spaces are
   **not** removed on this path.
2. `ViesClientHttps.CheckVatAsync(country, number)` makes a raw SOAP POST with an
   `HttpClient` (15 s timeout):
   * URL `https://ec.europa.eu/taxation_customs/vies/services/checkVatService`
   * `Content-Type: text/xml; charset=utf-8`, no SOAPAction
   * Body:
     ```xml
     <?xml version="1.0" encoding="utf-8"?>
     <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                       xmlns:urn="urn:ec.europa.eu:taxud:vies:services:checkVat:types">
        <soapenv:Header/>
        <soapenv:Body>
           <urn:checkVat>
              <urn:countryCode>CZ</urn:countryCode>
              <urn:vatNumber>27082440</urn:vatNumber>
           </urn:checkVat>
        </soapenv:Body>
     </soapenv:Envelope>
     ```
   * Throttle: at least 1000 ms between calls. Retry up to 3 attempts, with delays of
     2000·attempt ms, when the message contains `MS_MAX_CONCURRENT_REQ`,
     `SERVICE_UNAVAILABLE`, `TIMEOUT` or `TEMPORARILY`. On a non-2xx status it
     extracts a SOAP `Fault/faultstring`. Because of a catch-all, that exception is
     swallowed and `EnsureSuccessStatusCode` throws instead.
   * Parse: the first descendants `valid` (`== "true"`), `name` and `address` in the
     `urn:…checkVat:types` namespace. `\n` in the address becomes `", "`.
   * `VatSubject { Created = now, Valid, SubjectName = name, Vat = valid ? number : country+" "+number, Country, Address }`.
3. `ShowHtmlReport` fills a T4 template (`ReportTemplate.cs`, reproduce it verbatim):
   * `<html lang="cs">`, title `UctoVIES [v 1.0.1] - výsledek dotazu`, Bootstrap 5.2.0
     and bootstrap-icons 1.9.1 from cdn.jsdelivr.net with a `Courier New` body.
   * Heading "Ověřování DIČ pro účely DPH prostřednictvím systému VIES".
   * Green "Ano, platné DIČ" or red "Zadané DIČ nebylo nalezeno nebo není platné".
   * Table rows: Členský stát, DIČ, Datum přijetí žádosti (`DateTime.ToString()`,
     Czech locale `d.M.yyyy H:mm:ss`), Jméno, Adresa. Everything is HTML-encoded.
   * A printer icon runs `window.print()`, and there is print CSS. The footer shows
     `UctoVies [ver: 1.0.1.x]`.
   * A null `name` or `address` would throw in the template (`ToStringWithCulture(null)`).
     VIES returns `---` for unknown data, so this rarely happens.
4. `Process.Start(outputFilename)` opens the page in the default browser.
5. Any error shows a MessageBox "Chyba:\r\n<msg>.\n\rAplikaci ukončíte stiskem tlačítka OK."
   and the HTML stays empty.

Dead code, not used: `ViesClient` (WCF `BasicHttpBinding`), `EuropeanVatInformation`
(a `WebClient` variant that strips spaces), and `CheckVAT` (WCF).

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uctovies.ts`, key `uctovies.exe`.

* Read `<exeDir>/UctoVIES.xml`, decode as CP852, and take `vat` and `outputFilename`.
* Normalize: upper-case and trim. Also remove inner spaces and `/`; this is a safe
  improvement. Country = first 2 chars, which must match `/^[A-Z]{2}$/`; otherwise
  show a message "DIČ … není ve správném formátu" (the original's wording has a typo).
  Map `GR` to `EL`, since VIES uses EL for Greece.
* Make the SOAP call with `fetch` and the same envelope, a 15 s timeout, the same
  throttle and retry rules, and `fast-xml-parser` with `removeNSPrefix`. Report a
  SOAP `faultstring` (e.g. `INVALID_INPUT`, `MS_UNAVAILABLE`) to the user.
* Render the same HTML: port the T4 template to a TS template literal with an
  `htmlEscape` helper, and keep the Czech texts. Write it as UTF-8 with a BOM to the
  mapped `outputFilename`.
* OS integration: `ctx.host.openPath(htmlPath)` (Electron `shell.openPath`, which
  opens the default browser). An alternative is an Electron `BrowserWindow` that
  shows the file, so it works offline without bootstrap (the CDN CSS is cosmetic).
  Printing works in either viewer via `window.print()`.
* Headless mode records the "open" request instead of launching a browser.
* Still worth replacing: yes. It is a simple, commonly used check for intra-EU supplies.

## Test approach

* Fixtures: recorded VIES responses: valid (with multi-line address), invalid
  (`valid=false`, name `---`), a SOAP fault `MS_MAX_CONCURRENT_REQ`, then success on
  retry (mocked `fetch` plus fake timers), and HTTP 500 `INVALID_INPUT`.
* Snapshot test of the generated HTML, with `Created` and the version injected so the
  output is deterministic.
* Config parsing with a trailing-space `Dic` (A14), and a lower-case `cz…` value.
* Optional live test (`VIES_LIVE=1`): `CZ00006947`.
