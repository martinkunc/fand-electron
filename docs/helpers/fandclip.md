# FANDCLIP.EXE – put FAND text (or RTF) into the Windows clipboard

`{tisk}\FANDCLIP.EXE` (38 KB, native VB6, project `…\Moje pgm\clipboard\FandClip.vbp`,
modules `clsClipboard`, `clsData`, `clsConvert`, `mdlGlobal`; routines `ClipFandToWin`,
`MFandSoub`, `CtiFandTxt`, `FandTxtToClip`, `FormatRTF`; imports `user32!SetClipboardDataA`).
Direction FAND → Windows. The reverse direction is [ClipFand.exe](clipfand.md).

Priority **high** (every e-Podání flow copies the XML path for the upload form; text export to
Windows), effort **S**.

## How Účto calls it

Path: `FANDCLIP.Path:=PROGRAM.Path+'{TISK}\FANDCLIP.EXE'` (`UCTO2026_RDB/0556_P_KatalogG.txt`).
Always `proc(ExecWin,(FANDCLIP.Path,<file>))` – synchronous exec, one argument: a file whose
**content** goes to the clipboard. No result file.

Two usage patterns:

1. **Copy a text** – `UCTO2026_RDB/0184_P_FandClip.txt` `proc FandClip(Path)`, from the text
   viewer/editor menu *"Kopírovat vše → Windows"* and *"Kopírovat blok → Windows"*
   (`MODUL01_PRO/0002_P_TxtExit.txt`, the block goes through FAND's own `clipbd`):

   ```
   FILE.Path:=ADR03.Path+'FANDCLIP.UUU'; clip:=Path='';
   menu … of 'Formát .TXT   -': if clip then puttxt(FILE,clipbd) else begin TXT.Path:=Path; copyfile(TXT,FILE,nocancel) end;
             'Formát .RTF   -': begin rtf:=true; if clip then puttxt(UCTOTXT,clipbd);
                exec(TXTNARTF,'-l'+…+' '+cond(clip:UCTOTXT.Path,else:Path)+' '+FILE.Path,freemem,nocancel); end;
   proc(ExecWin,(FANDCLIP.Path,FILE.Path));
   if exitcode<>0 & ^PARAM3.DOSBox then proc(Hlaseni,('Chyba '+str(exitcode,0,0)+' při spuštění programu FandClip'))
   else proc(HlaseniF1,('Hotovo. Ve Windows vložíte obsah schránky do textu příkazem Ctrl-V.', …));
   ```

   `FANDCLIP.UUU` is either CP852 text (FAND report text, may contain FAND print control
   characters) or an RTF document produced by [TXTNARTF](txtnartf.md) (starts with `{\rtf1\`).

2. **Copy a short string (a file path, a URL fragment)** – the file holds one line, the user
   then presses Ctrl-V in the browser's upload dialog:

   | Chapter | What is copied |
   |---|---|
   | `MODUL03_PRO/0355_P_eVrep.txt`, `MODUL97_PRO/0262_P_eVrep2.txt`, `MODUL94_PRO/0115_P_eVrep94.txt` | path of the generated e-Podání XML (`puttxt(UCTOTXT,xp); ExecWin(FANDCLIP.Path,UCTOTXT.Path)`, status line `xp+' (Ctrl-V)'`) |
   | `MODUL97_PRO/0122_P_PZZD1.txt`, `0362_P_OznE.txt`, `0372_P_PojZamE.txt`, `0374_P_PojZamEvzp.txt`, `0376_P_PojZamEzpmv.txt` | path of the ČSSZ/ZP XML (e-Papír/e-Podání) |
   | `MODUL03_PRO/0298_P_DsVzp25.txt` | path of the VZP XML (after [Utf8](toutf8.md)) |
   | `MODUL04_PRO/0380_P_AntiCSV1.txt`, `0383_P_AntiCSV2.txt` | path of `{MAIL}\ANTI_*.CSV` (Antivirus A/B for ČSSZ) |
   | `MODUL08_PRO/0144_P_HlasExp.txt` | export file path (bank orders) |
   | `UCTO2026_RDB/0613_P_EpoDS.txt`, `0614_P_EpoFu.txt` | `PARAM3.DS3file` (XML to attach in the data box / EPO) |
   | `UCTO2026_RDB/0584_P_AdrWeb.txt` | a value (IČO, name…) before opening a web registry page via `UCTOURL.URL` + [CallAssoc](callasoc.md) |

## What it does (inferred from strings and callers)

* Reads the file named by the argument (`CtiFandTxt`).
* If the content starts with `{\rtf1\` (`FormatRTF`): registers the clipboard format
  "Rich Text Format" and puts the bytes there (plus plain text, inference).
* Otherwise converts CP852 → CP1250 (`clsConvert`; the callers never pre-convert) and sets
  `CF_TEXT`. FAND control characters (< 0x20 except CR/LF/TAB/FF) are presumably dropped –
  **unverified**; the path use case never contains them.
* Trailing CR/LF: callers write the path with `puttxt` (no newline), so no stripping is needed.
* Error: MessageBox "Chyba: …", exit code ≠ 0 (inference; Účto reports "Chyba N při spuštění
  programu FandClip").

## Replacement design

Module `src/engine/helpers/clipboard.ts`, keys `fandclip.exe` and `clipfand.exe`.

* `fandclip.exe <file>`: read bytes via `ctx.mapPath`. If they start with `{\rtf1`, write
  `{ rtf: latin1(bytes), text: rtfToPlain(bytes) }`; else decode CP852 (`cp852.ts` table), strip
  FAND control characters (keep `\r\n\t`), trim one trailing CRLF, write `{ text }`.
* Clipboard access lives in the Electron main process (`clipboard.write({text, rtf})`); the
  engine worker sends a request over the host channel and waits (Atomics) for the ack, so the
  exit code is known. Headless/test runs use an in-memory clipboard.
* Paths: when the content is a single line that `ctx.mapPath` recognises as a mapped DOS path
  (e.g. `C:\UCTO2026\{MAIL}\VZP.XML`), put the **host path** on the clipboard – the user pastes
  it into a native file dialog, so the Windows-style virtual path would be useless on
  Linux/macOS. This is the one deliberate behaviour change.
* Return 0 on success, 1 on read/clipboard failure.

## Test approach

* Unit (in-memory clipboard): CP852 text with Czech letters → correct Unicode; RTF fixture from
  TXTNARTF replacement → `rtf` flavour set; single-line mapped path → host path; control
  characters removed.
* Engine test: text viewer → "Kopírovat vše → Windows → Formát .TXT" ends with the "Hotovo…"
  message and the clipboard holds the report text.
