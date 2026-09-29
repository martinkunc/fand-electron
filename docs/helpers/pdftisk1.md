# PDFTISK1.EXE – fill an interactive PDF form (via XFDF) / open a PDF

`{tisk}\PDFTISK1.EXE` (55 KB, 2009). A **native VB6** app (`frmPDFTisk` "PDF tiskopisy" with
the label "Čekejte na zobrazení PDF tiskopisu.", classes `clsElement`/`clsElementColl`,
method `GetXFDF`). It does **not** create PDFs itself. It writes an **XFDF** file that
points at an AcroForm template and asks the default PDF viewer (Adobe Reader) to open it.
The viewer then shows the template with the fields filled in, and the user can still edit
them ("PDF1 – s možností oprav").

## How Účto invokes it

Wrapper `CallPdf(Soub)`, `UCTO2026_RDB/0590_P_CallPdf.txt`:

```
if filesize(PDFTISK1)<=0 then begin proc(Hlaseni,('Program '+PDFTISK1.Path+' nenalezen')); exit end;
proc(Vypocet1); proc(ExecWin,(PDFTISK1.Path,Soub));
if exitcode<>0 & ^PARAM3.DOSBox then proc(Hlaseni,('Program '+PDFTISK1.Path+' skončil chybou '+str(exitcode,'0')));
```

| | |
|---|---|
| Command line | one path, either a `.TXT` (form data) or a `.PDF` (just open it) |
| Exit code | non-zero → "Program … skončil chybou N". The codes are in the table below. |

**A. Form fill**: `Pdf2(Sest)` (`UCTO2026_RDB/0588_P_Pdf2.txt`), which decides between
PDF1 (this helper) and PDF3 ([PDFTISK3](pdftisk3.md)):

```
prefix:=ADR03.Path+'{PDF1}\'; s1:=prefix+Sest; s3:=prefix+Sest+'.TXT';
... pdf1 := true for Dzp_4/Dzp_7, WinVer='9', Pdf13='1', and for everything NOT in
          [SilDan, Vyuct, Dzp*, OdcitPol, Ossz*, VyuctSrz, PocZam, Vzp, HromOzn, PojZam,
           DavkyK8/9, PPoj21, ChybCast/ChybCa2, Nemoc2, HZUPN, Dph01..99]…;  Pdf13='2' → menu
if pdf1 then begin
  FILE.Path:=s3; h:='"'+XPath(s1)+' '+Sest+'"\13\10'; puttxt(FILE,h);
  if PARAM3.PdfNoDiak then copyfile(UCTOTXT,FILE,mode='LN',append) else copyfile(UCTOTXT,FILE,append);
  FILE.Path:=s2+'.PDF'; if filesize(FILE)<=0 then begin proc(Hlaseni,('Dokument '+FILE.Path+' nenalezen')); exit end;
  proc(CallPDF,(s3));
end else proc(PdfDok,(...Sest+'X'));
```

The data file `{PDF1}\<Sest>.TXT` (CP852, CRLF) looks like this:

```
"C:\UCTO2026\{PDF1}\Dph24 Dph24"          ← template path without .PDF, a space, the form name
"finUrad","Praha 1"                      ← from the form report (UCTOTXT), one field per line
"dic","12345678"
"r28","1 234"
...
```

The reports write the values through `PdfTxt()`, which replaces `"` → `'` and removes `#`,
because a `"` inside a value breaks VB `Input #` (Chyba 62).

**B. Plain open**: `CallPDF(<file>.PDF)`. Used by "Přečtěte si" → manuals
(`0415_P_Prirucky.txt`: `{UDOC}\U2023.PDF`, `R2026.PDF`, `DBOX.PDF` …), `Pdf3` (a blank
form from `{PDF1}`), the DPO demo (empty form), `PlatbaQR`, `FaktPdf1` (open the invoice
PDF), `IczPPZ`/`IczHOZ`, and others.

Templates: `{PDF1}\*.PDF` (51 files, e.g. `DPH24.PDF`, `VYUCT.pdf`, `ELDPM.pdf`), which
are AcroForms. For example, `DPH24.PDF` has `/T(finUrad)`, `/T(uzemPrac)`, `/T(dic)`, …
fields named exactly like the report keys.

