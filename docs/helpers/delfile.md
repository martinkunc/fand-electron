# DELFILE.EXE – delete all files (or all FAND data files) in a directory

`DELFILE.EXE` in the app root (3.9 KB, Borland Pascal DOS program). Used in every runtime except
vDos (vDos → [DELFILE2.EXE](delfile2.md)).

Priority **high** (backup rotation, DOSBox queue cleanup, restore), effort **S**.

## How Účto calls it

Wrapper `UCTO2026_RDB/0492_P_DelFiles.txt` `proc DelFiles(Adr,Maska)`:

```
PARAM3.Ano:=false;
if ^(Maska in~ ['v','u']) then begin message(' chyba DELFILE: nepovolená maska '+Maska); exit end;
if PARAM3.vDos then FILE.Path:=PROGRAM.Path+'{TISK}\DELFILE2.EXE' else FILE.Path:='DELFILE.EXE';
…
with window(1,1,1,1) do exec(FILE,'$ '+Adr+' '+Maska,freemem,nocancel);
…
end else if exitcode=0 then PARAM3.Ano:=true else begin
  proc(FileSize,(Adr+'\*.'+cond(Maska=~'u':'0??',else:'*')));
  if PARAM3.FFF=0 then PARAM3.Ano:=true;       { nothing left → treat as success }
end;
```

| | |
|---|---|
| Args | `$ <directory with trailing \> v|u` |
| Mask letter | `v` = všechny, all files `*.*`; `u` = Účto data files `*.0??` |
| Result | exit 0 = everything deleted; otherwise the wrapper checks with [FILESIZE](filesize.md) |

Call sites: `UCTO2026_RDB/0568_P_Program1.txt` (clear the DOSBox `{DBX2}` run queue at start,
DOSBox only), backup code (`DelFiles(zal3,'v')` ×5, `{ZAL1}`, `{ZAL3}` – empty the temporary
backup directories before/after packing), restore (`DelFiles(odkud,'u')`).

## What it does (inferred)

`FindFirst(dir+'*.*' or dir+'*.0??')` and `Erase` each file (probably clearing the read-only
attribute first, **unverified**). Subdirectories are not touched. Non-zero exit when a file
could not be deleted (locked/read-only).

FPC port equivalent: `FandDeleteFiles(Pattern)` in `FANDDOS.PAS`.

## Replacement design

`src/engine/helpers/dostools.ts`, key `delfile.exe`.

* Validate `args[0]==='$'`, `args[2]` in `v|u` (else exit 1).
* `dir = ctx.mapPath(args[1])`; pattern `*.*` or `*.0??` with DOS wildcard semantics
  (case-insensitive); delete regular files only (`rmSync` / `unlinkSync`), never recurse.
* Safety: refuse (exit 3, log) if `dir` resolves to the app root, the Účto data root or outside
  the mapped drives – the callers always pass a dedicated work directory; a bug in path mapping
  must not wipe user data. Refuse to touch the pristine install tree (`vendor/extracted`-like
  read-only roots).
* Exit 0 when everything matched was deleted, 2 otherwise.
* The engine must first close its own handles on those files (FAND's `close` precedes most calls;
  the port's file layer should release cached handles for the directory before deletion,
  like `CallCloseFandFiles` in FPC `OSshell`).

## Test approach

Temp dir with `A.000`, `B.001`, `C.TXT`, subdir: `u` deletes only the first two, `v` all three
files and not the subdir; guard cases (app root, unmapped path) return non-zero and delete
nothing; a locked/read-only file (chmod) → exit 2 and the wrapper's FILESIZE fallback.
