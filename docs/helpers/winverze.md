# WINVERZE.EXE – report the Windows version (drives `PARAM3.WinVer`)

`{tisk}\WINVERZE.EXE` (26 KB, native VB6, "kompilace 11.11.2009", description "Zjišťování verze
Windows pro účely programu účto."; imports `GetVersionExA`, reads `COMSPEC`; strings `Vista`,
`Ostatni`, `Error`).

Priority **high** (runs at **every start**, and the resulting `WinVer` gates many code paths),
effort **S**.

## How Účto calls it

Start-up: `UCTO2026_RDB/0568_P_Program1.txt` → `proc(DosWin)` (`0363_P_DosWin.txt`):

```
proc(ExecDos,('ver >'+UCTOTXT.Path)); ver:=gettxt(UCTOTXT);
proc(ExecDos,('set >'+UCTOTXT.Path)); set:=gettxt(UCTOTXT);
PARAM3.AAA:=cond(pos('Windows 95',ver,'u')>0:'95', pos('Windows 98',ver,'u')>0:'98', pos('Windows NT',ver,'u')>0:'NT',
                 pos('Windows XP',ver,'u')>0:'XP', pos('Windows 2000',ver,'u')>0 | getenv('systemroot')<>~'':'2000',
                 pos('Windows Millennium',ver,'u')>0:'ME', pos('windir',set,'u')>0:'31');
PARAM3.Ano:=PARAM3.TrailAAA in ['','31'] & ^PARAM3.vDos;          { pure DOS / Win 3.1 }
if PARAM3.Ano | PARAM3.TrailAAA in ['95','98','ME'] then exit;
FILE.Path:=PROGRAM.Path+'{TISK}\WINVERZE.EXE'; if filesize(FILE)<=0 then exit;
puttxt(UCTOTXT,''); exec(FILE,UCTOTXT.Path,freemem,nocancel);
proc(WaitFor,(UCTOTXT.Path,'WINVERZE.EXE'));
s:=gettxt(UCTOTXT);
if pos('vista',copyline(s,1),'u')>0 then PARAM3.AAA:='Vista';
if copy(s,1,1)='7' then PARAM3.AAA:='7';
if copy(s,1,1)='8' then PARAM3.AAA:='8';
if copy(s,1,2)='10' then PARAM3.AAA:='1';
```

and back in `Program1`:

```
PARAM3.WinVer:=cond(PARAM3.Ano:'D', PARAM3.AAA in~['95','98','ME']:'9', PARAM3.AAA=~'Vista':'V',
                    PARAM3.AAA=~'7':'7', PARAM3.AAA=~'8':'8', else:'W');
```

| | |
|---|---|
| Args | `<result file>` |
| Result | line 1 starts with the version: `Vista…`, `7…`, `8…`, `10…`, otherwise e.g. `Ostatni` |

`WinVer` then selects: `NewWin:=WinVer in ['V','7','8','W']` (ExecDos goes through `CMD.EXE /C`),
`DiskSizW` vs `diskfree`, UCTOOL/UCTOFTP variant on first start
(`PARAM3.UOL:=cond(WinVer='8':'3',else:'1')`), firewall probe [WFDETECT](wfdetect.md) only for
`WinVer in ['W','V']`, XP `CmdXp` prompts for `'W'`, "Font pro Windows 7" only for `'7'`, the
SysInfo title.

Note that `'10'` maps to `AAA='1'` which falls into `else:'W'` ("Windows XP/2000/NT") – a quirk
of the chapter code.

## What it does (inferred)

`GetVersionEx` → writes a short name (`Vista`, `7`, `8`, `10`, `Ostatni`), possibly a second line
with `COMSPEC`.

## Replacement design

This helper, the DOS shell's `ver`/`set` output and the engine's `getenv` form one contract –
**the runtime identity Účto sees**. Recommended identity (decision for the engine owner):

* `getenv('uctodbox')` and `getenv('VDOSP_CONFIG')` empty → not DOSBox, not vDos
  (consistent with the other helper specs: `SyncW=false`).
* `ver` (DOS shell, see [bat-files.md](bat-files.md)) prints `Microsoft Windows [Version 10.0]`;
  `getenv('SystemRoot')` returns `C:\WINDOWS` → `AAA='2000'`, not DOS → WINVERZE is called.
* `winverze.exe` handler writes **`8\r\n`** → `WinVer='8'`: `NewWin` true, modern paths
  (UOL `'3'` = .NET helpers, no XP firewall probe, no CmdXp nagging), SysInfo shows
  "Windows 8/10". Writing `10` would be more truthful but lands in the XP branch (`'W'`).
* `SystemRoot` also determines `CMDEXE.Path` (`KatalogG`: `…\SYSTEM32\CMD.EXE`); the EXEC layer
  must recognise that path + `/C` as "run in the DOS shell".

Key `winverze.exe` in `src/engine/helpers/dostools.ts`; write CP1250/ASCII, exit 0.

## Test approach

Engine start test (EngineDriver): after start, `PARAM3.WinVer='8'`, `NewWin=true`,
`DOSBox=false`, `vDos=false`; SysInfo menu header reads "Windows 8/10". Unit: handler output.
