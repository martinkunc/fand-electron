# UctoApep.exe – ČSSZ e-Podání over VREP/APEP: sign, encrypt, submit, poll, e-neschopenky, JMHZ answers

`{tisk}\UctoApep.exe` (567 KB, .NET Framework 4.0 WinForms, assembly `UctoApep` 1.0.0.22,
internal namespace `UctoVrepGui`; it ships with `Rebex.*.dll` for TLS 1.2 on old Windows).
It is Účto's single client for the ČSSZ **VREP** gateway (Veřejné rozhraní pro e-Podání,
`https://epodani.cssz.cz/VREP/ws/public.svc`, WCF "Government Gateway" contract). It has
four call types:

| callType | Účto letter | Purpose | Window |
|---|---|---|---|
| `ELPODPIS` | `P` | sign + encrypt + submit an e-Podání XML (PVPOJ, NEMPRI, ONZ, REGZEC, JMHZ, DZMH…) and log it to `VREP.UUU` | `FormMain` |
| `ELDOTAZ` | `D` | ask for the processing result of an earlier submission (poll by CorrelationID) | `FormPoll` |
| `ENESCHOP` | `N` | download the answer to a DZDPN/DZNP query (e-neschopenky), decrypt it with the employer's certificate, render PDF | `FormEneschop` |
| `DOTAZ_JMHZ` | `J` | download the answer to a DZMH query (state of a monthly JMHZ report), render PDF | `FormDotazJmhz` |

It replaces the legacy `ELPODPIS.EXE`, `ELDOTAZ.EXE` and `ENESCHOP.EXE` (see `elpodpis.md`,
`eldotaz.md`, `eneschop.md`; the ČSSZ certificate tool is in `sifrcssz.md`). All of them
should share one VREP/CMS core.
Účto uses it whenever `PARAM3.Apep` is true, which is the default, re-set on every upgrade
(`UPG_PRO/0008_M__Param3.txt`), and always for the newer forms.
Decompiled source: `work/decompiled/{tisk}_UctoApep/`.

## How Účto calls it

Single wrapper: procedure `UctoApep(callType, xmlType, inputXmlFilename, userEncryptionCert,
userEncryptionCertPassword, email, subject, sender, period, vs, idVrep)`,
`UCTO2026_RDB/0634_P_UctoApep.txt`:

```
callType:=upcase(copy(callType,1,1)); eDPN:=callType='N'; eMH:=callType='J';
callType:=cond(callType='P':'ELPODPIS', callType='D':'ELDOTAZ', callType='N':'ENESCHOP', callType='J':'DOTAZ_JMHZ');
s:=callType+crlf+ cond(PARAM2.testDS:'true',else:'false')+crlf+
   'https://epodani.cssz.cz/VREP/ws/public.svc'+crlf+ 'https://t-epodani.cssz.cz/VREP/ws/public.svc'+crlf+
   Trail(xmlType)+crlf+ '1250'+crlf+ inputXmlFilename+crlf+
   PROGRAM.Path+'{TISK}\sifrcssz.cer'+crlf+ 'http://www.cssz.cz/stranky/certifikaty/dis.cssz.aktualni.cer'+crlf+
   Trail(userEncryptionCert)+crlf+ Trail(userEncryptionCertPassword)+crlf+ Trail(email)+crlf+
   Trail(HtmlTxt(subject))+crlf+ Trail(HtmlTxt(sender))+crlf+ Trail(period)+crlf+ Trail(vs)+crlf+ Trail(idVrep)+crlf+
   PROGRAM.Path+'{TISK}\UctoApep.log'+crlf+ PROGRAM.Path+'{TISK}\Rebex.log'+crlf+ PROGRAM.Path+'VREP.UUU'+crlf+
   '852'+crlf+ PROGRAM.Path+'{TISK}\govtalk.xml'+crlf+
   cond(PARAM3.RbxOnly:'true',else:'false')+crlf+ cond(PARAM3.AcceptCrt:'true',else:'false')+crlf;
if eDPN then s:=s+ tisk+'dpnSoap.xml'+crlf+ tisk+'dpnEnc.xml'+crlf+ tisk+'dpnDec.xml'+crlf+ tisk+'dpnRprt.pdf'+crlf+
   tisk+'SETUPCP.EXE'+crlf+ pdf2+'dpnZac.pdf'+crlf+ pdf2+'dpnTrv.pdf'+crlf+ pdf2+'dpnKon.pdf'+crlf+ pdf2+'dpnZmen.pdf'+crlf+ pdf2+'dpnStor.pdf';
if eMH then s:=s+ pdf2+'BLANK.PDF'+crlf+ tisk+'dzmhRprt.pdf'+crlf+ tisk+'SETUPCP.EXE'+crlf;
t:=''; for i:=1 to length(s) do begin ch:=copy(s,i,1);
  if ord(ch) in [10,13,32..33,35..126,128..254] then t:=t+ch; end;      { drops '"', control chars, #255 }
PARAM3.TTT:=t; TXT.Path:=PROGRAM.Path+'{TISK}\UCTOAPEP.XML'; report(,UctoApep,assign=TXT);
if testmode & PARAM3.EditPdf3 then proc(Txt,(TXT.Path));
FILE.Path:=PROGRAM.Path+'{TISK}\UCTOAPEP.EXE'; proc(ExecWin,(FILE.Path,''));
```

