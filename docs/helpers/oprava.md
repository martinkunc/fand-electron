# Oprava.exe – "Obnova účta do výchozího nastavení" (download and re-run the installer)

`{tisk}\Oprava.exe` (25 KB, .NET console exe, assembly `UctRecov` 0.0.0.4, "Obnova účta
to výchozího nastavení", © 2019 Martin Zemek). It is a **repair launcher**. It finds out
which Účto year is installed, downloads the current full Windows installer from
www.ucto2000.cz, and runs it in repair mode on the installation directory, so the program
files are reinstalled and the data stays.
Decompiled source: `work/decompiled/{tisk}_Oprava/UctRecov/` (`Program.cs`, `Settings.cs`,
`DownloadService.cs`, `ProcessService.cs`, `TextUi.cs`; `Test01.cs` and `PuvodniVolani()`
are the old unused implementation).

## How Účto calls it

**Účto never calls it.** Neither the decoded chapters, the `.BAT` files nor `FAND.CFG`
reference it. The user starts it by hand from Explorer while Účto is **not running**,
following the help texts:

* `HELP.T00`, topic "HLÁŠENÍ: ÚLOHA MODUL??.PRO NENÍ ODLADĚNA" (a damaged
  `MODUL??.PRO/.TRO`): "(1) Ukončete program ÚČTO. (2) … podadresář {TISK}, kde poklepáním
  spusťte soubor oprava.exe. (3) Proveďte instalaci Účta. (4) Po spuštění Účta budete ve
  firmě Stehlík, podadresář {PRIK} …"
* `TIPY.T00` (Údržba souborů): "…nelze spustit, pak při vypnutém účtu spusťte soubor
  OPRAVA.EXE z adresáře {TISK}, implicitně C:\UCTO20XX\{TISK}. Programové soubory účta se
  přeinstalují, účetní data zůstanou beze změny!"

| | |
|---|---|
| Command line | none. Any single argument switches to "mock mode" (`!!! POZOR MOCKOVACI MOD !!!`, pretends to run from `C:\UCTO2025\{TISK}\neco.exe`) |
| Working dir | irrelevant; paths come from the exe location |
| Files | reads `..\*.cat` (or `..\{OBNV}\*.cat`); writes `{TISK}\{WWWW}\ucto<YYYY>_<NN>.exe` |
| Exit code | −1 on errors, after "Stiskněte klávesu <<ENTER>>" |

## What it does (decompiled C#)

1. A console banner: "Obnova účta do výchozího nastavení / Verze: 0.0.0.4".
2. `Settings.GetUctoVersion`: `UctoDir` = the parent of the exe dir, i.e. the Účto root.
   It takes the last `*.cat` file whose name contains `UCTO` (e.g. `UCTO2026.CAT` →
   `UCTO2026`). If there is none, it looks in `{OBNV}\*.cat`, the backup copy made by
   `{OBNV}.BAT`. If still nothing: "Nepodařilo se zjistit verzi účta, aplikace bude
   ukončena". The year is the last 4 characters (`2026`).
3. `GetVersionPrefix`: `GET http://www.ucto2000.cz/DOWNLOAD/FTP<YY>/verzewww.uuu` and take
   the first 2 characters, trimmed. The file currently holds `14 7598080 17.09.2026\r\n0
   10.1.2025`, so the prefix is `14`. Download errors → "Chyba: …" and exit −1.
4. The installer URL is `http://www.ucto2000.cz/DOWNLOAD/ucto<YYYY>_<NN>.exe`
   (verified: `ucto2026_14.exe`, HTTP 200, ~41.7 MB). If a `HEAD` request fails, it tries
   `http://www.ucto2000.cz/ARCHIV/DOWNLOAD/<YYYY>/ucto<YYYY>_<NN>.exe`. If both fail:
   "Internetová aresa není dostupná, aplikace bude ukončena".
5. It downloads with `WebClient.DownloadFileAsync` into `<exe dir>\{WWWW}\` (creating the
   dir), showing "Staženo N% [bytes] bytů", then "Stahování bylo dokončeno". Plain HTTP,
   no checksum or signature check.
6. It runs `ucto<YYYY>_<NN>.exe /R /DIR=<UctoDir>` (`Process.Start`) and exits.
   `/DIR=` is an Inno Setup switch. `/R` is presumably the installer's own "repair
   existing installation" flag (inferred, compare with the CD instructions: "zaškrtněte
   Opravit stávající instalaci"). On error: "Při stahování souboru došlo k chybě
   Podrobnosti: …".

## Replacement design

**Obsolete as a program.** In the Electron product, the Účto program files (chapters,
`.PRO/.TRO`, `{GLOB}` tables, `.CAT`) come from our own application package. A Windows
Inno Setup installer cannot be used on Linux or macOS, and on Windows it would install the
DOS/NTVDM-era product next to ours.

The *need* stays: "my program files are damaged; restore them without touching company
data". Replace it with an **application-level function**, not an EXEC helper:

* Electron menu (outside the DOS console) → **"Obnovit programové soubory Účta"**:
  * Re-extract the pristine Účto program files from the app bundle (the same source the
    first-run setup uses) over the user's installation root. Only overwrite the files in
    the vendor manifest (`*.PRO/.TRO/.RDB/.CAT`, `{GLOB}` code lists, `{TISK}`, `{AP0x}`,
    help), and never touch company data dirs, `{STAN}`, or user configs.
  * Before that, back up the overwritten files to `{OBNV}\<timestamp>\`.
  * If the bundle carries an older Účto update than the one installed (the local
    `VERZE.UUU` line 1), warn the user and point to the updater (see uctool3.md).
* Register a tiny stub under the EXEC key `oprava.exe` anyway, in case a hot-line
  instruction or a user batch runs it through FAND. The stub shows the FAND-style message
  "Obnova programových souborů se v této verzi spouští z nabídky aplikace (Nápověda →
  Obnovit programové soubory)." through `ctx.ui.message` and returns 0.
* Help texts (`HELP.T00`, `TIPY.T00`) mention `oprava.exe`. They are vendor data and we
  cannot edit them. The stub message covers the case where a user looks for the file.

Priority **low**, effort **S** (the stub). The real repair function belongs to the
installer/updater work package, not to the EXEC layer.

## Test approach

* Stub: an EngineDriver/unit test showing the message and returning 0.
* Repair function (when built): a temp installation copy under `work/tmp-*/`. Corrupt a
  `MODUL01.PRO`, run the restore, then check the file is byte-identical to the bundle, a
  company dir (`{PRIK}`) is untouched, and the backup exists in `{OBNV}`.
