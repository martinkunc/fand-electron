# UCTOOL.EXE – update check, original native variant (`PARAM3.UOL='1'`)

`{tisk}\UCTOOL.EXE` (31 KB, **native VB6** PE32 GUI exe, runtime `MSVBVM60.DLL`, uses the
**MSINET.OCX** Internet Transfer Control `InetCtlsObjects.Inet`, form `frmUctoOL`, modules
`mdlGlob`/`mdlAPI`; version resource 1.00, "Stažení souboru z webu", Tichý & spol., dated
2017). It is the oldest of the three interchangeable download helpers used by `UctoOL`.
It cannot be decompiled to source, so this description is **inferred** from `strings` /
`strings -el` and from the shared protocol of UCTOOL2/Uctool3 (see uctool3.md).

## How Účto calls it

Identical to Uctool3 (uctool3.md). It is used when `PARAM3.UOL='1'`: `ExecWin('{TISK}\UCTOOL.EXE',
'$ '+UCTOTXT.Path)` in `MODUL01_PRO/0598_P_UctoOL.txt`, plus `WaitFor(result,'UCTOOL.EXE')`
in DOSBox/vDos. The error text Účto shows after a failed check, "na počítači chybí
knihovna MSINET (nainstalujte ji z volby Ostatní /Speciality /Systémové informace
/Knihovny setupe.exe)", refers to this variant.

`{OBNV}.BAT` (run with `$`) copies `{TISK}\UCTOOL.EXE` to `{OBNV}\UCTOOL.EX` as part of the
"files needed for recovery" backup. In our port that backup is irrelevant (see oprava.md).

## What it does (inferred)

Evidence in the binary:

| String | Meaning (inferred) |
|---|---|
| `wininet` `InternetGetConnectedState`, "InternetGetConnectedState: (DLLError " | online check before the download; the Win32 error is logged |
| `InetCtlsObjects.Inet`, `MyInet`, `MSINET.OCX` | download with `Inet.OpenURL(url)` |
| "404 NOT FOUND" | the downloaded text is checked for the server's 404 page, because `OpenURL` returns the body without a status |
| `http://` | the URL must start with `http://` |
| `http://www.ucto2000.cz/PHPPGM/SLEDOVANI/infouser.php?info=` | the usage ping, as in UCTOOL2/3 |
| `\UCTOOL.LOG`, `d.m.yyyy hh:mm:ss` | errors are appended to `App.Path\UCTOOL.LOG` with a timestamp |
| `__vbaFileOpen` / `__vbaInputFile` / `__vbaPrintFile` | VB `Open … For Input` / `Input #` to read the parameter file, and `Print #` to write the result. `Print #` appends CRLF to the downloaded text |

Behaviour:
1. `Command$` = `$ <paramfile>`. It reads the URL, the result path and the info from the
   parameter file (VB `Input #`/`Line Input` split on CR; the quoted third field is read
   as a VB string, which drops the quotes).
2. If offline (`InternetGetConnectedState` false), or the download fails or returns the
   404 page, it writes a failure marker, presumably `0` as in the .NET versions, and logs
   it to `UCTOOL.LOG`.
3. Otherwise it writes the downloaded text to the result file and sends the usage ping.
4. Exit code 0.

Differences that matter to Účto: none. `UctoOL` only reads line 1 (the version, ≥10
chars) and line 2 of the result, and a trailing CRLF is harmless.

## Replacement design

The same module as Uctool3: `src/engine/helpers/uctool.ts`, registered as `uctool.exe`.
MSINET/VB6 have no meaning cross-platform. Do not reproduce the 404-string heuristic;
use the HTTP status instead. The error text about MSINET in `UctoOL` cannot be changed (it
is vendor FAND code), but our helper never triggers it for a missing library.

Priority: covered by uctool3 (medium, S). Keep the key because older installations may
have `UOL='1'`.

## Test approach

Shared with uctool3.md. Add one case: with `PARAM3.UOL='1'`, the engine calls `uctool.exe`
and the check works with mocked fetch. There is no golden run of the original: it would
need Windows with a registered MSINET.OCX.
