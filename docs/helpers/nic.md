# NIC.EXE – do nothing

`NIC.EXE` in the app root (1.6 KB, Borland Pascal DOS program; *nic* = "nothing" in Czech). The
binary contains only the Turbo Pascal runtime – no strings, no file names, no messages.

Priority **low**, effort **S**.

## How Účto calls it

No reference in the decoded chapter sources, the `.BAT` files, `FAND.CFG`, the vDos/DOSBox
configurations or the help texts. It is most likely a placeholder program: something a batch or
a FAND.CFG print-manager entry ("Náhradní tisk (manažer)" → *Název programu*) can point to when
nothing should run.

## What it does (inferred)

Exits with code 0.

## Replacement design

Key `nic.exe` → exit 0 immediately (keeps any user configuration that names it working).

## Test approach

Registry test.
