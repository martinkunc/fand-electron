# FILESIZE.EXE – total size and newest timestamp of files matching a mask

`FILESIZE.EXE` in the app root (4.6 KB, Turbo/Borland Pascal 7 DOS program, no text
strings). Behaviour inferred from the only wrapper and its many callers.

Priority **high** (data-size and backup checks all over Účto), effort **S**.

## How Účto calls it

Wrapper `UCTO2026_RDB/0487_P_FileSize.txt` `proc FileSize(Parametry)`:

```
PARAM3.FFF:=-2; FILE.Path:='FILESIZE.EXE';
if filesize(FILE)=-1 then begin proc(Hlaseni,('Program '+FILE.Path+' neexistuje')); exit; end;
with window(1,1,1,1) do exec('FILESIZE.EXE','$ '+UCTOTXT.Path+' '+Parametry,freemem,nocancel);
case exitcode=0: begin s:=gettxt(UCTOTXT);
       PARAM3.FFF:=val(copyline(s,1)); if PARAM3.FFF=-1 then PARAM3.FFF:=0;
       PARAM3.DDD:=valdate(copyline(s,2),'DD.MM.YYYY hh:mm'); end;
     exitcode=1: begin message(' chyba FILESIZE: nelze otevřít soubor pro zápis výsledku'); … end;
end;
```

| | |
|---|---|
| Args | `$ <result file> <mask>`; mask e.g. `C:\UCTO2026\{DATA}\*.*`, `…\{ZAL3}\*.*`, `…\*.0??`, or a single file |
| Working dir | app root (relative exe name) |
| Result file | `UCTOTXT` (CP852, CRLF): line 1 = total bytes of matching files, `-1` when nothing matches; line 2 = newest modification time `DD.MM.YYYY hh:mm` |
| Exit | 0 ok, 1 cannot write the result file |

About 15 call sites, e.g. `InfoPC`/SysInfo "Informace o datech" (`ADR02.Path+'*.*'`), backup
(`zal3+'*.*'`, `{ZAL1}`, `{ZAL3}`), [SUBDIR](subdir.md) check (size of every firm directory),
[DelFiles](delfile.md) fallback (`Adr+'\*.0??'`), upgrade (`UPG_PRO/0023_P_UpgradeL1.txt`).

## What it does (inferred)

`FindFirst/FindNext(mask, files only)`: sum of sizes, max of the DOS timestamp; writes the two
lines. `-1` for no match (the wrapper maps it to 0). Hidden/system files and directories are
presumably excluded (TP `AnyFile - Directory - VolumeID`, **unverified**).

The FPC port already has this exact logic: `FandTotalSize(Pattern,Total,Newest)` + `FandStamp`
in `vendor/reference/standa_pcfand/pas/FANDDOS.PAS` (stamp format `DD.MM.YYYY hh:mm`).

## Replacement design

`src/engine/helpers/dostools.ts`, key `filesize.exe` (one module for all small Účto DOS
utilities, sharing mask matching and path mapping with the DOS shell port, see
[bat-files.md](bat-files.md)).

* Args: drop the leading `$`; `out = ctx.mapPath(args[0])`, `mask = args[1]`.
* Split the mask into directory + DOS wildcard (`*`, `?`, 8.3 semantics: `*.*` matches names
  without extension, `*.0??` matches `.0`, `.00`, `.000`). Case-insensitive match on the host
  listing (`readdirSync(dir, {withFileTypes:true})`, files only).
* Write `String(total)` or `-1`, CRLF, `DD.MM.YYYY hh:mm` of the newest `mtime` in local time
  (empty line when nothing matches), CRLF. ASCII only.
* Exit 1 if the result cannot be written, otherwise 0.

## Test approach

Temp dir fixtures: several files with set `utimes` → sum and newest stamp; `*.0??` vs `*.*`
vs a single file; no match → `-1`; mixed-case host names; read-only result dir → exit 1. Compare
with `FandTotalSize` semantics.
