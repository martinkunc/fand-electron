# UCTOFTP2.EXE – update downloader, VB.NET variant

`{tisk}\UCTOFTP2.EXE` (23 KB, VB.NET WinForms, `UCTOFTP2.UCTOFTP` form). Used when
`PARAM3.UOL='2'`. Decompiled source: `work/decompiled/{tisk}_UCTOFTP2/UCTOFTP2/UCTOFTP.cs`.

Priority **low**, effort **S** (shares the [UctoFtp3](uctoftp3.md) handler).

## How Účto calls it

Exactly like [UctoFtp3](uctoftp3.md) (`MODUL01_PRO/0599_P_UctoFtp.txt`): `exec(FILE,'FTPyy/ <size>')`;
exit code 1 → Účto closes itself.

## What it does (decompiled)

* Window "PŘÍPRAVA AKTUALIZACE PROGRAMU ÚČTO", label "Stahuji aktualizační program: N%".
* URL `http://www.ucto2000.cz/DOWNLOAD/` + `args[1]` + `aktftp.exe` (note: `GetCommandLineArgs`,
  so `[1]` is the first real argument); `downloadSize=int(args[2])` is used only for the
  percentage.
* Downloads into memory (4 KB reads), deletes an old `{wwww}\aktftp.exe` (relative to the
  **current directory**, not the exe dir – works because Účto runs with cwd = app root), writes
  the bytes, `Process.Start("{wwww}\aktftp.exe")`, `Environment.ExitCode=1`.
* Any error: MsgBox "Aktualizaci se nepodařilo stáhnout, zkuste to znovu později." (caption
  "HLÁŠENÍ PROGRAMU UCTOFTP2..."), exit code 0. A non-200 status silently produces an **empty**
  file which is then started (bug).

## Replacement design

Same handler and policy as [uctoftp3.md](uctoftp3.md): no download of the Windows installer, tell
the user how updates work in this edition, return 0.

## Test approach

Registry/alias test plus the shared UctoFtp3 tests.
