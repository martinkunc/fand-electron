# CONFIG2.EXE – set `FILES=` in CONFIG.NT / CONFIG.SYS (Windows)

`{tisk}\CONFIG2.EXE` (30 KB, native VB6, product `SETFILE2`, description "Úprava parametru FILES v
souboru CONFIG.SYS(NT)"; imports `GetSystemDirectoryA`, `GetVersionExA`; strings `CONFIG.SYS`,
`CONFIG.NT`, `REM nastaveni pro program UCTO firmy Tichy a spol.`, `FILES = $$$`, `FILES*=*#*`,
`PROGRAMFILES(X86)`). Windows counterpart of [SETFILES.EXE](setfiles.md).

Priority **low** (obsolete), effort **S** (stub).

## How Účto calls it

`UCTO2026_RDB/0495_P_SetFiles.txt`, menu **Systémové informace → Nastavit files=** and
**Havárie → "Nastavit files="** (`MODUL01_PRO/0604_P_Havarie.txt`), branch for Windows NT-family
(`WinVer` not `D`/`9`, not DOSBox/vDos):

```
proc(Hlaseni,('CONFIG2: zásah do systémových souborů může ovlivnit chování počítače'));
proc(Dotaz,(false,'Nastavit systémový parametr files=150 pro provozování účta'));
EXE.Path:='{TISK}\CONFIG2.EXE'; …
exec(EXE,'150',freemem,nocancel);
proc(Hlaseni,('Hotovo, doporučujeme restartovat účto'));
```

Args: the number of files (`150`). The exit code is ignored.

## What it does (inferred)

Finds `%SystemRoot%\System32\CONFIG.NT` (NTVDM's CONFIG.SYS; `C:\CONFIG.SYS` on 9x), replaces or
adds `FILES = 150` preceded by the REM marker line. Refuses on 64-bit Windows (`PROGRAMFILES(X86)`
set → no NTVDM).

## Replacement design

Obsolete: our engine has no DOS handle limit. Key `config2.exe` → no-op, exit 0 (Účto then says
"Hotovo, doporučujeme restartovat účto", harmless). Optionally log. Nothing is written.

## Test approach

Registry test: returns 0, touches no file.
