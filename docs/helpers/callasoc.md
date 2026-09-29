# CALLASOC.EXE – open a file with its associated program

`{tisk}\CALLASOC.EXE` (26 KB, 2010). A **native VB6** app, form `frmCallAsoc`, description
"Spustí asociovaný program pro zadaný soubor". Its only import beyond the VB runtime is
`shell32.dll!ShellExecuteA` with the verb `"open"`.

## How Účto invokes it

Wrapper `CallAssoc(Soub)`, `UCTO2026_RDB/0502_P_CallAssoc.txt`:

```
FILE.Path:=PROGRAM.Path+'{TISK}\CALLASOC.EXE';
if filesize(FILE)=-1 then begin proc(Hlaseni,('Program '+FILE.Path+' neexistuje')); exit end;
proc(ExecWin,(FILE.Path,Soub));
```

| | |
|---|---|
| Command line | the file path, unquoted (the rest of the command line = one path) |
| Working dir | the Účto program dir |
| Exit code | read by one caller: `FakturaI` treats `exitcode=2` as "no application for .isdoc" and turns the option off |

Callers:

| Chapter | What is opened | Feature |
|---|---|---|
| `UCTO2026_RDB/0586_P_CallWeb.txt` | `ADR03\UCTOURL.URL` containing `[InternetShortcut]\r\nURL=<adr>` | generic "open web page": help links, `CallWeb('https://jmhz.lyxa.cz/')` and many "… i" menu items |
| `UCTO2026_RDB/0584_P_AdrWeb.txt` | `UCTOURL.URL` (after putting text on the clipboard via FANDCLIP) | web searches for a firm (registers, maps) |
| `UCTO2026_RDB/0256_P_AdresySF6.txt` | `UCTOURL.URL` with `VetaA.Fax` (the Web field) | address book Shift+F6 → "Webová adresa" |
| `UCTO2026_RDB/0181_P_FandHtml.txt` | the `.HTM` produced by FANDHTML | "HTML" export of a text, when `PARAM3.Msie` |
| `MODUL06_PRO/0097_P_FakturaI.txt` | the ISDOC file `{MAIL}\<name>.isdoc` | invoice export ISDOC ("spustit"), when `PAR06A3.FaIsRun` |
| `MODUL06_PRO/0099_P_FaktPdfMail.txt` | the invoice PDF | invoice PDF when e-mail is off |

`CallWeb` escapes `&` as `^&` in DOSBox mode only (cmd batch quoting). In our runtime the
URL is taken verbatim.

## What it does (inferred)

`ShellExecute(0, "open", Command$, "", "", SW_SHOWNORMAL)`. If the result is ≤ 32 it
most likely exits with that code: 2 = `SE_ERR_FNF`, 31 = `SE_ERR_NOASSOC`. That fits
`FakturaI`'s `exitcode=2` check. Otherwise it exits with 0. It shows no UI.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/callasoc.ts`, key `callasoc.exe`.

1. `p = ctx.mapPath(args.join(' ').trim())`, stripping surrounding quotes.
2. If the extension is `.url`: read the file (CP852), take the `URL=` line under
   `[InternetShortcut]`, and call **`ctx.host.openUrl(url)`** (Electron
   `shell.openExternal`). Allow only `http:`, `https:` and `mailto:`; anything else →
   message and exit 1. This is the common case.
3. Otherwise, if the file does not exist → return **2**, as the original does, so
   `FakturaI` behaves. If it exists → `ctx.host.openPath(p)` (Electron `shell.openPath`,
   which resolves to the OS default app). A non-empty error string ("no application") →
   return **31**.
4. Return 0. Do not wait for the opened app.

In headless or test mode, `ctx.host` records the requests.

Still needed: **yes, high**. It opens every web link, the HTML/ISDOC exports and invoice
PDFs. Effort **S**.

## Test approach

* Unit: a `.URL` fixture (CRLF, CP852) → `openUrl('https://…')` with a query string that
  has `&`. A `javascript:` URL is rejected. A missing file → returns 2. An existing `.pdf`
  → `openPath`. A host error → 31.
* EngineDriver on `{prik}`: address book → Shift+F6 → "Webová adresa" on a firm with a
  web address → one `openUrl`.
* ISDOC flow: `FakturaI` with `FaIsRun=true` and a missing association (host mock returns
  an error) → the helper returns 31, not 2. Document that the option only switches off on
  2, which is the original behaviour.
