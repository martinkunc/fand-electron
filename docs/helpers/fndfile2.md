# FNDFILE2.EXE – list files matching a mask (Windows build for vDos)

`{tisk}\FNDFILE2.EXE` (31 KB, native VB6, product "FNDFILE.EXE", form `frmMAIN` "FIND FILES",
imports `GetShortPathNameA`). The Windows counterpart of [FNDFILES.EXE](fndfiles.md), used only
when Účto runs under vDos (`PARAM3.vDos`, env `VDOSP_CONFIG` set).

Priority **low** (not reached in our runtime), effort **S** (alias).

## How Účto calls it

`UCTO2026_RDB/0491_P_FindFiles.txt`: same `$ <mask> <result>` arguments as FNDFILES, then
`WaitFor(UCTOTXT.Path,'FNDFILE2.EXE')` because a Windows exe started from vDos does not block.
The result file is emptied first (`puttxt(UCTOTXT,'')`).

## What it does (inferred)

Enumerates the mask, writes 8.3 names (hence `GetShortPathNameA`) one per line, CP1250/ASCII.

## Replacement design

Alias of the FNDFILES handler (`fndfile2.exe` key). Our runtime does not set `VDOSP_CONFIG`,
so this path is only exercised if someone forces vDos mode; the synchronous helper writes the
result before `WaitFor` looks at it, so `WaitFor` returns immediately. Note: `WaitFor` loops
while the result is empty – for "no files" it would ask "Účto čeká na výsledek programu …";
the original had the same behaviour.

## Test approach

Alias test.
