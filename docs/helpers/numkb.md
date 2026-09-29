# NUMKB.EXE, NUMKB3.EXE, NUMKB4.EXE – keypad TSR for the Czech DOS keyboard

Three small resident DOS programs in the app root by Pavel J. Panenka (NUMKB 1998, NUMKB3 2003,
NUMKB4 2010; 3.6–4.2 KB, Turbo Pascal with an assembler INT 9/INT 16h hook). Messages:
"… instalován", "… nelze instalovat!", "… odinstalován", "… nelze odinstalovat!".

From the Účto help (`HELP.T00`): *"S Účtem dodáváme rezidentní program NUMKB (NUMKB3), který na
české numerické klávesnici vnucuje tečku a lomítko. Program zabírá asi 6 KB paměti."* and from
`TIPY.T00`: NUMKB4 additionally makes **AltGr** combinations work under Windows 7
(`AltGr+Q=\`, `W=|`, `F=[`, `G=]`, `X=#`, …).

Priority **medium** as a keyboard feature (same as [NUMKBVD](numkbvd.md)), effort **S**;
the executables are obsolete.

## How Účto calls it

Not from FAND code. `U.BAT` (32-bit Windows / NTVDM launcher):

```
MODE CON: COLS=80 LINES=25
KB16 CZ,852
NUMKB4          ← install
…
ufand ucto2026
…
NUMKB4          ← second call uninstalls (toggle)
```

[UCTOCONF](uctoconf.md) carries the `NUMKB4` / `REM NUMKB4` choice to the next year.
`NUMKB.EXE` and `NUMKB3.EXE` are older builds kept for old installs.

## Replacement design

Nothing to register (if some user batch runs them, the DOS shell treats unknown `NUMKB*` as a
no-op with exit 0). Implement in the renderer key map, shared with NUMKBVD:

* NumpadDecimal → `.`, NumpadDivide → `/`, NumpadMultiply/Subtract/Add → `*`, `-`, `+` regardless
  of layout.
* AltGr: pass `KeyboardEvent.key` (the character produced by the OS layout, e.g. `\` for AltGr+Q
  on a Czech layout) and translate it to CP852; never interpret AltGr as Alt+key for FAND
  shortcuts when `key` is a printable character (Chrome reports AltGr as `ctrlKey+altKey`).

## Test approach

Key translation unit tests: Czech layout events for AltGr+Q (`key:'\\'`, `ctrlKey:true,
altKey:true`) → `\`; keypad keys → ASCII operators.
