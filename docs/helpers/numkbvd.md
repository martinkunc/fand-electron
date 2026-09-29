# NUMKBVD.exe – numeric-keypad dot for Účto under vDos (AutoHotkey)

`{tisk}\NUMKBVD.exe` (756 KB) is a **compiled AutoHotkey v1.1.26.01 script**. The embedded
script (extracted from the `>AUTOHOTKEY SCRIPT<` resource) is complete:

```autohotkey
; <COMPILER: v1.1.26.01>
#SingleInstance force
Menu, Tray, NoStandard
Menu, Tray, Add , Ukončit, ButtonExit
If 1 = /u
ExitApp
param = %1%
GroupAdd, UCTO, %param%
SetTitleMatchMode, 2
#IfWinActive ahk_group UCTO
NumpadDot::.
§::Send {ASC 00245}
#IfWinActive
ButtonExit:
ExitApp
```

While a window whose title contains the first argument (`ucto`) is active:
* the numeric keypad decimal key types `.` (a Czech layout produces `,`, which FAND number
  fields reject);
* the `§` key sends Alt+0245 (ANSI 0xF5), which vDos passes through as CP852 0xF5 = `§`.

Priority **medium** as a *renderer keyboard feature* (Czech users type amounts on the keypad
all day), effort **S**. The executable itself is obsolete.

## How Účto calls it

Not from FAND code. The vDos autoexec `{vdos}\vdos_a.txt`:

```
set FANDOVRB=80
{tisk}\numkbvd ucto          ← install (title filter "ucto")
ufand ucto2026
{tisk}\numkbvd /u            ← /u: a second instance with /u replaces the first (#SingleInstance force) and exits
```

## Replacement design

No helper registration is needed. Implement in the renderer key mapping
(`src/renderer/src/Console.tsx` → `src/engine/console/keys.ts`):

* `KeyboardEvent.code === 'NumpadDecimal'` → deliver `.` (ASCII 0x2E) regardless of the OS
  layout. Setting `keyboard.numpadDecimalDot` (default on).
* `NumpadDivide` → `/` (NUMKB's second job, see [numkb.md](numkb.md)); layouts already do this,
  keep it explicit.
* `§` and other non-ASCII characters: our console already maps Unicode → CP852 via `cp852.ts`, so
  no special case is needed; add a test that `§` arrives as 0xF5.

## Test approach

Renderer/unit test of the key translation: `{code:'NumpadDecimal', key:','}` → `.`;
`{key:'§'}` → CP852 0xF5; option off → `,`.
