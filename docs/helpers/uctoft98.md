# UCTOFT98.EXE – interactive updater for old Windows (95/98/ME)

`{tisk}\UCTOFT98.EXE` (84 KB, native VB6, "kompilace 28.11.2016", form `frmUctoFTP` with buttons
`cmdInfo` "…it verzi", `cmdOpravy` "Seznam oprav", `cmdKonec`; `MSINET.OCX`, `ShellExecuteA`).
The self-contained variant: it checks the version itself instead of relying on
[UCTOOL](uctool.md).

Priority **low**, effort **S**.

## How Účto calls it

`MODUL01_PRO/0600_P_UctoFtp98.txt`, reached from **Nápověda → Účto na internetu → Stáhnout
aktuální verzi** only when *not* (`DOSBox | NewWin | WinVer='W'` with auto-update) – i.e.
Windows 9x or when automatic updates are disabled (`MODUL01_PRO/0601_P_Ucto2000.txt`).

```
FILE.Path:=PROGRAM.Path+'VERZE.UUU'; v:=copyline(gettxt(FILE),1);        { e.g. '7 12.03.2026' }
proc(PathExist,(ADR01.Path+'{WWWW}')); if ^PARAM3.Ano then proc(ExecDos,('md '+ADR01.Path+'{WWWW}'));
proc(Dotaz,(false,'Aktualizovat program (vyžaduje připojení k internetu)'));
proc(HlaseniWw,(' Během instalace nové verze nesmí účto běžet. ...'));
proc(Dotaz,(true,'Ukončit účto ihned'));
proc(ExecWin,(FILE.Path,'FTP'+cond(test:'XX',else:copy(PARAM1.RočníkA,3,2))+'/ '+v));
if PARAM3.Ano then begin proc(Firma2,(true)); proc(PgmEnd); cancel end;
```

| | |
|---|---|
| Args | `FTPyy/` and the local version line from `VERZE.UUU` (`<number> <DD.MM.YYYY>`, two tokens) |
| Result | none read back; Účto quits if the user answered "Ukončit účto ihned" |

## What it does (inferred from strings)

* Downloads `http://www.ucto2000.cz/DOWNLOAD/FTPyy/verzewww.uuu` and compares with the local
  version: "Pro účto … zatím nejsou aktualizace!", "Používáte účto … verzi číslo …",
  "K dispozici je novější verze číslo … Chcete ji stáhnout a nainstalovat?",
  "Program účto není potřeba aktualizovat.", "Na disku je poslední verze číslo …".
* "Seznam oprav" downloads `opravy.uuu`, saves `opravy.txt` and opens it with `ShellExecute`
  ("Zatím nejsou žádné opravy." on `404 NOT FOUND`).
* Download of `aktftp.exe` to `{WWWW}\` and start of the installer (same as UCTOFTP),
  "Nebyly staženy všechny soubory, aktualizace se neprovede!" on partial failure.

## Replacement design

Same handler family as [uctoftp3.md](uctoftp3.md). Useful part worth keeping: showing the
change list. Implement "Seznam oprav" as: fetch `…/FTPyy/opravy.uuu` (CP1250 text, 10 s timeout),
show it in a renderer text dialog; offline → message. The installer part is replaced by the
app-update notice. Return 0.

## Test approach

Local `http.createServer` serving `verzewww.uuu`/`opravy.uuu` fixtures (plus a 404 case); assert
the dialog text and that no file is written into the pristine app tree.
