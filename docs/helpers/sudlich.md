# SUDLICH.EXE – extract odd or even pages of a print text

`SUDLICH.EXE` in the app root (4.7 KB, Borland Pascal DOS program; *sudé/liché* = even/odd).

Priority **medium** (duplex printing on simplex printers), effort **S**.

## How Účto calls it

Path `SUDLICH.Path:=pgm+'SUDLICH.EXE'`. `UCTO2026_RDB/0178_P_TiskSudLich.txt`
`TiskSudLich(Path,Lich)`, from the print menu of the text viewer (`UCTO2026_RDB/0171_P_TxtExitT.txt`:
*"Liché strany"*, *"Sudé strany"*):

```
proc(Dotaz,(true,'Vytisknout '+ls+' strany textu'));
s:=' Program vybírá pro tisk '+ls+' strany';
with window(1,1,1,1) do exec(SUDLICH,'$ '+Path+' '+UCTOTXT5.Path+' '+cond(Lich:'1',else:'2'), freemem,nocancel);
if exitcode=0 then begin edittxt(UCTOTXT5, head=TxtHead(Path), …, ww=(…,=ls+' strany',^A), exit=(AltF7,F10:TxtExit(UCTOTXT5.Path))) …
```

The user then prints the shown text with F6.

| | |
|---|---|
| Args | `$ <source> <target> 1|2` – `1` odd (liché), `2` even (sudé) |
| Input/Output | FAND print text, CP852, pages separated by form feed `^L` (0x0C) |

## What it does (inferred)

Splits the source into pages at `^L` and writes pages 1,3,5… or 2,4,6…, keeping the `^L`
separators (and the control codes) intact. Likely also counts lines when pages are not
form-feed separated (FAND inserts `^L` at `.pagelimit` in reports, so form feeds are the rule).

## Replacement design

Key `sudlich.exe` in `src/engine/helpers/fandtext.ts`: byte-level split on 0x0C (no decoding
needed), select by parity, join with `\x0C`; if the source has no FF, treat it as one page. For an
even selection of a document with an odd page count, append an empty page? – **no**, keep the
original semantics (only existing pages). Exit 0; 1/2 for read/write errors.

## Test approach

Byte fixtures with 1, 2, 5 pages (with/without trailing FF) → expected page sets; control codes
preserved byte-exact.
