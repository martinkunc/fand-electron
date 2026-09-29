# PC FAND file formats and protection (as used by Účto 2026)

References are to the ALIS PC FAND 4.2 sources (`vendor/reference/alisoss_pcfand/pas`).
Everything below is implemented in `src/engine/fand/` and verified against the
Účto 2026.14 installation (`test/fand-io.test.ts`).

## Installation layout

The Inno Setup installer (`ucto2026_14.exe`, Inno 5.5.7) unpacks to one folder. Folder
names in braces are literal (`{glob}` global data, `{prik}` sample firm data, `{nova}`
new-firm templates, `{dbx1}` DOSBox, `{vdos}` vDos+, `{tisk}` Windows printing helpers).
The Windows version starts `UFAND.EXE ucto2026` (PC FAND 4.20 runtime, overlay
`UFAND.OVR`) under vDos+ or DOSBox. The DOSBox config prints into `{dbx2}\print#.prn`,
which the Windows helpers pick up.

## Data files (`.000`, `.001`, … any extension)

* Header 6 bytes: `NRecs: longint; RecLen: word`. `NRecs < 0` = indexed file ('X'),
  whose records start with a 1-byte deleted flag. '8' files have a 4-byte header.
* Field encodings (RDFILDCL.PAS / RECACC.PAS):
  * `A,n` – n chars CP852, space padded; `!` flag = XOR 0xAA.
  * `N,n` – packed BCD, high nibble first, (n+1)/2 bytes.
  * `F,l.m` – big-endian two's complement integer ×10^m, width `TabF[l+m]` bytes.
  * `R`, `D` – Turbo Pascal Real48; dates are day numbers from 1.1.0001.
  * `B` – 1 byte, 0 or 0xFF = false.
  * `T` – 4-byte position in the `.Txx` text file.
  * all bytes 0xFF = null.
* Index `.Xxx`: B-tree, 1024-byte pages (INDEX.PAS); rebuildable from data.

## Text files (`.T00`, `.TTT`, Účto's `.TRO`)

512-byte pages. Page 0 is a header (`TT1Page`, FILEACC.PAS) whose bytes 13..510 are
XORed with the Borland Pascal `Random(255)` stream seeded with
`(MaxPage+1)*512 + header[511]` (older files: bytes 13..52, seed `MLen`). The generator is
`seed := seed*134775813+1; r := (seed shr 16) mod 255`. Plain fields written after the
XOR: FreePart..MaxPage (4..26), Version (53, "4.20"), LicNr (458).

A text is `len: word` + bytes; texts longer than one page continue on chained pages, the
last 4 bytes of each page pointing to the next one.

`IRec >= $6000` marks a *licensed* file: every text position stored in records is
increased by `LicNr` (Účto: 29140, MODUL08: 15961). Positions ending in `…D4h` in the
RDB are this shift.

## Projects (`.RDB` + `.TTT`, Účto sub-projects `.PRO` + `.TRO`)

The RDB is a plain data file with 24-byte records, one per chapter (FANDMSG.TXT #51):
`TxtPos:F,4.0; Overit:B; StText:T; Typ:A,1; Nazev:A,12; Text:T`.
Chapter types: F file, D declarations (functions), P procedure, E edit form, R report,
M merge, U users/passwords, L Prolog, I/space comment (and H help in Účto).

## Protection

* Passwords are *not* keys. Password 1 (chapters) and 2 are stored '@'-padded in the
  decrypted header (`PwNew`, offset 471); they only gate opening the task for editing.
  Licensed files store random bytes as password 1.
* When password 1 is set, chapter texts are encoded:
  * `LicNr = 0`: XOR 0xAA (`Code`);
  * `LicNr ≠ 0`: `XDecode` (ACCESS.PAS): the source was first compacted
    (`CompressTxt`: comments and line breaks removed), then LZ77 compressed with a
    rotating XOR mask. Trailer `t:byte; Displ xor $CCCC: word`; mask starts at
    `rol($9C, t and 3)` and rotates left before each literal; a set flag bit is a
    back-reference `len:byte; pos:word` relative to the string start.
* All 5420 chapters of Účto 2026 (49 projects) decode.

Procedures, edit forms and reports are compiled from source when the task starts; only
F chapters keep a compiled field-descriptor segment (`StText`). There is no bytecode to
reverse-engineer: running Účto means compiling its FAND source.