| | |
|---|---|
| Parameter file | `{TISK}\UCTOAPEP.XML`, report `UctoApep` (`0633_R_UctoApep.txt`), `encoding="ibm852"` (CP852) |
| Command line | none |
| Sync | `ExecWin` → blocking `exec`. There is no `WaitFor`, so under DOSBox/vDos the call is fire-and-forget |
| Output read by Účto | `VREP.UUU` (append, CP852) in the program dir, shown by "Seznam podání VREP" (`MODUL99_PRO/0164_P_VrepUUU.txt`) |
| Other outputs | `{TISK}\govtalk.xml` (last GovTalk envelope), `{TISK}\UctoApep.log`, `{TISK}\Rebex.log`, `UctoApepLastCert.uuu` (cwd), `dpn*.xml`, `dpnRprt.pdf` / `dzmhRprt.pdf` (opened in the PDF viewer) |
| Exit code | not used |

Parameter file (values in order of the `TTT` lines; the eDPN/eMH blocks are appended
conditionally):
```xml
<?xml version="1.0" encoding="ibm852" ?>
<configuration><appSettings>
  <add key="callType" value="ELPODPIS"/>
  <add key="useTestEnvironment" value="false"/>
  <add key="prodUrl" value="https://epodani.cssz.cz/VREP/ws/public.svc"/>
  <add key="testUrl" value="https://t-epodani.cssz.cz/VREP/ws/public.svc"/>
  <add key="xmlType" value="PVPOJ25"/>
  <add key="inputXmlEncoding" value="1250"/>
  <add key="inputXmlFilename" value="C:\UCTO2026\FIRMA\{MAIL}\PVPOJ25.XML"/>
  <add key="csszCert" value="C:\UCTO2026\{TISK}\sifrcssz.cer"/>
  <add key="csszCertUrl" value="http://www.cssz.cz/stranky/certifikaty/dis.cssz.aktualni.cer"/>
  <add key="userEncryptionCert" value=""/>          <!-- PFX for DZDPN/DZNP (PAR97A3.CrtDZ) -->
  <add key="userEncryptionCertPassword" value=""/>  <!-- PAR97A3.PwdDZ, plain text! -->
  <add key="email" value="mzdy@firma.cz"/>
  <add key="subject" value="Přehled o výši pojistného"/>
  <add key="sender" value="Firma s.r.o."/>
  <add key="period" value="2026-01"/>
  <add key="vs" value="1234567890"/>
  <add key="idVrep" value=""/>
  <add key="errorLog" value="C:\UCTO2026\{TISK}\UctoApep.log"/>
  <add key="rebexLogFile" value="C:\UCTO2026\{TISK}\Rebex.log"/>
  <add key="outputMessageFilename" value="C:\UCTO2026\VREP.UUU"/>
  <add key="outputMessageEncoding" value="852"/>
  <add key="govtalkMessageFilename" value="C:\UCTO2026\{TISK}\govtalk.xml"/>
  <add key="useRebexOnly" value="false"/>
  <add key="acceptAllCertificates" value="false"/>
  <!-- ENESCHOP only: completeResponseXmlFilename, encryptedXmlFilename, decryptedXmlFilename,
       outputPdfFilename, creatorPilotSetupFilename, vznik/trvani/ukonceni/zmeny/stornoDpnPdfFilename -->
  <!-- DOTAZ_JMHZ only: dznpPdfFilename (=BLANK.PDF), outputPdfFilename, creatorPilotSetupFilename -->
</appSettings></configuration>
```

