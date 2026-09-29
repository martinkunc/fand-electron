# POSTTISK.EXE – print data onto pre-printed paper forms (postal forms, ELDP, ONZ)

`{tisk}\POSTTISK.EXE` (240 KB, 2017). A **native VB6** app built on the **VB6 Data Report
designer** (`msdbrptr.dll`, installed by `{TISK}\SETUPRPT.EXE`; the literal CLSID
`9DF1A470-BA8E-11D0-849C-00A0C90DC8A9`). Internal name `PostTisk`, title "Hlášení programu
TISKOPISY...". Each supported form is a Data Report with text boxes (`Text1…Text90`)
positioned over the pre-printed paper form. The report prints to the Windows printer,
shifted by user offsets.

## How Účto invokes it

`PoTisk(Zkr,Náz,Nov)` (menu) → `PoTiskW(Zkr)` (`UCTO2026_RDB/0605_P_PoTiskW.txt`):

```
rn:=cond(Zkr=~'DR':1, Zkr=~'SA':2, Zkr=~'SC':3, Zkr in~['EL','ELK']:4, Zkr=~'OZ':5, Zkr=~'PL':6); if rn=0 then exit;
proc(PoTiskInit); pgm:=PROGRAM.Path+'{TISK}\POSTTISK.EXE'; ...
if filesize(UCTOTXT)<=0 then proc(Hlaseni,('Prázdná data pro potisk '+UCTOTXT.Path));
copyfile(UCTOTXT,UCTOTXT3,mode='LW');                  { CP852 → Windows code page (CP1250) }
readrec(VetaP,rn);
par:='"'+XPath(UCTOTXT3.Path)+'",'+'"'+str(VetaP.PosunX,'0')+'","'+str(VetaP.PosunY,'0')+'",'+'"'+Zkr+'"';
puttxt(UCTOTXT2,par);
proc(ExecWin,('{tisk}\caller.exe',FILE.Path+' $ '+XPath(UCTOTXT2.Path)));   { via CALLER: no wait }
```

| | |
|---|---|
| Command line | `$ <UCTOTXT2.UUU>` (started through [CALLER](caller.md)) |
| Param file | `"<data file>","<PosunX>","<PosunY>","<Zkr>"` (VB `Input #`) |
| Data file | `UCTOTXT3.UUU`, **CP1250** (FAND `mode='LW'`), **one field per line**, a fixed number of lines per record (see below) |
| Offsets | `POTISK` records (`0601_F_POTISK.txt`: `Zkr, Název, PosunX:F3.0, PosunY:F3.0`), whole mm. Edited in "Okraje pro tisk E" → `PoTiskPar`. Defaults from `PoTiskInit`: DR 4/24, SA 0/3, SC 0/2, EL 4/10, OZ 3/14, PL 1/40. |
| Exit code | not observed (asynchronous) |

Form types (`Zkr`) and their data reports:

