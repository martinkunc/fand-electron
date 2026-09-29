# DISKSIZW.EXE – capacity / free / used space of a drive (Windows)

`{tisk}\DISKSIZW.EXE` (30 KB, native VB6 "DiskSizeW", "kompilace: 08.04.2005", form
`frmDiskSpace`; imports `GetDiskFreeSpaceA`, `GetDiskFreeSpaceExA`, `GetVersionExA`).
The Windows counterpart of the DOS [DISKSIZE.EXE](disksize.md) (which cannot report more
than 2 GB).

Priority **medium** (backup free-space display, upgrade, Informace → Počítač/Disky), effort **S**.

## How Účto calls it

Wrapper `UCTO2026_RDB/0489_P_DiskSizW.txt` `proc DiskSizW(Disk)`:

```
PARAM3.Ano:=false; FILE.Path:=PROGRAM.Path+'{TISK}\DISKSIZW.EXE'; …
puttxt(UCTOTXT,'');
proc(ExecWin,(FILE.Path,Disk+': '+UCTOTXT.Path));
proc(WaitFor,(UCTOTXT.Path,'DISKSIZW.EXE'));
s:=gettxt(UCTOTXT); s:=replace(',',s,'.');
PARAM3.F1:=val(copyline(s,1)); PARAM3.F2:=val(copyline(s,2)); PARAM3.F3:=val(copyline(s,3));
PARAM3.Ano:=PARAM3.F1>0;
kap:=PARAM3.F2; jedn:='MB'; … if kap>kilo then begin jedn:='GB'; kap:=kap/kilo end;
PARAM3.AAA:=leadchar(' ',str(kap,maska))+' '+jedn;
```

| | |
|---|---|
| Args | `<letter>: <result file>` (no `$` guard), e.g. `C: C:\UCTO2026\{STAN}\UCTO.TXT` |
| Result | 3 lines: F1 = capacity in **MB**, F2 = free MB, F3 = used MB; decimal separator **comma** (Czech locale; the wrapper replaces `,`→`.`) |
| Sync | `WaitFor` – waits until the file is non-empty (and stable if ≥ 1000 bytes) |

Callers: `0351_P_InfoPC.txt` (free space of the data drive in "Počítač"), `0354_P_VsechnyDisky.txt`
(every letter A–Z with `diskfree(d)>=0` → table "DOSTUPNÉ DISKY (WINDOWS)" capacity + % free),
`0355_P_Disky.txt` (menu Informace → Disk, diskety → Volné místo na disku), `0457_P_BkpZal.txt`
(free space shown before a backup), `0473_P_BkpDel13.txt`, `UPG_PRO/0023_P_UpgradeL1.txt`
(space check before upgrade, `d:=PARAM3.F2*MB`). All these take the Windows branch because our
runtime reports `WinVer<>'D'`.

## What it does (inferred)

`GetDiskFreeSpaceExA("X:\")` → total, free-to-caller, used; divides by 1 048 576; writes with the
locale decimal separator. Error → MessageBox "Chyba programu DiskSizeW (ZapisVysledek). Číslo: …".

## Replacement design

`src/engine/helpers/dostools.ts`, key `disksizw.exe`.

* `root = ctx.mapPath(letter + ':\\')`; unmapped letter → write `0\r\n0\r\n0\r\n` (F1=0 → Účto
  shows "nepodařilo zjistit") – the file must not stay empty because of `WaitFor`.
* `fs.statfsSync(root)` (Node ≥ 18.15): `total = blocks*bsize`, `free = bavail*bsize`,
  `used = total - bfree*bsize`. Write each as MB with 1–2 decimals and a **comma**
  (`(n/1048576).toFixed(2).replace('.',',')`), CRLF.
* Exit 0.

Also note FAND's own `diskfree(letter)` (used to enumerate letters) must answer for the
mapped drive letters only; our engine decides which letters exist (`C:` = the mapped Účto root,
others from settings).

## Test approach

Unit with an injected `statfs` stub (2 TB disk: values > 2^31, comma formatting), unmapped
letter → zeros; engine test of *Disky → Dostupné disky* producing the table.
