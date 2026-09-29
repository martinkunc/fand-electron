# UEmail17.exe – hand a prepared e-mail to the default mail client

`{tisk}\UEmail17.exe` (30 KB, .NET 4 WinForms, assembly `UEmail3`, product "UEmail17").
It is the **default** e-mail helper (`PARAM3.UEmail123='3'`; the older VB6 variants
[UEMAIL.EXE](uemail.md) and [UEMAIL06.EXE](uemail06.md) read the same file).
It does not send anything itself: it opens a new-message window of the default MAPI
client (Outlook, Thunderbird …) prefilled with recipient, subject, body and attachments.
Decompiled source: `work/decompiled/{tisk}_UEmail17/`.

Priority **high** (every "e-mail do Windows" action in Účto ends here), effort **M**.

## How Účto calls it

The helper path is chosen once in `KatalogG` (`UCTO2026_RDB/0556_P_KatalogG.txt`) and again
after editing parameters in `Param0` (`0062_P_Param0.txt`, form *Programy*):

```
if UEMAIL.Volume=~'' then UEMAIL.Path:=ADR03.Path+cond(PARAM3.UEmail123='1':'{TISK}\UEMAIL06.EXE',
                                                   PARAM3.UEmail123='3':'{TISK}\UEMAIL17.EXE',
                                                   else:'{TISK}\UEMAIL.EXE');
```

All callers write the exchange file `ADR03.Path+'UEMAIL.UUU'` and run
`proc(ExecWin,(UEMAIL.Path,FILE.Path))` (a synchronous `exec(EXE,path,nocancel)` in our
non-DOSBox runtime). There is no `WaitFor` and no result file.

| Caller (work/source/…) | Feature |
|---|---|
| `UCTO2026_RDB/0531_P_UEmail.txt` `proc UEmail(Eml)` | generic: `puttxt(ADR03+'UEMAIL.UUU',Eml); ExecWin(UEMAIL.Path,…)`; on `exitcode<>0` shows "Chyba N při vytváření e-mailové zprávy" |
| `UCTO2026_RDB/0182_P_MailFile.txt` `MailFile(Adr,Subj,File,Body)` | builds the 4 parts, converts with `copyfile(…,mode='LW')`, calls `UEmail` – used by e-Podání/eVrep flows (`MODUL03_PRO/0355_P_eVrep.txt`, `MODUL97_PRO/0262_P_eVrep2.txt`, `MODUL94_PRO/0115_P_eVrep94.txt`, `UCTO2026_RDB/0614_P_EpoFu.txt`) |
| `UCTO2026_RDB/0183_P_FandMail.txt` `FandMail(Path)` | **F10 → "e-mail do Windows" in the text viewer/editor** (`MODUL01_PRO/0002_P_TxtExit.txt`): any printed report as mail body and/or RTF/HTM/PDF attachments |
| `UCTO2026_RDB/0534_P_DataMail.txt` | Zálohování → send the data backup (`<name>.<yy>2B/T/Z`) as three attachments |
| `MODUL02_PRO/0093_P_DopisyTisk1.txt`, `0094_P_DopisyTiskV.txt` | letters/invoices (Dopisy): PDF attachment + text of the letter |

`FandMail` excerpt (the most complex producer):

```
eml:=Trail(cond(adr=~'':'@.cz',else:adr))+'\13\10'+ Trail(subj)+'\13\10'+
     XPath(Trail(cond(rtf:prefix+'UEMAIL.RTF ')+cond(htm:prefix+'UEMAIL.HTM ')+cond(pdf:prefix+'UEMAIL.PDF ')))+'\13\10';
eml:=eml+cond(PARAM3.EmlTxt1<>'':PARAM3.EmlTxt1+'\13\10')+cond(txt:gettxt(ODKUD)+'\13\10')+PARAM3.EmlTxt2;
puttxt(UCTOTXT,eml); FILE.Path:=prefix+'UEMAIL.UUU';
if bez then copyfile(UCTOTXT,FILE,mode='LN') else copyfile(UCTOTXT,FILE,mode='LW');
proc(ExecWin,(UEMAIL.Path,FILE.Path));
```

Attachments are produced before the call by [TXTNARTF](txtnartf.md) (`UEMAIL.RTF`),
[FANDHTML](fandhtml.md) (`UEMAIL.HTM`) and FAND2PDF/PDFTISK2 (`UEMAIL.PDF`), all in `ADR03`
(the station directory, i.e. the app root in a single-user install).

### Exchange file `UEMAIL.UUU`

| Line | Content |
|---|---|
| 1 | recipient address(es). `a@b.cz` or `to;cc` (see below). `@.cz` is Účto's placeholder for "empty" |
| 2 | subject |
| 3 | attachment paths separated by **single spaces** (`XPath` is identity outside DOSBox). May be empty |
| 4… | body, CRLF lines, to EOF |

