# UctoDS2.exe – send a file to an ISDS data box (Datová schránka)

`{ap02}\UctoDS2.exe` (660 KB, .NET Framework 4.8 WinForms, assembly `UctoDS2`,
namespace `UctoDSWin2`, dated 2024-11). It logs in to the Czech data-box system ISDS
(Informační systém datových schránek), sends **one data message with one attachment**
(the e-Podání XML or a PDF) to one recipient box, and appends a CSV line about the sent
message to `{AP02}\UCTODS.LOG`. Účto then shows that log as "Odeslané zprávy DS".
It uses Rebex.Http (TLS 1.2 on old Windows) and BouncyCastle (SHA3 for large
attachments). Decompiled source: `work/decompiled/{ap02}_UctoDS2/`.

`UctoDS.exe` (2022) is the older version of the same program. Účto still offers it as
a fallback ("-"- starší verze UctoDS 2022"), see [uctods.md](uctods.md).

## How Účto calls it

| | |
|---|---|
| Wrapper | procedure `EpoDS`, `UCTO2026_RDB/0613_P_EpoDS.txt` |
| Parameter file | report `EpoDS2`, `UCTO2026_RDB/0612_R_EpoDS2.txt`, writes `PROGRAM.Path+'{AP02}\UCTODS2.XML'` |
| Command line | none (`proc(ExecWin,(FILE.Path,''))`) |
| Config lookup | .NET `APP_CONFIG_FILE="UctoDS2.xml"`, relative to the exe directory. **The name case differs** (`UCTODS2.XML` is written), so the lookup must be case-insensitive |
| Output | appends one line to `OutputFilename` = `{AP02}\UCTODS.LOG` (CP852), plus log files `DS2_APP.LOG`, `DS2_ERR.LOG`, `DS2_RBX.LOG` in `{AP02}` |
| Side effect | **deletes** `UctoDS2.xml` right after loading it (it contains the password) |
| Exit code | not used. Účto does not wait and reads nothing afterwards |

### Menu paths

`EpoDS` opens the pulldown **"DATOVÁ SCHRÁNKA"** with the items "Odesílatel",
"Příjemce, Zpráva", **"Odeslat přes Datovou schránku"** (UctoDS2),
**"-"- starší verze UctoDS 2022"** (UctoDS), "Odeslané zprávy DS" (the log viewer
`MODUL99/UctoDSlog`), "MojeDatovaSchranka.cz" (copies the login to the clipboard, opens
the web), "Systémová nastavení" (`ParDS3a`: the Rebex/SSL/verbose-log flags), and
"Adresář {MAIL}".

`EpoDS` is reached from every e-filing menu through a "Datová schránka »" item:

| Caller | Feature | Recipient (`PARAM3.DS3náz` → box ID) |
|---|---|---|
| `UCTO2026_RDB/0614_P_EpoFu.txt` | e-Podání to the tax office (DPH, KH, DPPO, …) | tax office via `MODUL95/UzP2DS` (`451..464`, `1111..9999`), or `FÚ` → `PARAM2.eÚzP` |
| `MODUL03_PRO/0355_P_eVrep.txt` | ČSSZ OSVČ overview | `S<code>`: ČSSZ `5ffu6xk` (`PARAM1.DsČssz`) or a district OSSZ box from `CISOSSZ` |
| `MODUL97_PRO/0262_P_eVrep2.txt` | ČSSZ payroll filings (PVPOJ, NEMPRI, ONZ, ELDP, DZDPN, …); `POPRIJ` goes to the labour office | `S…` as above; `U` → ÚP `2akmgv5` (`PARAM1.DsUpId`); `J` → JMHZ `iie254d` |
| `MODUL94_PRO/0115_P_eVrep94.txt` | JMHZ (monthly employer report) | `J` → `iie254d` "e-Podání JMHZ" |
| `MODUL97_PRO/0387_P_DsPPZ.txt`, `0367_P_DsHOZ.txt`, `MODUL03_PRO/0298_P_DsVzp25.txt` | health-insurance reports (PPZ, HOZ, OSVČ overview) as XML or PDF | `Z<kód>` → `KODPOJ.idDS` |

The file being sent is `PARAM3.DS3file`, usually `{MAIL}\<form>.XML` or a `.PDF`.
Subject: `PARAM3.DS3subj`, optionally built from the mask `PARAM3.DS3mask`.

