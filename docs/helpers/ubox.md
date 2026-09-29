# UBOX.exe – DOSBox → Windows bridge ("Volání programů z DOSBOX")

`{tisk}\UBOX.exe` (38 KB, 2013). It is a **native VB6** tray/background app, version 1.00,
comment "Volání programů z DOSBOX". It exists only for the **DOSBox** variant of Účto
(64-bit Windows): a DOS program in DOSBox cannot start Windows programs, so Účto drops
request files into a shared directory and UBOX runs them on the host.
[Ubox2.exe](ubox2.md) is the .NET 2.0 rewrite of the same thing.

## How Účto invokes it

The DOSBox launchers `U64.BAT` and `U8.BAT` (app root) start it before DOSBox:

```bat
call {dbx1}\setdisk.bat
if exist {dbx2}\stop del {dbx2}\stop
{tisk}\caller {tisk}\ubox $ {dbx2} 1000 500 utisk04.exe
{dbx1}\disxbut.exe $          (U8.BAT: disxbut8.exe)
```

Arguments: `$` (guard), the **watched folder** `{dbx2}`, the **scan interval** 1000 ms,
**500** (in Ubox2 this is the "delete timeout"; UBOX most likely uses it the same way), and
the **print program** `utisk04.exe`, resolved relative to UBOX's own directory.

Inside DOSBox (`PARAM3.DOSBox` = env `uctodbox=on`), Účto talks to it through files in
`ADR03.Path+'{DBX2}'`:

| Request | Written by | Content |
|---|---|---|
| `RUNnnn.BAT` | `ExecWin` (`UCTO2026_RDB/0498_P_ExecWin.txt`) for **every** Windows helper call | `@<program> <params>`, with the path mapped by `XPath` (DOSBox drive → host path); `nnn` = `PARAM3.DbRunNo`, 001..999 wrapping |
| `printN.prn` | FAND itself, as the DOSBox FAND.CFG printer (`{dbx1}\FAND.CFG`: `DOSBox`, TmOut 253, [15] `{dbx2}\print#.prn`, [16] `nic.exe`) | the raw print job (see [print-spool.md](print-spool.md)) |
| `STOP` | `PgmEnd` (`0569_P_PgmEnd.txt`) and `CancelUpg` on exit | a timestamp |

```
ExecWin:  if PARAM3.DOSBox then begin ... run:='@'+XPath(WinPgm+cond(WinPgm<>'':' ')+Parametry);
            FILE.Path:=ADR03.Path+'{DBX1}\DBX2.LOG'; puttxt(FILE,strdate(...)+' '+run+'\13\10',append);
            FILE.Path:=ADR03.Path+'{DBX2}\RUN'+str(PARAM3.DbRunNo,'000')+'.BAT'; PARAM3.DbRunNo+=1; ...
            puttxt(FILE,run);
          end else begin EXE.Path:=WinPgm; with window(1,1,1,1,@) do exec(EXE,Parametry,nocancel); end;
```

At startup (`Program1`) Účto creates `{DBX2}`, deletes its contents, resets `DbRunNo` and
logs `start` to `{DBX1}\DBX2.LOG`. "Ostatní → DOSBox → Programy volané z DOSBoxu"
(`ConfigDB`) shows that log. Because the call is asynchronous, `PARAM3.SyncW`
(= `DOSBox | vDos`) makes callers poll for result files with `WaitFor`.

## What it does (strings, plus the Ubox2 source as a guide)

UTF-16 literals: `STOP`, `\*.PRN`, `PRN: `, `.PRN`, `.PR$`, ` $ `, `\*.BAT`, `BAT: `,
`open`, `DIR: `, `START: `, `hh:mm`, and "Ukončit program? Některé úlohy v účtu pak
nebudou možné. (Například tisk.)" (the confirmation when the user closes it).

* A timer (the interval argument) scans the folder:
  * `*.PRN` → rename to `.PR$` (so it is not picked up twice), then run
    `<exeDir>\<print program> $ <folder>\<name>`, i.e. `utisk04.exe $ {dbx2}\print3.PR$`
    (the renamed name is inferred).
  * `*.BAT` → `ShellExecute("open", file)` (hidden). The batch contains the helper command
    line.
  * `STOP` → delete the folder contents and exit.
* It keeps a small history list (`PRN: …`, `BAT: …`, `START: hh:mm`) in its window.

## Replacement design

**Obsolete, do not port.** Our engine *is* the host process: `PARAM3.DOSBox` is never
true (we do not set `uctodbox`), so `ExecWin` takes the direct `exec(EXE,…)` branch, and
the EXEC layer dispatches to the in-process helpers synchronously. No `{dbx2}`, no
`RUNnnn.BAT`, no polling.

Needed only as stubs:

* Register `ubox.exe` as a **no-op returning 0**, in case something tries to start it (for
  example a user running `U64.BAT` logic).
* Register `nic.exe` (the DOSBox FAND.CFG print program) as a no-op returning 0.
* The engine should **not** read `{dbx1}\FAND.CFG`. Use the root `FAND.CFG` (printer
  `Windows3`).

If DOSBox-compatible data ever matters (a user copies a DOSBox install), the only thing to
honour is the FAND.CFG printer: a ToMgr printer with program `nic.exe` must be remapped
to the `utisk04` helper, or it will never print. Handle this in the ToMgr dispatcher:
program `nic.exe` → `utisk04`.

Priority **low**, effort **S**.

## Test approach

* Registry test: `ubox.exe`, `ubox2.exe` and `nic.exe` resolve to no-ops that return 0.
* Engine test: a ToMgr printer whose [16] is `nic.exe` (load `{dbx1}/FAND.CFG` in a temp
  copy) still produces a `utisk04` invocation with the spool path.
* Regression: with the default environment, `PARAM3.DOSBox` stays false after `Program1`,
  and no `{DBX2}` directory is created in the temp app copy.
