# SETUPCP.EXE – installer of PDFCreatorPilot

`{tisk}\SETUPCP.EXE` (3 MB) is an **Inno Setup 5.3.5** installer "Doplněk pro vytváření PDF
dokumentů z Účta". Contents (`innoextract -l`): `sys/PDFCreatorPilot.dll` (4 MB, commercial PDF
library, licence key `54RPC-9RS3K-MYKHP-G98BE` embedded in ENESCHOP) and `sys/gdiplus.dll`.

Priority **low** (obsolete), effort **S**.

## How Účto calls it

Not directly from FAND code. It is listed in the file set Účto passes to
[UctoApep](uctoapep.md) (`UCTO2026_RDB/0634_P_UctoApep.txt`: `tisk+'SETUPCP.EXE'` for eDPN / eMH),
and [ENESCHOP](eneschop.md) starts it when PDFCreatorPilot is missing
("Nelze spustit instalaci PDFCreatorPilot protože chybí soubor {TISK}\SETUPCP.EXE.").

## Replacement design

Obsolete: PDF generation is done with pdf-lib in the replacements of those helpers. Key
`setupcp.exe` → no-op, exit 0 (should never be called). Keep the path string in UctoApep's
configuration untouched (it is only a file name there).

## Test approach

Registry test.
