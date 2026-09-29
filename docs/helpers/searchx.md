# SEARCHX.EXE – search a drive for a file name (depth-limited)

`SEARCHX.EXE` in the app root (4.8 KB, Borland Pascal DOS program). Used unless running under
DOSBox/vDos (then [SEARCHW.EXE](searchw.md)).

Priority **medium** (upgrade: locating last year's installation), effort **S**.

## How Účto calls it

Wrapper `UCTO2026_RDB/0490_P_Search.txt` `proc Search(Parametry)`:

```
puttxt(UCTOTXT,''); db:=PARAM3.DOSBox | PARAM3.vDos;
pgm:=cond(db:PROGRAM.Path+'{TISK}\SEARCHW.EXE',else:'SEARCHX.EXE');
s:=' Program hledá na disku '+Parametry+' (úroveň 2)';
… exec(FILE,'$ '+Parametry+' '+UCTOTXT.Path+' 2',freemem,nocancel);
if ^db & ^(exitcode in [0,3]) then message(' chyba SEARCHX: exitcode ',str(exitcode,'0'));
s:=gettxt(UCTOTXT); if length(s)>0 then exit;
… same with level 3 …
```

| | |
|---|---|
| Args | `$ <file name> <result file> <level>`; name without path (e.g. `UCTO2025.RDB`), level 2 then 3 |
| Result | full paths of the found files, one per line (CP852, CRLF) |
| Exit | 0 found / done, 3 = nothing found (inference), others = error |

Callers:
* `UPG_PRO` upgrade – `proc(Search,(RdbOld))` "Čekejte prosím, prohledání velkého disku může trvat
  několik minut", then the user picks the directory of the previous year's Účto
  ("HLEDÁNÍ ADRESÁŘE S VERZÍ …").
* `UCTO2026_RDB/0361_P_SysInfo.txt` – *Soubory na disku → Hledat soubor na disku*: prompts a name,
  shows the result list, then the size of the chosen file.

## What it does (inferred)

Recursive `FindFirst` from the root of the **current drive** down to `level` directory levels,
collecting paths whose name matches (wildcards allowed). FPC equivalent:
`FandSearchDown(Dir,Mask,Depth)` in `FANDDOS.PAS`.

## Replacement design

`src/engine/helpers/dostools.ts`, key `searchx.exe` (and `searchw.exe`).

* Search roots: every mapped DOS drive root (normally `C:` = Účto root's parent mapping); do
  **not** walk the host filesystem outside the mappings.
* Additionally, for the upgrade use case, search the known places where a previous Účto may
  exist on the host (configured "legacy installations" list, e.g. `~/UCTO2025`, a mounted
  Windows partition) and return them as mapped paths when a mapping exists.
* Depth = `level` directories below the root, DOS wildcard, case-insensitive; skip unreadable
  dirs silently; hard limit (e.g. 20 000 entries / 5 s) to keep the engine responsive.
* Write matches as DOS paths (`ctx.unmapPath`), CP852, CRLF; exit 0 if any, 3 if none.

## Test approach

Temp tree `root/A/B/C/UCTO2025.RDB` → found at level 3 only; mixed case; exit 3 when absent;
entry limit respected.
