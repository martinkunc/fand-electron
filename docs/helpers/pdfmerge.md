# PDFMERGE.EXE – merge several PDFs into one (optionally password-protected)

`{tisk}\PDFMERGE.EXE` (31 KB, 2018). A **native VB6** app (`frmPDFMERGE` "PDF MERGE",
`mdlGLOB`). It uses the commercial COM library **PDF Creator Pilot**
(`PDFCreatorPilot.PDFDocument4`, installed by `{tisk}\SETUPCP.EXE`), with a licence key
embedded in the exe (not reproduced here). Description: "Merge PDF souborů. Určeno pro
program účto."

## How Účto invokes it

Two steps, `UCTO2026_RDB/0599_P_PdfMerge1.txt` and `0600_P_PdfMerge2.txt`:

```
PdfMerge1(var in):   { after each PdfDok('+…') – i.e. PDFTISK3 without opening }
  pdf1:=replace('.TXT',POSLSEST.Path,'.PDF','u');
  if in='' then PARAM3.PDFxxx:=0; PARAM3.PDFxxx+=1; pdfM:='PDF'+str(PARAM3.PDFxxx,'000')+'.PDF';
  proc(ExecDos,('@ren '+pdf1+' '+pdfM+' >NIC.UUU'));           { SESTnn.PDF → {SEST}\PDF001.PDF }
  in:=in+ADR03.Path+'{SEST}\'+pdfM+'\13\10';

PdfMerge2(in, out, hd):
  proc(Hlaseni,('Následuje sloučení PDF ('+str(PARAM3.PDFxxx,'0')+') do jednoho dokumentu'));
  if PARAM3.Pdf3Pw then begin proc(Param0,('Pdf3Pwd')); if edbreak=12 then pwd:=Trail(PARAM3.Pdf3Pwd); end;
  if out=~'' then out:=replace('.TXT',POSLSEST.Path,cond(pwd<>'':'x')+'.PDF','u');
  TXT.Path:=PROGRAM.Path+'{TISK}\PDFMERGE.TXT';
  puttxt(TXT,out+crlf+ 'A'+crlf+ 'A'+crlf+ pwd+crlf+ in);
  EXE.Path:=PROGRAM.Path+'{TISK}\PDFMERGE.EXE'; proc(ExecWin,(EXE.Path,TXT.Path));
```

| | |
|---|---|
| Command line | the path of `{TISK}\PDFMERGE.TXT` (no `$`) |
| `PDFMERGE.TXT` (CP852, CRLF) | line 1 output PDF; line 2 `A`; line 3 `A`; line 4 user password (may be empty); lines 5… the input PDFs in order |
| Output | the merged PDF (`{SEST}\SESTnn[x].PDF`, or `out`) |
| Exit code | not checked |

Lines 2 and 3 are always `A` (Ano). Their meaning is **unknown**; most likely "open the
result" and something like "overwrite" or "delete the inputs". The caller in `SestXXex`
merges the `SESTnn.PDF` files in place, which argues against deleting the inputs.

Callers (`hd` is only a label and is not passed on):

| Chapter | Feature |
|---|---|
| `MODUL97_PRO/0345_P_VykDppPdf.txt` | "Zaměstnanci na DPP" – several persons' DPP forms |
| `MODUL97_PRO/0053_P_PocZam.txt` | "Vyúčtování+příloha" |
| `MODUL97_PRO/0208_P_Eldp09Pdf3.txt`, `0253_P_PrihlPdf.txt` | ELDP, registrations for several employees |
| `MODUL03_PRO/0240_P_Pdf25.txt` | "Přiznání+přílohy" (tax return with attachments) |
| `MODUL04_PRO/0472_P_OdvodyDan.txt` | "Potvrzení o příjmech zálohová/srážková daň (n)" |
| `MODUL04_PRO/0199_P_ProZad.txt`, `0201_P_PracovSestB.txt` | employee declarations/sheets |
| `MODUL99_PRO/0183_P_SestXXex.txt` | sestavy list: "Označené sestavy (n)" → Txt2Pdf each, then merge |

## What it does (strings)

"Chyba při čtení parametrů.", "Knihovnu PDF Creator Pilot nelze použít.", "Soubor
<name> neexistuje." (a missing input), and the title "Hlášení programu PDFMERGE". It
creates a `PDFDocument4`, appends every input, sets `UserPassword` if one is given, saves,
and (inferred) opens the result.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/pdfmerge.ts`, key `pdfmerge.exe`. Effort **S**.

1. Read the param file (CP852) and split the lines. Skip empty lines at the end. Map all
   paths with `ctx.mapPath`.
2. Check every input exists, otherwise show "Soubor <…> neexistuje." and return 1.
3. Merge with **`pdf-lib`**: `PDFDocument.create()`, then for each input
   `copyPages(src, src.getPageIndices())`. AcroForm fields from PDFTISK1-filled forms would
   collide by name; PDFTISK3 output is flat, so this is not an issue here.
4. Password: `pdf-lib` cannot encrypt. Use **`@cantoo/pdf-lib`**, a maintained fork with
   `pdfDoc.encrypt({ userPassword, ownerPassword, permissions })`, as the project-wide
   pdf-lib (it is a drop-in replacement). The fallback is `qpdf --encrypt` when installed.
   The same choice applies to PDFTISK2/3 and UctoQR.
5. Save to line 1, then `ctx.host.openPath(out)`: treat line 2 `A` as "open". Do **not**
   delete the inputs.

Still needed: **yes, medium**. Used for batch payroll/tax PDF forms.

## Test approach

* Fixture: three small PDFs made by pdf-lib (1, 2 and 1 pages), plus the param file in
  CP852 with a Czech path.
* Assert 4 pages in order (a page-text marker), the output path, one `openPath` call, and
  the inputs still present.
* With a password: the output needs the password (open with `pdfjs-dist` with and without
  it). An empty password gives no encryption.
* A missing input → an exact message and no output file.
* EngineDriver (in a temp app copy): MODUL99 sestavy → mark 2 sestavy → "do PDF" →
  merged `SESTnn.PDF` with the combined page count.
