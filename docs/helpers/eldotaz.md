# ELDOTAZ.EXE – status query for a ČSSZ e-Podání (VREP)

`{tisk}\ELDOTAZ.EXE` (23 KB, VB.NET, .NET 4.0 WinExe, uses Rebex.Http as the
`WebRequest` provider). It asks the ČSSZ VREP gateway about the processing state of
an earlier electronic submission (GovTalk envelope) and tells the user the result.
Decompiled source: `work/decompiled/{tisk}_ELDOTAZ/ELDOTAZ/Eldotaz.cs`.

## How Účto calls it

Only one call site: `MODUL99_PRO/0163_P_VrepEx.txt`, the F10 exit of the
**"Uskutečněná e-Podání VREP ČSSZ"** list (edit of file `VREP`, opened from
`0165_P_VrepUUUF7.txt` and `0178_P_UctoDSF7.txt`). ELDOTAZ is only the **legacy path**.
When `PARAM3.Apep` is true, which is the default (set in `PARAM3` init and again by
every upgrade in `UPG_PRO/0008_M__Param3.txt`; user option in `0033_E_ParPgm.txt`),
Účto calls `UctoApep.exe` with call type `D` instead (a separate helper spec).

```
if pos('acknowledgement',VetaV.Výsledek,'u')=0 then begin proc(Hlaseni,('Zjišťování stavu pouze pro úspěšná e-Podání (výsledek "acknowledgement")')); exit; end;
proc(Dotaz,(true,'Poslat do ČSSZ online dotaz na stav e-Podání '+Trail(VetaV.Druh)+' ze dne '+strdate(VetaV.Datum,'DD.MM.YYYY')));
if ^PARAM3.Ano then exit;
if PARAM3.Apep then begin proc(UctoApep,('D', VetaV.Druh, …, VetaV.VsČssz, VetaV.Id));
end else begin
  FILE.Path:=PROGRAM.Path+'{TISK}\ELDOTAZ.EXE';
  if filesize(FILE)<=0 then begin proc(Hlaseni,('Program '+FILE.Path+' nenalezen')); exit; end;
  s:=Trail(VetaV.Druh)+'/'+Trail(VetaV.VsČssz)+'/'+Trail(VetaV.Id)+'/'+
     strdate(VetaV.Datum,'YYYY-MM-DDThh:mm:ss.ttt')+'/'+Trail(VetaV.Výsledek)+'/'+
     cond(PARAM2.testDS:'A',else:'N');
  s:=nodiakr(s);
  puttxt(UCTOTXT3,s);
  with window(…) do begin proc(Hlaseni23,('Čekáme na odpověď ČSSZ …'));
    proc(ExecWin,(FILE.Path,'$ '+UCTOTXT3.Path)); end;
end;
```

| | |
|---|---|
| Command line | `$ <path of UCTOTXT3>`. `argv[1]` must be exactly `$`, otherwise it shows "Chyba při volání programu." and quits |
| Input file | `UCTOTXT3` = `UCTOTXT3.UUU` (catalog `UCTO2026.CAT`, relative path), one line, CP852 but ASCII after `nodiakr` |
| Input format | `typ/VS/correlationId/datetime/result/testFlag`, split on `/`. Fields used: [0] submission type (e.g. `PVPOJ`, `NEMPRI`…), [1] variable symbol, [2] CorrelationID, [5] first char `A` = test gateway |
| Output | none for Účto. On `error`, it writes `<exe dir>\<corID>.txt` (CP1250) and opens it with the associated editor |
| Exit code | not used (always 0 via `EndApp`) |

## What it does

