# UctoFoD.exe – Windows file / folder picker

`{tisk}\UctoFoD.exe` (32 KB, .NET 4.0 WinForms, 2026-03 build). It lets DOS Účto use
the native Windows *Open file* or *Browse for folder* dialog, and it accepts drag and
drop. It returns the chosen path in a text file.
Decompiled source: `work/decompiled/{tisk}_UctoFoD/`.

## How Účto calls it

All calls go through one wrapper, `UctoFOD(absPath, mask, multiselect, shortName,
mustExist, folderOnly, folderDescription)`, in `UCTO2026_RDB/0632_P_UctoFOD.txt`.
It is reached from:

* `PathsWin` (`0193_P_PathsWin.txt`): menu item **"Nalistovat soubor ve Windows"** in
  the generic file-name prompt `Paths` (`0192_P_Paths.txt`). That prompt is used by
  about 16 chapters: imports, exports, e-Podání XML, certificates (`EETcrt`: mask
  `*.p12`/`*.pfx`, `mustExist`), HTML/PDF export, and more. Call:
  `UctoFOD(dir, 'Soubory *.XXX|*.XXX|…|Všechny soubory (*.*)|*.*', false, true, mustExist, false, '')`.
* `VyberDir` (`0485_P_VyberDir.txt`): **"Vybrat adresář ve Windows"**, used for
  directory prompts: `UctoFOD(Trail(Adr), '', false, true, true, true, Hd)`.
* `MODUL94_PRO/0010_P_ImportOic.txt`, OIČ import:
  `UctoFOD('', 'Soubory *.XML|*.XML', false, true, true, false, 'Import OIČ')`.

Wrapper (condensed):

```
if absPath='' then absPath:=PROGRAM.Path;
if mask='' then mask:='Všechny soubory (*.*)|*.*';
TXT.Path:=PROGRAM.Path+'{TISK}\UCTOFOD.TXT';
PARAM3.TTT:=absPath+crlf+ mask+crlf+ cond(multiselect:'true',else:'false')+crlf+ TXT.Path+crlf+
            cond(shortName:'true',else:'false')+crlf+ cond(folderOnly:'true',else:'false')+crlf+ folderDescription+crlf;
FILE.Path:=PROGRAM.Path+'{TISK}\UCTOFOD.XML';
report(,UctoFOD,assign=UCTOTXT5);
copyfile(UCTOTXT5,FILE,mode='LW',nocancel);        { CP852 -> CP1250 }
if exitcode<>0 then exit;
… window ' Nalistování souboru ve Windows' / ' Výběr adresáře ve Windows' …
puttxt(TXT,''); EXE.Path:=PROGRAM.Path+'{TISK}\UCTOFOD.EXE';
proc(ExecWin,(EXE.Path,''));
if PARAM3.SyncW then proc(WaitFor,(TXT.Path,'UCTOFOD.EXE'));
copyfile(TXT,UCTOTXT5,mode='WL',nocancel);         { CP1250 -> CP852 }
s:=gettxt(UCTOTXT5);
if copyline(s,1)<>~'' then begin ex:=copy(s,1,1)<>'#'; if ^ex then s:=copy(s,2,60000);
  if folderOnly then begin s:=copyline(s,1); PARAM3.TTT:=s; proc(PathExist,(s));
  end else begin PARAM3.TTT:=s; FILE.Path:=copyline(s,1); fs:=filesize(FILE); PARAM3.Ano:=mustExist => ex; end;
end;
```

The result goes to the caller in `PARAM3.TTT` and `FILE.Path` (`PARAM3.Ano`
= accepted). A blank first line (a single space) means cancelled.

### `UCTOFOD.XML` (report `UctoFOD`, `0631_R_UctoFOD.txt`, converted to CP1250)

```xml
<?xml version="1.0" encoding="windows-1250" ?>
<configuration>
<appSettings>
<add key="absPath" value="C:\UCTO2026\"/>
<add key="mask" value="Soubory *.XML|*.XML|Všechny soubory (*.*)|*.*"/>
<add key="multiselect" value="false"/>
<add key="output" value="C:\UCTO2026\{TISK}\UCTOFOD.TXT"/>
<add key="shortName" value="true"/>
<add key="folderOnly" value="false"/>
<add key="folderDescription" value="Import OIČ"/>
<add key="alwaysOnTop" value="true"/>
</appSettings>
</configuration>
```

Values are not XML-escaped by FAND. A `&` in a path or description would break the
original .NET config parser; the replacement should parse leniently.

## What it does (decompiled C#)

* Command line: none. The config comes from `UctoFoD.xml` in the exe directory. The
  keys `absPath`, `mask`, `folderDescription`, `multiselect`, `shortName`, `output`,
  `folderOnly` and `alwaysOnTop` are parsed with `bool.TryParse`, so invalid values
  become false.
