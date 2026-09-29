# Nepl2.exe – unreliable VAT payer check and published bank accounts (MF ČR)

`{ap02}\Nepl2.exe` (31 KB, .NET 4.0 WinExe, assembly name "NespolehlivyPlatceRebex").
It uses Rebex.Http for TLS 1.2 and a `SoapHttpClientProtocol` proxy generated from the
MF ČR WSDL. For a list of Czech DIČ it queries the service *Registr plátců DPH –
nespolehlivý plátce* and writes one line per DIČ: the unreliable-payer flag, the date
it was published and the published bank accounts.
Decompiled source: `work/decompiled/{ap02}_Nepl2/`.

## How Účto calls it

| | |
|---|---|
| Command line | none. Účto always uses the list mode (`ExecWin(FILE.Path,'')`). An optional `args[0]` = single DIČ exists but is never used |
| Input | `<exe dir>\neplin.txt`, one DIČ per line, **without** `CZ` and without `/` |
| Output | `<exe dir>\neplout.txt` (deleted at start, rewritten on success) |
| Logs | `<exe dir>\Nepl2-app.log` (errors), `<exe dir>\Nepl2-rebex.log` (Rebex debug trace of every request) |
| Paths | derived from `argv[0]`, so `{ap02}` in practice. The embedded `app.config` keys `ImportFile`/`ExportFile` (`c:\ucto\…`) are ignored |
| Exit code | not used. 1 only on I/O errors |

Entry points:

1. `AdrNePl1(di)` (`UCTO2026_RDB/0244_P_AdrNePl1.txt`) checks a single DIČ. It is
   called from [Ares2](ares2.md) after an ARES lookup of a VAT payer, to fill
   `ADRESY.Ucet`.
   ```
   di:=replace('CZ',di,'','u'); di:=replace('/',di,'');
   TXT.Path:=PROGRAM.Path+'{AP02}\NEPLIN.TXT'; puttxt(TXT,di);
   FILE.Path:=PROGRAM.Path+'{AP02}\NEPL2.EXE';
   TXT.Path:=PROGRAM.Path+'{AP02}\NEPLOUT.TXT'; puttxt(TXT,'');
   proc(Vypocet1); proc(ExecWin,(FILE.Path,''));
   if PARAM3.SyncW then proc(WaitFor,(TXT.Path,'NEPL2.EXE'));
   s:=gettxt(TXT); proc(Vypocet2);
   s:=copyline(s,1); úč:=copy(s,24,1000); úč:=replace(' ',úč,''); PARAM3.TTT:=úč;
   ```
   `Ares2` then takes `PARAM3.TTT`. With one account it goes straight into `Ucet`;
   with several (comma separated) the user picks one (`selectstr(…,delim=',')`).
2. `AdrNePl(i:index of ADRESY)` (`0243_P_AdrNePl.txt`) checks a batch. It collects the
   `Dic` of every record in the index with `PlatDPH & Dic<>~''`, writes them CRLF
   separated to `NEPLIN.TXT`, runs the exe, and passes `NEPLOUT.TXT` to report
   `AdrNePl` (`0242_R_AdrNePl.txt`). The report prints `NESPOLEHLIVÝ PLÁTCE` and counts
   unreliable payers and *unregistered accounts* (an address `Ucet` that is not in the
   published list).
   Menus: address book Shift+F6 → "Všechny/Vybrané" → **"Nespolehlivý plátce?"**
   (`0255_P_AdresySF6x.txt`), and receivables/payables settlement
   **"Nespolehlivý plátce?"** (`MODUL01_PRO/0299_P_PohlZavPropl.txt`, the partners of
   the payables marked for payment).

How the report reads each output line (`copyline(NePlOut,count)`, matched to the input
by **line order**):

```
pl:=copy(s,13,1);                                  { A / N / ? }
úč:=copy(s,24,1000); úč:=replace(' ',úč,''); if length(úč)<6 then úč:='';
```

## What it does (decompiled C#)

* It reads at most **101** lines from `neplin.txt` (`num <= 100` loop, UTF-8/ASCII).
* It makes one SOAP call, `getStatusNespolehlivyPlatce(string[] dic)`:
  * Endpoint: `https://adisrws.mfcr.cz/dpr/axis2/services/rozhraniCRPDPH.rozhraniCRPDPHSOAP`
  * `SOAPAction: "http://adis.mfcr.cz/rozhraniCRPDPH/getStatusNespolehlivyPlatce"`
  * Document/literal. The request element is `StatusNespolehlivyPlatceRequest` and
    the response element is `StatusNespolehlivyPlatceResponse`, both in namespace
    `http://adis.mfcr.cz/rozhraniCRPDPH/` (strings in the binary):
    ```xml
    <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"
                      xmlns:roz="http://adis.mfcr.cz/rozhraniCRPDPH/">
      <soapenv:Body>
        <roz:StatusNespolehlivyPlatceRequest>
          <roz:dic>27082440</roz:dic>
          <roz:dic>…</roz:dic>          <!-- max 100 per request -->
        </roz:StatusNespolehlivyPlatceRequest>
      </soapenv:Body>
    </soapenv:Envelope>
    ```
  * Response: `<status odpovedGenerovana="date" statusCode="int" statusText="…" bezVypisuUctu="…"/>`
    followed by one `<statusPlatceDPH dic="…" nespolehlivyPlatce="NE|ANO|NENALEZEN"
    datumZverejneniNespolehlivosti="yyyy-mm-dd" cisloFu="…">` per DIČ. Each contains
    `<zverejneneUcty><ucet datumZverejneni="…"><standardniUcet predcisli="…"
    cislo="…" kodBanky="…"/> | <nestandardniUcet cislo="IBAN…"/></ucet>…`.
  * The other operations (`getSeznamNespolehlivyPlatce`,
    `getStatusNespolehlivyPlatceRozsireny`) are not used.
