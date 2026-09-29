# ELPODPIS.EXE – sign, encrypt and submit a ČSSZ e-Podání via VREP (legacy, VB6)

`{tisk}\ELPODPIS.EXE` (207 KB, **native VB6** GUI, `MSVBVM60.DLL`, `MSINET.OCX`,
CAPICOM, ProductVersion 2020.01, "kompilace: 20.02.2020", © Tichý & spol.). It is the
old submission client for the ČSSZ electronic filing gateway VREP. It reads an
e-Podání XML produced by Účto, lets the user pick a **qualified signing certificate from
the Windows certificate store**, signs the data, encrypts it for ČSSZ with
`{tisk}\sifrcssz.cer`, wraps it in a GovTalk envelope, sends it (itself, or through
[ELPODPI2.EXE](elpodpi2.md)), and logs the result to `VREP.UUU`.

There is no decompiled source. Everything below comes from `strings`/UTF-16 strings,
the calling FAND code and ELPODPI2. **Inferred** items are marked.

## How Účto calls it

Live call site: `MODUL97_PRO/0262_P_eVrep2.txt`, payroll e-Podání menu
**"e-Podání <form>" → "Poslat přes VREP"** (Mzdy → ČSSZ forms: ELDP, ONZ, PVPOJ,
NEMPRI, HZUPN, DZDPN, …). It is used **only when `PARAM3.Apep` is false and the form
is not in the UctoApep-only list**:

```
FILE.Path:=PROGRAM.Path+'{TISK}\SIFRCSSZ.CER';
if filesize(FILE)<=0 then proc(Hlaseni,('Chybí šifrovací certifikát '+FILE.Path)) else begin
  eml:=cond(equmask(PAR97A2.KontMail,'?*@?*.?*'): replace(' ',PAR97A2.KontMail,''));
  if eN then ODKUD.Path:=Trail(PAR97A3.CrtDZ);                { DZDPN: eNeschopenka PFX }
  if PARAM3.Apep | Form in ['J21','J23','J25','J26','N25','O22','OZUSPOJ','VPDPP24',
                            'POPRIJ','REGZELDO','PREZAM','OREZAM','REGZEC','PREZEC']
  then proc(UctoApep,('P', …))                                  { default path }
  else begin
    FILE.Path:=PROGRAM.Path+'{TISK}\ELPODPIS.EXE';
    if filesize(FILE)<=0 then proc(Hlaseni,('Program '+FILE.Path+' nenalezen')) else begin
      s:=náz+'","'+obd+'","'+replace('"',Trail(PARAM2.Hlavička),''); s:=nodiakr(s);
      puttxt(UCTOTXT3,'"'+XPath(UCTOTXT5.Path)+'","'+ Trail(PAR97A2.KlíčPvs)+'","'+ eml+'","'+ s+'","'+
        cond(wxp | ep2:'XP')+'","'+ cond(eN:ODKUD.Path)+'","'+ cond(eN:Trail(PAR97A3.PwdDZ))+'","'+
        cond(PARAM2.testDS:'A',else:'N')+'"');
      proc(ExecWin,(FILE.Path,'$ '+UCTOTXT3.Path));
    end;
  end;
end;
```

`MODUL03_PRO/0355_P_eVrep.txt` (OSVČ overview) has the same ELPODPIS branch, but it is
dead code (`else if true then UctoApep…`).

| | |
|---|---|
| Command line | `$ <DOS path of UCTOTXT3.UUU>`. The `$` is a guard; there is a "Chybné parametry." message |
| Working dir | Účto root (`VREP.UUU` and `{TISK}` are resolved relative to it) |
| Parameter file | `UCTOTXT3`, one line, 10 double-quoted comma-separated fields (VB6 `Input #` format), ASCII after `nodiakr` |
| Data file | `UCTOTXT5`: the e-Podání XML in **CP1250 without its XML declaration line** (`eVrepXml`: `copyfile(UCTOTXT4,UCTOTXT5,mode='LW')`, then the first line is dropped) |
| Certificates | `{TISK}\sifrcssz.cer` (ČSSZ encryption cert, PEM, now `CN=DIS.CSSZ.2025`, valid to 2028-02-23); for DZDPN the user's PFX `PAR97A3.CrtDZ` (default `{tisk}\sifructo.pfx`, password `PAR97A3.PwdDZ`, default `ucto2000`) |
| Output | appends a record to `VREP.UUU` (see [elpodpi2.md](elpodpi2.md) for the format); temporary `{TISK}\ELPODPI2.UUU` (inferred: the envelope handed to ELPODPI2) |
| Exit code | not used; Účto does not wait |

Parameter fields (the names are the VB6 variables found in the binary, mapped by position; *inferred*):

