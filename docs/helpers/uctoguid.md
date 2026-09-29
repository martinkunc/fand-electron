# uctoGuid.exe – generate a GUID for ISDOC invoices

`{tisk}\uctoGuid.exe` (10 KB, .NET 2.0 WinExe). It writes one new random GUID,
upper-cased, to the file named on the command line.
Decompiled source: `work/decompiled/{tisk}_uctoGuid/`.

## How Účto calls it

`MODUL06_PRO/0096_P_FakturaIS.txt`, procedure `FakturaIS(…, Příp, var Soub)`. It is
called for each invoice exported to **ISDOC**, from `0097_P_FakturaI.txt` (issued
invoices → export ISDOC, single or batch). It is also called from
`0099_P_FaktPdfMail.txt` with `Příp='pdf'`, but there the procedure exits before the
GUID part. The GUID is generated only when the invoice parameter `PAR06A3.FaIsUid`
is set (default `true`, per the `PAR06A3` init in `0010_F_PAR06A3.txt`).

```
if Příp<>~'isdoc' then exit;
PARAM3.AAA:='';
if PAR06A3.FaIsUid then begin
  FILE.Path:=PROGRAM.Path+'{TISK}\UCTOGUID.EXE';
  if filesize(FILE)>0 then begin
    TXT.Path:=PROGRAM.Path+'{TISK}\GUID.TXT'; puttxt(TXT,'');
    proc(ExecWin,(FILE.Path,TXT.Path));
    if PARAM3.SyncW then proc(WaitFor,(TXT.Path,'UCTOGUID.EXE'));
    PARAM3.AAA:=gettxt(TXT);
    PARAM3.AAA:=copyline(PARAM3.AAA,1);
  end;
end;
```

The ISDOC report `0095_R_FakturaI.txt` then emits
`<UUID>_</UUID>` with `cond(PARAM3.AAA<>~'':PARAM3.AAA,else:'0')`. Without the helper,
the invoice gets `UUID` = `0`, which is invalid under the ISDOC 6.0.1 schema
(the pattern requires a GUID).

| | |
|---|---|
| Command line | `<full DOS path of {TISK}\GUID.TXT>`, one argument |
| Output | that file: `XXXXXXXX-XXXX-XXXX-XXXX-XXXXXXXXXXXX\r\n` (`Guid.NewGuid().ToString().ToUpper()`, `StreamWriter` default UTF-8 without BOM, ASCII) |
| Exit code | 1 when there is no argument, else 0. Write errors are swallowed |

## Replacement design

Module `src/engine/helpers/uctoguid.ts`, key `uctoguid.exe`:

```ts
// args[0] = DOS path of the output file
const out = ctx.mapPath(args[0]);
await writeFile(out, crypto.randomUUID().toUpperCase() + '\r\n', 'latin1');
return 0;
```

* `crypto.randomUUID()` produces a v4 GUID, like .NET `Guid.NewGuid()`.
* Return 1 when there is no argument. Ignore write errors, as the original does.
* Argument parsing: the whole parameter string is a single path; Účto program paths
  contain no spaces. Trim it and strip surrounding quotes.
* No OS integration and no libraries.
* Still worth replacing: yes. It is trivial, and ISDOC export produces invalid files
  without it.

## Test approach

* Unit test: run it with a temp path, then check the content against
  `/^[0-9A-F]{8}-[0-9A-F]{4}-4[0-9A-F]{3}-[89AB][0-9A-F]{3}-[0-9A-F]{12}\r\n$/`, and
  that no argument gives exit 1.
* EngineDriver: export one issued invoice from `{prik}` to ISDOC. Check that the
  `.isdoc` file in `{MAIL}` contains `<UUID>` with a GUID, and optionally validate it
  against the ISDOC 6.0.1 XSD if one is added to the fixtures.
