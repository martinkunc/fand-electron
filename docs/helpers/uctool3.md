# Uctool3.exe – check www.ucto2000.cz for a newer Účto update (download a small file)

`{tisk}\Uctool3.exe` (18 KB, .NET Framework 4.0 WinExe without a window, assembly
`UctoOL3` 1.0.0.1, "Zjišťování nových verzí účta", © 2022 Tichý & spol.). It is a
generic "download URL → file" tool with a usage ping. Účto uses it to fetch the version
file `verzewww.uuu`, and optionally the news file `zpravy.uuu`. It is the **default**
(`PARAM3.UOL='3'`) of three interchangeable programs with the same protocol:
`UCTOOL.EXE` (1, VB6 + MSINET.OCX, see uctool.md), `UCTOOL2.EXE` (2, .NET 2.0, see
uctool2.md) and `Uctool3.exe` (3).
Decompiled source: `work/decompiled/{tisk}_Uctool3/Uctool3/Program.cs`.

## How Účto calls it

| | |
|---|---|
| Wrapper | procedure `UctoOL(Echo)`, `MODUL01_PRO/0598_P_UctoOL.txt` |
| Choice of exe | `PARAM3.UOL`: `'1'` → `{TISK}\UCTOOL.EXE`, `'2'` → `{TISK}\UCTOOL2.EXE`, else `{TISK}\UCTOOL3.EXE`. Set in **Nápověda → Účto na internetu → "Program pro stahování aktualizací"** (`Param0('PgmUol')`, form `UCTO2026_RDB/0034_E_ParPgmUol.txt`) or Ostatní → Parametry → Program (`0033_E_ParPgm.txt`, "Automatické aktualizace: verze programu UCTOOL (1,2,3)") |
| Command line | `$ <path of UCTOTXT>` (`'$ '+UCTOTXT.Path`). The `$` marks "called from Účto" |
| Parameter file | `UCTOTXT` (CP852 FAND text, lines separated by a bare CR `\13`): 1 = URL, 2 = local result path (`XPath` = the DOSBox mount translated to a Windows path), 3 = usage info in double quotes (first call only) |
| Output | the result file = the raw bytes of the HTTP body, or the single character `0` on failure |
| Sync | `ExecWin`: on Windows a blocking `exec`, then `exitcode<>0` → "Program … skončil chybou N". In DOSBox/vDos (`PARAM3.SyncW`) a queued `RUNnnn.BAT` plus `WaitFor(result,'UCTOOL.EXE')` |
| Exit code | always 0 |

### Flow in `UctoOL`

```
ftp:='FTP'+copy(PARAM1.RočníkA,3,2);                                  { FTP26 }
verI:='http://www.ucto2000.cz/DOWNLOAD/'+ftp+cond(PARAM3.DOSBox:'/verzewwd.uuu', else:'/verzewww.uuu');
verW:=pgm+'{WWWW}\VERZEWWW.UUU'; verP:=pgm+'VERZE.UUU';
zprI:='http://www.ucto2000.cz/DOWNLOAD/'+ftp+'/zpravy.uuu'; zprW:=pgm+'{WWWW}\ZPRAVY.UUU'; zprD:=pgm+'{UDOC}\ZPRAVY.TXT';
…
db:='"'+PARAM1.RočníkA+' '+copy(PARAM3.VerU,1,pos(' ',PARAM3.VerU)-1)+','+ UCTO.Reg+','+ nodiakr(firm name+place)+','+
    str(FIRMY.nrecs,'0')+','+ str(PARAM3.AutAktDny,'0')+','+ strdate(PARAM3.DDD,'DD.MM.YY')+','+
    cond(Echo:'N',else:'A')+','+ PARAM3.WinVer+','+ cond(PARAM3.DOSBox:'D',PARAM3.vDos:'v',else:'3')+','+
    strdate(UCTO.lastupdate,'DD.MM.YY hh:mm')+'"';
puttxt(UCTOTXT,(verI+'\13'+XPath(verW)+'\13'+db));
with window(…) do begin write(' UCTOOL'+uol123+' zjišťuje, zda je na internetu dostupná novější verze účta.');
  proc(ExecWin,(FILE.Path,'$ '+UCTOTXT.Path)); … end;
```

1. Local version: `VERZE.UUU` in the Účto root. Currently `14 16.9.2026\r\n0 12.1.2026`:
   line 1 = `<update no.> <date>`, line 2 = `<news no.> <date>`. `Echo` (manual call)
   shows "Používáte účto 2026 verze 14 ze dne 16.9.2026".
