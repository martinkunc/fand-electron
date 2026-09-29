# DELFILE2.EXE – delete files (Windows build for vDos)

`{tisk}\DELFILE2.EXE` (27 KB, native VB6, description "Maže vybrané soubory.", comment "Určeno k
programu účto."). The vDos counterpart of [DELFILE.EXE](delfile.md).

Priority **low** (vDos only), effort **S** (alias + status file).

## How Účto calls it

`UCTO2026_RDB/0492_P_DelFiles.txt` when `PARAM3.vDos`:

```
FILE.Path:=PROGRAM.Path+'{TISK}\DELFILE2.EXE';
KAM.Path:=replace('.EXE',FILE.Path,'.UUU'); puttxt(KAM,'');          { {TISK}\DELFILE2.UUU }
with window(1,1,1,1) do exec(FILE,'$ '+Adr+' '+Maska,freemem,nocancel);
proc(WaitFor,(KAM.Path,'DELFILE2.EXE'));
s:=gettxt(KAM); PARAM3.Ano:=copy(s,1,1)='0';
```

| | |
|---|---|
| Args | `$ <dir\> v|u` as DELFILE |
| Status | `{TISK}\DELFILE2.UUU` (next to the exe, string `\DELFILE2.UUU` in the binary): first character `0` = success, anything else = failure |

## What it does (inferred)

Deletes `*.*` (`v`) or `*.0??` (`u`) in the directory and writes a result code into
`DELFILE2.UUU`.

## Replacement design

Same handler as DELFILE (`delfile2.exe` key) plus: write `0\r\n` (or `1\r\n`) to
`<dir of the exe>\DELFILE2.UUU` – the status file must be non-empty or `WaitFor` keeps asking.
Only relevant if vDos mode is ever emulated.

## Test approach

Alias test + status file content for success and failure.
