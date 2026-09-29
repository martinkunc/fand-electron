# UEMAIL06.EXE – e-mail helper, older VB6 / MSMAPI variant

`{tisk}\UEMAIL06.EXE` (38 KB, native VB6, internal name `UEmail`, version 1.00, comment
"Email z programu Účto"). Same program as [UEMAIL.EXE](uemail.md) in an earlier build (same
message strings, no build-machine environment block). Selected when `PARAM3.UEmail123='1'`
(`UCTO2026_RDB/0556_P_KatalogG.txt`, `0062_P_Param0.txt`).

Priority **low** (alias), effort **S**.

## How Účto calls it

Same as [UEmail17.exe](uemail17.md): `ExecWin(UEMAIL.Path, ADR03+'UEMAIL.UUU')`.

## What it does (inferred)

Reads `UEMAIL.UUU` (address / subject / space-separated attachments / body), warns about
missing attachments ("Následující přílohy neexistují …"), refuses an empty address ("Bez
vyplněné adresy nelze e-mail odeslat!") and opens the MAPI compose window through
`MSMAPI32.OCX`.

## Replacement design

Alias of the UEmail17 handler (`src/engine/helpers/uemail.ts`, key `uemail06.exe`). The
setting `UEmail123` keeps its meaning only as a label; all three values behave the same.

## Test approach

Registry test only (see [uemail17.md](uemail17.md)).