```
proc(Dotaz,(true,'Odeslat soubor '+EndTxt('\',Trail(PARAM3.DS3file))+' na Datovou schránku '+Trail(PARAM3.DS3id)));
if PARAM3.Ano then begin
  TXT.Path:=PROGRAM.Path+'{AP02}\UCTODS2.XML';
  PARAM3.AAA:=PROGRAM.Path+'{AP02}\'+'\13'+ Trail(FIRMA.Volume)+' '+PARAM2.Nazev;
  if nodiakr(PARAM2.pwdDS32)<>PARAM2.pwdDS32 then begin
    report(,EpoDS2,assign=SEST); proc(Utf8,(SEST.Path,TXT.Path))   { TOUTF8.EXE converts CP852 -> UTF-8 }
  end else report(,EpoDS2,assign=TXT);
  FILE.Path:=PROGRAM.Path+'{AP02}\UCTODS2.EXE';
  proc(ExecWin,(FILE.Path,''));
end;
```

### Parameter file `UCTODS2.XML`

Report `EpoDS2` (`#RF` expressions in order; `a1` = `PROGRAM.Path+'{AP02}\'`,
`a2` = `FIRMA.Volume+' '+PARAM2.Nazev`):

```xml
<?xml version="1.0" encoding="utf-8" ?>
<configuration>
  <appSettings>
    <add key="RecipientDSID" value="5ffu6xk"/>               <!-- PARAM3.DS3id -->
    <add key="SenderDSLogin" value="abc123"/>                <!-- PARAM2.jmDS (A10, 6-char login) -->
    <add key="SenderDSPassword" value="…"/>                  <!-- HtmlTxt(PARAM2.pwdDS32) -->
    <add key="SenderName" value="01 Firma s.r.o."/>          <!-- HtmlTxt(nodiakr(a2)) -->
    <add key="RecipientName" value="CSSZ"/>                  <!-- HtmlTxt(nodiakr(DS3náz)) -->
    <add key="SenderDSMobKey" value="N"/>                    <!-- PARAM2.mobDS, boolean printed as A/N -->
    <add key="Subject" value="Prehled o vysi pojistneho&#13;2026-01"/>  <!-- see below -->
    <add key="Filename" value="C:\\UCTO2026\\{MAIL}\\PVPOJ25.XML" />    <!-- backslashes doubled -->
    <add key="DSType" value="1"/>                            <!-- 0 test (czebox.cz), 1 production -->
    <add key="OutputFilename" value="C:\UCTO2026\{AP02}\UCTODS.LOG"/>
    <add key="OutputFormat" value="csv"/>
    <add key="OutputEncoding" value="0"/>                    <!-- 0 CP852, 1 CP1250, 2 UTF-8 -->
    <add key="Note" value="…"/>                              <!-- HtmlTxt(nodiakr(PARAM2.názDS)) -->
    <add value="C:\UCTO2026\{AP02}\DS2_APP.LOG" key="AppLogFile"/>
    <add value="C:\UCTO2026\{AP02}\DS2_ERR.LOG" key="ErrorLogFile"/>
    <add value="C:\UCTO2026\{AP02}\DS2_RBX.LOG" key="RebexLogFile"/>
    <add value="false" key="UseRebexOnly"/>                  <!-- PARAM3.RbxOnly -->
    <add value="false" key="AcceptAllCertificates"/>         <!-- PARAM3.AcceptCrt -->
    <add value="false" key="UseRebexVerboseLog"/>            <!-- PARAM3.VerbLog -->
  </appSettings>
</configuration>
```

Details that matter for the replacement:

* The XML is declared `utf-8`, but FAND writes it in **CP852** unless the password has
  diacritics; then the whole file goes through `TOUTF8.EXE` (`proc Utf8`). Every other
  value is `nodiakr` (no diacritics) **except `Filename`**, which can contain `Účto`-style
  paths, and the password. Decode with "valid UTF-8, otherwise CP852".
* The subject is `nodiakr(Trail(DS3subj))`, then `HtmlTxt` (entity escaping), with
  `§` → `par.`. `DS3subj` can hold several lines (CR, `\13`), so the value can contain a
  raw CR. .NET config reading keeps it, so the ISDS annotation contains the CR too.