### Call sites
| Feature / menu | Chapter | Call |
|---|---|---|
| Mzdy e-Podání menu → **Poslat přes VREP** (PVPOJ, NEMPRI, ONZ22, HZUPN, DZDPN, OZUSPOJ, VPDPP24, REGZELDO, REGZEC, PREZEC; PREZAM/OREZAM are e-Papír only) | `MODUL97_PRO/0262_P_eVrep2.txt` | `('P', map(epo), XPath(xp), cond(eN:CrtDZ), cond(eN:PwdDZ), eml, náz, PARAM2.Hlavička, obd, PAR97A2.KlíčPvs, '')`. `epo` map: `DZDPN20→DZDPN20V2`, `ELDP12→ELDP09`, `OZUSPOJ→OZUSPOJ23`, `REGZELDO→REGZELDOPL25`, `REGZEC→REGZEC25`, `PREZEC→PREZEC` |
| JMHZ (MODUL94) e-Podání → **Poslat přes VREP** (JMHZ, DZMH) | `MODUL94_PRO/0115_P_eVrep94.txt` | `('P', JMHZ→JMHZ25 / DZMH→DZMH25, XPath(xp), '', '', eml, náz, Hlavička, obd, PAR94A2.KlíčPvs, '')` |
| OSVČ Přehled → Poslat přes VREP | `MODUL03_PRO/0355_P_eVrep.txt` | `('P', OSVC.., XPath(xp), '', '', '', Subj3 lines…, VS, '')` |
| Seznam podání VREP → F10 **dotaz na stav** (needs `acknowledgement`) | `MODUL99_PRO/0163_P_VrepEx.txt` | `('D', Druh, '', '', '', '', 'Dotaz na stav e-Podání '+Druh, '', DD.MM.YYYY, VsČssz, Id)` |
| e-neschopenky: odpověď ČSSZ na dotaz DZDPN | `MODUL99_PRO/0166_P_eNeschop.txt` (from `0167_P_VrepDZ.txt`) | `('N', Druh, '', cert, pwd, '', 'Dotaz na stav…', '', date, VsČssz, Id)` |
| JMHZ: odpověď na dotaz DZMH | `MODUL99_PRO/0168_P_eDZMH.txt` (from `0169_P_DZMH99.txt`) | `('J', Druh, '', '', '', '', 'Dotaz na stav…', '', date, VsČssz, Id)` |
| **Parametry APEP** (useRebexOnly, acceptAllCertificates) | `0635_P_UctoApepPar.txt` → form `ParDS3b` (`0046`) | – |
| Program parameters "odeslat programem UCTOAPEP? (A/N)" = `PARAM3.Apep` | `0033_E_ParPgm.txt` | – |

Before "Poslat přes VREP", `eVrep2` checks that the VS (`KlíčPVS`) is filled and matches the
employer's VS, and that `{TISK}\SIFRCSSZ.CER` exists. It may also run `WFDETECT.EXE`.

### `VREP.UUU` (the only data Účto reads back)
A FAND `/var` text file for record type `VREP` (`MODUL99_PRO/0161_F_VREP.txt`:
`Druh:A,12; VsČssz:A,10; Id:A,40; Datum:D,'YYYY-MM-DDThh:mm:ss.ttt'; Výsledek:A,30;
Error:A,78; Tiskopis:A,30; Období:A,10; Firma:A,66`). After a successful submit,
`VrepUuu.ExportToCsv` appends one line in CP852 with CRLF, every field wrapped in **single
quotes**, comma-separated:
```
'PVPOJ25','1234567890','3F2504E0-4F89-11D3-9A0C-0305E82C3301','2026-02-19T10:15:02','acknowledgement','','Přehled o výši pojistného','2026-01','Firma s.r.o.'
```
= `DocumentType.ToString().ToUpper()` (the enum name: `PVPOJ25`, `NEMPRI25`, `DZDPN20V2`,
`JMHZ25`, `REGZEC25`, `ONZ22`…), VS, CorrelationID, GatewayTimestamp (local time,
`yyyy-MM-ddTHH:mm:ss`), Qualifier (`acknowledgement` on success), empty error, subject, period,
sender. Účto's VREP list and `VrepEx` rely on `Výsledek` containing `acknowledgement`,
`Druh` matching `DZDPN*`/`DZMH*`, and `Id`.

