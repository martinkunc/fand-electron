# UCTOLNK.EXE, UCTOLNKD.EXE, UCTOLNKV.EXE – desktop shortcut for Účto

Three native VB6 programs in `{tisk}` (31–35 KB, description "Zástupce programu účto na plochu.";
imports `SHGetSpecialFolderLocation`, `SHGetPathFromIDListA`, `ShellExecuteExA`, `GetVersionExA`):

| Exe | Mode | Templates / data read from `{TISK}` |
|---|---|---|
| `UCTOLNK.EXE` (2017) | 32-bit Windows, `U.BAT` | `UCTOLNK.UUU`, `UCTOLNK.WXP`/`.WV`/`.W7`/`.W7A`/`.W8` (template `.lnk` per Windows version) |
| `UCTOLNKD.EXE` (2012) | DOSBox, `U64.BAT` / `U8.BAT` | `UCTOLNK7.UUU`, `UCTOLNK8.UUU`, `UCTOLNK.W64` |
| `UCTOLNKV.EXE` (2017) | vDos, `{vdos} U64v.bat` | `UCTOLNKV.UUU`, `UCTOLNK.W64` |

`UCTOLNK*.UUU` (UTF-8 text) – line 1 shortcut name (`Účto 2026`, `Účto 2026 DOSBox`,
`Účto 2026 64-bit`), line 2 target batch (`U.BAT`, `U64.BAT`; missing in the vDos file – it comes
from the command line), line 3 icon (`ICOUCTO.ICO`, `IcoUctoD.ico`, `IcoUctoV.ico`), line 4
comment `Účto - jednoduché účetnictví`, line 5 (optional) the previous year's shortcut name
(`Účto 2025`), presumably removed. The `.W*` files are real `.lnk` templates (see `file`).
Target folder `%USERPROFILE%\Plocha` / Desktop.

Priority **low** (obsolete launcher integration), effort **S**.

## How Účto calls it

`UCTO2026_RDB/0496_P_UctoLnk.txt` `UctoLnk(Akce)`:

```
proc(Dotaz,(false,'Přidat zástupce pro spuštění účta '+ cond(db:'v režimu DOSBox ', vd:'v režimu vDos ')+'na plochu Windows'));
FILE.Path:=PROGRAM.Path+'{TISK}\UCTOLNK'+cond(db:'D', vd:'V')+'.EXE';
proc(ExecWin,(FILE.Path,cond(vd:'{vdos} U64v.bat')));
if exitcode<>0 & Akce=~'' then message('chyba UCTOLNK: exitcode '+str(exitcode,'0'));
```

From: **Systémové informace → Zástupce na plochu** (Windows 64-bit vDos / 64-bit DOSBox /
32-bit), **Havárie** hints (`MODUL01_PRO/0604_P_Havarie.txt`), and the upgrade when last year ran in
DOSBox (`UPG_PRO/0009_P_UpgradeG.txt`). Also the root batches `ZZZ.BAT`, `ZZZ64.BAT`, `ZZZ64v.BAT`
run them manually.

## Replacement design

The shortcuts start DOS launchers that do not exist in our app. Key `uctolnk.exe`,
`uctolnkd.exe`, `uctolnkv.exe` → one handler that offers a shortcut to **our** application:

* Windows: `shell.writeShortcutLink(desktop + '\\Účto 2026.lnk', 'create', { target: process.execPath, args: '--task ucto2026', icon: <app icon>, description: 'Účto - jednoduché účetnictví' })`.
* Linux: write `~/Desktop/ucto-2026.desktop` (and `~/.local/share/applications/`), `chmod +x`,
  `Exec=<AppImage or binary> --task ucto2026`.
* macOS: nothing to create (Dock/Launchpad); show a hint.

Desktop path from Electron `app.getPath('desktop')`. Return 0; any failure → 1 (Účto prints
"chyba UCTOLNK: exitcode 1" only for the 32-bit variant). The DOSBox/vDos distinction is
meaningless and all three do the same.

## Test approach

Host-level unit test with a temp "desktop" dir: `.desktop` file content on Linux; on Windows CI
`shell.readShortcutLink` round trip. Registry test for the three keys.
