# UctoFtp3.exe – download and start the Účto update installer

`{tisk}\UctoFtp3.exe` (27 KB, .NET 4 WinForms). Default updater (`PARAM3.UOL='3'`); the
alternatives [UCTOFTP.EXE](uctoftp.md) (`'1'`, VB6) and [UCTOFTP2.EXE](uctoftp2.md) (`'2'`,
VB.NET) do the same job. Decompiled source: `work/decompiled/{tisk}_UctoFtp3/`.

Priority **low–medium** (the update path of a Windows installation does not apply to our
build, but Účto offers it automatically), effort **S**.

## How Účto calls it

Update check → [UCTOOL*.EXE](uctool3.md) (`MODUL01_PRO/0598_P_UctoOL.txt`) finds a newer
version, then `proc(UctoFtp,(Echo))` (`MODUL01_PRO/0599_P_UctoFtp.txt`) runs. It is reached
from two places in `MODUL01_PRO`:

* `0605_P_Program01.txt` – automatic check at start-up every `PARAM3.AutAktDny` days (default
  7): `proc(UctoOL,(false)); if PARAM3.Ano then proc(UctoFtp,(false));`
* `0601_P_Ucto2000.txt` – menu **Nápověda → Účto na internetu → Stáhnout aktuální verzi účta**:
  `UctoOL(true)` + `UctoFtp(true)` when `DOSBox | NewWin | WinVer='W'` (else [UCTOFT98](uctoft98.md)).

```
proc(Dotaz,(true,'Na internetu je dostupná novější verze účta. Aktualizovat ihned'));
uol123:=PARAM3.UOL;
FILE.Path:=PROGRAM.Path+cond(uol123='1':'{TISK}\UCTOFTP.EXE', uol123='2':'{TISK}\UCTOFTP2.EXE', else:'{TISK}\UCTOFTP3.EXE');
par:='FTP'+cond(test:'XX',else:copy(PARAM1.RočníkA,3,2))+'/ '+ str(PARAM3.F2,'0');   { e.g. 'FTP26/ 48213377' }
if PARAM3.DOSBox | PARAM3.vDOS then begin ... proc(ExecWin,(FILE.Path,par)); proc(Firma2,(true)); proc(PgmEnd); cancel; end
else with window(0,0,62,8,='AKTUALIZACE ÚČTA Z INTERNETU (UCTOFTP'+uol123+')',^Q) do begin
  writeln(' Během stahování nové verze z internetu účto čeká a nereaguje'); ...
  exec(FILE,par,nocancel);
  if exitcode=1 then begin proc(Firma2,(true)); proc(PgmEnd); cancel end;   { installer started: quit Účto }
end;
```

| | |
|---|---|
| Args | `FTPyy/` (web folder, `yy` = last two digits of the year; `FTPXX/` in test mode) and the expected size in bytes (`PARAM3.F2`, from `verzewww.uuu` read by UCTOOL) |
| Working dir | app root; the exe resolves everything relative to its own directory (`{TISK}`) |
| Output | `{TISK}\{wwww}\aktftp.exe`, started with `Process.Start` |
| Exit code | **1** = downloaded and started the installer (Účto then closes itself: `Firma2`, `PgmEnd`, `cancel`); **0** = argument error or download error |

## What it does (decompiled C#)

* `Program.InputValidation`: exactly 2 args else MessageBox "Chybný počet vstupních parametrů…",
  exit 0; `Config.WebFolder=args[0]`, `Config.FileSize=int(args[1])` (bad int → "Neplatné
  vstupní parametry…", exit 0).
* `CommonHelper.SetAppConfig`: URL `http://www.ucto2000.cz/DOWNLOAD/` + WebFolder + `aktftp.exe`;
  local `<exe dir>/{wwww}/aktftp.exe` (folder created); timeout 5000 ms; log
  `<exe dir>\UctoFtp3.log`, lines `dd.MM.yyyy - HH:mm | Chyba: <msg> | Podrobnosti: <where>`.
* `frmMain` ("Stahování aktualizace účta", progress bar, label "Probíhá stahování
  instalačního souboru ..."): HEAD-like `GetResponse` for `ContentLength`, then
  `WebClient.OpenRead` streamed in 1 KB blocks to the file with percentage progress
  (`FileSize` argument is **not** used for progress here, only by UCTOFTP2).
* On success `Process.Start(aktftp.exe)`, sleep 500 ms, `Environment.Exit(1)`.
  On a download error: MessageBox "Error: …", log, `Environment.Exit(0)`.
  Any other exception in the worker still ends with `Exit(1)` (bug: Účto then quits although
  nothing was started).
* `aktftp.exe` is the vendor's self-extracting Windows installer of the new Účto build
  (DOSBox autoexec runs `{wwww}\komplet.exe` when `akt.uuu` exists – the second stage).

## Replacement design

Module `src/engine/helpers/uctoftp.ts`, keys `uctoftp.exe`, `uctoftp2.exe`, `uctoftp3.exe`,
`uctoft98.exe` (the latter with its own argument form, see [uctoft98.md](uctoft98.md)).

The vendor installer patches a Windows directory tree (FAND chapters, `{TISK}` binaries,
UFAND.EXE). Our app ships the Účto payload inside its own package, so running `aktftp.exe`
is wrong on every platform. Two options:

1. **Now (parity-safe stub):** show a renderer dialog "Aktualizace účta se v této verzi provádí
   aktualizací aplikace" with a button that opens our release page
   (`ctx.host.openUrl(settings.updates.releaseUrl)`), return **0** so Účto keeps running.
   Never return 1 (Účto would close itself).
2. **Later (real update channel):** the Electron main process owns updates
   (`electron-updater` against our GitHub releases / generic feed). The helper returns 0 and asks
   the host to `checkForUpdates()` and show the standard "restart to update" UI. The new app
   version carries the new Účto payload (chapters, `{TISK}` data files) and our startup code
   migrates the user's data directory as the vendor installer would.

Optional (support/diagnostics only): download `aktftp.exe` with `fetch` to `{TISK}\{wwww}` so a
Windows user can run it manually – not recommended, it would modify a pristine install.

Since UCTOOL's version check drives this (see [uctool3.md](uctool3.md) option 2), make the
version reported by our UCTOOL replacement consistent with what the app can actually deliver,
otherwise users get "novější verze" prompts every 7 days that lead nowhere.

## Test approach

* Unit: argument validation (`FTP26/ 123`, missing size) returns 0 and never 1; the stub calls
  `ctx.host.openUrl` / the update hook exactly once.
* Engine test (EngineDriver): run `UctoFtp(true)` with a fake `PARAM3.F2` and assert Účto does not
  terminate (no `cancel`) and the Hlaseni dialog text is shown.