## What it does (decompiled C#)

### Common startup (`UctoVrepGui/Program.cs`, `Helpers/Configuration.cs`)
* `APP_CONFIG_FILE=UctoApep.xml`. If the file is missing: MessageBox "Chyba:\n\rSoubor se
  vstupními parametry nebyl nalezen." and exit.
* `callType` must parse to the enum; for `ELPODPIS`, `xmlType` must parse (case-insensitive)
  to `ETypes` (`UctoVrepGui.Enums/ETypes.cs`: Reldp, Prihl, Onz, Onz22, Eldp09, Osvc…Osvc23,
  Ozuspoj23, Pvpoj09…Pvpoj25, Nempri10…Nempri25, Hpn10/18, HZUPN20, ZZDPN20, Postp09,
  DZDPN20, DZDPN20V2, VPDPP24, DZNP25, NPOSVC25, REGZEC25, JMHZ25, REGZELDOPL25, DZMH25,
  PREZEC), else "Hodnota X není platnou hodnotou podání."
* TLS: native `Tls12` when on Win7+ with .NET 4.8, else the Rebex binding (TLS 1.2 in managed
  code; `acceptAllCertificates` turns off server certificate validation; the log goes to
  `Rebex.log`). `useRebexOnly` forces Rebex.
* All windows show OS, TLS type (NATIVE/REBEX), DPI and a "TEST" marker when
  `useTestEnvironment`.

### ELPODPIS – submit (`UI/FormMain.cs`, `UI/FormWait.cs`, `Vrep/GovTalkMessageBuilder.cs`)
1. **Signing certificate**: lists all certificates in the Windows store
   **CurrentUser\My** that have a private key and are not expired, shown as "Jméno: … |
   Platnost do: … | Vydavatel: … | SN: …". One certificate → auto-selected. Several → the
   last choice is restored from `UctoApepLastCert.uuu` (serial number, in the cwd). A
   "Zobrazit certifikát" button opens the Windows certificate dialog.
2. **ČSSZ encryption certificate**: `csszCert` (`{TISK}\sifrcssz.cer`, DER; currently
   `CN=DIS.CSSZ.2025`, valid to 2028-02-23). It is downloaded from `csszCertUrl` if the file is
   missing or expired (download errors are ignored).
3. Form shows: druh podání, file, VS, subject, sender, test flag, both cert paths. Buttons:
   Náhled (shows the XML), Odeslat, Konec. Validation messages: "Nebyl vybrán žádný podpisový
   certifikát.", "Soubor … nebyl nalezen.", "Není vyplněn variabilní symbol." For
   DZDPN/DZNP the user PFX must exist; it is loaded with the password, and an expiry warning
   is shown.
4. **For `CSSZ_DZDPN` / `CSSZ_DZNP`**: `XmlHelper.AddXmlWithSignature` writes the user's
   encryption certificate (base64 DER, with line breaks) into the first
   `<SifrovaciCertifikat>` element of the input XML and **saves the file in place**. ČSSZ
   encrypts its answer to this certificate.