2. It creates `{WWWW}` if needed (`ExecDos md`) and empties `{WWWW}\VERZEWWW.UUU`.
3. Call 1 fetches `verzewww.uuu` (`verzewwd.uuu` in DOSBox), which currently holds
   `14 7598080 17.09.2026\r\n0 10.1.2025` (line 1 = `<update no.> <size in bytes>
   <DD.MM.YYYY>`, line 2 = `<news no.> <date>`).
4. Validation: `v2` (the first word of line 1) must be `'0'` or 1..20, and the line must be
   at least 10 chars. Otherwise, if `Echo`, it shows "Nepodařilo se navázat spojení ze
   serverem a zkontrolovat verzi účta. Možné příčiny: - na počítači chybí knihovna MSINET …
   - počítač není on-line …". So the `0` failure marker falls into this branch.
5. If the news number on the web (line 2) is greater than the local one, **call 2**
   fetches `zpravy.uuu` into `{WWWW}\ZPRAVY.UUU` (the parameter file now has only 2 lines,
   so no usage info). If the result is >100 bytes, it is copied to `{UDOC}\ZPRAVY.TXT` and
   shown ("ZPRÁVY OD AUTORŮ PROGRAMU"). Line 2 of `VERZE.UUU` is updated.
   `zpravy.uuu` currently returns 404, so the result is `0` and nothing is shown.
6. If the local number ≥ the web number, `Echo` shows "Používáte poslední verzi. Účto
   není třeba aktualizovat.". Otherwise it sets `PARAM3.Ano:=true`, `F1` = the new
   number, `F2` = the size and `DDD` = the date. The caller then runs `UctoFtp` (the
   UCTOFTP/UCTOFTP2/UCTOFTP3 installer download, not part of this spec).

Callers:
* **Automatic at start-up**: `MODUL01_PRO/0605_P_Program01.txt`. On Windows (`NewWin` /
  `WinVer='W'`) or in DOSBox, when `PARAM3.AutAktDny>0` (default 7) and
  `today >= AutAktDat + AutAktDny`, it calls `UctoOL(false)` (silent) and, if a newer
  version exists, `UctoFtp(false)`.
* **Manual**: Nápověda → Účto na internetu → **"Stáhnout aktuální verzi účta 2026"**
  (`MODUL01_PRO/0601_P_Ucto2000.txt`) → `UctoOL(true)` + `UctoFtp(true)`.

## What it does (decompiled C#)

1. `SetAppConfig`: sets the default result file `UCTOOL3.TXT` (relative to the cwd) and
   the log `<exe dir>\Uctool3.log`.
2. `InputValidation`: exactly 2 args, and `args[0]=="$"`. Otherwise it throws
   ("Chybný počet vstupních parametrů." / "…pravděpodobně volání mimo účto."), writes `0`
   to `UCTOOL3.TXT` in the cwd, and logs the error.
3. `CheckNetworkStatus`: `NetworkInterface.GetIsNetworkAvailable()`, else "Síť není
   dostupná.", `0` and a log entry.
4. `ProcessInputFile(args[1])`: reads it as **CP1250**, splits on CRLF/CR/LF, and takes
   `[0]` URL, `[1]` result path, `[2]` info with `"` removed. With only 2 lines (call 2),
   `[2]` throws. The catch writes `0` to the result path and logs, but execution
   **continues**, because `_webSourceFile`/`_destinationLocalFile` are already set.
5. `DownloadFileFromWebByHttpRequest`: `WebRequest` GET with a 10 s timeout. Non-2xx
   statuses throw, which leads to the `0` result. It writes the body bytes unchanged
   (`File.WriteAllBytes`).
6. If info is non-empty, `SendInfoUser`: `GET
   http://www.ucto2000.cz/PHPPGM/SLEDOVANI/infouser.php?info=<info>`. The info is
   inserted **unencoded**; `Uri` escapes spaces to `%20`. The response is ignored, but an
   exception is re-thrown, and the outer catch then **overwrites the already downloaded
   result with `0`**. This is a bug: a failing statistics ping makes Účto report "Nepodařilo
   se navázat spojení".
7. Always `Thread.Sleep(500)` and `Environment.Exit(0)`. Log line format:
   `dd.MM.yyyy - HH:mm | Chyba: <msg> | Podrobnosti: <method>`.

Everything goes over plain `http://`, with no integrity check (the file only carries
numbers).

### Usage info (sent on every automatic or manual check)

`<Ročník> <VerU>,<UCTO.Reg registration no.>,<licensee firm + place, no diacritics, without " , # &>,<number of companies>,<AutAktDny>,<last check DD.MM.YY>,<N manual|A auto>,<WinVer>,<D DOSBox|v vDos|3>,<UCTO last update DD.MM.YY hh:mm>`

