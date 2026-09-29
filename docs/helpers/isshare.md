# ISSHARE.EXE – detect SHARE.EXE and find it in .BAT files (DOS)

`ISSHARE.EXE` in the app root (5.1 KB, Borland Pascal DOS program).

Priority **low** (obsolete; reached only in pure DOS / Windows 3.1), effort **S** (stub).

## How Účto calls it

`UCTO2026_RDB/0370_P_Config1.txt`, menu *Systémové soubory → "SHARE.EXE v *.BAT"*, enabled only
when `os in ['','31']`:

```
with window(1,1,1,1) do exec('ISSHARE.EXE','$ *.BAT SHARE '+UCTOTXT.Path,freemem,nocancel);
case exitcode=1: message(' chyba ISSHARE: špatné parametry při volání programu');
     exitcode=2: message(' chyba ISSHARE: nelze otevřít soubor pro zápis výsledků hledání') …
else begin if (exitcode mod 8) div 4=1 then proc(Hlaseni,('Program SHARE je právě aktivní'))
           else proc(Hlaseni,('Program SHARE není nainstalován'));
     s:=gettxt(UCTOTXT);          { list of .BAT files containing SHARE }
     … selectstr … edittxt(TXT) with the cursor on 'share'
```

| | |
|---|---|
| Args | `$ <file mask> <word> <result file>` |
| Result | paths of files (matching the mask, searched on the disk – `:\` string suggests from the root) containing the word, one per line |
| Exit | 1 bad args, 2 cannot write; otherwise a bit mask where bit 2 (value 4) = SHARE resident (INT 2Fh AX=1000h) |

## Replacement design

Key `isshare.exe` → write an empty result, exit 0 ("SHARE není nainstalován", "…neobsahují
SHARE"). File locking is handled by the engine itself. Not reachable with `WinVer='8'`.

## Test approach

Registry test.