| Zkr | Form | Report | Lines per record (field names in POSTTISK) | Menu |
|---|---|---|---|---|
| `DR` | Balík do ruky (parcel dispatch note) | `MODUL02_PRO/0121_R_PoTiskDR.txt` | 25: PPsc, Hmotnost, Kc, Slovy1, Slovy2, OFirma, OJmeno, OUlice, OMisto, OPsc, AFirma, AJmeno, AUlice, AMisto, APsc, ATelefon, Banka, Ucet, Kod, K1–K6 (the "X" service boxes) | Adresy → sestavy → "Balík do ruky" → "Potisk formuláře F" |
| `SA` | Složenka A (postal order to an account) | `0123_R_PoTiskSA.txt` | 17: amount `=1.234=`, amount digits, haléře, amount in words 1/2, recipient name/street/place, account (full, number, bank code), VS, KS, SS, sender name/street/place | "Složenka na účet" |
| `SC` | Složenka C (postal order to an address) | `0125_R_PoTiskSC.txt` | 14 | "Složenka na adresu" |
| `PL` | Podací lístek (posting receipt) | `0127_R_PoTiskPLS.txt` / `0128_R_PoTiskPLD.txt` | 15: sender name, street, PSČ, place, phone (9 digits), e-mail, recipient firm, name, street, PSČ, place, phone, e-mail, dobírka, udaná cena. POSTTISK splits PSČ/phone into the per-digit boxes `OPsc1–5`, `OTelefon1–9`, … | "Podací lístek" (`0129_P_PoTiskPL.txt`) |
| `EL`/`ELK` | ELDP (pension insurance record list) | `PoTiskEL` (MODUL97) | NazevOSSZ, Prijmeni, Jmeno, Titul, DatNaroz, RodCis, address, Kod1–3/Dny1–3/VylDoby1–4/VymZaklad1–4/DobyOdect1–4, NazevOrg, IcoOrg, VarSymOrg, … | Mzdy → ELDP → "Potisk ELDP" (`MODUL97_PRO/0225_P_TiskEldp.txt`, `0212_P_EldpSF6.txt`) |
| `OZ` | ONZ (employee registration/deregistration) | MODUL97 | TypAkce, ZamestDatumVstup/Ukonc, personal data, address, foreign address, employer, KodZP, … (`KodOSSZ`, `OpravaDne`) | Mzdy → ONZ |

`PARAM3.FFF` (the record count) is shown in the menu header "… (n)". The data can be
viewed with "Data pro potisk T".

## What it does (strings)

* It checks `$`, reads the params ("Chyba volání programu."), and picks the report by
  `Zkr` ("Nepodporovaný typ tiskopisu."). It reads the data file in blocks of N lines
  per record, and fills the report text boxes: one record per page, with the
  "(počet stran: n)" caption.
* It shifts all controls by `PosunX`/`PosunY` mm and prints the report to the default
  printer (the Data Report print dialog or preview is inferred). If the Data Report
  runtime is missing, it offers `SETUPRPT.EXE`.

## Replacement design

Module `src/engine/helpers/posttisk.ts`, key `posttisk.exe`. Effort **M**. Priority
**low**: paper postal orders are rare and ELDP/ONZ are filed electronically now, but the
menu items exist.

1. Parse the param CSV and the data file (**CP1250** here, via `iconv-lite`). Group lines
   per record by the type's line count.
2. **Layout definitions as data**: `src/engine/helpers/posttisk-layouts.json`, with, for
   each `Zkr`, the page size and the field → `{x, y, w, align, font, size, split?}` in mm.
   `split` covers per-digit boxes (PSČ, phone, amount). The coordinates cannot be read
   out of the VB6 Data Report binary reliably; take them from a scan or a PDF of the
   official forms (Česká pošta DR/A/C/PL, ČSSZ ELDP/ONZ), or from an original POSTTISK
   printout.
3. Render one page per record with `pdf-lib`, text only (no background, since it prints
   **onto** pre-printed paper), shifted by `PosunX/PosunY`. Font: Liberation Sans.
4. Print through the shared print service: `ctx.host.printPdf(pdf, { dialog: true })`
   (Windows: `pdf-to-printer`; macOS/Linux: CUPS `lp`), with **no scaling** ("actual
   size"), which is essential for pre-printed forms. Offer "Náhled" (open the PDF) as a
   fallback.
5. Optional improvement: include the form image as a background layer for "tisk na
   prázdný papír", not in the original.

## Test approach

* Parser tests: a `SA` data file with 2 records (34 lines) → 2 record objects with the
  named fields; `PL` digit splitting (`46001` → 5 boxes); a short last record → error
  "Chyba: …".
* Layout snapshot: the per-page text positions (pdfjs-dist) for each `Zkr` with a
  fixture record. Offsets `4/24` shift everything by 4 mm/24 mm.
* Print options: `printPdf` is called with `scale: 'noscale'` and `dialog: true`.
* Manual: print a Složenka A on plain paper, lay it over a real form against the light,
  adjust the layout JSON. This replaces the user-side "Okraje pro tisk".