5. **Build** (`GovTalkMessageBuilder.Build`):
   * `content` = the input file read as CP1250 (`inputXmlEncoding`), re-encoded to CP1250
     bytes (the whole file **including** its `<?xml … windows-1250?>` declaration).
   * `encryptedData` = base64(CMS **EnvelopedData** of `content` to the ČSSZ certificate,
     .NET `EnvelopedCms` defaults: issuer-and-serial recipient, RSA PKCS#1 v1.5 key transport;
     content cipher = the .NET Framework default, **3DES-CBC** (inference, verify)).
   * `signedData` = base64(CMS **SignedData, detached** (`SignedCms(content, detached:true)`),
     `CmsSigner(cert)` defaults: signer identified by issuer+serial, cert chain without the
     root; digest: the .NET default for a net40-targeted app, which is **SHA-1** (inference,
     verify against a captured `govtalk.xml`)).
   * CSSZ envelope (`Vrep/CsszMessageEnvelope.cs`), built as literal text:
     ```xml
     <Message xmlns="http://www.cssz.cz/XMLSchema/envelope" version="1.2" eType="PVPOJ25">
         <Header>
             <Signature xmlns:dt="urn:schemas-microsoft-com:datatypes" dt:dt="bin.base64">{signedData}</Signature>
             <Vendor productName="UctoVrep" version="1.0.0.22" />
         </Header>
         <Body xmlns:dt="urn:schemas-microsoft-com:datatypes" encrypted="yes" contentEncoding="raw"  dt:dt="bin.base64">{encryptedData}</Body>
     </Message>
     ```
     `eType` from `GetETypeStr` (e.g. `DZDPN20V2→"DZDPN20-V2"`, `PREZEC→"PREZEC26"`,
     `Pvpoj19→"PVPOJ16"` (sic)). Plain `Osvc` has no case in the switch, so it gives
     `eType=""`. That is what MODUL03 sends for every OSVČ přehled (it maps `OSVC*` →
     `OSVC`). Keep this unless the test gateway rejects it.
   * GovTalk envelope (ns `http://www.govtalk.gov.uk/CM/envelope`, `XmlSerializer`,
     declaration `windows-1250`):
     ```xml
     <GovTalkMessage xmlns="http://www.govtalk.gov.uk/CM/envelope">
       <EnvelopeVersion>2.0</EnvelopeVersion>
       <Header>
         <MessageDetails><Class>CSSZ_PVPOJ</Class><Qualifier>request</Qualifier>
           <Function>submit</Function><Transformation>XML</Transformation></MessageDetails>
         <SenderDetails><EmailAddress>mzdy@firma.cz</EmailAddress></SenderDetails>
       </Header>
       <GovTalkDetails><Keys><Key Type="vars">1234567890</Key></Keys></GovTalkDetails>
       <Body>{CSSZ Message}</Body>
     </GovTalkMessage>
     ```
     `Class` from `Helpers/EtypeToGovtalkClass.cs`: PVPOJ*→`CSSZ_PVPOJ`, NEMPRI*/HZUPN20→`CSSZ_NEM_PRI`,
     ONZ*→`CSSZ_ONZ`, ELDP09/RELDP→`CSSZ_RELDP`, OSVC*→`CSSZ_OSVC_PRE`,
     OZUSPOJ23→`CSSZ_OZUSPOJ`, HPN*→`CSSZ_HPN`, ZZDPN20→`CSSZ_ZZVDPN`, DZDPN*→`CSSZ_DZDPN`,
     VPDPP24→`CSSZ_VPDPP`, NPOSVC25→`CZZS_NPOSVC` (sic), DZNP25→`CSSZ_DZNP`,
     JMHZ25→`CSSZ_JMHZ`, DZMH25→`CSSZ_DZMH`, REGZEC25→`CSSZ_REGZEC`,
     REGZELDOPL25→`CSSZ_REGZELDOPL`, PREZEC→`CSSZ_PREZEC`.
   * Saved to `govtalkMessageFilename` (`{TISK}\govtalk.xml`).
6. **Send** (`Vrep/VrepService.cs`): a WCF client for contract `IBusinessTransactions`
   (ns `http://www.government-gateway.cz/wcf/submission`), `WSHttpBinding(Transport)`, which
   means **SOAP 1.2 + WS-Addressing 1.0 over HTTPS**, no message security, and
   `MaxReceivedMessageSize=512000`.
   * `Submit(tclass=Class, bodies=[BodyPart{Id="0", Body=<GovTalkMessage…>}],
     optionals=[{ParameterName="email", ParameterValue=email}, {ParameterName="key",
     ParameterType="vars", ParameterValue=vs}])` → `PollResponseData{BodyBase64XML, Class,
     CorrelationID, Function, GatewayTimestamp, GovTalkErrors{Errors[]{Id, Number, Text,
     RaisedBy, Location, Type, GatewayTimeStamp}}, PollInterval, Qualifier}`.
   * Then `Dispose(CorrelationID, null)`. GovTalk errors → "Při odesílání podání došlo
     k chybě:\r\nGovtalkError: id: …, number: …, error: …". A `FaultException` from Submit
     is swallowed (the detail is read, nothing shown).
   * Actions: `http://www.government-gateway.cz/wcf/submission/IBusinessTransactions/{Submit|Poll|Dispose|DataRequest}`.