| # | Value from Účto | VB6 name |
|---|---|---|
| 1 | `XPath(UCTOTXT5.Path)`, the XML to sign | `NekodovaneXML` |
| 2 | `PAR97A2.KlíčPvs`, the VREP key (variable symbol) | `Klic` → `<Key Type="vars">` |
| 3 | contact e-mail or empty | `Email` → `<EmailAddress>` |
| 4 | name of the filing (`náz`) | `PodaniInfo` |
| 5 | period `YYYY-MM[-YYYY-MM]` | `PodaniObdobi` |
| 6 | `PARAM2.Hlavička` (firm heading, `"` removed) | `PodaniInfoFirma` |
| 7 | `XP` or empty: send through ELPODPI2 (Rebex) | `Rebex` |
| 8 | eNeschopenka PFX path (DZDPN only) | `CertNemocPath` |
| 9 | its password | `CertNemocPwd` |
| 10 | `A` = test gateway | `IsTest` |

## What it does (inferred from strings)

1. `Form_Load`: checks that CAPICOM is registered. If not: "Program nelze spustit. V systému
   není komponenta capicom.dll. Chcete ji nainstalovat?" and runs `{tisk}\setupe.exe`.
   `NactiParametry` reads the parameter file; `CtiXML` reads the XML.
2. `TypPodani`: recognises the form with VB `Like` patterns on the XML text:
   `*<DZDPN*</DZDPN>*`, `*<PodaniHZUPN*…`, `*<RELDP*…` (ELDP), `*<ONZ*…`,
   `*<pvpoj*PVPOJ2020*</pvpoj>*` … `PVPOJ2010`, `*<NEMPRI*version="2020.0"*` … `NEMPRI/2.0.0`,
   `*<OSVC*version="2020.0"*` … `2014.0`. Unknown → "Neznámý typ podání." Each type has a
   class (`clsPVPOJ2020`, `clsNEMPRI20`, `clsDZDPN`, …) that supplies the GovTalk class and
   the message `eType`/`Vendor`:

   | Form | `<Class>` | `eType` (latest) | Vendor |
   |---|---|---|---|
   | ELDP | `CSSZ_RELDP` | `ELDP09` | `UCTO - ELDP09`, version `2015` |
   | ONZ | `CSSZ_ONZ` | `ONZ` | `UCTO - ONZ` |
   | PVPOJ | `CSSZ_PVPOJ` | `PVPOJ20` (…`PVPOJ10`) | `UCTO - PVPOJ20`, `2020` |
   | NEMPRI | `CSSZ_NEM_PRI` | `NEMPRI20` (…`NEMPRI10`) | `UCTO - NEMPRI20`, `2020` |
   | HZUPN | (not listed separately, *probably* `CSSZ_NEM_PRI`) | `HZUPN20` | `UCTO - HZUPN`, `2020` |
   | DZDPN | `CSSZ_DZDPN` | `DZDPN20-V2` | `UCTO - DZDPN`, `2020.2` |
   | OSVČ | `CSSZ_OSVC_PRE` | `OSVC20` (…`OSVC13`) | `UCTO - OSVC20`, `2021` |

3. Window `frmELPODPIS` ("Elektronické podání pro ČSSZ"): the list `lstCert`
   "Vyberte podpisový certifikát" filled from the Windows `My` store via CAPICOM (entries
   "<name> / vydal: <issuer> / platí: dd.mm.yy", with "(! chybí soukromá část
   certifikátu)" when there is no private key), the label "Šifrovací certifikát:
   {tisk}\sifrcssz.cer", and the buttons **"Zašifrovat a podepsat"**, **"Detail
   podpisového certifikátu"**, **"Obsah podání"**, **"Odeslat data"**, **"Konec"**.
   A test run shows "Testovací větev!". No valid cert → "Není nainstalován žádný platný
   podpisový certifikát."
4. `KontrolaCerCSSZ`: if `sifrcssz.cer` has expired → "Platnost šifrovacího certifikátu
   ČSSZ vypršela … Chcete instalační program stáhnout?", then opens
   `http://www.ucto2000.cz/DOWNLOAD/sifrcssz.exe` (*inferred*: base URL + file name are
   adjacent strings; see [sifrcssz.md](sifrcssz.md)).
