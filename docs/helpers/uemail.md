# UEMAIL.EXE – e-mail helper, VB6 / MSMAPI variant (2009)

`{tisk}\UEMAIL.EXE` (38 KB, native VB6, `MSVBVM60.DLL`, internal name `UEmail`, version 2.00,
"kompilace 16.12.2009", project path `…\Moje pgm\UCTOEMAIL\2010\`). Classes `frmEmail`,
`clsEmail`, `clsDbEmail`, `clsMAPImail`; uses the ActiveX controls `MSMAPI.MAPISession` /
`MSMAPI.MAPIMessages` from `MSMAPI32.OCX` (installed by [setupe.exe](setupe.md)).

Selected when `PARAM3.UEmail123` is neither `'1'` nor `'3'` (Programy parameter form). The
current default is `'3'` → [UEmail17.exe](uemail17.md).

Priority **low** (alias), effort **S** (no extra code).

## How Účto calls it

Identical to [UEmail17.exe](uemail17.md): `ExecWin(UEMAIL.Path, ADR03+'UEMAIL.UUU')`, same
callers, same 4-part exchange file (address, subject, space-separated attachments, body; CP1250
or ASCII without diacritics).

## What it does (inferred from strings; no decompiler for VB6 P-code/native here)

* Reads the parameter file given as the single argument (same layout as UEmail17 – the file is
  written by the same FAND code regardless of `UEmail123`).
* Messages found in the binary:
  "Bez vyplněné adresy nelze e-mail odeslat!" (empty line 1 → abort),
  "Následující přílohy neexistují a nebudou do e-mailu připojeny." (missing attachments are
  listed to the user, the rest is attached),
  "Chyba v programu ÚčtoEmail: …" (generic error box), caption "Hlášení...".
* Opens the compose dialog of the default MAPI client via `MAPIMessages.Send True`
  (inference: the OCX `Send` with dialog is the only usage pattern for these controls).
* No `;`/Cc handling is visible in the strings (**unknown**; treat as UEmail17).

## Replacement design

Register `uemail.exe` to the same handler as [UEmail17](uemail17.md). Differences worth
keeping: when line 1 is empty/`@.cz`, still create the draft (the user fills the address in the
client) – the VB6 refusal is not useful. Report missing attachments with `ctx.ui.message`
(this variant did).

## Test approach

Covered by the UEmail17 tests; add one test that `uemail.exe` and `uemail06.exe` resolve to the
same handler.
