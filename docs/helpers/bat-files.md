# .BAT files in the Účto root and the DOS command shell they need

Účto calls DOS commands and batch files through FAND `exec`. On the original platforms they ran
in COMMAND.COM / CMD.EXE / 4DOS (vDos) / the DOSBox shell. We need an **in-process DOS shell** in
the EXEC layer; the batch files themselves stay as they are (read from the pristine install,
never modified).

Priority **high** (MAKEDIR, CHKPATH, RENVYP, REN3BKP, `{OBNV}.BAT`, `DELPRAC.BAT`, `ver`, `set`,
`md`, `copy`, `del` are used in normal operation), effort **M**.

## How commands reach the shell

`UCTO2026_RDB/0497_P_ExecDos.txt` `ExecDos(Parametry)`:

```
s:=copy(Parametry,1,pos(' ',Parametry)-1);
if equmask(s,'*.BAT') then begin FILE.Path:=s; if filesize(FILE)=-1 then begin proc(Hlaseni,('Program '+FILE.Path+' neexistuje')); exit end; end;
proc(Vypocet1);
with window(1,1,1,1) do case
  PARAM3.vDos: exec('',Parametry,freemem,nocancel,textmode,loadfont);
  PARAM3.NewWin | (PARAM3.WinVer='W' & PARAM3.CmdXp): begin ce:=filesize(CMDEXE)>0;
       if ce then exec(CMDEXE,'/C '+Parametry,…) else exec('CMD','/C '+Parametry,…); end;
  else exec('',Parametry,freemem,nocancel,textmode,loadfont);
end;
```

So the EXEC layer sees three shapes, all of which must go to the same shell:
1. `exec('', 'ver >C:\…\UCTO.TXT')` – empty program = COMSPEC command line (FAND semantics);
2. `exec(CMDEXE, '/C <cmd>')` with `CMDEXE.Path` = `%SystemRoot%\SYSTEM32\CMD.EXE` (see
   [winverze.md](winverze.md) for the runtime identity) or bare `CMD`;
3. `exec('X.BAT', args)` / `ExecWin('REN3BKP.BAT',…)` (DOSBox branch only).

Plain helper exes (`exec('SUBDIR.EXE',…)`, `exec(TXTNARTF,…)`) go to the helper registry
directly; a line inside a batch naming an exe (`{TISK}\UCTOLNKD.EXE`) goes to the same registry.

## Shell specification

Port `FandDosCmd` + `RunBat` from `vendor/reference/standa_pcfand/pas/FANDDOS.PAS` (fpc-migration
branch; it already implements exactly this subset) to `src/engine/exec/dosshell.ts`:

