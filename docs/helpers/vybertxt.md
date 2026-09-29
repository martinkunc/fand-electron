# VYBERTXT.EXE – extract a page range of a print text

`VYBERTXT.EXE` in the app root (5.3 KB, Borland Pascal DOS program; *vyber text* = select text).

Priority **medium** (printing selected pages), effort **S**.

## How Účto calls it

Path `VYBERTXT.Path:=pgm+'VYBERTXT.EXE'`. `UCTO2026_RDB/0177_P_TiskOdDoP.txt` `TiskOdDoP(Soubor)`,
from the text viewer print menu *"Vybrané strany ↑F6"* (`UCTO2026_RDB/0171_P_TxtExitT.txt`):

```
StrOd:=prompt(' Vytisknout úsek od strany: ':F,4.0:=1); StrDo:=prompt('                 do strany: ':F,4.0:=9999);
if StrOd>StrDo then StrDo:=StrOd;
with window(1,1,1,1) do exec(VYBERTXT,'$ '+trailchar(' ',Soubor)+' '+trailchar(' ',UCTOTXT5.Path)+' '+s1+' '+s2, freemem ,nocancel);
if exitcode=0 then edittxt(UCTOTXT5, head=TxtHead('VYBRANÉ STRANY'), …)
else proc(Hlaseni,('Chyba '+str(exitcode,0,0)+' při otevření souboru'));
```

(The many `VyberTxt` hits in `MODUL06_PRO/*F7.txt` are a different FAND procedure – a text
code-list picker – not this exe.)

| | |
|---|---|
| Args | `$ <source> <target> <from> <to>` (1-based, `to` may exceed the page count, default 9999) |
| Input/Output | FAND print text, CP852, pages separated by `^L` |

## Replacement design

Key `vybertxt.exe` in `src/engine/helpers/fandtext.ts`: split on 0x0C, keep pages
`from..min(to,n)`, join with 0x0C, write bytes unchanged. `from > n` → empty file, exit 0 (the
FAND side shows an empty text). Exit 1/2 on I/O errors.

Longer term the print dialog of our app can offer page ranges natively (PDF/OS print), making
SUDLICH/VYBERTXT unnecessary, but they are cheap to keep for parity.

## Test approach

Same fixtures as [sudlich.md](sudlich.md): ranges 1–1, 2–4, 3–9999, 7–9 on a 5-page text.
