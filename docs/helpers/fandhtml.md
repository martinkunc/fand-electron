# FANDHTML.EXE – convert a FAND print text to HTML

`FANDHTML.EXE` in the app root (9.7 KB, Borland Pascal 7 DOS program, partly assembler).
Embedded HTML fragments (all strings of the binary that are not runtime):

```
<html>
<meta http-equiv="Content-Type" content="text/html; charset=windows-1250"><style>@media print{div{page-break-after: always}}</style>
<body style="margin: 2mm 0 1mm 0; font-family:'Courier New CE', 'Courier New'; font-size: 12pt; line-height: <n>pt">
<pre>
…
</pre>
</body>
</html>
<span style="font-size: <n>…">…</span>
<b>…</b>        <i>…</i>        <span style="text-decoration: underline">…</span>
<div>&nbsp;</div>
```

Priority **medium** (HTML export and the `.HTM` e-mail attachment), effort **M**.

## How Účto calls it

Path: `FANDHTML.Path:=pgm+'FANDHTML.EXE'` (`UCTO2026_RDB/0556_P_KatalogG.txt`, `pgm` = app root).

1. `UCTO2026_RDB/0181_P_FandHtml.txt` `FandHtml(Soubor)` – text viewer F10 menu, conversion submenu item
   *"HTM - internet"* (`MODUL01_PRO/0002_P_TxtExit.txt`):

   ```
   proc(Paths,('Html','HTM')); html:=PARAM3.TrailAAA;               { user picks the target .HTM }
   FILE.Path:=Soubor; copyfile(FILE/TXT,UCTOTXT,nocancel);           { report text → work copy }
   with window(1,1,1,1) do exec(FANDHTML,'$ '+UCTOTXT.Path+' '+html+' 95',freemem,nocancel);
   if exitcode=0 then if PARAM3.Msie then proc(CallAssoc,(html)) else proc(Hlaseni,('Vytvořen soubor '+html))
   else proc(Hlaseni,('Chyba '+str(exitcode,0,0)+' při otevření souboru'));
   ```
   With `PARAM3.Msie` (default true) the result is opened in the browser via
   [CALLASOC](callasoc.md).

2. `UCTO2026_RDB/0183_P_FandMail.txt` – e-mail attachment `ADR03+'UEMAIL.HTM'`, same arguments
   (see [uemail17.md](uemail17.md)).

| | |
|---|---|
| Args | `$ <source text> <target .htm> 95` – the third number is unknown (likely a line-height or zoom percentage used in `line-height: …pt`) |
| Input | FAND print text, CP852, CRLF, with FAND printer control characters |
| Output | HTML, **windows-1250**, whole text in one `<pre>` |
| Exit | 0 ok, ≠0 error (cannot open source/target) |

## What it does (inferred from strings + FAND text conventions)

FAND report texts use toggle control characters (names from `fandcfg/FANDINST.PAS` `pNames`):
`^S` 0x13 underline, `^W` 0x17 italic, `^Q` 0x11 wide, `^D` 0x04 double-strike, `^B` 0x02 bold,
`^E` 0x05 compressed, `^A` 0x01 elite, `^X`/`^V`/`^T` user codes, `^L` 0x0C form feed. FANDHTML:

* converts CP852 → CP1250, escapes `<`, `>`, `&` (**assumed**);
* `^B`, `^D` → `<b>…</b>`; `^W` → `<i>…</i>`; `^S` → underline span; `^E`/`^A`/`^Q` →
  `<span style="font-size: …">` (smaller / larger); user codes dropped;
* `^L` → close the page and emit `<div>&nbsp;</div>` (the `@media print` rule turns it into a
  page break);
* box-drawing characters of CP852 have no CP1250 equivalent – probably replaced by `-`, `|`,
  `+` (**unverified**).

The exact tag nesting and the numeric font sizes need a reference output from the real program
(run it once under DOS/vDos on a fixture, store as golden file). Until then implement the
mapping above.

## Replacement design

`src/engine/helpers/fandtext.ts` (shared tokenizer for FAND print text: runs of text + toggle
events + form feeds; also used by TXTNARTF, FANDT602, SUDLICH, VYBERTXT and the PDF path),
key `fandhtml.exe`.

* Output **UTF-8** HTML with `<meta charset="utf-8">` instead of windows-1250: box-drawing
  characters then render correctly (CP852 → Unicode via `cp852.ts`). Browsers and mail clients
  handle UTF-8; nothing in Účto reads the file back.
* Same skeleton, CSS and tag mapping as above, font `'Courier New', 'DejaVu Sans Mono', monospace`
  so frames align.
* Close open tags at line/page end and reopen after, so the HTML stays well-formed.
* Exit 0; 1 if the source cannot be read; 2 if the target cannot be written.

## Test approach

Fixtures: a report text with every control code, box drawing, `<&>`, several `^L` pages (take
real outputs from the engine's report runner, e.g. "Deník" and "Faktura"). Snapshot the HTML;
parse with `fast-xml-parser`/`parse5` to assert well-formedness and tag counts; optional golden
comparison once a reference output of the original exists.