* Tokenizer honours double quotes (`copy "C:\Moje doklady\f.pdf" "…"`).
* Redirection `>` / `>>` (last `>` wins), `NUL` (and treat `null` as discard); path separators `\` mapped via the engine's
  DOS↔host path mapping (drive letters, case-insensitive lookup) instead of FPC's `Slashed`.
* Built-ins: `VER`, `SET`, `MD/MKDIR`, `RD/RMDIR`, `DEL/ERASE` (wildcards, files only), `COPY`
  (`a b`, `a dir\*.*`, `a dir\*.EX` – see below, `a + b c` concatenation), `REN/RENAME/MOVE`,
  `TYPE`, `ECHO`, `CLS`; accepted no-ops: `CD`, `EXIT`, `PAUSE`, `REM`, `PATH`, `PROMPT`, `MODE`,
  `KEYB`, `KB16`, `SHARE`, `MOUNT`, `USE`, `DIR`, `ALIAS`, `@echo off`.
* `ver` output: `Microsoft Windows [Version 10.0]` (drives `DosWin`; FPC prints
  `MS-DOS Version 6.22`, which would make Účto believe it runs in pure DOS).
* `set` output: the engine's virtual environment (`COMSPEC`, `SystemRoot=C:\WINDOWS`, `windir`,
  `FANDOVRB`, `FANDCFG` …), not the host environment (privacy + stable tests). It is shown in
  *Systémové informace → Počítač*.
* Batch interpreter: `%1…%9`, `@` prefix, `:label`, `GOTO`, `IF [NOT] EXIST <path>`,
  `IF [NOT] "a"=="b"` (quotes compared literally, as COMMAND.COM does), `CALL x.bat`.
  **Fix vs. FPC:** `IF EXIST dir\` and `IF EXIST dir\*.*` must be true for an existing *empty*
  directory (DOS `NUL`-device trick semantics); FPC's `AnyMatch` returns false there, which would
  break `CHKPATH.BAT`/`MAKEDIR.BAT`.
* `COPY src dir\*.EX`: DOS renames the extension (`UCTOOL.EXE` → `UCTOOL.EX`); FPC strips the
  wildcard and copies with the original name – implement the DOS rename.
* Exit code of a batch = exit code of its last command (FPC behaviour); `ExecDos` never checks it
  anyway (callers inspect files).
* Writes are confined to writable roots (user data dir); an attempt to write into the pristine
  install fails with exit 1 and a log line.

## The batch files

| File | Called from | What it does | Port notes |
|---|---|---|---|
| `MAKEDIR.BAT` | `UCTO2026_RDB/0560_P_MakeDir.txt` (new firm data dirs `ADR01+d`, `ADR03+d`), `0485_P_VyberDir.txt` ("nový adresář"), `0561_P_KatalogL.txt`, `0287_P_Trenink.txt` (training data) – `ExecDos('MAKEDIR.BAT $ <dir> [<dir2>]')` | `if not exist %2\*.* md %2` (and `%3`) | needs the empty-dir `IF EXIST` fix; `md` must create nested dirs |
| `CHKPATH.BAT` | `UCTO2026_RDB/0428_P_PathExist.txt` when `PARAM3.PathExBat` (option in *Programy*, `0033_E_ParPgm.txt`): writes the path into `CHKPATH.TXT`, runs `CHKPATH.BAT $ <path\> CHKPATH.TXT exist` (`isdir` under vDos), then `PARAM3.Ano:=filesize(CHKPATH.TXT)>0` | `if not %4 %2 del %3` → deletes the marker file when the directory does not exist | `%4` expands to the keyword `exist`/`isdir` – the IF parser must run **after** substitution; support 4DOS `isdir` too. The default path (option off) uses FAND `checkfile` instead |
| `RENVYP.BAT` | `MODUL08_PRO/0141_P_RenVyp.txt`, `0139_P_VypPřenos.txt` – archive imported bank statements: `ExecDos('RENVYP.BAT $ <dir\> <old> <new>')` | copy `%2%3`→`%2%4`, then delete `%2%3`, unless missing or equal | `IF "%3"=="%4"` |
| `REN3BKP.BAT` | `UCTO2026_RDB/0457_P_BkpZal.txt` "Uchovat, přejmenovat" an older backup: `ExecDos('REN3BKP.BAT $ '+kamP+s+' '+s+' '+strdate(lu,'YYYY-MM-DD_hh-mm_'))` | `ren %2B %4%3B` (same for `T`, `Z`) – prefix the three backup parts with a timestamp | `REN` with a target **name** (not path) → rename inside the source dir; long names (`2026-03-01_08-30_FIRMA.262B`) are fine on the host |
| `{OBNV}.BAT` | `UCTO2026_RDB/0565_P_Poprve.txt` (first start of a year), `UPG_PRO/0042_P_UpgradeA5.txt`: `ExecDos('{OBNV}.BAT $')` | copies the catalog and key `{GLOB}` code lists to `{OBNV}\` for disaster recovery; `UCTOOL.EXE`/`UTISK04.EXE` → `*.EX` | batch name with braces; `copy x {OBNV}\*.*` and `*.EX` rename; copying the exes is pointless but harmless (read from install, write to data) |
| `DELPRAC.BAT` | `MODUL01_PRO/0584_P_Udrzba.txt` *Údržba → Pracovní soubory*, `0604_P_Havarie.txt` after a crash | deletes `{STAN}\DPH.?09`, `{STAN}\DPH92A.?09` (work files left by antivirus-interrupted runs) | `?` wildcard |
| `CAT.BAT` | manual (support instructions) | restores `UCTO2026.CAT` from `{OBNV}` | keep working if a user runs it through a future "run batch" feature; otherwise unused |
| `RENFILES.BAT` | no caller in the decoded sources (legacy) | `copy %2 %3` + `del %2` (move) | supported by the generic shell |
| `U.BAT` | launcher for 32-bit Windows (NTVDM): `MODE CON: COLS=80 LINES=25`, `KB16 CZ,852`, [NUMKB4](numkb.md), `SET FANDOVRB=80`, `ufand ucto2026`. Edited from Účto: *Systémové informace → U.BAT* (`0356_P_UBat.txt`), *Přepnout na 25/28/43/50 řádků* (`MODUL01_PRO/0056_P_OknoW32.txt` rewrites the `LINES=` value), attached to support mails (`0532_P_HotMail.txt`) | **obsolete as a launcher**. Compatibility: at start the host may read `LINES=` from the user's `U.BAT` to choose 25/28/43/50 rows, so the Účto menu keeps working; editing stays a plain text edit |
| `UK.BAT` | manual | like U.BAT with a US keyboard | obsolete |
| `U64.BAT`, `U8.BAT` | DOSBox launchers (Windows 7 / 8–11): `{dbx1}\setdisk.bat`, `{tisk}\caller {tisk}\ubox …` ([UBOX](ubox.md) print bridge), `{dbx1}\disxbut*.exe $` (DOSBox frontend) | obsolete (DOSBox) |
| `U64v.bat` | vDos launcher: `set >Win.uuu`, `{tisk}\caller {vdos}\vdosplus.exe /cfg {vdos}\vdos_c.txt /set autoexec={vdos}\vdos_a.txt` | obsolete (vDos); `vdos_a.txt` itself runs [NUMKBVD](numkbvd.md) and `ufand ucto2026` |
| `UFAND64.BAT`, `UFAND64v.BAT` | start bare UFAND (developer mode) under DOSBox / vDos | obsolete |
| `ZZZ.BAT`, `ZZZ64.BAT`, `ZZZ64v.BAT` | manual: create desktop shortcuts via [UCTOLNK*](uctolnk.md) | obsolete |
| `{vdos}\ObnovCFG.BAT`, `{dbx1}\ObnovCFG.BAT`, `{dbx1}\setdisk.bat` | restore vDos/DOSBox configs, build the DOSBox mount section | obsolete |
| `Z<year>.BAT` | written by `UPG_PRO/0029_P_UpgradeCfg.txt` (`{TISK}\UCTOCONF.EXE … C`) | re-runs [UCTOCONF](uctoconf.md) | obsolete |
| `UCTOBAT.BAT` | written at runtime by `0358_P_RustDesk.txt` (`'@'+program`) and run through `ExecDos` | one-line launcher | the shell runs the line → helper registry / host launcher (see [filedown.md](filedown.md)) |
| `UCTOBAT2.BAT` | written by `UCTO2026_RDB/0435_P_CopyBat.txt` `CopyBat(Odkud,Kam)` – used for invoice PDF/QR files (`MODUL06_PRO/0098_P_FaktQR.txt`, `0099_P_FaktPdfMail.txt`, `0162_P_FaktPdf1.txt`, `MODUL08_PRO/0079_P_QRPlatEx.txt`, `0630_P_PlatbaQR.txt`, `0563_P_ConfigEET.txt`) | `@copy "<from>" "<to>" >null` | needs **quoted arguments** with spaces (FPC's tokenizer splits on blanks – fix); `>null` creates a file literally named `null` in cwd on DOS – redirect it to a discard instead of littering the data dir |

## Test approach

* Port the FPC semantics with table-driven tests (command line → files created/deleted, output
  text, exit code), using a temp directory mapped as `C:\UCTO2026\`.
* Run every shipped batch with realistic arguments: MAKEDIR (new and existing empty dir),
  CHKPATH (`exist` for existing/empty/missing dir), RENVYP (equal names, missing source),
  REN3BKP (three parts), `{OBNV}.BAT` (compare the `{OBNV}` listing incl. `UCTOOL.EX`),
  DELPRAC.
* EngineDriver: start Účto → `DosWin` via `ver`/`set` gives `WinVer='8'`; create a new firm →
  directories exist.
