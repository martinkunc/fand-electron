# PDFTISK3.EXE – overlay data onto an official PDF form using a position definition (.DEF)

`{tisk}\PDFTISK3.EXE` (80 KB, 2019). A **native VB6** app (by Miroslav Štandera for Tichý &
spol.) using **PDF Creator Pilot** (`PDFCreatorPilot.PDFDocument4`, licence key embedded,
installer `{TISK}\SETUPCP.EXE`). Classes: `clsData`/`clsDataCol` (`NazevUdaje`,
`HodnotaUdaje`), `clsDefinice`/`clsDefiniceCol` (`NazevUdaje`, `TypUdaje`,
`CisloStrany`, `PosX`, `PosY`, `Vyska`, `Sirka`, `Mrizka`, `UhelTextu`), the renderers
`clsPDFObjectTL/TR/TC/TG/GL` (`ZapisDoPDF`), and `cls1250` (`FandTo1250`). This is
**"PDF3 – vhodný pro e-mail"**: a flat, printable PDF of a tax or insurance form, as opposed
to the editable PDF1 ([PDFTISK1](pdftisk1.md)).

## How Účto invokes it

Wrapper `PdfDok(Sest)`, `UCTO2026_RDB/0597_P_PdfDok.txt`:

```
if copy(Sest,1,1)='+' then begin Sest:=copy(Sest,2,30); mrg:=true end;   { part of a merge batch }
pgm:=PROGRAM.Path+'{TISK}\PDFTISK3.EXE';
p:=pos(' ',Sest); if p=0 then begin def:=Sest; pdf:=Sest end else begin def:=copy(Sest,1,p-1); pdf:=copy(Sest,p+1,8) end;
if PARAM3.Pdf3Pw & ^mrg then begin proc(Param0,('Pdf3Pwd')); if edbreak=12 then pwd:=Trail(PARAM3.Pdf3Pwd); end;
out:=XPath(ADR03.Path)+'{SEST}\SEST'+str(PARAM3.SestAkt,'00')+cond(pwd<>'':'x')+'.PDF';
par:=XPath(SEST.Path)+'\13'+
     XPath(ADR01.Path)+'{PDF3}\'+def+'.DEF\13'+
     XPath(ADR01.Path)+'{PDF3}\'+pdf+'.PDF\13'+
     out+'\13'+ pwd+'\13'+
     cond(p>0 & def=~'Eldp09BX':str(PARAM3.PdfY,0,2)+','+str(-PARAM3.PdfX,0,2),
          p>0 & Sest<>~'Eldp09BX':str(PARAM3.PdfX,0,2)+','+str(PARAM3.PdfY,0,2), else:'0,0')+'\13'+
     cond(def in~['Eldp09BX','VzpX','HromOznX','PojZamX','OsszX','OsszUX','OnzKX']:'C')+'\13'+
     cond(^mrg:'A')+'\13';
copyfile(UCTOTXT,SEST,nocancel);                  { the data: report output → SESTnn.TXT }
if ^mrg & PARAM3.EditPdf3 then ... proc(Txt,(SEST.Path));   { optional manual edit of the data }
puttxt(UCTOTXT2,par); ... KAM.Path:=out; puttxt(KAM,'');
proc(ExecWin,(FILE.Path,'$ '+UCTOTXT2.Path));
if PARAM3.SyncW then proc(WaitFor,(out,'PDFTISK3.EXE'));
```

| # | Param line (in `UCTOTXT2.UUU`, CR-separated) |
|---|---|
| 1 | data file `{SEST}\SESTnn.TXT` |
| 2 | definition `ADR01\{PDF3}\<def>.DEF` |
| 3 | template `ADR01\{PDF3}\<pdf>.PDF` (a blank official form, background only) |
| 4 | output `{SEST}\SESTnn[x].PDF` (the `x` suffix when password-protected) |
| 5 | user password (empty = none) |
| 6 | offset `"dx,dy"` in mm with a `.` decimal point (`PARAM3.PdfX/PdfY` = "Posun formulářů"; axes swapped and negated for the landscape `Eldp09BX`), or `0,0` |
| 7 | `C` for Eldp09BX, VzpX, HromOznX, PojZamX, OsszX, OsszUX, OnzKX, else empty. Inferred: **Courier New** instead of the default **Arial** (both font names are in the binary). |
| 8 | `A` = open the result (not in merge mode) |

Data file (CP852), the same format as PDF1: one `"name","value"` per line, produced by the
form's report (e.g. `MODUL97_PRO/0344_R_VykDppY.txt` → `"mesic","_"`, `"rok","_"` …). The
values go through `PdfTxt()` (`"`→`'`, `#` removed).

Definition file `{PDF3}\*.DEF` (CP852 CSV, `"`-quoted, decimal **comma**), 9 columns:

```
"mesic","TC","1","91,80","27,00","5,20","12,00","0","0"
 name   type page PosX    PosY    Vyska  Sirka  Mrizka UhelTextu
```

