# Ares2.exe – company lookup in the ARES register

`{ap02}\Ares2.exe` (27 KB, .NET Framework 4.0 WinExe, uses Rebex.Http for TLS 1.2 and
`System.Web.Script.Serialization.JavaScriptSerializer`). It looks up one IČO in ARES,
the Czech register of economic subjects, and writes a fixed 8-line text file.
Decompiled source: `work/decompiled/{ap02}_Ares2/`.

## How Účto calls it

| | |
|---|---|
| Wrapper | procedure `Ares2(Form:boolean; VetaA:record of ADRESY)`, `work/source/UCTO2026_RDB/0265_P_Ares2.txt` |
| Parameter file | report `Ares2`, `0264_R_Ares2.txt`, writes `{ap02}\ARES2.XML` |
| Command line | none (`ExecWin(EXE.Path,'')`) |
| Working dir / config lookup | the exe resolves `Ares2.xml` against its own directory (`AppDomain APP_CONFIG_FILE`), so it must sit in `{ap02}` next to the exe |
| Output | `{ap02}\ARES2.TXT` (the path comes from the XML) |
| Log | `{ap02}\ARES2.LOG` (appended, only on error) |
| Exit code | not used by Účto. The exe returns 0, or 1 from `Environment.Exit(1)` when writing fails |

Entry points (menus):

* Address book (`ADRESY`), F10 menu item **"Registr firem ARES"**
  (`0266_P_AdresyF10.txt`: `proc(Ares2,(formulář,VetaA))`). It is also bound to F10
  inside the new-address edit (`0268_P_AdresyExit.txt`: `F10:Ares2(true)`).
* Company parameters (`PARAM2`), edit break 30 in `0078_P_ParFirmaEx.txt`: it calls
  `proc(Ares2,(false,VetaA))` with `VetaA.Firma:='PARAM2'`, then copies the result into
  `PARAM2`.

Calling code, condensed from `0265_P_Ares2.txt`:

```
pth:=PROGRAM.Path+'{AP02}\'; EXE.Path:=pth+'ARES2.EXE';
if filesize(EXE)<=0 then begin proc(Hlaseni,('Program '+EXE.Path+' nenalezen')); exit end;
...
proc(PromptA,('IČ firmy pro hledání v registru ARES',8,ič,ič));
with window(0,0,54,1,='',^Q) do begin write(' Čekáme na odezvu registru ekonomických subjektů ARES');
  TXT.Path:=pth+'ARES2.TXT'; puttxt(TXT,'');
  PARAM3.TTT:=TXT.Path+crlf+ Trail(ič)+crlf+ pth+'ARES2.LOG';
  FILE.Path:=pth+'ARES2.XML'; report(,Ares2,assign=FILE);
  proc(ExecWin,(EXE.Path,''));
  if PARAM3.SyncW then proc(WaitFor,(TXT.Path,'ARES2.EXE'));
end;
if filesize(TXT)<=0 then begin proc(Hlaseni,('Nepodařilo se načíst data z registru ARES pro IČ '+ič)); ... exit end;
s:=gettxt(TXT);
case copyline(s,7) in~['101'..'108']: VetaI.Jmeno:=copyline(s,1); else VetaI.Firma:=copyline(s,1); end;
VetaI.Ulice:=copyline(s,2); VetaI.Misto:=upcase(copyline(s,3)); VetaI.Psc:=copyline(s,4);
VetaI.Ico10:=copyline(s,5); VetaI.Dic:=copyline(s,6); VetaI.PlatDPH:=copyline(s,8)=~'A';
if VetaI.PlatDPH & VetaI.Dic<>~'' then ... proc(AdrNePl1,(VetaI.Dic));   { -> Nepl2.exe, bank accounts }
```

After that, Účto shows the fetched record in an edit window and offers a merge menu
("Přepsat jen údaje z registru…", "Převzít z ARES jen DIČ", and so on). If the subject
is a VAT payer, Účto chains to [Nepl2.exe](nepl2.md) to fill `Ucet` with the published
bank account(s).

### `ARES2.XML` (written by report `Ares2`)

Placeholders `_` are filled in order from `copyline(PARAM3.TTT,1..3)`: the output path,
the IČO and the log path.

```xml
<?xml version="1.0" encoding="utf-8" ?>
<configuration>
<appSettings>
<add key="outputEncoding" value="852" />
<add key="outputFilename" value="C:\UCTO2026\{AP02}\ARES2.TXT" />
<add key="regNo" value="27082440" />
<add key="logFilename" value="C:\UCTO2026\{AP02}\ARES2.LOG"/>
</appSettings>
</configuration>
```

FAND writes the file in its native code page (CP852), even though the declaration says
UTF-8. Only the paths can hold non-ASCII bytes. The replacement must decode the file as
CP852 and ignore the declaration.

## What it does (from the decompiled C#)

1. It loads `regNo`, `outputFilename`, `logFilename` and `outputEncoding` (default
   1250; only 852 and 1250 are accepted, anything else becomes 1250). An empty `regNo`
   or one longer than 8 characters throws, and the exception goes to the log.
2. `GET https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/{regNo}`
   over TLS 1.2, with no headers beyond the defaults. It deserializes the JSON into
   `AresSubject`. Property matching is case-insensitive, so `obchodniJmeno` maps to
   `ObchodniJmeno`.
