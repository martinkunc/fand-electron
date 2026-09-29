# FANDT602.EXE – convert a FAND print text to T602 (Text602)

`FANDT602.EXE` in the app root (5.5 KB, Borland Pascal DOS program). Strings: `HEAD602.UUU`,
`@FO`, `@TB -----T-----T…`, `@MT 0`, `@MB 2`.

T602 is the Czech DOS word processor format: plain text lines plus `@XX` dot-command lines. The
header template `HEAD602.UUU` (app root, CP852) is:

```
@CT 1            code table 1 = Latin 2 (CP852)
@LM 1  @RM 62  @PL 63  @TB -----T…  @MT 3  @MB 3  @HM 0  @FM 0  @PO 10  @PN 1  @OP  @LH 6  @HE  @FO
^Z
```

Priority **low** (legacy format, rarely useful today), effort **S**.

## How Účto calls it

Path `FANDT602.Path:=pgm+'FANDT602.EXE'`. `UCTO2026_RDB/0179_P_Fand602P.txt` `Fand602P(Soubor)`,
from the text viewer F10 menu, item *"602 - textový editor Text602"* (`MODUL01_PRO/0002_P_TxtExit.txt`, and
`Fand602P(UCTOTXT.path)` for the current editor content):

```
proc(Paths,('T602','602')); t602:=PARAM3.TrailAAA;
with window(1,1,1,1) do exec(FANDT602,'$ '+Trail(Soubor)+' '+t602,freemem,nocancel);
if exitcode=0 then begin FILE.Path:=t602;
  edittxt(FILE, head=TxtHead('PŘEVOD DO T602'), …, ww=(…,='PŘEVEDENÝ TEXT VE FORMÁTU T602',^A)); end;
```

| | |
|---|---|
| Args | `$ <source> <target .602>` |
| Output | CP852 T602 file: header from `HEAD602.UUU` (with `@MT 0`, `@MB 2`, `@FO` overridden – inference from the strings), then the text; afterwards shown in FAND's editor |

## What it does (inferred)

Copies the header, then the text. FAND control codes map to T602 inline codes (T602 uses the same
style: `^B` bold, `^S` underline, `^W` italic, `^Q` wide… are T602's own toggles, so they are
likely copied unchanged); `^L` → `@PA` page break (**unverified**).

## Replacement design

Key `fandt602.exe` in `src/engine/helpers/fandtext.ts`: write `HEAD602.UUU` (without the
trailing `^Z`, applying `@MT 0`, `@MB 2`, `@FO` overrides), then the source text with control codes
copied, `^L` → `@PA` line, CP852 bytes unchanged, CRLF. Exit 0/1/2 as FANDHTML.

## Test approach

Golden test against a hand-checked sample; open the result in the FAND editor path of the engine
(EngineDriver) to see "PŘEVEDENÝ TEXT VE FORMÁTU T602".