| Column | Meaning |
|---|---|
| type | `TL` left-aligned text at (x,y); `TR` right-aligned (x = right edge); `TC` centred in a box of width `Sirka` (height `Vyska`); `TG` **grid/comb**: `Mrizka` cells across `Sirka` mm, one character per cell (e.g. `"dic","TG","1","15,22","38,10","5,84","60,07","12","0"`); `GL` a **line** (strike-through of pre-printed options) of length `Sirka` (e.g. `"prohlAx","GL",…,"0,00","7,00"`) |
| page | 1-based page number (0 occurs in a few DEFs: treat it as page 1, **verify**) |
| PosX, PosY | mm from the **top-left** of the page (inferred from the values: y grows down the form) |
| Vyska | text height/font-size hint in mm (0 = default) |
| Sirka | box width in mm (TC/TG/GL) |
| Mrizka | grid cell count (TG) |
| UhelTextu | rotation in degrees (0 or 90) |

Counts over the 41 shipped DEFs (3889 entries): TC 2021, TL 1147, TR 654, TG 49, GL 18; rotation 90 in 89
entries.

Callers: `Pdf2` for PDF3 forms (`<Sest>X`, e.g. `DPH24X`, `VYUCTX`, `DZPX`, `ELDP09BX` …),
the "Tisk do originálního formuláře" menu in `PdfBlank` (`0598`), the batch merges (`+`
prefix → [PDFMERGE](pdfmerge.md)): VykDpp, PocZam, Eldp09, Prihl, OdvodyDan (Potvrzení o
příjmech), ProZad. Also the ČSSZ e-submissions (`DsPPZ`, `DsHOZ`) that attach the PDF
form. The offsets are set in "Posun formulářů" (`Param0('PosunF')`).

## What it does (strings)

* It reads the params ("Chyba při čtení parametrů (GetParam).", "Pro tiskopis chybí
  definice/vzor (GetParam)."), the data ("Chyba při čtení dat (CtiDataFile).",
  "Nestandardní znak v datech z účta (uvozovky...)"), and the definitions ("Chyba při
  čtení definic (CtiDefinice).", "Chyba v datech (PridejData/PridejDefinici).").
* For every definition whose name has a data value, it draws the value (CP852 → CP1250) on
  its page of the template with the given alignment, grid or rotation, shifted by the
  offset. `GL` draws a line when the value is non-empty (inferred). The literal `10,25` is
  likely the default font size, or a default for the grid height.
* Metadata: Author "Miroslav Štandera", Subject "účto, mzdy, daňová evidence, DPH",
  Creator "Tichý & spol., …", Keywords/Title "Vytištěno z programu účto" / "Daňový tiskopis".
* Password, save, and open if `A`. Errors: "Chyba při generování PDF (VyrobPDF).",
  "Tiskopis se nevytvoří."

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/pdftisk3.ts`, key `pdftisk3.exe`. Effort **M**.

1. `$` guard, 8 param lines (CR / CRLF), mapped paths.
2. Parse the DEF (CP852, CSV, comma decimals) and the data (CP852, CSV). Warn on unknown
   names, never fail on them.
3. `@cantoo/pdf-lib`: load the template and embed **Liberation Sans** (Arial-metric) or
   **Liberation Mono** when line 7 is `C`. For each entry, with `mm = 72/25.4`:
   * `x = (PosX + dx)·mm`, `yTop = (PosY + dy)·mm`, `y = pageHeight − yTop` (baseline
     adjustment calibrated);
   * the font size is `Vyska` → pt when > 0, otherwise the default. Rotation via
     `rotate: degrees(UhelTextu)`;
   * TL/TR/TC: alignment from `font.widthOfTextAtSize`; TG: split the value into
     characters, cell width = `Sirka/Mrizka`, centred per cell; GL: `drawLine` of length
     `Sirka` at y (horizontal, or vertical when rotated).
4. Metadata as in the original. Encrypt when there is a password. Save, then `openPath`
   if `A`.

Still needed: **yes, high**: all flat official forms and batch payroll forms.

## Test approach

* Unit: the DEF parser over **all** `{pdf3}/*.DEF` in the pristine app: no parse errors,
  and the type/column counts equal the numbers above.
* Render test: `DppX.DEF` + `DppX.pdf` + a hand-written data file. Extract with
  `pdfjs-dist` and assert every value is present, on the right page, with x/y within
  ±0.5 mm of the DEF (after the offset). TG → N separate glyph runs. Rotation 90 → a
  rotated transform matrix.
* Offset test `1.50,-2.00` → all runs shifted by that amount. The Eldp09BX axis swap is
  handled by FAND, so the helper just applies line 6.
* Golden (calibration): the original PDFTISK3 output for one form from each family (DPH,
  VYUCT, ELDP09B, VZP), run once on Windows/Wine, to fix the baseline offset and the default
  font size.
* EngineDriver: PAM/mzdy → "Tisk do originálního formuláře" on `{prik}` → `SESTnn.PDF`
  created and `openPath` recorded.
