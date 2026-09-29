# REGISTER.EXE – default printer and OS information from the registry

`{tisk}\REGISTER.EXE` (30 KB, native VB6, comment "Informace o tiskárně a OS"; imports
`RegOpenKeyExA`, `RegQueryValueExA`, `GetVersionExA`; keys
`Software\Microsoft\Internet Explorer\PageSetup`, `SYSTEM\CurrentControlSet\Control\Print\Printers`,
values `Datatype`, `PrintersMask`; strings `Windows 95/98/ME/NT/2000`, `\REGISTER.TXT`).

Priority **low** (information only), effort **S**.

## How Účto calls it

`UCTO2026_RDB/0352_P_ReadReg32.txt` `ReadReg32(var Reg)`, from `0351_P_InfoPC.txt` – menu
**Ostatní → Speciality → Systémové informace → Počítač** (report `SysInfo`):

```
Reg:='\13\10\13\10\13\10\13\10\13\10';
FILE.Path:=PROGRAM.Path+'{TISK}\REGISTER.EXE'; if filesize(FILE)=-1 then exit;
TXT.Path:=PROGRAM.Path+'{TISK}\REGISTER.TXT'; puttxt(TXT,'');
proc(ExecWin,(FILE.Path,''));
if exitcode<>0 & ^PARAM3.DOSBox then exit;
proc(WaitFor,(TXT.Path,'REGISTER.EXE'));
copyfile(TXT,UCTOTXT,mode='WL'); s:=gettxt(UCTOTXT); … if linecnt(s)<5 then exit;
Reg:='řazení DOS úloh do fronty: '+cond(copyline(s,1)=~'A':'zapnuto',copyline(s,1)=~'N':'vypnuto',else:'nezjištěno')+'\13\10'+
     'port: '+copyline(s,2)+'\13\10'+ 'název tiskárny: '+copyline(s,3)+'\13\10'+ 'formát dat: '+copyline(s,4)+'\13\10'+
     'formát papíru A4: '+cond(copyline(s,5)=~'A':'ano',…)+'\13\10'+
     'orientace papíru: '+cond(copyline(s,6)=~'A':'normální (na výšku)',copyline(s,6)=~'N':'LandScape (naležato)',…)+'\13\10'+
     'verze Windows: '+copyline(s,7)+'\13\10'+ ''+copyline(s,9,100);
```

| | |
|---|---|
| Args | none; output fixed at `{TISK}\REGISTER.TXT` (exe directory) |
| Result | CP1250 lines: 1 spool DOS jobs `A/N`, 2 port, 3 default printer name, 4 data type (`RAW`/`EMF`), 5 paper A4 `A/N`, 6 portrait `A/N`, 7 Windows version, 8 (not shown), 9… extra lines appended verbatim |

## Replacement design

`src/engine/helpers/dostools.ts`, key `register.exe`. Ask the host for the printer list
(Electron `webContents.getPrintersAsync()` → default printer `name`, `options`/`status`) and write:
`N`, `-` (no ports in our print path), `<default printer or empty>`, `RAW`, `A` (we render A4),
`A`, `<os.type() os.release()>`, empty, then `Electron <version>, Node <version>`. Always ≥ 5
lines so Účto shows the block. CP1250, exit 0. The values only feed the info report; the real
print settings live in our print pipeline (see [print-spool.md](print-spool.md)).

## Test approach

Unit with a stubbed printer list (and with none): file has ≥ 5 lines, CP1250 round trip.
