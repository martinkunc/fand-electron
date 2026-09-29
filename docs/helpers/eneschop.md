# ENESCHOP.EXE – fetch the ČSSZ answer to an eNeschopenka query and render PDFs (legacy)

`{tisk}\ENESCHOP.EXE` (44 KB, VB.NET, .NET 4.x WinExe, dated 2020-09, uses Rebex.Http
+ Rebex PKCS for decryption and the COM component **PDFCreatorPilot** for the PDF). An
employer first sends ČSSZ the query **DZDPN20** ("Dotaz zaměstnavatele na DPN": which
employees are on sick leave, the eNeschopenka service). ENESCHOP polls the VREP
gateway for the answer, decrypts it with the employer's PFX, and fills one PDF page per
sick-leave notification into `{SEST}\ENESCHOP.PDF`, which it opens.
Decompiled source: `work/decompiled/{tisk}_ENESCHOP/ENESCHOP/ENeschop.cs`.

## How Účto calls it

Menu: **Zaměstnanci (MODUL04 main menu) → "eNeschopenka" → `call(MODUL97,DZDPN)`
(`MODUL97_PRO/0140_P_DZDPN.txt`) → "Odpovědi ČSSZ" → "Na poslední dotaz" / "Na starší
dotazy"**. Both run `MODUL99_PRO/0167_P_VrepDZ.txt`, which loads `VREP.UUU` (this year's or
last year's), filters `Druh` = `DZDPN*`, and takes either the newest record or the one the
user picks, then calls `MODUL99_PRO/0166_P_eNeschop.txt`:

```
proc(Dotaz,(true,'Vyžádat na ČSSZ odpověď na dotaz '+Trail(VetaV.Druh)+' ze dne '+strdate(VetaV.Datum,'DD.MM.YYYY hh:mm')));
if ^PARAM3.Ano then exit;
if PARAM3.Apep then begin proc(UctoApep,('N', VetaV.Druh, '', cert, pwd, '', …, VetaV.VsČssz, VetaV.Id));   { default }
end else begin
  FILE.Path:=PROGRAM.Path+'{TISK}\ENESCHOP.EXE';
  if filesize(FILE)<=0 then begin proc(Hlaseni,('Program '+FILE.Path+' nenalezen')); exit; end;
  s:=Trail(VetaV.Druh)+'/'+Trail(VetaV.VsČssz)+'/'+Trail(VetaV.Id)+'/'+ cert+'/'+pwd+'/'+cond(PARAM2.testDS:'A',else:'N');
  s:=nodiakr(s); puttxt(UCTOTXT3,s);
  with window(1,maxrow-2,80,maxrow-2,@) do begin
    proc(Hlaseni23,('Čekáme na odpověď ČSSZ na dotaz '+Trail(VetaV.Druh)+' ze dne '+…));
    proc(ExecWin,(FILE.Path,UCTOTXT3.Path)); setkeybuf('');
  end;
end;
```

`cert`/`pwd` come from `PAR97A3.CrtDZ` / `PAR97A3.PwdDZ` (defaults `{tisk}\sifructo.pfx` /
`ucto2000`), passed through `PARAM3.AAA`.