* Encoding: **CP1250** (`copyfile mode='LW'` = Latin2→Windows) or plain ASCII with diacritics
  stripped (`mode='LN'`, option "Diakritika ne"). `DataMail` converts only when the text has
  diacritics. `MailFile` always uses `LW`.
* Paths cannot contain spaces (the separator); DOS 8.3 paths make that true in the original.
* `PARAM3.XmlEmlAdr` makes `MailFile` put the firm's own address (`PARAM2.eMail`) in line 1.

## What it does (decompiled C#)

* `Program.Main`: exactly one argument, else MessageBox "Chybný počet vstupních parametrů."
  and exit; the file must exist, else "Cesta k souboru … neexistuje.". Exit code is always 0
  (WinForms `Application.Exit`, no `Environment.ExitCode`).
* `Form1.ParseParams`: `StreamReader(file, Encoding.GetEncoding(1250))`, line by line:
  * line 0: `Split(';')`. One part → `To`. More parts → `To = parts[0]` (or `";"` when empty),
    `Cc = parts[1]` if its length > 1.
  * line 1 → `Subject`; line 2 → `Attachements = line.Split(' ')`.
  * line 3 → body = line 3 + `"\n\r"` (sic) + `ReadToEnd()`.
* `CreateMessage` (Simple MAPI, `MAPI32.DLL`): recipient `To` (MAPI_TO, name only, no address,
  so the client resolves it), optional `Cc` (MAPI_CC); every attachment path that
  `File.Exists` is attached, others are **silently skipped**; `Thread.Sleep(1000)`; then
  `MAPISendMail(session=0, …, flags=MAPI_DIALOG)` – the client shows the compose window, the
  user sends it. Errors other than "User abort" → MessageBox "Chyba: <MAPI error text>".
* UI: a small window "Připravuji zprávu pro odeslání ...", closed after MAPISendMail returns.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/uemail.ts`, registered as `uemail17.exe`, `uemail.exe`,
`uemail06.exe` (same exchange file for all three).

1. **Parse** `UEMAIL.UUU` (`ctx.mapPath(args[0])`), decode CP1250 (`TextDecoder('windows-1250')`),
   split lines on `\r\n|\n`. Apply the `;` → To/Cc rule. Treat `@.cz` / `;` as empty.
   Attachments: `line3.split(' ').filter(Boolean).map(ctx.mapPath)`, keep existing files only
   (log the missing ones; UEMAIL.EXE told the user, UEmail17 did not).
2. **Deliver** – three strategies, chosen by an engine setting `mail.mode`:
   * `compose` (default, parity): create an RFC 822 draft and open it in the user's client.
     Build the MIME message with **nodemailer's `MailComposer`** (`nodemailer/lib/mail-composer`),
     `textEncoding: 'quoted-printable'`, UTF-8, `X-Unsent: 1` header. Write
     `<tmp>/ucto-mail-<ts>.eml` and `ctx.host.openPath()` it. Outlook, Thunderbird, Apple Mail
     and Evolution open `.eml` with `X-Unsent: 1` as an editable draft. Cross-platform, keeps
     attachments. (A `mailto:` URL cannot carry attachments, so it is only the fallback when no
     attachment exists and the `.eml` open fails.)
   * `smtp`: send directly with **nodemailer** SMTP transport (host/port/user/password/From in
     app settings; password in the OS keychain via Electron `safeStorage`). Before sending, show
     a confirmation dialog (renderer modal: To/Cc/Subject/attachments, editable) because the
     original always let the user review the message.
   * `mapi` (Windows only, optional later): call Simple MAPI through a tiny native bridge; not
     needed for v1.
3. Body: the original produced `line3 + "\n\r" + rest`; normalise to CRLF-joined text.
4. **Return 0** (Účto shows an error on non-zero). If the host cannot open the draft, show
   `ctx.ui.message('Chyba: …')` and still return 0, matching the original which only showed a box.
5. Engine-side: the call is synchronous in Účto; the helper must not block the worker on the
   renderer dialog longer than needed (ask the host, wait for the "draft opened" ack only).

## Test approach

* Fixtures: `UEMAIL.UUU` samples in CP1250 generated by running the real producers in our
  engine (FandMail with RTF+HTM+PDF, DataMail with 3 backup files, MailFile from eVrep), plus
  hand-made edge cases: `to;cc`, empty line 3, missing attachment, `@.cz`, `mode='LN'` ASCII.
* Unit: parser output (To/Cc/Subject/attachments/body) matches the C# rules above; `.eml`
  produced by MailComposer contains the Czech subject (RFC 2047) and every existing attachment
  with the right filename; `X-Unsent: 1` present.
* Integration: with a fake `ctx.host.openPath` assert the `.eml` path; with nodemailer's
  `jsonTransport`/`streamTransport` assert SMTP mode without network.