## What it does (strings)

* No argument → "Chyba 513: Nelze spustit - nejsou parametry." A missing file → "Chyba 53:
  Soubor … neexistuje."
* `.TXT`: parse the first line (template path + name), then every `"name","value"` line
  (`Input #`). Build `<same path>.XFDF`:
  ```xml
  <?xml version="1.0" encoding="UTF-8"?>
  <xfdf xmlns="http://ns.adobe.com/xfdf/" xml:space="preserve">
  <fields>
      <field name="finUrad">
          <value>Praha 1</value>
      </field>
      …
  </fields>
  <f href="C:\UCTO2026\{PDF1}\Dph24.PDF"/>
  </xfdf>
  ```
  Values are escaped `&amp; &lt; &gt;`. The character conversion from CP852 is unknown
  (inferred: to the declared UTF-8, or to ANSI).
* `FindExecutable` for `.PDF` → "Chyba 514: Nelze zjistit program pro spouštění PDF
  souborů." Then `ShellExecute "open"` on the XFDF (or the PDF) → "Chyba 515: Nelze
  spustit prohlížeč PDF souborů." "Chyba 516: Pravděpodobně chyba v datech." and "Chyba
  62: Nestandardní znak v datech z účta (uvozovky...)" are data errors. The exit code is
  most likely the error number.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/pdftisk1.ts`, key `pdftisk1.exe`. Effort **M**.

XFDF does not work outside Adobe Reader (browsers, Preview, Evince and Okular ignore
it), so **fill the form ourselves**:

1. `p = ctx.mapPath(args[0])`. A missing file → message "Chyba 53: …", return 53.
2. `.pdf` → `ctx.host.openPath(p)`, return 0.
3. `.txt` → decode CP852 and parse with a small CSV reader (`"a","b"` per line; tolerate
   embedded `'`). Line 1 → template = `<path>.PDF`, matched case-insensitively (the
   files are `DPH24.PDF` / `Davkyp9.pdf`).
4. With **`@cantoo/pdf-lib`**: `form = doc.getForm()`. For each pair, look up the field by
   its fully qualified name (fallback: the partial name). Then:
   * text field → `setText(value)`. Respect `maxLength` by truncating and logging.
   * checkbox → check it if the value is non-empty and not `0`/`N`/`Off` (or equals its
     export value);
   * radio group / dropdown → select the option whose export value equals the value;
   * an unknown field → log it (for a developer report), do not fail.
5. Appearances: embed **Liberation Sans** (Arial-metric, Latin-2) and call
   `form.updateFieldAppearances(font)` so that Czech characters render in every viewer.
   Also set `NeedAppearances`. **Do not flatten**: PDF1 is meant to be editable.
6. Save the filled form next to the data file as `<same dir>\<Sest>_vypl.PDF`. The
   original also wrote `.TXT`/`.XFDF` into `{PDF1}`, so the directory is writable, and
   Účto's own "do not write to `{PDF?}`" rule only applies to user-chosen targets. Also
   write the `.XFDF` for fidelity and debugging. Then `ctx.host.openPath(filled)`. Return
   0.

Still needed: **yes, high**: tax and insurance forms (DPH, vyúčtování, ELDP …) and the
PDF-open path for manuals and invoices. The template forms must be kept up to date by the
vendor, as before.

## Test approach

* Fixtures: `{PDF1}/DPH24.PDF` (copied from the pristine app into the test temp dir at
  runtime, not committed) plus a data file generated by running the report `Dph25Y` on
  `{prik}` in the engine, or a hand-written one with 10 fields including a checkbox and
  Czech text.
* Assert with `pdf-lib`: the reloaded form fields have the expected values, the checkbox
  is checked, and the appearance streams exist (`/AP`).
* A data line containing `"` → the parser does not crash and logs a data warning (the
  original returned 62).
* The `.PDF` argument → a single `openPath` call, and no file written.
* Snapshot of the generated XFDF (escaping of `&<>`).