3. On an HTTP error it reads the error JSON `{kod, popis, subKod}` and shows a
   **MessageBox** ("Zpráva z ARES:\r\nKód:…\r\nSubkód:…\r\nPopis:…", title "Ares2",
   error icon). Nothing is parsed, and `Save` then **deletes** the output file, so
   Účto sees `filesize<=0` and reports "Nepodařilo se načíst data…".
4. `Save` writes 8 lines (CRLF, `StreamWriter.WriteLine`, a null value gives an empty
   line) in the chosen code page (852 from Účto):

| line | value | JSON source |
|---|---|---|
| 1 | business name | `obchodniJmeno` |
| 2 | street + house number | `(sidlo.nazevUlice ?? sidlo.nazevCastiObce) + ' ' + sidlo.cisloDomovni + (sidlo.cisloOrientacni ? '/' + cisloOrientacni : '')` |
| 3 | municipality | `sidlo.nazevObce` |
| 4 | postcode | `sidlo.psc` (a JSON number, printed as digits, e.g. `11000`) |
| 5 | IČO | `ico` |
| 6 | DIČ | `dicSkDph` if non-empty, else `dic` prefixed with `CZ` when the prefix is missing, else empty |
| 7 | legal form code | `pravniForma` (e.g. `101` for a sole trader, `112` for an s.r.o.) |
| 8 | VAT registration | `A` if `seznamRegistraci.stavZdrojeDph == "AKTIVNI"`, else `N` |

Notes and quirks to keep:

* `cisloOrientacniPismeno`, `adresaDorucovaci` and `czNace` are parsed but not written.
* If `sidlo` or `seznamRegistraci` is missing, a NullReferenceException is logged
  and the process exits with code 1. The output file may then be partial or empty
  (the StreamWriter is not closed). The replacement should write nothing in that
  case, or write the lines it can and leave line 8 as `N`. The recommended behaviour
  is to write every line with empty strings for missing values.
* Log line format: `dd.MM.yyyy - hh:mm | Chyba: <msg>\r\nDetaily:<stack>`. The log is
  appended to `logFilename`, or to `<exe dir>\Ares2.log` when none is set.
* Účto limits: `Firma` A30, `Ulice` A24, `Misto` A20 (upper-cased by Účto), `Psc` N5,
  `Ico10` N10, `Dic` A14. Truncation is done by FAND field assignment, not by the helper.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/ares2.ts`, registered in the EXEC layer under `ares2.exe`.

```ts
export async function ares2(ctx: HelperContext): Promise<number>
```

* Read `<exeDir>/Ares2.xml` (case-insensitive lookup) with `readFile`, decode it as
  CP852 (`iconv-lite`), and parse the `<add key= value=>` pairs. A small regex or
  `fast-xml-parser` is enough, since the file is flat.
* Validate `regNo` the same way as the original. Pad it to 8 digits with leading zeros
  (ARES accepts the unpadded form too, but this is harmless).
* Fetch with the global `fetch`, a 15 s timeout (`AbortSignal.timeout`) and
  `Accept: application/json`. There are no certificates and no authentication.
* If the response is not OK: parse `{kod, subKod, popis}` and call
  `ctx.ui.message('Ares2', 'Zpráva z ARES:\nKód:…', 'error')`, then delete the output
  file.
* On success, build the 8 lines as specified above and write them with `\r\n`,
  encoded as CP852 or CP1250 according to `outputEncoding`.
* Log errors to `logFilename` in the same format. Return 0, or 1 for write errors.
* OS integration: only the message box. In Electron this is
  `dialog.showMessageBox` through the host bridge, or preferably a FAND-style
  console message box, since the engine owns the screen. Headless tests collect the
  messages.

Engine-side requirements (shared by all helpers):

* The EXEC layer dispatches on the lower-cased basename of the program path and
  **blocks** the synchronous interpreter until the async helper resolves (worker
  `Atomics.wait` on a result slot; the helper runs on the host side or in a
  sub-worker). `PARAM3.SyncW` is false in our runtime (no `uctodbox` or
  `VDOSP_CONFIG` env var), so Účto reads the result right after `exec`.
* `filesize(EXE)>0` must stay true: keep the original `.exe` in the app copy, or let
  the file layer report a virtual size for registered helpers.
* DOS paths from the XML (`C:\UCTO2026\{AP02}\…`) go through the engine's DOS-to-host
  path mapper.

Still worth replacing: yes. This is a frequently used address book feature.

## Test approach

* Unit tests: feed recorded ARES JSON fixtures, such as a legal entity with
  `nazevUlice` and `cisloOrientacni`, a sole trader (`pravniForma` 101, no DIČ), a
  subject with no street (`nazevCastiObce`), one with `dicSkDph`, and a 404 error body
  `{"kod":"NENALEZENO",...}`. Put them in `test/fixtures/helpers/ares2/`, mock `fetch`,
  and assert the exact CP852 bytes of `ARES2.TXT` and the deleted file on error.
* XML parsing test: use `ARES2.XML` produced by running report `Ares2` in the engine,
  or a hand-written one with a CP852 path such as `{AP02}` under `Účto`.
* Optional live smoke test (`ARES_LIVE=1`): IČO `00006947` (Ministerstvo financí).
* End-to-end with EngineDriver: open the address book in `{prik}`, choose F10 →
  "Registr firem ARES", enter an IČO, stub the helper, and check that the edit window
  shows the parsed values.
