# RO.EXE – set/clear the read-only attribute (inferred)

`RO.EXE` in the app root (4.1 KB, Borland Pascal DOS program). Strings are only runtime data
plus fragments `<1w` (compare a parameter character with `'1'`), `<\t(,@` (drive letter
from a path) and `:\` – the same path-parsing snippet as ISSHARE/SEARCHX.

Priority **low**, effort **S**.

## How Účto calls it

No reference in the decoded chapters, `.BAT` files or configuration. The FAND documentation shipped
with Účto (`UFANDHLP.T00`) discusses network access rights "RO" (read-only) for program files –
`FAND.*`, `(U)FANDHLP.*`, "datové soubory jen pro čtení – s DOS-atributem RdOnly". RO.EXE is
probably the vendor's tool to set (`1`) or clear (`0`) the DOS read-only attribute on the program
files of a network installation (**inference**).

## Replacement design

Key `ro.exe` → no-op, exit 0 (our app keeps the program payload read-only by packaging; user data
must stay writable). If ever needed: `RO <mask> 0|1` → `fs.chmod` removing/adding write bits.

## Test approach

Registry test.