* `SslAcceptAllCertificates = true`: certificate validation is off. The replacement
  must **not** copy this.
* It writes `neplout.txt` with `StreamWriter` defaults (UTF-8 without BOM, CRLF),
  one line per returned `statusPlatceDPH` in response order:
  ```
  String.Format("{0,-10}{1}{2:dd.MM.yyyy}", dic, flag, date)  +  accounts
  flag  = N (NE) | A (ANO) | ? (NENALEZEN)
  date  = datumZverejneniNespolehlivosti for ANO, else DateTime.MinValue = "01.01.0001"
  accounts = for each ucet: "predcisli-cislo/kodBanky," or "cislo/kodBanky," (standard),
             "cislo," (non-standard); the trailing comma is removed
  ```
  Example: `27082440  N01.01.00012000145399/0800,19-2000145399/0800`.
* Service status: the code checks `new StatusType().statusCode` (a fresh object, always
  0) instead of the response status, so outages (status 2 = maintenance window,
  3 = service unavailable) are **not** detected. SOAP faults and exceptions go to
  `Nepl2-app.log` (`dd.MM.yyyy - HH:mm | Chyba: … | Podrobnosti: …`). A top-level
  exception shows a MessageBox: "Při dotazování na službu Nespolehlivý plátce DPH
  nastala chyba: …".

### Column mismatch between Nepl2 and Účto (important)

Nepl2 pads the DIČ to **10** characters, so the flag is at column 11 and the accounts
start at column 22. Účto's FAND code reads the flag at column **13** and the accounts
from column **24**, both in `AdrNePl1` and in report `AdrNePl`. Both FAND consumers
agree with a DIČ padded to **12** characters (12 + 1 + 10 = 23). This suggests the
code was written for an older `NEPL.EXE`. With the current Nepl2 output, Účto reads a
date digit as the flag, so no payer is ever flagged unreliable, and it cuts the first
two characters off every account.
**Recommendation:** the replacement writes the layout the FAND code expects:
`dic.padEnd(12) + flag + date(10) + accounts`. That fixes both consumers without
touching Účto. Mark it clearly in code as a deliberate deviation from Nepl2.exe.
If byte-exact Nepl2 parity is ever needed, make it an option.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/nepl2.ts`, key `nepl2.exe`.

* Input: read `<exeDir>/NEPLIN.TXT` (case-insensitive), decode as CP852 (FAND wrote
  it), split on CRLF, trim, drop empty lines. `args[0]`, if present, is a single DIČ.
* Delete `NEPLOUT.TXT` first, as the original does. If the call fails, the file stays
  absent and Účto shows empty results.
* Split into chunks of 100 DIČ (the service limit). This is an improvement: the
  original silently checks only the first 101. Keep the output order the same as the
  input order, because the report matches lines by position. If the service omits a
  DIČ, emit a `?` line for it.
* HTTP: `fetch` POST, `Content-Type: text/xml; charset=utf-8`, plus the `SOAPAction`
  header, with a 30 s timeout. Build the envelope with template strings (the DIČ must
  be digits only; validate with `/^\d{8,10}$/` and escape anyway). Parse the response
  with `fast-xml-parser` (`ignoreAttributes:false`, `removeNSPrefix:true`,
  `isArray` for `statusPlatceDPH`, `ucet`).
* Check the real `status@statusCode`. For any non-zero value (the MF ČR
  documentation lists 0 = OK, 1 = too many DIČ, 2 = maintenance window,
  3 = unavailable; the message texts in the binary match 2 and 3), show
  `ctx.ui.message` with the service's `statusText` and do not write output.
* Output encoding: CP852. The content is ASCII, so this matches the original UTF-8
  byte for byte.
* Log errors to `<exeDir>/Nepl2-app.log` with the same line format. Drop the Rebex
  trace log.
* Libraries: `fast-xml-parser` and `iconv-lite` (already a dependency).
* Still worth replacing: yes. The VAT law (§ 109 ZDPH, guarantee liability) makes the
  unreliable-payer and account check part of the payment workflow.

## Test approach

* Fixtures in `test/fixtures/helpers/nepl2/`: recorded SOAP responses with
  (a) NE plus 2 standard accounts, one with `predcisli`,
  (b) ANO with `datumZverejneniNespolehlivosti`, (c) NENALEZEN, (d) a `nestandardniUcet`
  IBAN, (e) `statusCode="2"`, (f) a SOAP fault. Mock `fetch` and assert the exact
  `NEPLOUT.TXT` bytes.
* Chunking test with 250 DIČ: expect 3 requests and 250 output lines in input order.
* FAND-level test: run report `AdrNePl` on `{prik}` ADRESY with a stubbed helper and
  check the `!` and `?` marks and the counters `PARAM3.F1/F2`. This test covers the
  column layout decision.
* Optional live test (`NEPL_LIVE=1`) with DIČ `00006947`.
