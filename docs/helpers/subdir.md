# SUBDIR.EXE – list subdirectories of a directory

`SUBDIR.EXE` in the app root (3.4 KB, Borland Pascal DOS program).

Priority **high** (directory picker for all path parameters, firm-directory check, upgrade),
effort **S**.

## How Účto calls it

Always `exec('SUBDIR.EXE' or ADR01+'SUBDIR.EXE', '$ '+<dir>+' '+UCTOTXT.Path, freemem,nocancel)`
(runs synchronously in every runtime – it is not switched to a Windows variant).

| | |
|---|---|
| Args | `$ <directory> <result file>`; directory with or without trailing `\` |
| Result | CP852, one **subdirectory name** (no path) per line, CRLF |
| Exit | 0 ok, 1 bad parameters, 2 cannot write the result |

Callers:

| Chapter | Feature |
|---|---|
| `UCTO2026_RDB/0485_P_VyberDir.txt` `VyberDir(Adr,Hd)` | **"Vybrat adresář v DOSu"** – FAND directory browser used by every folder parameter (backup targets, PDF output, bank import/export, …): the list is shown with `selectstr` prefixed by `zvolit`, `nový adresář` ([MAKEDIR.BAT](bat-files.md)), `jiný disk` ([VsechnyDisky](disksizw.md)), `..` |
| `UCTO2026_RDB/0506_P_SubDir.txt` `SubDir(Kořen,upg)` | Ostatní → Jiná firma → **Kontrola adresářů**: every subdirectory of the Účto root (except `*.BAK`) is inspected (FILESIZE, `PARAM2.000` → firm name) and compared with the FIRMY list; reports `SubDir1`/`SubDir2` |
| `UPG_PRO/0009_P_UpgradeG.txt` | upgrade: `SubDir(VERZEOLD.Path,true)` to import firms of last year |
| `UPG_PRO/0045_P_SubDirUpg.txt`, `0046_P_UpgradeR.txt` | "? … najít data na disku" when converting data from an old directory |
| `UCTO2026_RDB/0288_P_Firmy.txt` | menu item calling `SubDir(ADR01.Path,false)` |
| `MODUL08_PRO/0223_P_GetDirsExe.txt` | `GetDirsExe(Kořen)`: raw list into `PARAM3.TTT`; no caller found in the decoded sources (dead code) |

## What it does (inferred)

`FindFirst(dir+'\*.*', Directory)`, skip `.`/`..` and non-directories, write `Name` (upper-case
8.3). Order = DOS order; `SubDir` sorts the records itself (`sort(SUBDIR,(~Dir))`), `VyberDir`
shows as is. FPC equivalent: `FandListFiles(Pattern,true,false)` (sorted).

## Replacement design

`src/engine/helpers/dostools.ts`, key `subdir.exe`.

* `dir = ctx.mapPath(args[1])`; list directories, skip hidden host dirs (`.git`, `.cache`…
  anything starting with `.`), map names to the engine's DOS names (Účto's `{DATA}`, `{ZAL3}`
  etc. are valid 8.3 names with braces), sort case-insensitively, CRLF, CP852.
* Exit 2 if the result cannot be written, 1 on wrong args, else 0.
* Note for `VyberDir`: the chosen path must remain expressible as a DOS path; when the user wants
  a host folder outside the mappings, the Windows branch ("Vybrat adresář ve Windows" →
  [UctoFoD](uctofod.md)) is the right tool – it returns a host path that the engine maps or
  registers as a new drive letter.

## Test approach

Fixture root with `{DATA}`, `{ZAL3}`, `FIRMA1`, `FIRMA1.BAK`, `.hidden`, a file: exact list and
order; EngineDriver test of *Kontrola adresářů* producing the "PODADRESÁŘE S DATY" report.
