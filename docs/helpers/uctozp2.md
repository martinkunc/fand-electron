# UctoZP2.exe – send PPPZ / HOZ to health-insurance portals (Portál ZP, VZP Point, ZPMV)

`{ap03}\UctoZP2.exe` (494 KB, .NET Framework 4.0 WinForms, **x86**, assembly `UctoZP`
1.0.0.9, "Aplikace pro komunikaci s portálem ZP", © 2015 Tichý & spol.). It takes the
fixed-width filing that Účto has already written, which is either PPPZ (the employer's
monthly premium statement) or HOZ (the bulk notification of employee changes). It lets the
user pick a signing certificate from the Windows store, or enter PIN+password for ZPMV,
then signs the filing (PKCS#7) and posts it to the insurer's "komunikační brána". It shows
the portal's answer in an embedded browser. Rebex (`Rebex.Http`, `Rebex.Networking`, …, in
`{ap03}`) supplies the TLS 1.2 HTTP client.
Decompiled source: `work/decompiled/{ap03}_UctoZP2/`. The app code is in `UctoZP/`
(forms), `UctoZP.DL/` (logic), `UctoZP.ZpMvcr/` and `UctoZP.UC/`. The ~150 top-level
`*Type.cs` files are the generated proxy of the ZPMV `eServices4` WSDL; only
`setFormularRequestType*`, `zamestnavatelType` and `pojistenecHOZType` are used.

## How Účto calls it