1. Builds the GovTalk request (`SlozPodani`). The XML declaration says
   `windows-1250`, but the content is sent through a UTF-8 `StreamWriter`; it is ASCII
   anyway.
   ```xml
   <?xml version="1.0" encoding="windows-1250"?>
   <GovTalkMessage xmlns="http://www.govtalk.gov.uk/CM/envelope">
   <EnvelopeVersion>2.0</EnvelopeVersion>
   <Header>
   <MessageDetails>
   <Class>CSSZ_{typ}</Class>
   <Qualifier>request</Qualifier>
   <Function>delete</Function>
   <CorrelationID>{corID}</CorrelationID>
   </MessageDetails>
   <SenderDetails><IDAuthentication><SenderID></SenderID>
   <Authentication><Method>clear</Method><Value></Value></Authentication>
   </IDAuthentication></SenderDetails>
   </Header>
   <GovTalkDetails>
   <Keys><Key Type="vars">{VS}</Key></Keys>
   <GatewayAdditions><Flags><TimestampVersion>xmldsig</TimestampVersion></Flags></GatewayAdditions>
   </GovTalkDetails>
   <Body></Body>
   </GovTalkMessage>
   ```
   (The original has one element per line with CRLF; the whitespace is irrelevant to
   the gateway.)
2. `POST` with `Content-Type: text/xml` to `https://epodani.cssz.cz/VREP/submission`,
   or to `https://t-epodani.cssz.cz/VREP/submission` when the test flag is `A`. No
   client certificate is used. Anyone can query with the CorrelationID and VS.
3. Reads the response as text and extracts `<Qualifier>(.*?)</Qualifier>` with a regex:
   * `response`: MsgBox "Podání <corID> bylo bez chyb přijato."
   * `acknowledgement`: MsgBox "Podání <corID> bylo doručeno, ale ještě není zpracováno."
   * `error`: takes `<Error>…<Number>(n)</Number>…</Error>` (singleline).
     * `2000`: MsgBox "Portál VREP neeviduje podání <corID>."
     * anything else: takes the first `<Text>(.*?)</Text>` and writes `<exe dir>\<corID>.txt`
       (CP1250):
       `Podání <corID> nebylo kvůli následujícím chybám přijato:\r\n\r\nTyp podání: {typ}\r\nČíslo chyby: {n}\r\nText: {text}`,
       then `Process.Start` on the file (Notepad).
   * any other value: MsgBox "Neznámý typ odpovědi <value>."
   * a non-200 HTTP status: MsgBox "Chyba v odpovědi."; network errors: "Nelze
     odeslat dotaz." / "Nelze přijmout odpověď." / "Nelze navázat spojení s VREP."
   * All MsgBoxes are Information style with the title "Hlášení programu...".

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/eldotaz.ts`, key `eldotaz.exe`.

* Parse the command line: token 1 must be `$`. Token 2 is a DOS path; map it and
  decode the file as CP852.
* Build the same envelope with a template literal. XML-escape the fields; they are
  ASCII after `nodiakr`, but escape anyway.
* `fetch` POST with a 30 s timeout. Use `fast-xml-parser` (or the same regexes, which
  are simpler and fully compatible) for `Qualifier`, `Error/Number` and `Error/Text`.
* Show messages through `ctx.ui.message(title='Hlášení programu...', text)`. For the
  error-detail case, write `<exeDir>/<corID>.txt` in CP1250 and open it with
  `ctx.host.openPath`. Better: show the same text in a FAND-style scrolling message
  window and skip the external editor.
* Libraries: none beyond `fetch` and `iconv-lite`.
* Still worth replacing: only for parity. It is reached only with `PARAM3.Apep=false`,
  a non-default option (UctoApep covers the same query). Implement it after UctoApep
  or map it onto the same code path.

## Test approach

* Unit tests with a mocked `fetch` returning captured GovTalk responses for the
  qualifiers `response`, `acknowledgement`, `error` + 2000, `error` + another number
  with `<Text>`, and an unknown qualifier. Assert the message texts and the CP1250
  bytes of `<corID>.txt`.
* Envelope snapshot test for input `PVPOJ/1234567890/ABCDEF0123456789/2026-01-31T10:00:00.000/acknowledgement/A`.
  Check that the URL is the test gateway.
* Argument validation: a missing `$` and a missing file.
* Live testing is not practical, since it needs a real CorrelationID. The test
  gateway `t-epodani.cssz.cz` can be used with a submission created there.
