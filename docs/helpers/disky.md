# DISKY.EXE – list of Windows drives with their type

`{tisk}\DISKY.EXE` (30 KB, native VB6, form `frmDisky`, comment "Seznam připojených disků";
imports `GetLogicalDriveStringsA`, `GetDriveTypeA`).

Priority **low** (information menu; DOSBox auto-mount), effort **S**.

## How Účto calls it

`UCTO2026_RDB/0353_P_SeznamDiskW.txt` – menu **Ostatní → Speciality → Systémové informace → Disky →
Seznam disků Windows** (`0355_P_Disky.txt`, hidden in pure DOS):

```
FILE.Path:=PROGRAM.Path+'{TISK}\DISKY.EXE'; …
puttxt(UCTOTXT,'');
proc(ExecWin,(FILE.Path,UCTOTXT.Path));
proc(WaitFor,(UCTOTXT.Path,'DISKY.EXE'));
copyfile(UCTOTXT,SEST,mode='WL');                 { CP1250 → CP852 }
PARAM3.TxtHd:='SEZNAM DISKŮ WINDOWS'; proc(Ses);
if PARAM3.DOSBox then … for i:=1 to linecnt(s) do proc(MountDB,(copyline(s,i)));   { DOSBox: mount every drive }
```

| | |
|---|---|
| Args | `<result file>` |
| Result | CP1250 text, one drive per line; `MountDB` takes `copy(line,1,2)` as the drive (`C:`) |

## What it does (inferred from strings)

For each root from `GetLogicalDriveStrings`: `<root> : <type text>` where the text is one of
"Disketa.", "Vyměnitelný disk.", "Pevný disk.", "Připojený (síťový) disk.", "CD-ROM disk.",
"RAM disk.", "Typ disku nelze zjistit.", "Disk nemá hlavní adresář." (texts partly reconstructed
from UTF-16 fragments). Error → "Chyba programu Disky.".

## Replacement design

`src/engine/helpers/dostools.ts`, key `disky.exe`: write one line per **mapped** DOS drive letter
(`C:\ : Pevný disk. (<host path>)`), CP1250, CRLF. Showing host mounts (`/`, `/home`, network
shares) would only confuse because FAND can reach nothing else. The DOSBox auto-mount branch is
not taken in our runtime.

## Test approach

Unit: mapping table with `C:` and `D:` → two lines, CP1250 round-trip through `WL` gives the
Czech text.
