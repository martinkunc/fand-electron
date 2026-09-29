# WFDETECT.EXE – detect installed .NET Framework 4.0 / 4.5

`{tisk}\WFDETECT.EXE` (18 KB, VB.NET, .NET 4.0 console exe). It checks the Windows
registry for .NET Framework 4.0 and 4.5+ and writes two `true`/`false` lines. Účto uses
it to warn the user before starting the .NET helpers for EET and e-Podání.
Decompiled source: `work/decompiled/{tisk}_WFDETECT/WFDETECT/MainPgm.cs`.

## How Účto calls it

| | |
|---|---|
| Command line | `<full DOS path of UCTOTXT>` (`UCTOTXT.UUU` from the catalog) |
| Output | that file, CP1250: `4.0: True\r\n4.5: True` (no trailing newline) |
| Exit code | not used (always 0, exceptions swallowed) |

Call sites:

1. **e-Podání via VREP**: `MODUL03_PRO/0355_P_eVrep.txt` and
   `MODUL97_PRO/0262_P_eVrep2.txt`, menu **"Poslat přes VREP"**. It runs once per
   invocation, only when `wxp := PARAM3.WinVer in ['W','V']` and `PARAM3.TestFwXp`
   (default true). On Windows 10/11, `DosWin` falls through to `WinVer='W'`, so the
   check does run on modern Windows.
   ```
   pgm:='WFDETECT.EXE'; EXE.Path:=PROGRAM.Path+'{TISK}\'+pgm;
   if filesize(EXE)>0 then begin puttxt(UCTOTXT,'');
     proc(ExecWin,(EXE.Path,UCTOTXT.Path));
     if PARAM3.SyncW then proc(WaitFor,(UCTOTXT.Path,pgm));
     s:=gettxt(UCTOTXT);
     if pos('true',copyline(s,2),'u')=0 & pos('true',copyline(s,1),'u')=0 then begin
       proc(HlaseniWw,(' Nedaří se detekovat prostředí pro e-Podání VREP\13 Pravděpodobně je třeba instalovat Microsoft .NET Framework 4.0'));
       proc(Dotaz,(true,'Stáhnout .NET Framework 4.0')); if PARAM3.Ano then proc(AdrWeb,('eetfwxp',''));
     end;
   end;
   ```
2. **EET tests**: `MODUL01_PRO/0103_P_TestEET.txt`, menu **"Test .NET Framework"**.
   It shows "Microsoft .NET Framework: v pořádku, detekovaná verze 4.5 nebo vyšší"
   when line 2 contains `true` (case-insensitive `pos(…,'u')`), or reports a missing
   version.

## What it does

* `GetVersion40()`: for each subkey of `HKLM\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4.0`,
  and then of `…\NDP\v4` (`Client`, `Full`), it reads `Version` and returns true if
  the first 3 characters with dots removed equal `40`.
* `GetVersion45()`: returns true if any `…\NDP\v4\*` `Version` gives a value of 45 or
  more by the same rule (e.g. `4.8.09037` → `48`).
* It writes `String.Format("4.0: {0}\r\n", b40) + "4.5: " + b45` (.NET bool
  formatting: `True`/`False`) with `Encoding.GetEncoding("windows-1250")`.

## Replacement design

Module `src/engine/helpers/wfdetect.ts`, key `wfdetect.exe`. The check is **obsolete**
in the cross-platform runtime, because none of the replacement helpers need .NET.
Implement it as a constant answer:

```ts
await writeFile(ctx.mapPath(args[0]), '4.0: True\r\n4.5: True', 'latin1');
return 0;
```

* This keeps both FAND call sites happy: no bogus ".NET Framework 4.0" download
  prompt, and the EET test menu reports OK.
* Do **not** probe the real registry. Even on Windows, the replaced helpers do not
  depend on it.
* Other ways to avoid the call: set `PARAM3.TestFwXp=false`, or make the environment
  report a `WinVer` other than W/V. Both mean changing Účto state or the emulated
  `ver` output, so the stub is simpler and more robust.
* Still worth replacing: only as a stub. Effort is minimal.

## Test approach

* Unit test: exact output bytes `4.0: True\r\n4.5: True`.
* EngineDriver: EET test menu → "Test .NET Framework" shows "v pořádku, detekovaná
  verze 4.5 nebo vyšší".
