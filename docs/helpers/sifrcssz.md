# sifrcssz.exe – installer for the ČSSZ encryption certificate (Inno Setup)

`{tisk}\sifrcssz.exe` (317 KB, native Win32, **Inno Setup 5.5.7** installer,
setup-data version 5.6.0, dated 2021-02). Product "Instalace nového šifrovacího
certifikátu pro ČSSZ", version 1.0.0, © 2013–2021 Tichý & spol., language Czech, not
password protected. `innoextract -l` lists a single file:

```
Listing "Šifrovací certifikát pro ČSSZ" - setup data version 5.6.0
 - "app/sifrcssz.cer" (2.32 KiB)
```

So it copies `sifrcssz.cer` into the chosen Účto directory's `{app}` target, which is
presumably the `{TISK}` folder (*inferred*; the `[Files]` DestDir is not printed by
`innoextract -l`).

## Certificate contents

| | installer payload (`app/sifrcssz.cer`) | current `{tisk}\sifrcssz.cer` (2025-02) |
|---|---|---|
| Subject CN | `DIS.CSSZ.2022` | `DIS.CSSZ.2025` |
| Subject O / OU | ČR - Česká správa sociálního zabezpečení / Odbor 51 | … / odbor řízení bezpečnosti a rizik |
| Issuer | `PostSignum Public CA 4` (Česká pošta, s.p.) | `PostSignum Public CA 4` |
| Validity | 2021-02-17 → **2022-03-09 (expired)** | 2025-02-03 → 2028-02-23 |
| Format | PEM | PEM |

The installer is stale. The live certificate was refreshed separately, *presumably* by
Účto's normal update (UCTOOL), which overwrites `{tisk}\sifrcssz.cer`.

## How Účto calls it

**Not called from FAND code, BAT files or FAND.CFG.** The chapters only test for the
certificate file itself before every VREP submission:

```
FILE.Path:=PROGRAM.Path+'{TISK}\SIFRCSSZ.CER';
if filesize(FILE)<=0 then proc(Hlaseni,('Chybí šifrovací certifikát '+FILE.Path)) else …
```

(`MODUL03_PRO/0355_P_eVrep.txt`, `MODUL97_PRO/0262_P_eVrep2.txt`, `MODUL94_PRO/0115_P_eVrep94.txt`).
The certificate path also goes to UctoApep as `csszCert` (`UCTO2026_RDB/0634_P_UctoApep.txt`),
together with `csszCertUrl = http://www.cssz.cz/stranky/certifikaty/dis.cssz.aktualni.cer`.

The only reference to the installer is in [ELPODPIS.EXE](elpodpis.md) (strings): when
the certificate has expired, it says "Platnost šifrovacího certifikátu ČSSZ vypršela …
Stáhněte si instalační program s novým certifikátem z našich stránek www.ucto2000.cz …
Chcete instalační program stáhnout?" and opens (*inferred*)
`http://www.ucto2000.cz/DOWNLOAD/sifrcssz.exe`. The copy in `{tisk}` is a leftover
download.

## Replacement design

**Obsolete, do not port.** A Windows installer that copies one file has no place in a
cross-platform runtime, and the certificate it carries expired in 2022.

What remains useful is a **certificate check/refresh** function in the shared VREP code
(`src/engine/helpers/vrep/cssz-cert.ts`), used by the UctoApep/ELPODPIS/ENESCHOP
replacements before encrypting for ČSSZ:

* Load `{tisk}\sifrcssz.cer` (PEM or DER) with `node:crypto` `X509Certificate`. Check
  `validTo`, a subject CN matching `/^DIS\.CSSZ\.\d{4}$/`, and an issuer matching
  `/PostSignum/`.
* If it has expired or is missing: offer to download `csszCertUrl` (the URL UctoApep gets
  from Účto; the ČSSZ publishes the current DIS certificate there, **verify it is still
  valid and prefer https**) with `fetch`, validate the result the same way (and
  optionally the chain to the PostSignum roots), and write it back as PEM. Otherwise,
  show the original advice text.
* Register `sifrcssz.exe` as a stub key that runs this refresh, so that a user who opens
  the file from a file manager inside Účto (e.g. via "Adresář" / ExplWin) gets something
  sensible.

Priority low, effort S.

## Test approach

* Unit tests with the two real certificates as fixtures (the expired installer payload and
  the current `sifrcssz.cer`). Copy them into `test/fixtures/helpers/cssz/`; they are
  public certificates. Assert expiry detection and subject/issuer matching.
* Refresh: mock `fetch` returning the DER/PEM of the current certificate and check that
  the file is replaced only when validation passes.
