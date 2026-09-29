# CERTINFO.EXE – show the EET certificate

`{tisk}\CERTINFO.EXE` (16 KB, VB.NET, .NET 4.0 WinExe, assembly `ShowCertificate`,
dated 2017). It shows the Windows certificate dialog for the PKCS#12 certificate used
for EET (the electronic registration of sales), or lists valid EET certificates from
the Windows certificate store.
Decompiled source: `work/decompiled/{tisk}_CERTINFO/ShowCertificate/ShowCertificate.cs`.

## How Účto calls it

Only one call site: `MODUL01_PRO/0103_P_TestEET.txt`, menu **e-Tržby (`EET`, procedure
`MODUL01_PRO/0104_P_EET.txt`) → "Testy prostředí" → "Informace o certifikátu"**.

```
EXE.Path:=PROGRAM.Path+'{TISK}\CERTINFO.EXE';
if filesize(EXE)<0 then proc(Hlaseni,('Program '+EXE.Path+' neexistuje')) else begin
  s:=Trail(PAREET.eCrt); par:=cond(s<>'':s+' '+Trail(PAREET.eCrtPwd));
  proc(Dotaz,(true,'Zobrazit vlastnosti certifikátu pro EET '+
    cond(par='': 'z úložiště Windows', pos('\',s)=0: s, else:EndTxt('\',s))));
  if PARAM3.Ano then begin
    proc(Hlaseni23,(cond(par='':'úložiště Windows', else:s)));
    proc(ExecWin,(EXE.Path,par)); proc(Clr); clearkeybuf;
  end;
end;
```

| | |
|---|---|
| Command line | `<pfx path> <password>` (`PAREET.eCrt` A80, `PAREET.eCrtPwd` A30, stored encrypted in FAND), or nothing |
| Working dir | Účto root; a relative `eCrt` is resolved against it |
| Exchange files | none |
| Output / exit code | none; the program only shows UI |

The command line is split on spaces, so a path or password containing a space breaks
the call: `argv[1]` = path, `argv[2]` = password, and the rest is ignored.

## What it does (decompiled C#)

* With two non-empty arguments: `new X509Certificate2(path, password)`, then
  `X509Certificate2UI.DisplayCertificate` (the standard Windows certificate properties
  dialog: General, Details, Certification path). If loading fails (wrong password,
  missing file), MsgBox `<exception message>`, style Exclamation, title
  "Hlášení programu ShowCertificate...".
* Otherwise, for each `StoreLocation` (CurrentUser, LocalMachine): open store `My`
  read-only and find certificates with `FindByIssuerName "EET"` and `FindByTimeValid(now)`.
  If any are found, show `X509Certificate2UI.SelectFromCollection` titled
  "EET CERTIFIKÁTY V ÚLOŽIŠTI: <CurrentUser|LocalMachine>". If none are found anywhere,
  MsgBox "Nebyl nalezen žádný platný EET certifikát." Exceptions in this branch are
  swallowed.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/certinfo.ts`, key `certinfo.exe`.

* Parse `args` as the original does (space split, first two tokens). Map the path
  (DOS → host, relative to the Účto root).
* Load the PKCS#12 with `node-forge` (`forge.asn1.fromDer`,
  `forge.pkcs12.pkcs12FromAsn1(asn1, password)`). Collect the certificate bags and the
  key bag. `node:crypto` `X509Certificate` can then format the certificate fields.
* Show a **FAND-style info window** through `ctx.ui` instead of the Windows dialog:
  Subject (CN, O, serialNumber), Issuer, serial number, valid from/to (with "PLATNÝ" /
  "NEPLATNÝ"), key usage, SHA-1 and SHA-256 fingerprints, "obsahuje soukromý klíč
  ano/ne", and the certificate chain from the PFX. On error, show the message with the
  title "Hlášení programu ShowCertificate...".
* Store mode (no arguments): there is no portable certificate store. Show "Úložiště
  certifikátů Windows není v této verzi podporováno; zadejte soubor .pfx v parametrech
  EET." Enumerating the Windows store is not worth it.
* OS integration: none.

**Still worth replacing: barely.** EET was abolished in the Czech Republic from
1 January 2023, and the menu only exists for legacy data. Implement the small PFX
viewer (it doubles as a generic "show certificate" tool, e.g. for the eNeschopenka
`sifructo.pfx`) or register a stub that shows the store-mode message. Priority low.

## Test approach

* Generate a test PKCS#12 with `node-forge` in the test (self-signed, issuer
  `CN=EET CA 1 Playground`, known password) and assert the rendered text lines.
* Wrong password gives the error message; missing file; no arguments gives the
  store-mode message.
* Argument splitting: `"C:\UCTO\{TISK}\EET.P12 heslo"` → path + password.