| | |
|---|---|
| Command line | `<DOS path of UCTOTXT3.UUU>` (no `$` guard) |
| Input file | one line, CP852 but ASCII after `nodiakr`: `Druh/VS/CorrelationID/certPath/certPwd/A\|N`. Split on `/`: [1] VS, [2] CorrelationID, [3] PFX path, [4] password, [5] `A` = test. A `/` in the path or password, or a password with diacritics (`nodiakr` alters it), breaks it |
| Working dir | Účto root. Program paths are relative to the **exe dir** (`{TISK}\`) |
| Templates | `{TISK}\ENP1.PDF` … `ENP5.PDF` (A4, 595×841 pt, one page each) |
| Output | `{TISK}\ENESCHOP.XML` (decrypted answer) and `{TISK}\..\{SEST}\ENESCHOP.PDF`, opened in the default viewer (`AutoLaunch`) |
| Exit code | not used |

## What it does (decompiled C#)

1. Creates the COM object `PDFCreatorPilot.PDFDocument4`. If it is missing (error 429),
   it offers to run `{TISK}\SETUPCP.EXE`. Then it parses the parameters ("Chyba v
   parametrech! Dotaz se neodeslal.").
2. `PosliDotaz`: a test run shows MsgBox "Testovací větev!". POST (Rebex) `text/xml`
   UTF-8 to **`https://t-epodani.cssz.cz/VREP/poll`** (test) or
   **`https://epodani.cssz.cz/VREP/submission`** (production). The paths are asymmetric
   in the original. The body (CRLF between elements):
   ```xml
   <?xml version="1.0" encoding="UTF-8"?>
   <GovTalkMessage xmlns="http://www.govtalk.gov.uk/CM/envelope">
   <EnvelopeVersion>2.0</EnvelopeVersion>
   <Header><MessageDetails>
   <Class>CSSZ_DZDPN</Class><Qualifier>poll</Qualifier><Function>submit</Function>
   <CorrelationID>{corID}</CorrelationID>
   </MessageDetails>
   <SenderDetails><IDAuthentication><SenderID></SenderID>
   <Authentication><Method>clear</Method><Value></Value></Authentication>
   </IDAuthentication></SenderDetails></Header>
   <GovTalkDetails><Keys><Key Type="vars">{VS}</Key></Keys>
   <GatewayAdditions><Flags><TimestampVersion>xmldsig</TimestampVersion></Flags></GatewayAdditions>
   </GovTalkDetails>
   <Body></Body>
   </GovTalkMessage>
   ```
3. Response handling (regexes): `<ProcessingResult.*?result="(.*?)" .*>.*</ProcessingResult>`
   must be `OK`, otherwise "Podání <ID: corID> nebylo na VREP nalezeno." Then
   `<Data.*>(.*)</Data>` → base64 → CMS **EnvelopedData**, decrypted with the key from the
   PFX (`CertificateChain.LoadPfx(certPath, certPwd)`) → the content is **gzip** →
   UTF-8 XML. It saves the XML as `{TISK}\ENESCHOP.XML` (`XmlDocument.Save`). Errors:
   "Chyba při zpracování odpovědi.\r\n<msg>" / "Chyba při odeslání dotazu."
4. `ZpracujVysledek`: namespace `http://schemas.cssz.cz/nem/DZDPN20-V2` for
   `DatumOd`, `DatumDo`, `Notifikace`. An empty `Notifikace` gives the MsgBox "Pro zadané
   období (<od> až <do>) nejsou žádné záznamy o pracovní neschopnosti." and exit.
   Otherwise, for each `VznikDpnInfo`, `TrvaniDpnInfo`, `UkonceniDpnInfo`, `ZmenaDpnInfo`,
   `StornoDpnInfo` (namespace `urn:cz:isvs:cssz:schemas:IkrMessageTypes:v2`; the sub-elements
   of `Zamestnani`, `Zamestnanec`, `Lekar*`, `UpresneniNeschopnosti`, `Vychazky` are in
   `…:v1`), it appends a copy of the template page `ENP1…ENP5.PDF` and writes text with
   Arial Bold 10 pt (`ShowUnicodeTextAt(x, y, text)`, y measured **from the top**):

   | Page | Fields (x,y) |
   |---|---|
   | ENP1 Vznik (start) | employer `NazevZamestnavatele + ", VS: " + VariabilniSymbol` (70,192); `NazevDruhuCinnosti` (137,210); `Jmeno Prijmeni` (154,258); `DatumNarozeni` (148,274); `RodneCislo` (128,290); `CisloRozhodnuti` (148,339); `DatumNeschopenOd` (161,354); PracovniUraz/UrazJinaOsoba/AlkoholOmamneLatky as Ano/Ne (150,390) (212,405) (386,419); `AdresaMistaPobytu` lines (70,450, box, 12 pt leading); `Vychazky` intervals (70,527); `LekarVystavil` NazevPzs/JmenoLekare/address (70,625/640/655); `Poznamka` (70,720); `IdPripadu` (169,765); `IdNotifikace` (175,786); print time (172,806) |
   | ENP2 Trvání (duration) | as ENP1 up to the birth number (y 204–315); `CisloRozhodnuti` (148,369), `DatumNeschopenOd` (161,387), `DatumVystaveniKeDni` (205,405); `LekarPotvrdil` (71,439/457/475); ids + time (169,493)(175,511)(172,534) |
   | ENP3 Ukončení (end) | like ENP2, with `DatumNeschopenDo` (172,406) and `LekarRozhodl` |
   | ENP4 Změna (change) | like ENP1; addresses (70,450), outings (70,550), doctor (71,675/690/705) |
   | ENP5 Storno (cancel) | employer (71,201), activity (137,219), person (154,269)(148,286)(128,305), `CisloRozhodnuti` (148,359), ids + time (170,395)(175,412)(172,431) |

   The exact element paths and every coordinate are in `ENeschop.cs`, lines 276–628.
   Quirks: the address line prints `DatumAdresaDo až DatumAdresaDo` (bug, should be
   Od–Do); dates are printed raw (ISO `YYYY-MM-DD`); the print time uses the
   `DateTime.ToString()` Czech format.
5. `DeletePage(0)` (the initial blank page), then
   `SaveToFile("<TISK>\..\{SEST}\ENESCHOP.PDF", AutoLaunch=true)`.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/vrep/eneschop.ts`, key `eneschop.exe`. It shares the GovTalk
transport with [ELPODPI2](elpodpi2.md) and the DPN parser/renderer with the UctoApep
replacement: UctoApep call type `N` does the same job through the WS endpoint and fills
the newer templates `{PDF2}\dpnZac/dpnTrv/dpnKon/dpnZmen/dpnStor.pdf`.

* Parse the `/`-separated line as the original does. Map the PFX path (DOS → host,
  relative to the Účto root).
* Transport: `fetch` POST of the poll envelope (template literal), 60 s timeout. Keep the
  original URLs, but make them configurable. **Check that ČSSZ still serves the legacy
  GovTalk poll**; if not, reuse the UctoApep WS client.
* Decryption: `node-forge` `pkcs12` (key + cert) and `forge.pkcs7.messageFromAsn1(...)` →
  `decrypt(recipient, privateKey)`. Forge supports RSA key transport with
  3DES/AES-CBC content encryption. If ČSSZ uses RSA-OAEP or AES-GCM, switch to `pkijs`
  + WebCrypto. Then `zlib.gunzipSync` and `TextDecoder('utf-8')`.
* Write `{TISK}\ENESCHOP.XML` (UTF-8, pretty printing not required).
* PDF: `pdf-lib` + `@pdf-lib/fontkit` with a bundled metric-compatible Arial Bold
  substitute (Liberation Sans Bold, OFL). `copyPages` from `ENP<n>.PDF` for each
  notification, and `page.drawText(text, { x, y: 841 - y - ascent, size: 10 })`. Calibrate
  the top-origin conversion once against the original output (PDFCreatorPilot's
  `ShowUnicodeTextAt` uses the top edge of the text box). Multi-line blocks become
  `drawText` with `lineHeight: 12` and `maxWidth`. Fix the Od–Do address bug and format
  dates as `DD.MM.YYYY` (the target is a readable form; parity is not needed).
* Save to `<Účto root>\{SEST}\ENESCHOP.PDF` (create the directory if needed) and open it
  with `ctx.host.openPath`. Headless mode records the open request.
* Messages through `ctx.ui.message`, with the original texts.

Still worth replacing on its own: **low priority.** It is only reached with
`PARAM3.Apep=false`; the default path is UctoApep `N`. Implement it only as a thin
adapter over the UctoApep DPN code (effort M on its own, S once UctoApep exists), or
register a stub that redirects to UctoApep.

## Test approach

* Build an encrypted fixture in the test: take a sample DZDPN20-V2 answer XML with one
  notification of each kind (hand-written from the schema in
  `work/decompiled/{tisk}_UctoApep/UctoVrepGui.Eneschopenka.Api_15.Dzdpn20v2_Dznp25/`),
  gzip it, encrypt it with `forge.pkcs7.createEnvelopedData` for a generated test PFX,
  and wrap it in a GovTalk poll response with `ProcessingResult result="OK"`. Mock `fetch`.
* Assert: the ENESCHOP.XML content, the PDF page count (= number of notifications),
  the text positions and strings via `pdfjs-dist` text extraction, and the "no
  records" message for an empty `Notifikace`.
* Error paths: `result="ERROR"` → "nebylo na VREP nalezeno", wrong PFX password, and a
  malformed parameter line.
