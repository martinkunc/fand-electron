# FileDown.exe – download files from a URL list and optionally run the result

`{tisk}\FileDown.exe` (20 KB, .NET 4.0 WinExe, built 2025-12-30). It is a generic
downloader driven by `FileDown.xml`. Účto uses it for one thing only: fetching the
RustDesk remote-support client `uctord.exe` and starting it.
Decompiled source: `work/decompiled/{tisk}_FileDown/`.

## How Účto calls it

Menu **Nápověda → "Vzdálená správa"** (`MODUL01_PRO/0611_P_MAIN.txt`,
`0602_P_Napoveda01.txt`) calls `proc(RustDesk)` (`UCTO2026_RDB/0358_P_RustDesk.txt`):

```
p:=PROGRAM.Path+'{TISK}\UCTORD.EXE'; EXE.Path:=p;
if filesize(EXE)>0 then begin                     { already downloaded: run it }
  proc(Dotaz,(false,'Spustit program RustDesk (technik se připojí k vašemu počítači)'));
  if PARAM3.Ano then if PARAM3.vDos | PARAM3.DOSBox then proc(ExecWin,(p,''))
  else begin FILE.Path:=ADR03.Path+'UCTOBAT.BAT'; puttxt(FILE,'@'+p); proc(ExecDos,(FILE.Path)); end;
end else begin
  p:=PROGRAM.Path+'{TISK}\FILEDOWN.EXE'; EXE.Path:=p;
  if filesize(EXE)>0 then begin
    proc(Dotaz,(false,'Program RustDesk pro vzdálenou správu nenalazen. Stáhnout z webu'));
    if PARAM3.Ano then begin
      TXT.Path:=replace('.EXE',p,'.XML');                          { {TISK}\FILEDOWN.XML }
      PARAM3.AA2:='https://www.ucto2000.cz/DOWNLOAD/uctord.exe'+cr+ PROGRAM.Path+'{TISK}'+cr+
                  'true'+cr+ replace('.EXE',p,'.LOG');
      report(,FileDown,assign=TXT);
      proc(ExecWin,(p,''));
    end;
  end else proc(Hlaseni,('Program '+p+' nenalezen'));
end;
```

| | |
|---|---|
| Command line | none |
| Config | `FileDown.xml` in the exe directory (`APP_CONFIG_FILE`), written by report `FileDown` (`0357_R_FileDown.txt`) in CP852 without an encoding declaration |
| Output | the downloaded file(s) in `TargetDirectory`, and the log in `LogFilePath` |
| Exit code | 0 ok, 1 configuration error, 2 download error, 4 unexpected error. Účto ignores it; it does not wait or check |

```xml
<?xml version="1.0" ?>
<configuration>
  <appSettings>
    <add key="DownloadUrls" value="https://www.ucto2000.cz/DOWNLOAD/uctord.exe" />
    <add key="TargetDirectory" value="C:\UCTO2026\{TISK}" />
    <add key="RunAfterDownload" value="true" />
    <add key="LogFilePath" value="C:\UCTO2026\{TISK}\FILEDOWN.LOG" />
  </appSettings>
</configuration>
```

## What it does (decompiled C#)

* `ConfigLoader`: `DownloadUrls` (`;`-separated, trimmed), `TargetDirectory` and
  `LogFilePath` are required. `RunAfterDownload` must parse as a bool, otherwise it is
  a configuration error. On Windows before 7 / 2008 R2 (no TLS 1.2), `https://` is
  rewritten to `http://`.
* It creates the log directory and `TargetDirectory` if they are missing. The log is
  UTF-8 lines of the form `yyyy-MM-dd HH:mm:ss [INFO|ERROR] message`, with messages
  such as "FileDown started.", "Downloading: <url>", "Saved to: <path>" and
  "FileDown finished successfully.".
* For each URL it runs `WebClient.DownloadFile(url, TargetDirectory\<last URL path segment>)`,
  overwriting any existing file. The first failure stops the run (exit 2).
* `RunAfterDownload && exactly one file`: `Process.Start(file)`, i.e. it runs the
  downloaded exe. With several files it logs "execution skipped".
* No UI: no message boxes and no progress display.

## Replacement design (Node/TypeScript)

Module `src/engine/helpers/filedown.ts`, key `filedown.exe`.

* Parse `FileDown.xml` (CP852, flat `<add>` pairs). Validate and return 1, 2 or 4 with
  the same log lines and format.
* Download with `fetch` and stream to a temporary file in the target directory, then
  rename it: `Readable.fromWeb(res.body).pipe(createWriteStream(tmp))`, with
  redirects followed, a 60 s idle timeout, and non-2xx treated as an error. Drop the
  HTTP downgrade.
* **Platform policy for "run after download".** The only real payload is a Windows
  RustDesk build (`uctord.exe`), which is useless on Linux and macOS:
  * Windows: download, then `ctx.host.openPath(file)`, keeping the original behaviour.
  * macOS/Linux: do not download the `.exe`. Tell the user and open the RustDesk
    download page (`https://rustdesk.com/download`) with `shell.openExternal`, or use a
    platform-specific URL if the Účto vendor provides one. This is an open question
    for the vendor or product owner.
* Related non-helper code: the first branch of `RustDesk` runs `UCTORD.EXE` through
  `ExecDos` (`UCTOBAT.BAT`). The EXEC layer should treat `uctord.exe` as "launch
  external GUI program". On non-Windows hosts, map it to launching an installed
  `rustdesk` binary if one is found, or to the message above.
* Do not block the engine for long. Účto does not wait for the result (it is not a
  `WaitFor` caller), so run the download in the background (fire and forget, host
  side) and return 0 right away. This matches the asynchronous behaviour of `ExecWin`
  starting a GUI exe on Windows.
* Still worth replacing: low priority. It covers only the remote-support convenience
  feature.

## Test approach

* Unit tests with a local `http.createServer` fixture serving a small binary.
  Check that the file is saved under the last path segment and overwrites an existing
  file. Check the log lines, exit codes 1 (missing key or bad bool) and 2 (404), and
  that the run-after hook is called only for exactly one file (inject `openPath`).
* Platform policy test: with `process.platform` injected as `linux`, check that no
  download happens and that an openExternal request goes to the RustDesk URL.