| | |
|---|---|
| Wrappers | `UctoZPpppz(MZDY,VetaP)` (`MODUL97_PRO/0380_P_UctoZPpppz.txt`), `UctoZPhoz` (`0378_P_UctoZPhoz.txt`) |
| Guard | `PAR04A2.UctoZP`, i.e. **Mzdy → Parametry "posílat z účta tiskopisy PPPZ a HOZ na Portál ZP? (A/N)"** (`MODUL04_PRO/0017_E_ParMzdyS.txt`, default false). Then the prompt "Odeslat <file> na Portál ZP" |
| Parameter file | report `UctoZPpppz` / `UctoZPhoz` (`0379_R_…`, `0377_R_…`), written to `{AP03}\UCTOZP.XML` (CP852, declared `IBM852`) |
| Command line | none |
| Working dir | Účto's current dir; the config is found relative to the exe dir (`APP_CONFIG_FILE=UctoZP.xml`, case-insensitive on Windows) |
| Input | the filing file `FILE.Path`, just written in `{MAIL}\` by FAND (see formats below) |
| Output | nothing that Účto reads. Errors are appended to `{AP03}\UCTOZP2.LOG`, and Rebex writes a debug log to `<exeDir>\rebex-log.txt` |
| Sync | `ExecWin(EXE,'')` then `clearkeybuf`, **no** `WaitFor`. On Windows FAND's `exec` blocks until the window closes |
| Exit code | not used |

```
begin
  if ^PAR04A2.UctoZP then exit;
  proc(Dotaz,(true,'Odeslat '+EndTxt('\',FILE.Path)+' na Portál ZP')); if ^PARAM3.Ano then exit;
  EXE.Path:=PROGRAM.Path+'{AP03}\UCTOZP2.EXE';
  if filesize(EXE)<=0 then begin proc(Hlaseni,('Program '+FILE.Path+' nenalezen')); exit end;
  if VetaP.Kód='211' then proc(eZPMV) else PARAM3.TTT:='';        { HOZ: copy(copyline(PARAM3.AAA,2),1,3)='211' }
  PARAM3.TTT:=FILE.Path+'\13\10'+PROGRAM.Path+'{AP03}\UCTOZP2.LOG'+'\13\10'+PARAM3.TTT;
  TXT.Path:=PROGRAM.Path+'{AP03}\UCTOZP.XML';
  report((MZDY,VetaP),UctoZPpppz,assign=TXT);                      { HOZ: report(,UctoZPhoz,…) }
  proc(ExecWin,(EXE.Path,'')); clearkeybuf;
end;
```

`eZPMV` (`0381_P_eZPMV.txt`) is used for ZPMV (code 211) only. It opens a small FAND form
"211 ZPMV / Přihlašovací údaje" with pin1, pin2 and password, pre-filled from the user
parameters `P02.UUU` (`GetParU('02','ZPMVp1'|'ZPMVp2'|'ZPMVpwd')`). If they were edited,
it saves them back (**in plain text**) and puts them into lines 3–5 of `PARAM3.TTT`.

The parameter file (the PPPZ report; HOZ is identical except `fileType=HOZ`, `payerNumber` =
the VS line of `PARAM3.AAA`, and `period` = the month of `OZNPOJ.DatZměn`):

```xml
<?xml version="1.0" encoding="IBM852" ?>
<configuration>
  <appSettings>
    <add key="fileType" value="PPPZ"/>                       <!-- PPPZ | HOZ -->
    <add key="filePath" value="C:\UCTO2026\{PRIK}\{MAIL}\12345678.H00"/>
    <add key="insName" value="ČPZP"/>                        <!-- POJIST.Zkr, '' → VZP -->
    <add key="insCode" value="205"/>                         <!-- POJIST.Kód -->
    <add key="encoding" value="852"/>
    <add key="infoText" value=""/>                           <!-- empty → built-in text -->
    <add key="employer" value="Firma s.r.o."/>               <!-- HtmlTxt(PAR97A2.NázevO) -->
    <add key="address" value="Ulice"/>                       <!-- HtmlTxt(PAR97A2.UliceO) -->
    <add key="streetNumber" value="12"/>                     <!-- PAR97A2.ČpO -->
    <add key="payerNumber" value="12345678"/>                <!-- VS from POJIST.Doklad or IČO -->
    <add key="zip" value="47301"/>
    <add key="city" value="Nový Bor"/>
    <add key="phone" value="…"/>
    <add key="period" value="09/2026"/>                      <!-- MM/YYYY -->
    <add key="pin1" value="…"/>                              <!-- only if zpmv lines exist -->
    <add key="pin2" value="…"/>
    <add key="password" value="…"/>
    <add key="logFileName" value="C:\UCTO2026\{AP03}\UCTOZP2.LOG"/>
    <add key="acceptAllCertificates" value="false"/>         <!-- PARAM3.AcceptCrt -->
  </appSettings>
</configuration>
```

`#RF (zpmv<>~'')` prints the pin block only for ZPMV, so otherwise the keys are missing.
The config file stays on disk with the ZPMV password in plain text.

### Call sites

| Menu | FAND producer of `FILE` | Format |
|---|---|---|
| Mzdy → Zdravotní pojištění → pojišťovna → **e-Podání Portál ZP → "VZP Point 111 VZP"** (`MODUL97_PRO/0388_P_ZdrPoj1Poj.txt`) | `PojZamEvzp` (`0374`/report `0373`), default `{MAIL}\<IČO>.00p` | VZP PPPZ, 50 chars |
| … → **"Portál ZP ostatní pojišťovny"** | `PojZamE` (`0372`/`0371`), default `{MAIL}\<IČO>.H00` | Portál ZP PPPZ, 61 chars |
| … → **"Formulář H76 211 ZPMV"** | `PojZamEzpmv` (`0376`/`0375`), default `{MAIL}\<IČO>.TXT` | `%H76` record, 51 chars |
| Mzdy → Oznámení pojišťovně (HOZ) → pojišťovna → **"e-Podání Portál ZP"** (`MODUL97_PRO/0368_P_HromOznPoj.txt`) | `OznE` (`0362`/`0360`), default `{MAIL}\<IČO>.00` | HOZ, 138 chars per employee line |

In each case, FAND first shows the file in its viewer, copies the path to the clipboard
(`FANDCLIP.EXE`), and shows "Soubor pro e-Podání … (CtrlV)". It then calls the wrapper,
which runs only if `PAR04A2.UctoZP` is set. Without it the user uploads the file on the
portal by hand, and that path must keep working.

## Filing file formats (written by FAND, CP852, CRLF)

* **Portál ZP PPPZ** (`PojZamE`, one line; FAND pads a 54-char line to 61 + CRLF):
  `IČO(8) '00'(2) kodZP(3) YYYY(4) MM(2) početZam(5) základ(10) pojistné(10)
  datumSplatnosti DDMMYYYY(8) kód ' '|'O'(1) datumOpravy DDMMYYYY|8 spaces(8)`.
  `PppzService.PppzParser` reads the same offsets.
* **VZP PPPZ** (`PojZamEvzp`): `IČO(8) '00' MMYYYY(6) početZam(10, zero-padded)
  základ(12, zero-padded) pojistné(12, zero-padded)`. `VzpPppzParser`.
* **ZPMV H76** (`PojZamEzpmv`, truncated to 51 chars): `'%H76' 'R'|'O' IČO(8)+3 spaces(11)
  MMYYYY(6) početZam(5) základ(12.2) pojistné(12.2)`. `ZpMvcrPppzParser`: `R` → `typ=1`,
  `O` → `typ=2`; amounts are parsed with `en-US` culture.
* **HOZ** (`OznE`, one line per employee): `kód(1) čísloPojištěnce(10) příjmení(30)
  jméno(24) datumZměny DDMMYYYY(8) ulice(30) obec(30) PSČ(5)`. `HozService.HozParser`.

## What it does (decompiled C#)

### Startup and main window (`FormMain`)
* Config: `LoadConfigData`/`Config.LoadConfiguration` read the keys above.
  * A bad `fileType` gives "Chyba: Parametr \"fileType\" obsahuje neplatnou hodnotu", and
    a bad `encoding` gives "…encoding obsahuje neplatnou hodnotu". In both cases the
    buttons are disabled.
  * `infoText` shorter than 11 chars becomes "Timto se prihlasuji k Portalu []. Soucasne
    predavam podani pro prehled plateb pojistneho zamestnavatele v definovanem datovem
    rozhrani. Po predani tohoto podani a prijmu odpovedi Portalu [] se z Portalu []
    odhlasuji.". `[]` is replaced with `insName.ToUpper()`, and then diacritics are
    removed (NFD, dropping non-spacing marks). The same text is used for HOZ.
  * `insCode` 111 means VZP, 211 means ZPMVCR (PIN login), and anything else means
    PORTALZP. Every code except 211 uses certificate login.
  * `rebexLogFile` is never written by Účto, so it defaults to `<exeDir>\rebex-log.txt`.
  * `logFileName` is used by `ErrorProvider` (append, `dd.MM.yyyy - hh:mm | Chyba: … |
    Podrobnosti: …` plus a stack line, default encoding UTF-8).
* The window title is "Účto ZP - elektronická podání PPPZ a HOZ na portál ZP - verze:
  1.0.0.9". The tab "Výběr a odeslání podání" shows:
  * "Cesta k souboru", "Typ podání".
  * Either the group "Podpisový certifikát" or the group "Přihlášení pomocí PIN a hesla"
    (PIN1, PIN2, Heslo). The combo lists certificates from **CurrentUser\My** that have a
    private key and have not expired, shown as "Jméno: <CN> | Platnost do: <date> |
    Vydavatel: <issuer CN>".
  * The buttons "Prohlédnout obsah podání", "Podepsat a odeslat", "Tisk" and "Konec".
    Closing asks "Přejete si ukončit aplikaci?".
* **Prohlédnout obsah podání**: a read-only replica of the paper form, built from the
  parsed file plus the config employer data. `FormPppz` shows "Přehled o platbě pojistného
  na zdravotní pojištění zaměstnavatele", Období, Typ přehledu řádný/opravný, počet
  zaměstnanců, úhrn vyměřovacích základů and výše pojistného. `FormHoz` + `HozRepeater` +
  `HozPaticka` show "Hromadné oznámení zaměstnavatele" with one block per employee.
  This is purely informational.
* **Podepsat a odeslat** (`ValidateForm` → `SignAndSend`):
  * Checks: a certificate must be selected ("Nebyl vybrán žádný podpisový certifikát."),
    or PIN1 and password must be filled in ("Nejsou vyplněny přihlašovací údaje."). The
    file must exist ("Soubor … nebyl nalezen.").
  * `RemoveDiacritics(insName).ToUpper()` must be a key in `CollectionZP` ("Parametr
    \"insName\" obsahuje neplatnou hodnotu."):

    | insName | URL |
    |---|---|
    | VZP | `https://point.vzp.cz/kom_brana.phtml` |
    | CPZP (ČPZP, 205) | `https://portal.cpzp.cz/kom_brana.phtml` |
    | VOZP (201) | `https://portal.vozp.cz/kom_brana.phtml` |
    | RBP (213) | `https://portal.rbp-zp.cz/kom_brana.phtml` |
    | ZPS (ZPŠ, 209) | `https://portal.zpskoda.cz/kom_brana.phtml` |
    | OZP (207) | `https://portal.ozp.cz/kom_brana.phtml` |
    | ZPMV (211) | `https://eforms.zpmvcr.cz/eServices3` |
    | TEST / TESTSPOLZONA / ZPMVCRTEST | `https://pilot-pzp.asseco.cz/…`, `https://pilot-brn-pzp.asseco.cz/…`, `https://eforms.zpmvcr.cz:8444/eServices3` |

    Test URLs are reachable only by editing `insName`.
  * `FormWait` ("Čekejte prosím ...", marquee) runs the send on a BackgroundWorker. When it
    finishes, the "Výsledek podání" tab shows the result, and "Tisk" becomes enabled
    (`WebBrowser.ShowPrintDialog`).

### Portál ZP / VZP Point protocol (`PortalZpHelper`, certificate login)
1. `PortalZpEncoding`: ISO-8859-2 (28592). If the URL contains `vzp` it is **CP852**.
2. Read the file in `encoding` (852). For non-VZP portals, **remove diacritics** from the
   content. Convert it to the portal encoding and base64 the bytes.
3. `UnikatniInfo = DateTime.Now.ToString()` (Czech culture on a Czech PC, e.g.
   `28.09.2026 10:15:03`).
4. The message pattern to sign (no whitespace between elements):
   ```xml
   <Data Typ="POZADAVEK" Ucel="PPPZ|HOZ"><Prihlaseni UnikatniInfo="…">{infoText}</Prihlaseni><Soubor Jmeno="{file name}" Format="BASE64">{base64}</Soubor></Data>
   ```
5. `SignNoHash`: encode the pattern in the portal encoding. Build a CMS SignedData with
   **detached** content (`new SignedCms(…, new ContentInfo(bytes), detached: true)`).
   `CmsSigner` uses `IncludeOption = None`, so **no certificates are embedded**, and the
   signer is identified by issuer+serial. The signed attributes are the automatic
   contentType and messageDigest plus `Pkcs9SigningTime`. The digest is the framework
   default; for a `net40` target that is **SHA-1** (inferred: .NET 4.7.1+ keeps SHA-1 for
   apps targeting older frameworks). A `Sign()` variant with SHA-256 exists but is unused.
   The result is base64 with line breaks every 76 chars, wrapped as
   `\r\n-----BEGIN PKCS7-----\r\n{b64}\r\n-----END PKCS7-----\r\n`.
6. The request document (`Komunikace.ToString()`):
   ```xml
   <?xml version="1.0" encoding="iso-8859-2|ibm852" ?><!DOCTYPE Komunikace><Komunikace><Data Typ="POZADAVEK" Ucel="PPPZ"><Prihlaseni UnikatniInfo="…">…</Prihlaseni><Soubor Jmeno="…" Format="BASE64">…</Soubor></Data><Podpis>{PEM block}</Podpis></Komunikace>
   ```
   The encoding name comes from `Encoding.BodyName`.
7. `POST {url}`, `Content-Type: application/x-www-form-urlencoded`, body
   `request=` + `HttpUtility.UrlEncode(xml)`, encoded to bytes with the **file encoding
   (852)** (the url-encoded text is ASCII, and UrlEncode itself uses UTF-8 for non-ASCII).
   Rebex TLS 1.2 only; `SslAcceptAllCertificates` if `acceptAllCertificates=true`.
   Rebex also registers EC, Curve25519 and Ed25519. There is no client-certificate TLS,
   because authentication is the CMS signature.
8. Response decoding: `iso-8859-2` in Content-Type → the portal encoding; `utf-8` → UTF-8;
   otherwise CP852. Parse it with XmlReader (DTD ignored):
   * `<Data PZP_IdPodani=… PZP_Chyba=… Ucel=… Typ=…>`: the fields "ID podání", "Chyba"
     and "Druh".
   * `<Soubor Format="BASE64|TEXT">`: base64-decode it and re-decode by the charset named
     inside (utf-8, windows-1250 or ibm852; otherwise the portal encoding). The result is
     an HTML/text protocol that goes into the WebBrowser ("Zpráva").
   * Nothing is saved to disk (`ResultFileName = "result.xml"` is dead code).

### ZPMV protocol (`PortalZpMvcrHelper`, PIN login)
* The body is built from the **parsed** file, not the raw file:
  * PPPZ: `PodaniPppz.GetPppzMessage(typ, now, mesic, rok, pocetZamestnancu, zaklad,
    pojistne)`.
  * HOZ: `PodaniHoz.GetHozMessage()`, with `obdobi` from `period` and each employee line →
    `pojistenec {kod, rodneCislo, datumZmeny(DDMMYYYY→date), jmeno, prijmeni, ulice,
    cisloPopisne=null, psc, obec}` with `pocetListu = count`. Fields are not trimmed, so
    they carry the fixed-width padding.
  * Both use `zamestnavatel {nazev, identifikacniCislo=payerNumber, ulice, cisloPopisne,
    psc, obec, telefon}` from the config.
* `XmlSerializer` of `setFormularRequestType` (ns `net:atos:ava:kobra:ws:eservices4:vo`).
  Namespaces are then stripped, the `PPZ` or `HOZ` element is taken, and every tag is
  prefixed with `net1:`. The resulting element order follows the declaration order:
  * PPZ: `typ, obdobi{rok, mesic}, zamestnavatel, pocetZamestnancu, vymerenyZaklad,
    sumaPojistneho, datumVyplneni(yyyy-MM-dd)`.
  * HOZ: `obdobi{rok, mesic}, zamestnavatel, pojistenec*, pocetListu, datumVyplneni`.
* The SOAP 1.1 envelope, with a WS-Security UsernameToken:
  ```xml
  <soapenv:Envelope xmlns:net="net:atos:ava:kobra:ws:eservices4:endpoint" xmlns:net1="net:atos:ava:kobra:ws:eservices4:vo" xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/">
    <soapenv:Header><wsse:Security soapenv:mustUnderstand="1" xmlns:wsse="…oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="…oasis-200401-wss-wssecurity-utility-1.0.xsd">
      <wsse:UsernameToken wsu:Id="UsernameToken-{guid N}">
        <wsse:Username>{pin1}{pin2}</wsse:Username>
        <wsse:Password Type="…#PasswordDigest">{digest}</wsse:Password>
        <wsse:Nonce EncodingType="…#Base64Binary">{base64(utf8(GUID upper))}</wsse:Nonce>
        <wsu:Created>{UTC yyyy-MM-ddTHH:mm:ss.fffZ}</wsu:Created>
      </wsse:UsernameToken></wsse:Security></soapenv:Header>
    <soapenv:Body><net:SetFormularRequest>{net1:PPZ | net1:HOZ}</net:SetFormularRequest></soapenv:Body>
  </soapenv:Envelope>
  ```
  The digest is **non-standard**:
  * `pwHash = HEX_UPPER(SHA1(SHA1(utf8(hex_lower(MD5(utf8(password)))))))`.
  * `digest = base64(SHA1(utf8(GUIDstring + created + pwHash)))`, where `GUIDstring` is
    the upper-case GUID text itself, not the decoded nonce bytes.
* `POST https://eforms.zpmvcr.cz/eServices3` with `Content-Type: text/xml;charset="utf-8"`,
  `Accept: text/xml`, UTF-8 body, .NET HttpWebRequest (no Rebex, no SOAPAction header).
  The response body of a WebException is read as well.
* Result: strip namespaces, then find `vysledek{kod,text,textDetail}` or `Fault{faultcode,
  faultstring}`:
  * `kod=4` → "Kód 4 - Zpracování proběhlo v pořádku".
  * A code of 3+ chars → "Při pokusu o odeslání požadavku došlo k chybě na úrovni SOAP
    komunikace. | Kód chyby:… Popis:…".
  * Otherwise → "Požadavek se nepodařilo zpracovat. | Kód chyby:… Popis:…".

  The text is shown in the WebBrowser.

Errors almost everywhere become `MessageBox("Chyba: …")` plus a log line, and the flow
continues with empty data.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uctozp2.ts`, key `uctozp2.exe`, in-process and synchronous (the
FAND call blocks until our dialog closes). Split it into:

* `helpers/zp/files.ts`: parsers for the four fixed-width formats (offsets above, CP852 via
  `iconv-lite`). They drive the preview and the ZPMV body.
* `helpers/zp/portalzp.ts`: the kom_brana client.
  * Build the pattern exactly as above. Encode it with `iconv-lite` (`iso-8859-2` or
    `cp852`) and base64 the file bytes.
  * `UnikatniInfo`: `dd.MM.yyyy H:mm:ss` local time (the Czech `DateTime.ToString()`).
  * Diacritics removal: `s.normalize('NFD').replace(/\p{Mn}/gu, '')`.
  * **CMS signature** with `node-forge` `pkcs7.createSignedData()`: `content` = the
    pattern bytes. `addSigner({key, certificate, digestAlgorithm: sha1,
    authenticatedAttributes: [contentType, messageDigest, signingTime]})`. Sign with
    `{detached: true}`, then remove `p7.certificates` before `toAsn1()` (the original
    embeds no certificates). Keep SHA-1 as the default for parity. Add a config switch
    for SHA-256, which is worth testing against the pilot portal, since modern portals
    may reject SHA-1.
  * POST with `fetch` (undici): `application/x-www-form-urlencoded`,
    `request=${encodeURIComponent(xml)}`. .NET `UrlEncode` encodes spaces as `+` and uses
    lower-case hex. Mimic it with `new URLSearchParams({request: xml}).toString()`, which
    also produces `+`. The XML is ASCII after base64, except `infoText`, which has no
    diacritics. `acceptAllCertificates=true` → an undici `Agent({connect:
    {rejectUnauthorized:false}})` plus a warning in the log.
  * Response: pick the charset as above, parse with `fast-xml-parser`
    (`ignoreAttributes:false`, `processEntities`; the `<!DOCTYPE Komunikace>` is
    harmless), then decode the `Soubor` payload.
* `helpers/zp/zpmv.ts`: the ZPMV SOAP client. It builds the XML body by hand in the exact
  element order above (no serializer is needed; escape the text). The digest uses
  `node:crypto` (`md5`, `sha1`). `Created` is `new Date().toISOString()`, which already has
  milliseconds and `Z`. It parses `vysledek`/`Fault` with `fast-xml-parser`
  (`removeNSPrefix:true`).
* **Signing identity (cross-platform)**: there is no Windows certificate store. Use a
  PKCS#12 file plus a password:
  * Add a Účto-independent engine setting `zp.certPath` (the host settings store, not a
    FAND file). The UI offers "Vybrat certifikát (.pfx/.p12)" through
    `ctx.ui.pickPath` / Electron `dialog.showOpenDialog`, then prompts for the password
    (not stored, or stored through Electron `safeStorage` if the user agrees).
  * Load it with `forge.pkcs12.pkcs12FromAsn1`. List the certificates that have a
    matching key and are valid today, labelled as in the original ("Jméno: … | Platnost
    do: … | Vydavatel: …").
  * *Optional later*: on Windows, read the CurrentUser\My store through PowerShell
    `Export-PfxCertificate` or a tiny native module. Not needed for the first version.
    Qualified certificates on smart cards (non-exportable keys) cannot be supported this
    way. Document that, and point users to the manual upload.
* **UI**: a FAND-style console dialog through `ctx.ui`, not a native window:
  1. The header "Účto ZP – elektronická podání PPPZ a HOZ", the file, the type and the
     insurer.
  2. Certificate selection, or PIN1/PIN2/Heslo pre-filled from the config (password
     masked).
  3. Actions **Prohlédnout obsah** (a text rendering of the parsed form in the engine's
     text viewer; no replica of the paper form), **Podepsat a odeslat**, **Konec**.
  4. A progress box "Čekejte prosím ...".
  5. The result: ID podání, Chyba, Druh. The HTML/text "Zpráva" goes to a temp `.html`
     file and opens with `ctx.host.openPath` (the system browser handles viewing and
     printing, which replaces the embedded WebBrowser + "Tisk"). For ZPMV, show the
     result text in the dialog.
* **Config and logs**: read `{AP03}/UCTOZP.XML` case-insensitively as CP852 (the
  declaration says IBM852). Then **delete it**, because it contains the ZPMV password
  (an improvement over the original). Append errors to `logFileName` in the original
  format, and put the protocol and HTTP trace in the engine debug log (no Rebex log).
* Return 0.

Still worth replacing: **medium priority**. It is opt-in (`PAR04A2.UctoZP` defaults to
false), and every filing can still be uploaded by hand or sent through the data box
(`DsPPZ`, `DsHOZ` → UctoDS2), which is the path most users take. The PKCS#12 requirement
changes the UX. Also verify that the `kom_brana.phtml` endpoints still accept this
protocol and SHA-1 CMS before investing. The ZPMV eServices3 part is the cheapest win,
because it needs only PIN+password.

## Test approach

* **Parsers**: fixtures generated by the engine from `{prik}` (Stehlík sample company,
  MZDY/POJIST/OZNPOJ) through the reports `PojZamE`, `PojZamEvzp`, `PojZamEzpmv` and
  `OznE`. Assert the parsed fields, and assert the 61/50/51/138-char line lengths.
* **CMS**: sign with a throw-away self-signed PKCS#12 generated in the test (forge). Then
  verify with `openssl cms -verify -binary -inform PEM -content pattern.bin -noverify
  -certfile cert.pem` (or with forge/pkijs in-process). Check detached content, no
  embedded certificates, issuer+serial SID, and signingTime present.
* **Request bytes**: golden test of the full `Komunikace` document and form body, with a
  fixed clock and a fixed signature stub. Check the diacritics removal, the ISO-8859-2 vs
  CP852 branch for VZP, and the `+` encoding of spaces.
* **ZPMV digest**: a known vector. Compute it once with the decompiled C# logic
  (e.g. in `dotnet-script`, or by hand in the test comments) for password `heslo`, GUID
  `00000000-…`, and a fixed `created`. Then assert the whole envelope for a PPPZ and a HOZ
  fixture.
* **Responses**: mocked `fetch` with a kom_brana answer (`PZP_IdPodani`, a BASE64
  `Soubor` in windows-1250), an error answer (`PZP_Chyba`), a ZPMV `vysledek kod=4`, a
  SOAP `Fault`, and HTTP 500.
* **Live (manual, env-gated)**: the Asseco pilot `pilot-pzp.asseco.cz` with a test
  certificate, and `eforms.zpmvcr.cz:8444` with test credentials, if the vendor or insurer
  provides them.
* **Engine integration**: set `PAR04A2.UctoZP`, run Mzdy → Zdravotní pojištění →
  e-Podání Portál ZP, confirm "Odeslat … na Portál ZP", then expect our dialog (with
  mocked HTTP) and the return to the menu.
