# DISKSIZE.EXE – drive capacity, free and used bytes, volume label (DOS)

`DISKSIZE.EXE` in the app root (4.3 KB, Borland Pascal DOS program; string `:\*.*` for the
volume-label search). The DOS variant of [DISKSIZW.EXE](disksizw.md).

Priority **low** (only floppies and pure DOS), effort **S**.

## How Účto calls it

Wrapper `UCTO2026_RDB/0488_P_DiskSize.txt` `proc DiskSize(Disk)`:

```
FILE.Path:='DISKSIZE.EXE'; …
with window(1,1,1,1) do exec('DISKSIZE.EXE','$ '+UCTOTXT.Path+' '+Disk,freemem,nocancel);
PARAM3.Ano:=exitcode=0;
case exitcode=0: begin s:=gettxt(UCTOTXT);
  PARAM3.F1:=val(copyline(s,1)); PARAM3.F2:=val(copyline(s,2)); PARAM3.F3:=val(copyline(s,3));
  PARAM3.AAA:=copyline(s,4); end;
  exitcode=2: message(' chyba DISKSIZE: nelze otevřít soubor pro zápis výsledku') …
```

| | |
|---|---|
| Args | `$ <result file> <letter>` (letter without colon) |
| Result | CP852: line 1 capacity bytes, line 2 free bytes, line 3 used bytes, line 4 volume label |
| Exit | 0 ok, 2 cannot write result, other = drive error (not ready) |

Callers: `0355_P_Disky.txt` "Volné místo na disku" when the drive is `A:`/`B:` (floppy) or WinVer
is `'D'`; `MODUL99_PRO/0180_P_ObsZalDisk.txt` "obsah záložní diskety" (reads line 3 as `df` and
line 4 as the label).

## What it does (inferred)

TP `DiskSize(n)`/`DiskFree(n)` + `FindFirst('X:\*.*', VolumeID)` for the label. Values are
limited to 2 GB (DOS), as Účto's own message says.

## Replacement design

`src/engine/helpers/dostools.ts`, key `disksize.exe`. Same `statfs` source as DISKSIZW but
output in **bytes** (integers) and line 4 = a label (the mapped drive's configured name or empty).
Floppy letters `A:`/`B:` are normally unmapped → exit 3 ("nelze zjistit"), which is the honest
answer on a modern PC.

## Test approach

Shared with DISKSIZW (stubbed statfs); check integer formatting and exit 3 for `A`.
