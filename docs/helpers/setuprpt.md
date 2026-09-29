# SETUPRPT.EXE – installer of the VB6 DataReport runtime

`{tisk}\SETUPRPT.EXE` (664 KB) is an **Inno Setup 5.4.2** installer "Doplněk pro tisk do
poštovních tiskopisů z Účta". Contents: `sys/MSDBRPTR.dll` (Microsoft Data Report runtime) and
`sys/MSSTDFMT.dll` (standard data formats) – the VB6 components used by POSTTISK.

Priority **low** (obsolete), effort **S**.

## How Účto calls it

Not from FAND code. `{tisk}\POSTTISK.EXE` (postal forms – poštovní poukázky) contains
`\SETUPRPT.EXE` and the message "… soubor {TISK}\SETUPRPT.EXE." – it offers the installation when
the DataReport runtime is missing.

## Replacement design

Obsolete once POSTTISK is replaced (see the POSTTISK spec). Key `setuprpt.exe` → no-op, exit 0.

## Test approach

Registry test.
