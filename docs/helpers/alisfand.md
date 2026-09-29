# AlisFand.exe – installer of the "Alis Fand" console TrueType font (Windows 7)

`{tisk}\AlisFand.exe` (188 KB, 2010). **.NET** WinForms wizard, decompiled source in
`work/decompiled/{tisk}_AlisFand/AlisFand/{Program,frmMain,WizzardCore}.cs`. The font
itself is embedded as a resource (`Resource1.alisfand`) and also shipped as
`{tisk}\alisfand.ttf` (83 KB).

## How Účto invokes it

1. **"Font pro Windows 7 !"** in the system information menu (`UCTO2026_RDB/0361_P_SysInfo.txt`),
   visible only when `PARAM3.WinVer='7'`:
   ```
   FILE.Path:=PROGRAM.Path+'{TISK}\ALISFAND.EXE';
   if filesize(FILE)<=0 then proc(Hlaseni,('Program '+FILE.Path+' nenalezen')) else begin
     proc(HlaseniWw,(' Nyní spustíme program '+FILE.Path+'.\13'+ ' Bude-li třeba, povolte ho v nástroji řízení uživatelských účtů.\13'+
       '   Pozor, instalátor může být na obrazovce schovaný za jinými okny.\13'+
       ' Po instalaci fontu restartujte účto, klikněte na ikonu v levém\13'+
       '   horním rohu okna s účtem, volte Vlastnosti, na kartě Písmo\13'+
       '   vyberte AlisFont a vyzkoušejte vhodnou velikost písma.'));
     puttxt(UCTOTXT,'explorer.exe '+FILE.Path); exec('{tisk}\caller.exe','# '+UCTOTXT.Path,nocancel);
   ```
   It is started through `explorer.exe` (via [CALLER](caller.md)) so that UAC can elevate
   it. There are no arguments and no exchange files.
2. vDos: `MODUL01_PRO/0059_P_OknoVD.txt` → "Font AlisFand" sets `FONT={TISK}\ALISFAND.TTF`
   in the vDos config (it uses the `.ttf` directly, not the exe).

## What it does (decompiled C#)

* It is a wizard: "Instalace fontu Alis Fand", with the text "Tento program provede
  instalaci fontu Alis Fand, který umožňuje provoz DOSovských aplikací v prostředí Windows
  7 (32-bit) s použitím TrueTypových písem." and the footer "Instalace je určena pouze pro
  Windows 7 (32-bit)". Other OS versions → an error page.
* `MakeInstallFont()`: if `%windir%\Fonts\alisfand.ttf` exists → "Instalace nebude
  provedena, ALISFAND je již nainstalován." Otherwise it writes the embedded TTF to the
  current dir if missing, copies it to `%windir%\Fonts`, and sets
  `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Fonts\alisfand(TrueType)` =
  path. It registers the font as a **console font**
  (`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Console\TrueTypeFont`, value name
  `0`, `00`, `000`… (the first free one) = `"Alis Fand"`), then `AddFontResource`,
  `SendMessage(HWND_BROADCAST, WM_FONTCHANGE)`, `WriteProfileString("fonts", …)`. Result:
  "Instalace fontu je dokončena."

## Replacement design

**Obsolete, do not port.** The font was needed so the Windows console could show the
FAND/CP852 box-drawing and Czech glyphs with a TrueType font. Our console is a React
renderer that draws Unicode cells with any font we bundle.

* Register `alisfand.exe` as a helper that shows a message: "Písmo konzole nastavíte v
  Nastavení aplikace (Zobrazení → Písmo)." Return 0.
* **Reuse the font asset**: `alisfand.ttf` is the natural choice for a "classic FAND look"
  font in our renderer. **Check its licence first**. It is Tichý & spol.'s distribution,
  of unclear origin (a derivative of a DOS 8×16 VGA font). If it is clean, offer it as an
  optional console font, mapping its CP852-ordered glyphs to Unicode if the TTF uses a
  non-Unicode cmap. Otherwise use a free alternative such as "Px437 IBM VGA" (from the
  Ultimate Oldschool PC Font Pack, CC BY-SA), which covers the box drawing.
* The vDos `FONT=` menu item edits a vDos config that we do not use. It is harmless.

Priority **low**, effort **S**.

## Test approach

* Registry test: `alisfand.exe` → a message helper that returns 0.
* If the TTF is adopted: a unit test that loads it with `fontkit`, checks the glyph
  coverage for all 256 CP852 code points (after Unicode mapping), and checks the
  monospace advance widths.
