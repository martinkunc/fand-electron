# SETDATE.EXE – set the system date and time (DOS)

`SETDATE.EXE` in the app root (2.5 KB, Borland Pascal DOS program).

Priority **low**, effort **S**.

## How Účto calls it

`UCTO2026_RDB/0493_P_SetDate.txt` `proc SetDate`, called at start-up from
`0568_P_Program1.txt` when the system date is implausible:

```
if PARAM3.KoCfg then begin if ^(today in [17.11.1989..31.12.2040]) then proc(SetDate) else …
```

SetDate shows "Systémové hodiny ukazují datum …", offers "Změnit nastavení systémových hodin a
data", prompts date and time, then:

```
exec('SETDATE.EXE',strdate(d,'YYYY MM DD ')+strdate(t,'hh mm'));      { e.g. '2026 03 15 08 30' }
if PARAM3.Ano then proc(ObrDatum);
```

The exit code is not checked.

## What it does (inferred)

DOS `SetDate`/`SetTime` (INT 21h AH=2Bh/2Dh). Under NTVDM/vDos this changed only the virtual DOS
clock of the session.

## Replacement design

Never change the host clock. Key `setdate.exe` → set an **engine clock offset** (`today`,
`currtime` in the FAND runtime = host time + offset, persisted for the session only) and return
0. That reproduces the observable effect inside Účto (the DOS session clock) and doubles as a
test hook. If the offset is not implemented yet: no-op + exit 0.

## Test approach

Unit: args parsed into a date; engine test with a fake host date outside the range → SetDate
dialog appears; after confirming, FAND `today` returns the entered date.
