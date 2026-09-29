# UCTOCONF.EXE – carry last year's launcher/DOSBox/vDos configuration over

`{tisk}\UCTOCONF.EXE` (43 KB, native VB6, "Kompilace 07.01.2019", description "Konfigurace
programu účto.", classes `clsVDOS`, `clsDOSBOX`, `clsCommon`, routines `SetVDOS`, `SetDOSBOX`,
`WSetCommon`, `verVDOS`, `pathOldVer`, `pathNewVer`).

Priority **low** (obsolete), effort **S** (stub).

## How Účto calls it

Upgrade of data from last year, `UPG_PRO/0029_P_UpgradeCfg.txt` (menu **Ostatní → Speciality →
Převod dat z účta <rok-1>** / first start after installation):

```
if VERZEOLD.Path<>~'C:\UCTO'+VerOld() then begin EXE.Path:=PROGRAM.Path+'{TISK}\UCTOCONF.EXE';
  if filesize(EXE)>0 then begin
    proc(ExecWin,(EXE.Path,VERZEOLD.Path+' '+VerOld()+' '+VerNew()+' U'));
    FILE.Path:='Z'+VerOld()+'.BAT';
    puttxt(FILE,'{TISK}\UCTOCONF.EXE '+VERZEOLD.Path+' '+VerOld()+' '+VerNew()+' C');
  end;
end;
```

| | |
|---|---|
| Args | `<old install dir> <old year> <new year> U|C` – `U` = run during the upgrade, `C` = the same call stored in `Z<oldyear>.BAT` in the app root for a manual re-run |
| Condition | only when last year's Účto was **not** in the default `C:\UCTO<year>` |

Afterwards Účto itself converts `FAND.CFG` (`MODUL98 FandCfg25_26`) and copies `UTISK98.INI`.

## What it does (inferred from strings)

Reads the old installation's `U.BAT`, `U8.BAT`, `U64.BAT`, `{DBX1}\FAND.CFG`, `{DBX1}\DISXBUT.INI`,
`{DBX1}\DOSBOX_U.TXT` (`windowresolution=`), `{VDOS}\VDOS_C.TXT`, `{VDOS}\VDOS_A.TXT`, `4DOS.INI` and
transfers user choices into the new installation: `LINES=25/43` in `MODE CON`, `KB16`/`NUMKB4`
lines (`REM KB16`, `REM NUMKB4`), DOSBox window size, vDos settings; replaces the old year/path in
them (`ucto`, `ufanducto`).

## Replacement design

Obsolete – none of those launcher files is used by our app (window size, rows, keyboard options
are app settings migrated by the app itself). Key `uctoconf.exe` → no-op, exit 0. Because
`UpgradeCfg` also writes `Z<year>.BAT` into the app root, the engine's write layer must allow it
(it goes to the user's writable Účto directory, never to the pristine install).

## Test approach

Registry test; upgrade EngineDriver scenario completes without errors.
