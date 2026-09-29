# TXTNARTF.EXE – convert a FAND print text to RTF (with frames)

`TXTNARTF.EXE` in the app root (72 KB, **Borland C++ 1991** DOS program, v1.12, "podpůrný
program pro PC Fand, distribuci zajišťuje firma ALIS spol. s r.o. Česká Lípa"). Built-in usage:

```
TXTNARTF.EXE [-k|-l|-p|-u[znak]|-9|-24|-hp|-97|-eSOU.DEF|-A3|-r|-s] zdroj [cil]
  -k     zdrojovy kod je Kamenik
  -l     zdrojovy kod je Latin 2 jinak CP1250
  -p     proporcionalni prevod ( nebere pak v uvahu prepinac ^P^U )
  -u     pro prepnuti do proporcionalniho fontu zvoli jiny prepinac
  -A3    nastavi format stranky A3
  -9     rozmery ramu pro 9 jehlickove tiskarny [-f]
  -24    rozmery ramu pro 24 jehlickove tiskarny
  -hp    rozmery ramu pro laserove a inkoustove tiskarny (implicitne)
  -97    rozmery ramu pro Word 97 nebo Word 2000
  -esoub pri problemech s ramy externi definice rozmeru znaku
  -r     vypne prevod ramu (jsou nahrazeny jen mezerami )
  -s     "sekane ramy" kazdy radek ramu se prevadi zvlast
  -w     ramy pro Windows95
  -m     mekke konce radku prevede na mezery
  -o     ignoruje odstrankovani
  zdroj  zdrojovy soubor
  cil    cilovy soubor, pokud se neuvede doplni se stejne jmeno jako zdroj jen koncovka je rtf
```

Output skeleton (strings): `{\rtf1\ansi\ansicpg1250\uc1{\fonttbl{\f0\fmodern Courier New CE;}
{\f1\froman Times New Roman CE;}{\f2\froman Symbol;}}`, A4 `\paperw11907\paperh16840\margl567
\margr567\margt1417\margb1417` or A3 landscape `\paperw23814\paperh16840 … \lndscpsxn`, font
sizes `{\fs%d …}`, bold `\b`, underline `\ul`, superscript, `\page`, `\par`, `\line`, `\tab`,
header/footer with `PAGE`/`DATE`/`TIME` fields, and **frames drawn as Word 95 drawing objects**
(`{\*\do\dobxcolumn\dobypara … \dprect / \dpline …}`) computed from the CP852 box characters.
Error texts: "chybne argumenty", "neni uveden zadny zdroj", "Chyba otevreni souboru zdroje/cile",
"Chyba - nedostatek pameti".

Priority **medium** (RTF export, RTF clipboard, RTF e-mail attachment), effort **M** (L for
pixel-exact frames).

## How Účto calls it

Path `TXTNARTF.Path:=pgm+'TXTNARTF.EXE'`. Flags from `PARAM3.Rtf` (4 chars: `A` = on):
1 bez rámečků → `-r`, 2 9-jehličková → `-9`, 3 24-jehličková → `-24`, 4 A3 → `-A3`.

| Chapter | Feature | Command |
|---|---|---|
| `UCTO2026_RDB/0186_P_FandRTF.txt` | text viewer F10 → *"RTF - Rich Text Format"* → dialog *Převod textu do RTF* (menu with frame/printer/page options, then a target path) | `Exec(TXTNARTF,'-l'+flags+' '+Soubor+' '+RTFcesta)`; `ExCode>127 → ExCode-256`; 0 → "Převedeno do …", else "Chyba převodu N" |
| `UCTO2026_RDB/0183_P_FandMail.txt` | e-mail attachment | `exec(TXTNARTF,'-l'+flags+' '+Path+' '+ADR03+'UEMAIL.RTF')`; non-zero → attachment dropped |
| `UCTO2026_RDB/0184_P_FandClip.txt` | *Kopírovat → Windows → Formát .RTF* | `…' '+src+' '+ADR03+'FANDCLIP.UUU'`, then [FANDCLIP](fandclip.md) |

All run with `window(1,1,maxcol,maxrow,@)` (the program prints a progress screen: "konverze",
"Zdroj : %s", "Cil : %s", "Delka : %ld", "Strana : n").

## Replacement design

`src/engine/helpers/txtnartf.ts` on top of the shared FAND-text tokenizer
(`src/engine/helpers/fandtext.ts`, see [fandhtml.md](fandhtml.md)); key `txtnartf.exe`.

* Parse the options above (only `-l -9 -24 -A3 -r` are used by Účto; accept and ignore the rest).
* Decode CP852 (`-l`), emit RTF with `\ansicpg1250` and `\uN?` escapes for every non-ASCII
  character (so encoding is never an issue), font table `Courier New` / `Times New Roman`.
* Control codes → `\b`/`\b0` (`^B`,`^D`), `\i` (`^W`), `\ul` (`^S`), `\fs` changes (`^E` 8 pt,
  `^A` 10 pt, `^Q` wide ≈ 20 pt, default 10–12 pt), `^L` → `\page`.
* Page setup: A4 portrait or A3 landscape with the margins above.
* Frames: default = keep box-drawing characters as Unicode glyphs in Courier New (renders well in
  Word/LibreOffice). `-r` = replace box characters with spaces (original behaviour). Word-95 drawing
  objects (`\do…`) are **not** reproduced (obsolete, badly supported by modern readers); the
  `-9/-24/-hp/-97` frame metrics are therefore ignored.
* Exit 0; negative codes as in the original (`255` → −1 in FandRTF) for open/write errors.
* No progress screen is needed (the conversion is instantaneous).

## Test approach

Fixtures as for FANDHTML. Assert: RTF parses (e.g. with a small RTF tokenizer or LibreOffice
`soffice --headless --convert-to txt` in an optional integration test), Czech text round-trips,
`-r` removes box characters, `-A3` sets landscape page size, `^L` count = `\page` count.
