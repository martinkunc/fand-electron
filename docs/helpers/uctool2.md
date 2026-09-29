# UCTOOL2.EXE – update check, .NET 2.0 variant (`PARAM3.UOL='2'`)

`{tisk}\UCTOOL2.EXE` (23 KB, VB.NET, .NET Framework 2.0 WinExe without a window, assembly
`UCTOOL2` 1.0.0.0, "Určeno pro program účto", © 2019 Tichý & spol.). It does the same job
as `Uctool3.exe`: it downloads one URL to a file for `UctoOL`'s update check, then sends
the usage ping. It is the choice for machines without .NET 4.
Decompiled source: `work/decompiled/{tisk}_UCTOOL2/UCTOOL2/UctoOL2.cs`.

## How Účto calls it

Identical to Uctool3; see **uctool3.md**. It is selected when `PARAM3.UOL='2'`
("Automatické aktualizace: verze programu UCTOOL 1-UCTOOL, 2-UCTOOL2, 3-UCTOOL3",
`UCTO2026_RDB/0034_E_ParPgmUol.txt`). The call is `ExecWin('{TISK}\UCTOOL2.EXE',
'$ '+UCTOTXT.Path)` from `MODUL01_PRO/0598_P_UctoOL.txt`, followed by
`WaitFor(result,'UCTOOL.EXE')` in DOSBox/vDos mode.

## What it does (decompiled VB.NET)

1. `args[1]` must be `"$"`; otherwise it returns silently **without writing anything**.
   Účto would then time out in `WaitFor`, or read a stale or empty file, which becomes the
   "Nepodařilo se navázat spojení" box.
2. It reads `args[2]` as **windows-1250** (`My.Computer.FileSystem.ReadAllText`) and
   splits on `"\r"` only: `[0]` URL, `[1]` result file, `[2]` info with `"` removed.
   With the 2-line parameter file of the news download (`zpravy.uuu`), `[2]` throws
   `IndexOutOfRange`. That happens *after* `[1]` is known, so the result is `0` and the
   news are never downloaded with UCTOOL2. This is inferred from the code and assumes FAND
   `puttxt` adds no trailing CR.
3. `My.Computer.Network.IsAvailable`, else output `0`.
4. `WebRequest` GET, 10 s timeout. On 200, the body bytes go to the result file
   (`WriteAllBytes`, overwrite). Exceptions (e.g. 404 → WebException) give output `0`
   (the single byte `0x30`).
5. If the info is non-empty: `GET http://www.ucto2000.cz/PHPPGM/SLEDOVANI/infouser.php?info=<info>`
   (unencoded, 10 s). Errors are swallowed, so unlike Uctool3 the result stays intact.
6. `WriteOutput` runs in `finally`: the result file is always written (except in step 1).
   No log file. The exit code is 0.

## Replacement design

The same module as Uctool3: `src/engine/helpers/uctool.ts`, registered as `uctool2.exe`.
Behaviour differences are **not** reproduced. The shared implementation handles 2- and
3-line parameter files and never lets the ping affect the result, which strictly improves
on all three originals. A wrong first argument writes `0` instead of nothing, so Účto
does not hang in `WaitFor`.

Priority: covered by uctool3 (medium, S). The separate key exists only because users may
have `UOL='2'` stored in `PARAM3`.

## Test approach

Shared with uctool3.md. Add one case: `PARAM3.UOL='2'` makes the engine call
`uctool2.exe`, and the flow works end to end with mocked fetch.
