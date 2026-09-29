# FANDINST.EXE – PC FAND 4.20 configuration program (FAND.CFG editor)

`FANDINST.EXE` in the app root (52 KB, Turbo Pascal DOS program; a copy also in `{dbx1}` for the
DOSBox config). The original PC FAND installer/configurator: "PC FAND 4.20 – instalační program".
It edits `FAND.CFG` (found via env `FANDCFG` or the current dir; backup `FANDCFG.BAK`): constants
(report, page separation, LAN, mouse, backup), monitor type, colours, alphabet (Kamenický /
Latin 2 / IBM), up to 10 printers (way of printing – LPT / logical port / print manager –,
program name/params, control code table from `pNames`: `^S` underline, `^W` italic, `^Q` wide,
`^D` double, `^B` bold, `^E` compressed, `^A` elite, reset, page length, user codes …), calendar
exceptions from `DNY.000`, printer test print.

Source is available: `vendor/reference/alisoss_pcfand/fandcfg/FANDINST.PAS` (+ `MAKECFG.PAS`,
`CHARTABS.PAS`, the same in `standa_pcfand/fandcfg`).

Priority **low**, effort **L** for a port / **S** for the stub.

## How Účto calls it

`MODUL01_PRO/0591_P_FandInst.txt`, menu **Ostatní → Speciality → Nastavení PC FANDu →
"FANDINST.EXE pro odborníky"**:

```
FILE.Path:=dbx1+'FAND.CFG';
if FILE.Path<>FANDCFG.Path then proc(HlaseniWw,(' Umístění konfiguračního souboru: '+FANDCFG.Path+…))
else begin FILE.Path:=dbx1+'FANDINST.EXE';
  if filesize(FILE)>0 then begin cfgold:=gettxt(FANDCFG);
    with window(1,1,1,1) do exec(FILE,'',freemem,nocancel,textmode);
    if PARAM3.Ano then begin cfgnew:=gettxt(FANDCFG); if cfgnew<>cfgold then proc(CancelCfg); end;
  end else proc(Hlaseni,('Program '+FILE.Path+' nenalezen'));
end;
```

`CancelCfg` asks the user to restart Účto so FAND reloads the configuration. Other mentions only
in texts (`MODUL98_PRO/0055_R_Printer.txt`, `0056_R_PrinterW.txt`, `UPG_PRO/0042_P_UpgradeA5.txt`).
The same menu offers Účto's own configuration screens (`call(MODUL98,FandCfg)`, *Převzít
distribuční FAND.CFG*, *Svátky: DNY.000 do FAND.CFG*), which cover what normal users need.

## Replacement design

* v1: key `fandinst.exe` → `ctx.ui.message('Konfiguraci upravte volbou "Konfigurační program" nebo v nastavení aplikace.')`,
  exit 0 (FAND.CFG unchanged → no restart prompt).
* Later (optional): a TypeScript port of FANDINST.PAS as a full-screen text UI running on our
  `Crt`/`Screen` inside the engine worker (it is an interactive DOS UI – same console, same keys),
  reading/writing FAND.CFG through the codec described in `docs/FORMATS.md`. Only worth it if
  printer control-code editing is still relevant with our print pipeline (see
  [print-spool.md](print-spool.md)).

## Test approach

Stub: registry test. Port (if done): round-trip FAND.CFG read → write equals the original bytes
for the shipped `FAND.CFG`, `FANDCFG.25`, `FANDCFG.26`, `{dbx1}\FAND.CFG`.
