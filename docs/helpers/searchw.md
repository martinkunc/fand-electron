# SEARCHW.EXE – search drives for a file (Windows build for DOSBox/vDos)

`{tisk}\SEARCHW.EXE` (30 KB, native VB6, form `frmSearchW` with a `drvDrive` DriveListBox,
imports `GetShortPathNameA`, comment "Doplněk k programu účto."). Counterpart of
[SEARCHX.EXE](searchx.md).

Priority **low** (DOSBox/vDos only), effort **S** (alias).

## How Účto calls it

`UCTO2026_RDB/0490_P_Search.txt` when `DOSBox | vDos`:

```
proc(ExecWin,(pgm,'$ '+Parametry+' '+UCTOTXT.Path+' 2 N'));
proc(WaitFor,(UCTOTXT.Path,'SEARCHW.EXE'));
```

Same arguments as SEARCHX plus a 5th `N` (probably "no UI"/"do not show the window",
**unknown**). Exit code is not checked in this branch.

## What it does (inferred)

Iterates the drives of the DriveListBox, searches to the given depth and writes 8.3 paths
(`GetShortPathNameA`) one per line. The result must become non-empty for `WaitFor` to finish, so
it probably writes an empty line/marker when nothing is found (**unverified**).

## Replacement design

Alias of the SEARCHX handler (`searchw.exe`), ignoring the `N`. If nothing is found write a single
CRLF so `WaitFor` does not prompt (Účto then sees `length(s)>0` and stops after level 2 – same as
the original would with a marker line).

## Test approach

Alias test.