5. DZDPN only (`CertNemoc`, `VlozCert`): loads the eNeschopenka PFX ("Chybí certifikát
   pro eNeschopenku nebo je neplatné heslo k němu.") and inserts its public certificate
   into the request as `<SifrovaciCertifikat>` (*inferred*), so that ČSSZ can encrypt its
   answer for [ENESCHOP](eneschop.md).
6. `PodepisZpravu` (CAPICOM `SignedData`, base64) and `ZasifrujZpravu` (CAPICOM
   `EnvelopedData` for the ČSSZ certificate, base64) produce the envelope:

   ```xml
   <?xml version="1.0" encoding="windows-1250"?>
   <GovTalkMessage  xmlns="http://www.govtalk.gov.uk/CM/envelope">
       <EnvelopeVersion>2.0</EnvelopeVersion>
       <Header>
           <MessageDetails>
               <Class>CSSZ_PVPOJ</Class>
               <Qualifier>request</Qualifier>
               <Function>submit</Function>
               <TransactionID/><AuditID/><CorrelationID/>
               <ResponseEndPoint/>
               <Transformation>XML</Transformation>
           </MessageDetails>
           <SenderDetails>
               <IDAuthentication><SenderID/>
                   <Authentication><Method>clear</Method><Value/></Authentication>
               </IDAuthentication>
               <EmailAddress>{email}</EmailAddress>
           </SenderDetails>
       </Header>
       <GovTalkDetails><Keys><Key Type="vars">{VS}</Key></Keys></GovTalkDetails>
       <Body>
           <Message version="1.2" eType="PVPOJ20" xmlns="http://www.cssz.cz/XMLSchema/envelope">
               <Header>
                   <Signature xmlns:dt="urn:schemas-microsoft-com:datatypes" dt:dt="bin.base64">{PKCS#7 signature}</Signature>
                   <Vendor productName="UCTO - PVPOJ20" version="2020" />
               </Header>
               <Body encrypted="yes" contentEncoding="raw" xmlns:dt="urn:schemas-microsoft-com:datatypes" dt:dt="bin.base64">{PKCS#7 enveloped data}</Body>
           </Message>
       </Body>
   </GovTalkMessage>
   ```

   **To verify** before implementing: whether the signature is detached and computed
   over the plain or the encrypted data, and which content cipher is used (CAPICOM
   default: 3DES). Use the ČSSZ "VREP – popis rozhraní" specification as the reference.
7. `SendVREP`: with the `XP` flag, it writes the envelope to `ELPODPI2.UUU` and runs
   `{TISK}\ELPODPI2.EXE` (argv in [elpodpi2.md](elpodpi2.md)). Otherwise MSINET `POST` to
   `https://[t-]epodani.cssz.cz/VREP/submission` with `Content-Type: text/xml` and handles
   the reply itself: `acknowledgement` → "Podání bylo přijato pod číslem <<corID>> …
   Výsledek zpracování obdržíte z ČSSZ e-mailem (to může trvat i několik hodin).";
   `error` 1046 → "…nesouhlasí klíč (VS) z účta s údaji na ČSSZ"; other errors, CA/SSL
   errors, timeout. `ZapisDoProtokoluVREP` appends to `VREP.UUU`.

## Replacement design (Node/TypeScript)

**Recommendation: do not port ELPODPIS.** Register `elpodpis.exe` as a stub that tells the
user to use UCTOAPEP, for example: "Odesílání programem ELPODPIS není podporováno.
V Parametrech programu nastavte 'odeslat programem UCTOAPEP? = A'". Better: make the stub
call the UctoApep replacement directly. Reasons:

* The default configuration never reaches it (`PARAM3.Apep=true`, reset by every
  upgrade), and all current form versions (J21+, N25, O22, …) are forced to UctoApep.
* It depends on a Windows certificate store with a qualified signing certificate.
  A port would need PFX-based signing, a certificate picker, and PKCS#7
  sign/encrypt that matches ČSSZ byte for byte. That is effort **L**, and the legacy GovTalk
  endpoint may no longer be served.

If a port is ever needed (e.g. UctoApep stops working), the design would be:

* `src/engine/helpers/vrep/elpodpis.ts`: parse `UCTOTXT3` with a CSV reader
  (double-quoted fields), read `UCTOTXT5` as CP1250, and detect the form with the `Like`
  patterns converted to regexes.
* Signing identity: a PFX chosen by the user (Electron `dialog.showOpenDialog` + a password
  prompt), remembered per firm. On Windows, an optional native addon for the certificate
  store is not worth it.
* Crypto with `node-forge` (`forge.pkcs7.createSignedData`, `createEnvelopedData` with
  `sifrcssz.cer`), or `pkijs` if forge's cipher support is too narrow. Check the ČSSZ
  certificate validity and refresh it from `csszCertUrl` (see [sifrcssz.md](sifrcssz.md)).
* Transport and `VREP.UUU` logging through the shared `vrepSubmitGovTalk()` from
  [elpodpi2.md](elpodpi2.md).
* UI: a FAND-style dialog with the same five actions.

## Test approach

* Stub: an EngineDriver test with `PARAM3.Apep=false` and form `E` (ELDP) checks that the
  message (or the redirect to UctoApep) appears and that no file is written.
* For a port: parameter-file parsing fixtures generated by `eVrep2`, form detection
  for each pattern, and envelope snapshot tests with a fixed test PFX and deterministic
  randomness. Validate against the ČSSZ test gateway `t-epodani.cssz.cz` with a test
  certificate.
