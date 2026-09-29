# CALLER.exe – run a Windows command line without waiting

`{tisk}\CALLER.exe` (26 KB, 2007). A **native VB6** app, internal name `CALLER` (product
"PIF", form `frmPIF`, comment "kompilace 05.11.2004"). It is a tiny launcher: FAND's
`exec` waits for its child, and running a Windows GUI program directly from a DOS
process (NTVDM/vDos) is unreliable. CALLER starts the target program and **exits
immediately**, so FAND returns at once and the target keeps running.

## How Účto invokes it

Two argument forms, confirmed by the callers and the literals `' '`, `'#'`, `'-'` and the
default `explorer.exe c:\`:

| Form | Meaning |
|---|---|
| `caller.exe <program> [args…]` | run the command line given on the command line |
| `caller.exe # <file>` | read the command line from the **first line of `<file>`** (CP852/ANSI text), used when the line is too long for a DOS command line or contains special characters |
| `caller.exe` (no args) | runs `explorer.exe c:\` (the built-in default) |

A `-` literal is also present: probably an option such as a hidden/minimized window.
Nothing in Účto passes it (**unknown**).

Call sites (`work/source/...`):

| Chapter | Code | Purpose |
|---|---|---|
| `UCTO2026_RDB/0499_P_ExplWin.txt` | `if PARAM3.DOSBox then proc(ExecWin,('explorer.exe',Cesta)) else exec('{tisk}\caller.exe','explorer.exe '+Cesta,nocancel);` | **"Adresář … W" menu items** (18 chapters: `{MAIL}`, `{PDF1}`/`{PDF3}`/`{PDF4}`, backups `{ZAL2}`, `{VDOS}`, `{DBX1}`/`{DBX2}`, "Průzkumník Windows" in Speciality …): open a folder in Explorer |
| `MODUL01_PRO/0596_P_UctoGraf.txt`, `0597_P_UctoGrafK.txt` | `puttxt(UCTOTXT3,FILE.Path+' $ '+UCTOTXT.Path); exec('{tisk}\caller.exe','# '+UCTOTXT3.Path,nocancel);` | start [UCTOGRAF](uctograf.md) without waiting |
| `UCTO2026_RDB/0605_P_PoTiskW.txt` | `proc(ExecWin,('{tisk}\caller.exe',FILE.Path+' $ '+XPath(UCTOTXT2.Path)));` | start [POSTTISK](posttisk.md) |
| `UCTO2026_RDB/0361_P_SysInfo.txt` | `puttxt(UCTOTXT,'explorer.exe '+FILE.Path); exec('{tisk}\caller.exe','# '+UCTOTXT.Path,nocancel);` | "Font pro Windows 7": start [AlisFand](alisfand.md) through Explorer (to get UAC elevation) |
| `UCTO2026_RDB/0435_P_CopyBat.txt` | `puttxt(FILE,'@copy "'+Odkud+'" "'+Kam+'" >null'); if PARAM3.DOSBox then proc(ExecWin,(PROGRAM.Path+'{tisk}\caller.exe',FILE.Path)) else proc(ExecDos,(FILE.Path));` | copy a file with long names on the host (DOSBox only) |
| `MODUL03_PRO/0355_P_eVrep.txt`, `MODUL97_PRO/0262_P_eVrep2.txt` | `if PARAM3.vDos then begin puttxt(TXT,''); exec('{tisk}\caller.exe','{MAIL}\xmlchk.bat '+epo,nocancel); proc(WaitFor,(TXT.Path,'XMLCHK.BAT'));` | "XML Check" (test mode only): run a user-provided `xmlchk.bat` under vDos |
| `U64.BAT`, `U8.BAT` | `{tisk}\caller {tisk}\ubox $ {dbx2} 1000 500 utisk04.exe` | start [UBOX](ubox.md) in the background before DOSBox |

`nocancel` → a failure does not abort the FAND procedure, and the exit code is ignored
everywhere.

## What it does (inferred)

1. Take `Command$`. If it starts with `#`, open the file named after it (`__vbaFileOpen` /
   `__vbaInputFile`) and read the first line as the command line. If it is empty, use
   `explorer.exe c:\`.
2. Run it with VB `Shell` (normal focus) and end. There is no wait and no message.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/caller.ts`, key `caller.exe`. It is a **re-dispatcher**, not
a process spawner:

1. Build the command line: `args` joined, or, for `#`, the first line of
   `ctx.mapPath(args[1])` decoded as CP852 (it is written by FAND `puttxt`).
2. Tokenize it Windows-style (quotes). The first token is the program.
3. Dispatch:
   * `explorer.exe <path>` → if `<path>` is a directory, `ctx.host.openPath(mapPath(path))`
     (Electron `shell.openPath` → Finder/Explorer/file manager). If it is a `.exe` that
     is a registered helper (the AlisFand case), dispatch to that helper. Otherwise
     `openPath`.
   * A program that is a **registered helper** (`uctograf.exe`, `posttisk.exe`,
     `ubox.exe`, …) → call the helper through the EXEC registry with the remaining args,
     **fire-and-forget** (do not block the interpreter). This matches CALLER's semantics:
     the FAND code does not wait. Note that UCTOGRAF is interactive (a window), so async is
     right.
   * A `.bat` (`UCTOBAT2.BAT` from `CopyBat`, `xmlchk.bat`) → run it through the engine's
     batch interpreter (the FANDDOS-style `ExecDos` layer), async. `@copy "a" "b" >null`
     must work: map it to `fs.copyFile`.
   * Anything else → `ctx.ui.message('Caller', 'Program … není podporován')` and log it.
     Do **not** spawn arbitrary host processes from FAND data.
4. Return 0 immediately.

OS integration: `shell.openPath` for folders. Nothing else. Still needed: **yes, medium**
(folder shortcuts appear in many menus, and it is the entry point for UCTOGRAF/POSTTISK).
Effort **S**.

## Test approach

* Unit tests: `caller.exe explorer.exe C:\UCTO2026\{MAIL}\` → one `openPath` with the
  mapped host dir. `caller.exe # <file with "…\UCTOGRAF.EXE $ …\UCTOTXT.UUU">` → the
  `uctograf` helper is invoked with `['$', '…UCTOTXT.UUU']`. No args → `openPath` of the
  mapped `C:\`, or a no-op in headless mode.
* A CP852 `#` file with Czech path characters (`Účto`) decodes correctly.
* Security test: `caller.exe cmd.exe /c del …` → a message, no spawn.
* EngineDriver: Speciality → "Průzkumník Windows" → assert an `openPath` of the station dir.
