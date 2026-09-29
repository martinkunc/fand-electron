# FNDFILES.EXE – list file names matching a mask

`FNDFILES.EXE` in the app root (3.3 KB, Borland Pascal DOS program). Used in every runtime
except vDos (vDos uses [FNDFILE2.EXE](fndfile2.md)).

Priority **high** (backup/restore, bank statement import, palettes), effort **S**.

## How Účto calls it

Wrapper `UCTO2026_RDB/0491_P_FindFiles.txt` `proc FindFiles(Maska)`:

```
puttxt(UCTOTXT,'');
FILE.Path:=cond(PARAM3.vDos:PROGRAM.Path+'{TISK}\FNDFILE2.EXE', else:'FNDFILES.EXE');
…
with window(1,1,1,1) do exec(FILE,'$ '+Maska+' '+UCTOTXT.Path,freemem,nocancel);
if PARAM3.vDos then proc(WaitFor,(UCTOTXT.Path,'FNDFILE2.EXE'));
case exitcode=1: message(' chyba FNDFILES: špatné parametry při volání programu');
     exitcode=2: begin message(' chyba FNDFILES: nelze otevřít soubor pro zápis výsledků hledání'); … end;
```

| | |
|---|---|
| Args | `$ <mask> <result file>` (note: mask first, unlike [FILESIZE](filesize.md)) |
| Result | CP852, one **file name without path** per line, CRLF after each line (callers loop `1..linecnt(s)-1` and treat `length(s)<2` as "no files") |
| Exit | 0 ok, 1 bad arguments, 2 cannot write the result |

Call sites (≈15): backup and restore (`odkud+'*.0??'`, `zal3+'*.0??'`, `{ZAL2}\*.<rok>?T`,
`Adr+'*'+příp` hromadná záloha), directory listing reports (`Adresář+'*.*'`), bank statement
import (`Maska1`, `Maska2` in `MODUL08_PRO`), colour palettes (`'*.PAL'`, relative to cwd).

## What it does (inferred)

`FindFirst(mask, files)` loop writing `SearchRec.Name` (upper-case 8.3 names from DOS). Order =
directory order (DOS). The FPC port equivalent is `FandListFiles(Pattern,false,false)` in
`FANDDOS.PAS`, which **sorts** case-insensitively; sorting is harmless for all callers.

## Replacement design

`src/engine/helpers/dostools.ts`, key `fndfiles.exe` (and `fndfile2.exe`, see there).

* Args after `$`: `mask`, `out`. `mask` is a DOS path + wildcard → `ctx.mapPath(dir)`.
* List regular files matching the 8.3 wildcard case-insensitively; write each name as the
  engine presents it to FAND (the file-name mapping used by the engine's FAND file layer, i.e.
  upper-case DOS name for files that have one), sorted, each followed by CRLF; CP852.
* Exit 2 when `out` cannot be written; 1 when the argument count is wrong; else 0.
* Long host names that do not fit 8.3 are skipped or mapped the same way the engine's
  directory layer maps them (single rule for the whole engine).

## Test approach

Fixture directory with `FIRMA.000`, `FIRMA.001`, `X.TXT`, `lower.000`, a subdirectory: masks
`*.0??`, `*.*`, `*.PAL` relative to cwd; check names, CRLF terminator, empty result, exit codes.
