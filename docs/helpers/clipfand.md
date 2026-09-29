# ClipFand.exe – read the Windows clipboard into a file for FAND

`{tisk}\ClipFand.exe` (30 KB, native VB6, "kompilace 08.03.2017", form `frmClipFand`, module
`mdlGlob`, imports `kernel32!GetShortPathNameA`). Direction Windows → FAND; the reverse is
[FANDCLIP.EXE](fandclip.md).

Priority **medium** (paste from other applications into Účto), effort **S**.

## How Účto calls it

Single wrapper `UCTO2026_RDB/0185_P_ClipFand.txt`:

```
(var cbdW:string) begin EXE.Path:=PROGRAM.Path+'{TISK}\CLIPFAND.EXE';
TXT.Path:=PROGRAM.Path+'{TISK}\CLIPFAND.UUU'; puttxt(TXT,'');
with window(1,1,1,1) do proc(ExecWin,(EXE.Path,'$ '+TXT.Path));
if PARAM3.SyncW then proc(WaitFor,(TXT.Path,'CLIPFAND.EXE'));        { only DOSBox/vDos }
if exitcode<>0 & ^PARAM3.DOSBox then proc(Hlaseni,('Chyba '+str(exitcode,'0')+' při spuštění programu ClipFand'));
cbdW:=gettxt(TXT);
```

| | |
|---|---|
| Args | `$ <result file>` (`$` guard), result `{TISK}\CLIPFAND.UUU` |
| Output | clipboard content, **CP1250** (callers convert with `copyfile(…,mode='WL')`) |
| Exit | 0 ok; non-zero → error message |

Callers:

| Chapter | Use |
|---|---|
| `MODUL01_PRO/0002_P_TxtExit.txt` | text editor menu *"Vložit (Windows)"*: whole clipboard → `WL` → edit window → FAND `clipbd` |
| `UCTO2026_RDB/0485_P_VyberDir.txt`, `0192_P_Paths.txt` | *"Načíst jméno ze schránky"*: `s:=copyline(s,2)`; must look like `X:\…` else "Schránka Windows neobsahuje jméno souboru"; empty → "Schránka Windows je prázdná" |
| `UCTO2026_RDB/0078_P_ParFirmaEx.txt`, `0258_P_AdresyF7.txt` | F7 on the web-address field: line 1 → "Naplnit webovou adresu ze schránky Windows", strips `http(s)://www.` |
| `MODUL09_PRO/0430_P_khCJ.txt`, `UCTO2026_RDB/0324_P_KalkUpr.txt`, `MODUL97_PRO/0129_P_ParPoPrijEx.txt` | line 1 as a value to paste into a field / calculator |

## What it does (inferred)

* Writes the clipboard text (CF_TEXT, i.e. ANSI CP1250) into the result file.
* The "file name" callers read **line 2** and the other callers read line 1, and the binary
  imports `GetShortPathNameA`. Most likely layout when the clipboard holds a file (Explorer
  Ctrl-C = `CF_HDROP`, or text that is an existing path): line 1 = long path, line 2 =
  8.3 short path (DOS FAND cannot open long names). For ordinary text only the text is written.
  **Unverified** – confirm on Windows if exact parity matters.

## Replacement design

Same module as FANDCLIP (`src/engine/helpers/clipboard.ts`), key `clipfand.exe`.

* Ask the host for the clipboard (`clipboard.readText()`, plus the file flavour:
  Windows `clipboard.read('FileNameW')`, macOS `public.file-url`, Linux `text/uri-list` /
  `x-special/gnome-copied-files`).
* If a file is present (or the text, without surrounding quotes, is an existing host path):
  write `dosPath + CRLF + dosPath + CRLF`, where `dosPath = ctx.unmapPath(hostPath)` (the
  inverse of `ctx.mapPath`; paths outside the mapped drives cannot be expressed – then write
  the text only). Line 2 must satisfy Účto's `copy(s,2,2)=':\'` test.
* Else write the text with CRLF line ends.
* Encode **CP1250** (the callers convert W→L); unmappable characters → `?`.
* Return 0. Writing the file even when the clipboard is empty (0 bytes) is fine here: no
  `WaitFor` in our runtime (`SyncW=false`).

## Test approach

In-memory clipboard fixtures: Czech multi-line text (round trip through `copyfile WL` gives the
original), a copied file under a mapped drive (line 2 = DOS path), a quoted path from "Copy as
path", an unmapped path, empty clipboard. Engine test for `VyberDir → Načíst jméno ze schránky`.