7. On success: append to `VREP.UUU` (above), switch to the result tab ("Identifikátor
   podání: …", "Datum a čas přijetí: …", "Výsledek podání: dosud nezpracováno", "Podání bylo
   přijato ke zpracování."), and start a countdown of `PollInterval` s (≈60), after which
   "Dotaz na stav podání" polls (same as ELDOTAZ).

### ELDOTAZ – poll (`UI/FormPoll.cs`)
`Poll(correlationid=idVrep, optionals=[key/vars=vs])`, then `Dispose`. `BodyBase64XML` →
UTF-8 → `bodies` XML:
`bodies{ns …/wcf/submission}/Body{govtalk}/Message{cssz envelope, eType}/Body/`
`ProcessingResult{@type,@result,@errMsg,@errNumber,@count,@countErr,@countWar}/Details/Item{@sqnr,@identifier,@subtype,@period,@result,@errMsg,@errNum}`
and `ProcessingResult/Error{Type, RaisedBy, Number, Text}`, `ProcessingResponse/Data{@encryptionAlgorithm,@compression,@contentEncoding, base64}`.
The window shows:
* `CSSZ_JMHZ`: any item with result ≠ OK → "Podání obsahuje chyby." and a text box with
  `Typ/Stav/Chyba/Text/Guid/Identifikátor zaměstnance` per item (or just `errMsg` when
  `errNumber=300`), else "Podání bylo v pořádku přijato."
* Others: per item "#n Identifikátor: … / Výsledek: … / errMsg split on `;`", and the
  overall status "Přijato bez chyb." or "Podání obsahuje chyby."
* GovTalk error 2000 → "Podání nebylo nalezeno." with the ČSSZ hot-line text
  (tel. 800 050 248). Other errors → "Číslo chyby: … Popis: …".

Nothing is written for Účto (`VREP.UUU` is not updated with the result).

### ENESCHOP – e-neschopenky answer (`UI/FormEneschop.cs`, `Eneschopenka/*`)
Requires the **PDFCreatorPilot** COM component (CLSID `465FE951-…`). If it is missing, it
offers to run `{TISK}\SETUPCP.EXE` and exits. It deletes `dpnDec.xml`, `dpnEnc.xml` and
`dpnSoap.xml`, loads the user PFX (`userEncryptionCert` + password), then polls as above
and:
1. Saves the raw `PollResponseData` to `completeResponseXmlFilename` (`dpnSoap.xml`) and
   the response envelope to `encryptedXmlFilename` (`dpnEnc.xml`). The type must be
   `CSSZ_DZDPN`/`CSSZ_DZNP` ("Typ podání není DZDPN nebo DZNP").
2. `ProcessingResponse/Data`: base64 → if `encryptionAlgorithm` is set, CMS EnvelopedData
   decrypt with the user certificate (`EnvelopedCms.Decrypt`) → if `compression=gzip`,
   gunzip → UTF-8 → `decryptedXmlFilename` (`dpnDec.xml`).
3. Deserialize `DzdpnOdpovedType` (API 1.32/1.5 `Dzdpn20v2`) or `DznpOdpovedType`
   (`Dznp25`). Count Vznik/Trvání/Ukončení/Změna/Storno DPN notifications, or the DZNP
   podání/případy.
4. `PdfBuilder`: stamps each notification's data onto the templates
   `{PDF2}\dpnZac.pdf`, `dpnTrv.pdf`, `dpnKon.pdf`, `dpnZmen.pdf`, `dpnStor.pdf` (DZNP: a
   text layout on a template), with Arial Bold via PDFCreatorPilot (licence
   "TichySpol"). Output to `dpnRprt.pdf`, then `Process.Start` opens it.

### DOTAZ_JMHZ – DZMH answer (`UI/FormDotazJmhz.cs`, `Common/JmhzOdpovedReport.cs`)
Poll as above. `ProcessingResponse/Data`: decrypt only if `encryptionAlgorithm=="aes128"`
(Účto passes no user PFX here, so DZMH answers are expected unencrypted), then gunzip → UTF-8 →
`DzmhOdpovedType{variabilniSymbol, idPodani, mesic, rok, stavMH{kod,nazev,datumZpracovani},
protokoly[]{kod,nazev,datumProtokolu,datumPodani,idKonkretnihoPodani,chybySeznam[]}}`.
The grid shows the protocols. The PDF `dzmhRprt.pdf` is a text report (header, submission
info, state, protocols with wrapped error texts) on `{PDF2}\BLANK.PDF`, and it is opened.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uctoapep/` registered under `uctoapep.exe`. The same core should
later serve the legacy keys `elpodpis.exe`, `eldotaz.exe` and `eneschop.exe`, so the
`PARAM3.Apep=false` paths also work (see `eldotaz.md`).

* **Config**: `{tisk}/UCTOAPEP.XML` (case-insensitive), decoded as CP852, `<add key value>`
  pairs. Treat `userEncryptionCertPassword` as a secret: overwrite the file after reading it,
  as `uctods` does.
* **`vrep/soap.ts`** – a minimal Government Gateway client with `fetch`:
  * SOAP 1.2: `Content-Type: application/soap+xml; charset=utf-8; action="<Action>"`.
    WS-Addressing headers `a:Action` (mustUnderstand), `a:MessageID` (`urn:uuid:…`),
    `a:ReplyTo/a:Address = http://www.w3.org/2005/08/addressing/anonymous`, `a:To`
    (mustUnderstand).
  * Body = the DataContract XML, e.g.
    ```xml
    <Submit xmlns="http://www.government-gateway.cz/wcf/submission">
      <tclass>CSSZ_PVPOJ</tclass>
      <bodies><BodyPart><Body>{GovTalkMessage element}</Body><Id>0</Id></BodyPart></bodies>
      <optionals xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
        <OptionalParameter><ParameterName>email</ParameterName><ParameterType i:nil="true"/><ParameterValue>…</ParameterValue></OptionalParameter>
        <OptionalParameter><ParameterName>key</ParameterName><ParameterType>vars</ParameterType><ParameterValue>…</ParameterValue></OptionalParameter>
      </optionals>
    </Submit>
    ```
    (derived from WCF DataContract defaults: members in alphabetical order, the contract
    namespace, `i:nil` for nulls). **Verify** it byte-level against a real exchange before
    going live: set `useRebexOnly=true` on a Windows machine and read the HTTP bodies from
    `{TISK}\Rebex.log`, or fetch the WSDL from `…/public.svc?wsdl`.
  * Parse responses with `fast-xml-parser` (`removeNSPrefix`). Map SOAP faults
    (`GGErrorException`) and `GovTalkErrors` to the same Czech texts.
  * TLS: Node's TLS 1.2/1.3. `acceptAllCertificates` → an `undici` `Agent` with
    `rejectUnauthorized:false` plus a logged warning. `useRebexOnly` is ignored (obsolete).
  * Timeouts 60 s; honour `PollInterval`.
* **`vrep/cms.ts`** – PKCS#7/CMS with **`pkijs`** (+ Node `crypto.webcrypto`), or
  `node-forge` (`forge.pkcs7`), which has both detached SignedData and EnvelopedData:
  * EnvelopedData to `sifrcssz.cer` (RSA PKCS#1 v1.5, issuerAndSerial). Content cipher:
    start with 3DES to mirror .NET Framework, but AES-256-CBC is likely also accepted; check
    with the test gateway.
  * Detached SignedData over the exact CP1250 bytes of the file, including the signer
    certificate chain. Digest SHA-256 if the test gateway accepts it; else SHA-1 to match the
    original.
  * Decrypt EnvelopedData with the user PFX (DZDPN/DZNP/DZMH answers), then gunzip with
    `zlib.gunzipSync`.
* **Certificates** (the main cross-platform gap: there is no Windows certificate store):
  * Signing certificate: a PKCS#12 file (`.pfx/.p12`) chosen by the user once (Electron file
    dialog), stored in the Účto profile. The password is asked per session and optionally
    kept with Electron `safeStorage`. List its validity, subject and issuer in the form as
    the original combo does. Optional later: Windows/macOS system stores or smart cards via
    PKCS#11 (`pkcs11js`). Qualified certificates with non-exportable keys cannot be used
    until then; document this for users.
  * ČSSZ certificate: keep `{tisk}/sifrcssz.cer`, and refresh it from `csszCertUrl` when
    it is missing or expired (plain `fetch`, write atomically).
* **UI**: FAND-style console dialogs through `ctx.ui` (the engine owns the screen), one per
  call type:
  * Submit: summary (druh, soubor, VS, předmět, odesílatel, certifikát, TEST) → Odeslat /
    Náhled (engine text viewer) / Konec → progress → result (ID, time, "dosud nezpracováno")
    with a countdown and "Dotaz na stav podání".
  * Poll: result text (same wording as `FormPoll`).
  * ENESCHOP/DZMH: counts + "Otevřít PDF".
* **PDF**: replace PDFCreatorPilot with **`pdf-lib`** + `@pdf-lib/fontkit` and an embedded
  TTF with Czech glyphs (e.g. DejaVu Sans or Liberation Sans Bold, like Arial Bold). Port the
  field coordinates from `Common/PdfBuilder.cs` (DZDPN template overlays, 5 templates) and
  the text layout from `JmhzOdpovedReport.cs` (margins 20/190/40/277 mm, line height
  5.5 mm). Open the PDF with `ctx.host.openPath`. `SETUPCP.EXE` and the COM check are obsolete.
* **Outputs kept for Účto**: `VREP.UUU` append (CP852, CRLF, quoting exactly as above),
  `govtalk.xml` (useful for support), `UctoApep.log` (`OperationLog` format), and the `dpn*.xml`
  debug files. Drop `Rebex.log` and `UctoApepLastCert.uuu` (store the chosen PFX in settings).
* **Behaviour fixes worth making**: surface swallowed `FaultException`s from Submit; write
  the poll result into `VREP.UUU` (`Výsledek`/`Error`) as an optional improvement (Účto's
  VREP list would then show it; the file format allows it).

Still worth replacing: **yes, high priority, large effort.** VREP is the main channel for
all ČSSZ filings (monthly JMHZ from 2026, PVPOJ, NEMPRI, ONZ, REGZEC, e-neschopenky). The
data box (`UctoDS2`) is the fallback that users can use until this lands.

## Test approach

* **Unit – envelopes**: golden GovTalk/CSSZ envelopes built from fixed inputs with a
  deterministic CMS (fixed signing time if present, test RSA keys generated in the test).
  Parse our CMS output with `openssl cms -verify -inform DER -binary -content <xml>` and
  `openssl cms -decrypt` in a test helper to prove interoperability.
* **Cross-check with the original**: on a Windows VM, run `UctoApep.exe` against the
  **test gateway** (`useTestEnvironment=true`, `PARAM2.testDS`) with a test certificate,
  capture `govtalk.xml` and the Rebex HTTP log, and commit them (secrets stripped) as
  fixtures. Our envelope must match in structure, algorithms (OIDs) and element order.
* **SOAP client**: mock `fetch` with recorded Submit/Poll/Dispose responses:
  acknowledgement, GovTalk error 2000, JMHZ `ProcessingResult` with item errors, and an
  encrypted+gzipped `ProcessingResponse` (build it with our own CMS for the test).
* **VREP.UUU**: append a line and read it back through the engine's `copyfile(TXT/var,VREP)`.
  Assert the field values (`Druh`, `Id`, `Datum`, `Výsledek`), then drive `VrepUUU` in the
  headless `EngineDriver`.
* **PDF**: render DZDPN/DZMH fixtures with `pdf-lib`. Assert the page count and extracted
  text (e.g. with `pdfjs-dist`), and do a visual smoke check once against the original output.
* **Live** (manual, `CSSZ_LIVE=1`): a submit to `t-epodani.cssz.cz` with a test certificate
  and poll until `acknowledgement`.