* UI: a fixed 884×564 WinForms window titled `UctoFoD [verze x.y]`. It has the heading
  "VÝBĚR SOUBORU NEBO ADRESÁŘE", a dashed drop zone ("PŘESUŇTE SEM POŽADOVANÝ
  SOUBOR / ADRESÁŘ", "NEBO KLIKNĚTE NA **PROCHÁZET**") and buttons
  **STORNO** / **ULOŽIT A UKONČIT**.
  * PROCHÁZET opens `OpenFileDialog`, or `FolderBrowserDialog` when `folderOnly`.
    * File dialog: `Filter = mask` (it falls back to `Všechny soubory (*.*)|*.*` when
      the mask is invalid), `FilterIndex=1`, `Multiselect`, `InitialDirectory=absPath`,
      `CheckFileExists=false`, so the user can type a **new** file name. With
      `alwaysOnTop` the owner is a TopMost form.
    * Folder dialog: `SelectedPath=absPath`, `Description=folderDescription`, and
      "new folder" allowed.
    * OK writes the result and closes. Cancel writes an empty result (a single space).
  * Drag and drop: each dropped path's extension must match one of the mask patterns
    (`*.*` accepts everything). Otherwise it shows "Neplatný formát souboru." Valid
    drops are saved and the window closes.
  * Closing the window any other way asks "Chcete aplikaci ukončit?" (OK/Cancel). On
    OK it writes `" "` (the empty result).
* Output (`FileServices.SaveOutput`): the file is `output`, or
  `<exe dir>\UctoFoD.TXT` when the directory of `output` does not exist. It is deleted
  and rewritten in **CP1250**, one line per selected path, CRLF:
  * `folderOnly`: the directory (for a file path, its parent directory).
  * otherwise: the path, with `#` prepended when the file **does not exist** (a
    new-file name typed by the user). `" "` is written as is.
  * `shortName=true`: the path is converted with `GetShortPathName` (8.3). For a
    non-existent file a temporary file is created to get its short name and then
    deleted, keeping the `#` prefix.
* Errors: MessageBox "Chyba:\n…" titled "Účto - výběr souboru", a log in
  `<exe dir>\UctoFoD.LOG` (`dd.MM.yyyy - HH:mm;Chyba:…;Poznámka:…;`, diacritics
  removed), and an empty result.
* Exit code: always 0. `exitcode` in the FAND wrapper refers to the preceding
  `copyfile`.

## Replacement design (Node/TypeScript + Electron)

Module `src/engine/helpers/uctofod.ts`, key `uctofod.exe`. This is the only helper in
this group that needs **interactive native UI**.

* Read `<exeDir>/UctoFoD.xml`, decode it as CP1250 (FAND converted it), and parse the
  flat `<add key value>` pairs leniently with a regex, tolerating a raw `&`.
* Skip the intermediate WinForms window and open the native dialog straight away.
  Drag and drop onto the DOS console could be a later add-on: the renderer can accept
  a file drop while the dialog is pending.
* `ctx.ui.pickPath({ kind: 'file'|'folder', defaultPath, filters, multi, title })`
  goes to the Electron main process:
  * file: `dialog.showOpenDialog(win, { defaultPath, filters, properties: ['openFile', multi && 'multiSelections', 'promptToCreate'] })`.
    `promptToCreate` (Windows) and typed names cover the `CheckFileExists=false`
    semantics. On macOS/Linux, where typing a non-existent name in an open dialog is
    not supported, use `dialog.showSaveDialog` when the caller is known to want a new
    file. With `mustExist=false`, prefer `showSaveDialog` with the same filters, and
    ask for confirmation before overwriting.
  * folder: `properties: ['openDirectory', 'createDirectory']`, `message: folderDescription` (macOS).
  * Filter conversion: `'Soubory *.XML|*.XML|Všechny soubory (*.*)|*.*'` becomes
    `[{name:'Soubory *.XML', extensions:['XML','xml']}, {name:'Všechny soubory (*.*)', extensions:['*']}]`.
    Split on `|` into (name, patterns) pairs and patterns on `;`; `*.ext` becomes
    `ext`. Linux GTK filters are case-sensitive, so add both cases.
  * Window: modal to the main window (this replaces `alwaysOnTop`).
* Result mapping: host path → DOS path through the engine's path mapper. **Check that
  the path is visible to the engine.** A pick outside the mapped drives needs either
  an automatic extra drive mapping or a message. Apply the `#` prefix when the file
  does not exist, and in folder mode reduce the path to a directory. Write
  `UCTOFOD.TXT` in CP1250 with CRLF. Cancel writes `" \r\n"`.
* `shortName=true` has no meaning without an 8.3 layer: return the long (mapped) path.
  In BP7, `Dos.PathStr` is `string[79]`, which is why Účto asked for 8.3 names. The
  FPC and TS ports use longer strings, but Účto string fields that store paths may
  be shorter. Deciding how to handle paths longer than 79 characters is an open
  question (warn, or map them through a short virtual drive).
* Blocking: the engine worker waits on `Atomics.wait` while the main process shows
  the dialog. The console renderer must stay responsive, which it does because only
  the worker blocks.
* Headless and tests: `pickPath` is injected. `EngineDriver` supplies scripted
  answers, e.g. `driver.onPickPath(() => '/tmp/x.xml')`. In a plain Node CLI without
  Electron, the fallback is a text-mode prompt in the console, i.e. Účto's own
  "Vybrat adresář v DOSu" path.
* Still worth replacing: yes, **high priority**. It is the main way users pick import
  files and certificates on a modern desktop.

## Test approach

* Unit tests of the pure parts: XML parsing (CP1250 bytes with diacritics, a raw
  `&`), mask to filters conversion, and result serialization (existing file,
  non-existent file → `#`, folder mode with a file path, cancel → `" "`), asserting
  exact CP1250 bytes.
* EngineDriver end-to-end: in `{prik}`, open an import that uses `Paths`, choose
  "Nalistovat soubor ve Windows", and have the stubbed `pickPath` return a file. Check
  that the prompt field shows the mapped DOS path and that `PARAM3.Ano` gates
  `mustExist`.
* Manual check in Electron on Windows, macOS and Linux: filters, the default
  directory, the folder picker, and cancel.