* `Filename` has doubled backslashes (`replace('\',…,'\\')`). Windows tolerates this.
  Collapse runs of `\` before mapping the path.
* `mobDS` is a FAND boolean. It prints as `A`/`N`, which the program compares with `"A"`/`"N"`.

## What it does (decompiled C#)

1. `Program.Main`: sets `APP_CONFIG_FILE`, detects the Windows version and .NET 4.8. It
   uses native TLS 1.2 on Windows 10+ with .NET 4.8, otherwise Rebex (`HttpRequestCreator`,
   `TlsVersion.TLS12`, optional `SslAcceptAllCertificates`, Rebex log file). Reads
   the config (`Configuration.Initialize`):
   * `IsProductionEnvironment = Convert.ToBoolean(Convert.ToInt16(DSType))`
   * `MimeType = MimeTypeMap.GetMimeType(extension of Filename)`: `.xml` → `text/xml`,
     `.pdf` → `application/pdf`, `.txt` → `text/plain`, `.csv` → `text/csv`, `.zip` →
     `application/zip`; unknown → error "Dokument s příponou … není podporován."
   * a missing `OutputFilename` defaults to `Export.csv`.
   Then it **deletes** `<exeDir>\UctoDS2.xml`.
2. `FormMain` (title "Účto - modul Datové schránky (verze: x)", heading "Odeslání do
   Datové schránky") shows Odesílatel (login), Příjemce (box ID), Předmět, Soubor,
   a red "TESTOVACÍ REŽIM" label when `DSType=0`, and buttons **Odeslat**, **Náhled**
   (XML in an internal viewer, PDF/TXT opened with the shell), **Konec** (asks
   "Přejete si ukončit aplikaci?"). Ctrl+F10 shows the parameters including the
   **plain-text password**; Ctrl+F9 shows the config file.
3. `FormMain_Shown` → `ValidateForm`: non-empty password, recipient and login; no
   spaces in login or recipient. Otherwise it shows a message and disables Odeslat.
   Mobile key together with Rebex → error. Attachment > 20 MB (size/1000/1000) → asks
   whether to upload it as a **VoDZ** (large data message) first.
4. Odeslat → `FormWait` (modal, "Probíhá komunikace se systémem ISDS", marquee, Storno)
   runs `IsdsService` in a background worker:
   * **Login type** `SenderDSMobKey`: `A` = mobile key (MEP), otherwise password.
   * **Service URLs** (`https://<host>[/<suffix>]/DS/<service>`):

     | | production | test (`DSType=0`) |
     |---|---|---|
     | password, normal | `ws1.mojedatovaschranka.cz` | `ws1.czebox.cz` |
     | password, VoDZ | `ws2.mojedatovaschranka.cz` | `ws2.czebox.cz` |
     | mobile key | `www.mojedatovaschranka.cz/apps` | `www.czebox.cz/apps` |

     services: `dz` (dmOperations: CreateMessage), `DsManage` (DbAccess:
     GetOwnerInfoFromLogin, GetPasswordInfo, GetUserInfoFromLogin), `vodz`
     (UploadAttachment, CreateBigMessage). All use namespace `http://isds.czechpoint.cz/v20`,
     document/literal. UctoDS2 sets `SoapVersion=Soap12`. UserAgent = app title.
   * **Password auth**: HTTP Basic with login/password (`PreAuthenticate`).
   * **Mobile key auth** (`IsdsServiceHelper.ObtainAuthCookie`):
     1. `POST https://www.mojedatovaschranka.cz/as/processLogin?type=mep-ws&applicationName=UctoDS2&uri=<service URL>`
        with `Authorization: Basic base64(login:password)`, empty body, no redirects.
        Keep the first `Set-Cookie`.
     2. Every 2 s: `GET https://www.mojedatovaschranka.cz/as/mepWsStateUpdate` with that
        cookie. The body is an integer: `2` = confirmed in the phone app, `3` = expired
        ("Požadavku vypršela platnost, zkuste se přihlásit znovu."), anything else = wait.
        Storno sets `Canceled` and ends the loop.
     3. On `2`: repeat the POST from step 1 with the cookie. Its `Set-Cookie`
        (`IPCZ-X-…`) authenticates all following SOAP calls; no Basic header is sent.
   * Sequence: `GetPasswordInfo` + `GetUserInfoFromLogin` (protocol lines "Přihlášený
     uživatel: <příjmení> <jméno>", "Platnost hesla do: dd.MM.yyyy (N dní)" or
     "neomezená"; HTTP 401 → "Chybné přihlašovací údaje nebo vypršela platnost hesla.",
     503 → maintenance text) → `CreateMessage`.
   * `CreateMessage` input: envelope `dbIDRecipient`, `dmAnnotation`=Subject,
     `dmAllowSubstDelivery=false`, `dmPersonalDelivery=false`, `dmRecipientOrgUnitNum=-1`,
     every other string `""`; one `dmFile` with `dmMimeType`, `dmFileMetaType="main"`,
     `dmFileDescr` = file name without path, `dmFileGuid=""`, `dmFormat=""`,
     `dmEncodedContent` = base64 of the file.
   * Status `dmStatusCode` starting with `0` = success. It then calls
     `GetOwnerInfoFromLogin` to get the sender box ID (`dbOwnerInfo/dbID`) and appends
     the log line (below). Otherwise the protocol shows
     "Zprávu se nepodařilo odeslat. Důvod: Chyba: <code> - <message>".
   * **VoDZ** (> 20 MB): `UploadAttachment` (`dmFile` with `dmFileDescr`, `dmMimeType`,
     `dmEncodedContent`), which returns `dmAttID`, `dmAttHash1` (SHA-256) and `dmAttHash2`
     (SHA3-256). They are compared with local hashes (lower-case hex), then
     `CreateBigMessage` is called with `dmExtFile{dmAttID, dmAttHash1, dmAttHash1Alg="SHA-256", dmAttHash2, dmAttHash2Alg="SHA3-256", dmFileMetaType="main"}`.
     (The decompiled flow has bugs: `UploadVodzFile` always returns null, so the VoDZ path
     likely never sends. Účto's files are tiny, so this does not matter in practice.)
5. The result tab "Protokol" lists the timestamped messages, the message ID and the
   send time, and "Zpráva byla v pořádku odeslána." / "Zprávu se nepodařilo odeslat."
   The user closes the window with Konec.

### Output line in `UCTODS.LOG`

`ExportDataMessageServices.SaveToCsv`, appended, encoding by `OutputEncoding`
(`0` → CP852, no BOM), `WriteLine` → CRLF:

```
dd.MM.yyyy HH:mm:ss;<IdSenderDS>;<IdReceiverDS>;<dmID>;<Subject>;<Filename>;<Note>;<SenderName>;<RecipientName>
28.09.2026 14:03:11;q7wabcd;5ffu6xk;1234567890;Prehled o vysi pojistneho
2026-01;C:\\UCTO2026\\{MAIL}\\PVPOJ25.XML;;01 Firma s.r.o.;CSSZ
```

`Filename` is the config value (doubled backslashes are kept). The subject may contain the
CR from the multi-line `DS3subj`. `MODUL99_PRO/0177_P_UctoDSlog.txt` parses the file line
by line: date `DD.MM.YYYY`, time `h:mm:ss` or `hh:mm:ss`, then `;`-separated
Odesilatel, Prijemce, IdZpravy, Predmet, `Priloha:=EndTxt('\',s)`, Pozn, NazevOdes,
NazevPrij. It reads only the last 65000 bytes. `OutputFormat=xml` (serialised
`ExportDataMessage`, overwritten) is never requested by Účto.

`OperationLog`: `----- [dd.MM.yyyy HH:mm] START APP -----` / `END APP`, errors as
`dd.MM.yyyy - HH:mm:ss;Chyba:<msg>;[Podrobnosti:<inner>;]Poznámka:<site>;`.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uctods.ts`, registered under **both** `uctods2.exe` and
`uctods.exe`. The two configs differ only in key names and small defaults (see
uctods.md). Split the module into:

* `isds/client.ts`: a minimal ISDS SOAP client with `fetch`:
  * Operations: `GetPasswordInfo`, `GetUserInfoFromLogin`, `GetOwnerInfoFromLogin`
    (`/DS/DsManage`), `CreateMessage` (`/DS/dz`), optionally `UploadAttachment` +
    `CreateBigMessage` (`/DS/vodz`).
  * Use SOAP 1.1 (`Content-Type: text/xml; charset=utf-8`, `SOAPAction: ""`), which
    ISDS documents for all services and which the older UctoDS uses. Build requests with
    template literals and XML escaping. Parse responses with `fast-xml-parser`
    (`removeNSPrefix: true`), reading `dmStatus/dmStatusCode`, `dmStatusMessage`,
    `dmID`, `dbOwnerInfo/dbID`, `dbUserInfo/pnFirstName|pnLastName`, `pswExpDate`.
  * Envelope: send only the elements that carry data (`dbIDRecipient`,
    `dmAnnotation`, `dmPersonalDelivery`, `dmAllowSubstDelivery`). The original's
    empty `integer` elements are schema-invalid and ISDS merely tolerates them.
  * Auth: Basic header for password login. For the mobile key, implement the three-step
    MEP flow above with manual `Cookie`/`Set-Cookie` handling (a small cookie jar,
    since `fetch` has none), polling every 2 s, cancellable, with a timeout
    (e.g. 5 min).
  * Base64 the attachment. `crypto.createHash('sha256')` and `'sha3-256'` (OpenSSL 3,
    built into Node) cover VoDZ. Implement VoDZ only if a real need appears. Účto's
    attachments are small XML/PDF files.
  * TLS: Node's own TLS 1.2/1.3. `AcceptAllCertificates=true` maps to a per-request
    `undici` `Agent({ connect: { rejectUnauthorized: false } })`; log a warning. The
    Rebex options have no other meaning.
* `helpers/uctods.ts`: the Účto side:
  * Find `<exeDir>/UctoDS2.xml` case-insensitively and decode it (UTF-8 if valid,
    otherwise CP852). Parse the flat `<add key value>` pairs, decode entities, then
    **delete the file** (keeps the original's password hygiene).
  * Normalise `Filename`: collapse `\\`, then map the DOS path to a host path. Keep the
    DOS spelling for the log line, because the viewer uses `EndTxt('\',…)`.
  * MIME type from the extension as in `MimeTypeMap`.
  * Append the CSV line to the mapped `OutputFilename` in CP852 with CRLF, byte for byte
    as above. Write `DS2_APP.LOG`/`DS2_ERR.LOG` in the same format (they are useful for
    support).
* UI: a **FAND-style console dialog** drawn by the engine through `ctx.ui` (the engine
  owns the screen; no native window is needed):
  1. A summary box: Odesílatel, Příjemce (ID + name), Předmět, Soubor, the "TESTOVACÍ
     REŽIM" marker, and the actions Odeslat / Náhled / Konec. Účto has already asked
     "Odeslat soubor … ?", so a second confirmation is optional but keeps parity.
  2. A progress window with the protocol lines and Esc = Storno. For the mobile key:
     "Čekám na potvrzení žádosti o autentizaci na Vašem mobilním telefonu ...".
  3. The result: message ID and the protocol, closed with Enter.
  * Náhled: XML → the engine's text viewer; PDF → `ctx.host.openPath`.
  * The Ctrl+F10 password dump is dropped.
* Exit code 0 always (Účto ignores it). The EXEC call blocks until the dialog closes.

Still worth replacing: **yes, high priority.** The data box is mandatory for companies
and the standard way Účto users deliver tax, social-security and health-insurance
filings.

## Test approach

* Config parsing: fixtures produced by running report `EpoDS2` in the engine (CP852
  file) and a UTF-8 variant with a diacritic password; `HtmlTxt` entities; multi-line
  subject; doubled backslashes; `mobDS` `A`/`N`; the deleted file afterwards.
* SOAP: snapshot tests of the request bodies (`CreateMessage` with a small XML
  attachment, `GetOwnerInfoFromLogin`), plus recorded responses (success `0000`,
  `1216`-type error, HTTP 401, HTTP 503, SOAP fault) against a mocked `fetch`. Assert
  the protocol texts and that the log line is written only on success.
* Mobile key: mock the `processLogin` / `mepWsStateUpdate` sequence (1,1,2), expiry (3)
  and user cancel.
* Log: assert the exact CP852 bytes of the appended line, then run
  `MODUL99/UctoDSlog` in the engine (EngineDriver) and check that the "Odeslané zprávy
  DS" list shows the row with Priloha = file name.
* Live test (`ISDS_LIVE=1`): a free test account on `czebox.cz` (ISDS test
  environment), sending a small XML to its own box or to a second test box.
