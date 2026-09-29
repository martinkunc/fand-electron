# SETFILES.EXE – set `FILES=` in CONFIG.SYS / SYSTEM.INI (DOS, Windows 9x)

`SETFILES.EXE` in the app root (10 KB, Borland Pascal 7 DOS program, "(c) Alis 2003").
Its built-in help (strings, ASCII Czech):

```
Program SetFiles pro nastaveni parametru FILES v souboru CONFIG.SYS
nebo v dalsich odpovidajicich souborech podle verze op.systemu   (c) Alis 2003
Parametry:  - cislo  (pozadovany pocet files)
Navratove hodnoty exitcode:
  0 Ukonceni bez chyby, FILES nastaveno
  1 Ukonceni bez chyby, FILES nebylo treba nastavovat
  2 Chybny pocet parametru, nebo parametr neni cislo, nebo neni v intervalu [1,255]
  3 Nelze zalozit konfiguracni soubor
```

It edits `CONFIG.SYS`/`CONFIG.NT` (`FILES = n`, backup `CONFIG.$$0`) and `SYSTEM.INI`
(`[386Enh] PerVMFiles=`, backup `System.$$0`), locating the boot drive via `COMSPEC`.

Priority **low** (obsolete), effort **S** (stub).

## How Účto calls it

`UCTO2026_RDB/0495_P_SetFiles.txt`, only when `WinVer in ['D','9']` (pure DOS / Windows 9x):

```
with window(1,1,1,1) do exec('SETFILES','150',freemem,nocancel);
case exitcode=0: proc(HlaseniF1,(' Hotovo, v systému nastaven parametr files=150. …'));
     exitcode=1: proc(Hlaseni,('Beze změny, parametr files= byl správně nastaven už předtím.'));
     exitcode=2: message('chyba SETFILES: špatné parametry při volání programu');
     exitcode=3: message('chyba SETFILES: files= nelze nastavit');
```

Note the exe is referenced without extension (`'SETFILES'`) – the EXEC layer must resolve
`SETFILES` → `SETFILES.EXE` (DOS search order `.COM`, `.EXE`, `.BAT`).

## Replacement design

Not reached in our runtime (`WinVer='8'`, see [winverze.md](winverze.md)). Key `setfiles.exe` →
exit **1** ("nebylo třeba nastavovat"), which is the truthful answer. No files written.

## Test approach

Registry test incl. extension-less lookup of `SETFILES`.
