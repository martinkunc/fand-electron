# setupe.exe – installer of the e-communication runtime libraries

`{tisk}\setupe.exe` (716 KB) is an **Inno Setup 5.5** installer "Doplněk pro e-komunikaci Účta"
(Tichý & spol.). `innoextract -l`:

```
sys/capicom.dll    (456 KiB)   CAPICOM – signing with certificates (ELPODPIS)
sys/msinet.ocx     (113 KiB)   Microsoft Internet Transfer Control (UCTOOL, UCTOFTP, UCTOFT98)
sys/msmapi32.ocx   (133 KiB)   MAPI controls (UEMAIL, UEMAIL06)
```

It copies and registers the COM components into the Windows system directory (needs UAC).

Priority **low** (obsolete), effort **S**.

## How Účto calls it

* `UCTO2026_RDB/0361_P_SysInfo.txt`, menu **Systémové informace → Knihovny setupe.exe**:
  `proc(Dotaz,(true,'Nainstalovat knihovny pro elektronickou komunikaci z účta (SETUPE.EXE)'));
  if PARAM3.Ano then proc(ExecWin,(PROGRAM.Path+'{TISK}\SETUPE.EXE',''));`
* Mentioned in the UCTOOL failure text (`MODUL01_PRO/0598_P_UctoOL.txt`): "na počítači chybí
  knihovna MSINET (nainstalujte ji z volby … Knihovny setupe.exe)".
* Started by [ELPODPIS.EXE](elpodpis.md) (`\setupe.exe` string) when CAPICOM is missing.

## Replacement design

Obsolete – every consumer is replaced by a Node implementation. Key `setupe.exe` → show
"Knihovny nejsou v této verzi potřeba" (`ctx.ui.message`) and return 0.

## Test approach

Registry test.
