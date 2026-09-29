# UCTOFTP.EXE – update downloader, VB6 / MSINET variant

`{tisk}\UCTOFTP.EXE` (75 KB, native VB6, "kompilace 08.11.2016", form `frmUctoFTP` "Aktualizace
programu účto z www.ucto2000.cz", uses `InetCtlsObjects.Inet` from `MSINET.OCX`). Used when
`PARAM3.UOL='1'`, which is what Účto sets on first start for every WinVer except `'8'`
(`PARAM3.UOL:=cond(PARAM3.WinVer='8':'3',else:'1')`).

Priority **low**, effort **S** (shares the [UctoFtp3](uctoftp3.md) handler).

## How Účto calls it

Same as [UctoFtp3](uctoftp3.md): `exec('{TISK}\UCTOFTP.EXE','FTPyy/ <size>')`; exit code 1 means
"installer started, quit Účto".

## What it does (inferred from strings)

* URL base `http://www.ucto2000.cz/DOWNLOAD/` + folder argument + `aktftp.exe`, target
  `{WWWW}\aktftp.exe`.
* Status texts: "Kontrola IP adresy...", "IP adresa v pořádku...", "Připojen k www.ucto2000.cz...",
  "Požadavek na stažení souboru...", "Stahuji soubor >>", thermometer control `shTeplomer`.
* Success: "Stahování je dokončeno, následuje aktualizace účta." then starts the installer.
  Alternative message "Na disku je připravena aktualizace. Provede se při příštím spuštění účta."
  (the DOSBox path, where `akt.uuu` triggers `{wwww}\komplet.exe` in the DOSBox autoexec).
* Errors (MsgBox caption " .: Hlášení programu UCTOFTP :."): "Aktualizaci se nepodařilo
  stáhnout.", firewall/timeout tips, "Chyba v parametrech. Program nelze spustit!",
  "Nelze spustit program pro aktualizaci účta!".

## Replacement design

Alias of the [UctoFtp3](uctoftp3.md) handler: no installer download, informational dialog / our
update channel, return 0.

## Test approach

Alias test; see [uctoftp3.md](uctoftp3.md).