This is identifying data (licence number and licensee name). The vendor uses it for
statistics and, presumably, licence tracking (inferred).

## Replacement design (Node/TypeScript)

One module, `src/engine/helpers/uctool.ts`, registered under **`uctool.exe`,
`uctool2.exe` and `uctool3.exe`**. The FAND wrapper checks that the file exists
(`filesize(FILE)<=0` → silent exit), so the original exes must stay in `{TISK}`, or the
EXEC layer's existence check must report registered helpers as present.

* **Args**: require `args[0]==='$'` and `args[1]` = a DOS path → `ctx.mapPath`. Read the
  file as CP852 (the FAND side; the content is ASCII in practice). Split on `\r\n|\r|\n`.
  Line 1 is the URL, line 2 is the result path (a DOS or Windows path, because `XPath`
  translates only in DOSBox mode → `ctx.mapPath`), and line 3 (optional) is the info with
  quotes removed.
* **Download**: `fetch(url, {signal: AbortSignal.timeout(10000), redirect:'follow'})`.
  Only `http:`/`https:` URLs are allowed. On `res.ok`, write the body bytes unchanged to
  the result path. On any failure (offline, DNS, timeout, non-2xx), write the single byte
  `0`. Upgrade to `https://www.ucto2000.cz/…` if it serves the same file. Check once, and
  keep `http` as the fallback.
* **Usage ping**: after the result has been written, `GET
  …/infouser.php?info=${encodeURIComponent(info)}` with a 10 s timeout, fire-and-forget.
  Errors are logged and **never** change the result (this fixes the bug above). Control it
  by an engine setting `updates.sendUsageInfo`. The default is an open question: on for
  parity with the vendor, or off for privacy (it carries the licence number and licensee
  name).
* **Return 0** always, as the original does. `UctoOL` treats non-zero as "skončil chybou".
* **Log**: failures go to `<exe dir>/Uctool3.log` (or UCTOOL.LOG/UCTOOL2 equivalents, see
  their docs) in the original line format. The engine debug log is enough; the file is
  optional.
* **The update itself**: a positive answer makes Účto run `UctoFtp` → `UCTOFTP3.EXE`,
  which downloads and starts a **Windows installer**. That cannot work cross-platform and
  is specified separately (UCTOFTP2/UctoFtp3). Until it exists, two choices:
  1. Parity: report the real vendor version. The user then sees "Na internetu je dostupná
     novější verze účta. Aktualizovat ihned", and the UCTOFTP stub must explain how
     updates are delivered in this edition.
  2. Point `verI` at our own update channel. We cannot change the FAND URL, so the
     helper would map the host `www.ucto2000.cz/DOWNLOAD/FTPyy/verzewww.uuu` to our
     release feed, which carries the Účto update number bundled with our latest app
     release.

  Recommendation: option 2 once our packaging republishes vendor updates, and option 1
  until then.
* Still worth replacing: **yes, medium priority, small effort.** It runs automatically
  every 7 days at start-up, and a missing or crashing helper must stay silent (`Echo=false`
  hides errors, but `exitcode≠0` would still show "skončil chybou").

## Test approach

* **Unit**: parameter parsing (3 lines, 2 lines, CR-only separators, quotes stripped).
  Mocked `fetch`: 200 → exact body bytes written, 404/timeout/offline → `0`. A ping
  failure must not overwrite the result. Ping URL encoding; the ping is skipped when the
  info is empty or the setting is off.
* **Engine integration** (`EngineDriver`, mocked fetch): Nápověda → Účto na internetu →
  Stáhnout aktuální verzi:
  * server `14 …` and local `VERZE.UUU` `14 …` → "Používáte poslední verzi…";
  * server `15 7598080 17.09.2026` → "Ke stažení: verze 15 ze dne 17.09.2026 (7.2 MB)"
    then the "Aktualizovat ihned" prompt;
  * a failure → the "Nepodařilo se navázat spojení…" box.
  * Check that `{WWWW}\VERZEWWW.UUU` and `VERZE.UUU` in the temp copy under `work/tmp-*/`
    are updated as FAND expects.
* **Start-up path**: set `AutAktDat` to 8 days ago, start the engine, and expect the
  status window "UCTOOL3 zjišťuje…" and no error dialog while offline.
* **Live (env-gated)**: fetch `http://www.ucto2000.cz/DOWNLOAD/FTP26/verzewww.uuu` and
  assert the `^\d+ \d+ \d\d\.\d\d\.\d{4}` shape.
