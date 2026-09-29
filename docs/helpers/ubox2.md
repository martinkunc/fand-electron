# Ubox2.exe – .NET version of the DOSBox → Windows bridge

`{tisk}\Ubox2.exe` (174 KB, 2017). **.NET Framework 2.0** WinForms, assembly `Ubox`
1.0.0.3, "Doplněk k programu účto", © 2012 Tichý & spol. Decompiled source:
`work/decompiled/{tisk}_Ubox2/Ubox/{Program,MainForm}.cs`. It does the same job as
[UBOX.exe](ubox.md), but event-driven (`FileSystemWatcher`) instead of polling.

## How Účto invokes it

**Nothing references it.** No chapter, BAT or FAND.CFG string mentions `ubox2`:
`U64.BAT`/`U8.BAT` start `{tisk}\ubox`, which resolves to `UBOX.exe`. It is shipped
as an alternative that support can swap in by editing the BAT. Its contract is the same
as UBOX's:

```
Ubox2.exe $ <scannedFolder> <scanWait ms> <deleteTimeOut ms> <printApplication>
```

## What it does (decompiled C#)

* `Main`: exactly 5 args, and `args[0]=="$"`. Otherwise it shows a MessageBox "Chybný
  počet parametrů." or "Chybný vstupní parametr." (both "Aplikace bude ukončena.") and
  exits. `scanWait` and `deleteTimeOut` are parsed with default 1000. An empty
  `printApplication` defaults to `UTISK04.EXE`. (The two timeouts are stored but never
  used.)
* `MainForm`: a minimized, tray-only form (NotifyIcon "Doplněk Účta", 95 % opacity) with a
  history list box. `FileSystemWatcher` on the folder, filter `*.*`, `Created` events
  only:
  * a name containing `.BAT` (case-insensitive) → `Process.Start(fullPath)` with a hidden
    window;
  * a name containing `.PRN` → `Process.Start(StartupPath\printApplication, "$ " +
    folder + "\" + name)`. The file is not renamed, and the helper deletes it;
  * a name equal to `STOP` → `DeleteFiles(folder)` (retrying after 2 s on a sharing
    error that mentions STOP), then `Application.Exit()`.
  * Exceptions → MessageBox "Chyba:\n…" titled "Doplněk účta", and an append to
    `<StartupPath>\Log.txt` in the form `DateTime.Now | message | stack`.

## Replacement design

**Obsolete, do not port.** The DOSBox indirection disappears in our runtime (see
[ubox.md](ubox.md)). Register `ubox2.exe` as a no-op returning 0.

Priority **low**, effort **S**.

## Test approach

* Registry test only (`ubox2.exe` → no-op, returns 0).
