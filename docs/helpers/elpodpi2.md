# ELPODPI2.EXE – post a signed GovTalk envelope to ČSSZ VREP (Rebex TLS)

`{tisk}\ELPODPI2.EXE` (19 KB, VB.NET, .NET 4.0 **console** exe, assembly `Elpodpi2`,
dated 2020-09, uses `Rebex.Http`). It is the transport half of
[ELPODPIS.EXE](elpodpis.md). It POSTs an already signed and encrypted GovTalk envelope
to the ČSSZ gateway, shows the result, and appends a record to `VREP.UUU`. It exists
because the VB6 program's WinInet transport cannot do TLS 1.2 on Windows XP/7.
Decompiled source: `work/decompiled/{tisk}_ELPODPI2/Elpodpi2/Program.cs`.

## How Účto calls it

**Not called from FAND code.** ELPODPIS.EXE starts it (strings `\ELPODPI2.EXE`,
`{TISK}`, `ELPODPI2.UUU` in ELPODPIS) when its parameter file carries the transport flag
`XP`. Účto sets that flag in `MODUL97_PRO/0262_P_eVrep2.txt` (and the dead branch of
`MODUL03_PRO/0355_P_eVrep.txt`):

```
wxp:=PARAM3.WinVer in ['W','V']; ep2:=PARAM3.ElPodp2;   { "odeslat programem ELPODPI2?" in ParPgm }
… cond(wxp | ep2:'XP') …                                  { 5th field of UCTOTXT3 for ELPODPIS }
```

`PARAM3.ElPodp2` is the option **"e-Podání VREP: odeslat programem ELPODPI2? (A/N)"** in
Parametry programu (`UCTO2026_RDB/0033_E_ParPgm.txt`). `WinVer='W'` also holds on
Windows 10/11, so in practice every ELPODPIS submission went through ELPODPI2.

Command line (from the decompiled `Main`; the values ELPODPIS passes are inferred from
its strings and the `VREP` record layout):

| argv | Meaning |
|---|---|
| 1 | path of the envelope file (probably `{TISK}\ELPODPI2.UUU` written by ELPODPIS), read with `ReadAllText` (UTF-8 default, ASCII/CP1250 content) |
| 2 | submission type → `VREP.Druh` (A12, e.g. `PVPOJ`, `NEMPRI`, `DZDPN`) |
| 3 | variable symbol → `VREP.VsČssz` (A10) |
| 4 | `O` = production, anything else = test gateway |
| 5, 6, 7 | Tiskopis, Období, Firma → the last three `VREP` fields |

Output: appends to **`VREP.UUU` in the current directory** (the Účto root, inherited
from FAND → ELPODPIS), CP1250, CRLF. Účto reads this file as `copyfile(TXT/var,VREP)`
(`MODUL99_PRO/0164_P_VrepUUU.txt`, "Seznam podání VREP"; also `0167_P_VrepDZ.txt`,
`0178_P_UctoDSF7.txt`, `0165_P_VrepUUUF7.txt`).

## What it does (decompiled C#)

1. `POST https://epodani.cssz.cz/VREP/submission` (argv4=`O`) or
   `https://t-epodani.cssz.cz/VREP/submission`, `Content-Type: text/xml`, body = the
   file content. `ContentLength` is set to the **character** count, so non-ASCII content
   would break. The envelope is ASCII anyway: base64 plus tags.
2. Non-200 → MsgBox "Podání se nepodařilo na VREP doručit."
3. Regexes (greedy, single line) on the response: `<Qualifier>(.*)</Qualifier>`,
   `<CorrelationID>…`, `<GatewayTimestamp>…`, `<Number>…`, `<Text>…`.
   * `acknowledgement` → MsgBox "Podání bylo přijato (ID: <corID>).\rVýsledek zpracování
     obdržíte e-mailem." and the record
     `'<druh>','<vs>','<corID>','<timestamp>','acknowledgement','','<tiskopis>','<obdobi>','<firma>'`
   * `error` → MsgBox "Podání bylo zamítnuto. Výsledek zpracování obdržíte e-mailem." and
     `'<druh>','<vs>','<corID>','<timestamp>','error','<Number>: <Text>','','',''`
   * anything else → "Neznámý typ odpovědi, podání nebylo přijato." (no record)
4. `WriteProtokol`: `File.AppendAllText("VREP.UUU", record+"\r\n", CP1250)`.
5. Exception → "Chyba programu ELPODPI2:\r<message>".

The `VREP` file declaration (`MODUL99_PRO/0161_F_VREP.txt`):
`Druh:A,12; VsČssz:A,10; Id:A,40; Datum:D,'YYYY-MM-DDThh:mm:ss.ttt'; Výsledek:A,30; Error:A,78; Tiskopis:A,30; Období:A,10; Firma:A,66`.
`GatewayTimestamp` (e.g. `2026-01-20T10:15:30.123`) fills `Datum`. FAND's `/var` text
import handles the apostrophe-quoted, comma-separated fields.

## Replacement design (Node/TypeScript)

No standalone helper. This is a ~30-line transport function, `vrepSubmitGovTalk()` in
`src/engine/helpers/vrep/govtalk.ts`, shared with the [ELPODPIS](elpodpis.md),
[ENESCHOP](eneschop.md) and ELDOTAZ replacements:

* `fetch` POST with `Content-Type: text/xml`, a 60 s timeout, UTF-8 body.
* Parse the reply with `fast-xml-parser` (`removeNSPrefix`): `Header/MessageDetails/Qualifier`,
  `CorrelationID`, `GatewayTimestamp`, `GovTalkErrors/Error/Number|Text`.
* `appendVrepRecord(root, fields)`: append to `<Účto root>/VREP.UUU` in CP1250 with CRLF,
  using the same apostrophe-quoted format. Replace any `'` inside a value with a space,
  because FAND's `/var` reader cannot handle it.
* Register `elpodpi2.exe` too, with the argv contract above, for the unlikely case that
  something runs it directly. It costs nothing once the function exists.
* Messages go through `ctx.ui.message`.

Still worth replacing on its own: **no.** It is only reachable through ELPODPIS, which
Účto uses only when `PARAM3.Apep=false`. That is not the default: `UPG_PRO` resets
`Apep:=true` on every upgrade. Also verify that ČSSZ still operates the legacy
`/VREP/submission` GovTalk endpoint; UctoApep uses the WS endpoint
`/VREP/ws/public.svc`.

## Test approach

* Mocked `fetch` with captured GovTalk responses: `acknowledgement` (with CorrelationID
  and GatewayTimestamp), `error` with `Number`/`Text`, an unknown qualifier, and HTTP 500.
  Assert the message texts and the exact CP1250 bytes appended to `VREP.UUU`.
* Round trip: append a record, then run `MODUL99/VrepUUU` in the engine and check that
  the edit shows Druh, Id, Datum and Výsledek.
