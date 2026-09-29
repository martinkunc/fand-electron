# účto – PC FAND engine for Electron

A cross-platform re-implementation of the PC FAND 4.2 runtime (the DOS RDBMS/4GL that
Účto by Tichý & spol. is written in), with a React console that renders DOS text mode
(PC FAND's own CP852 VGA font, 80×25, VGA palette). No emulator: the engine is a
TypeScript port of the MIT-licensed ALIS sources (github.com/alisoss/pcfand) and works
directly on the original data files, so an existing Účto installation stays usable
by the Windows version and vice versa.

![The FAND desktop running in the app (`--fand`): PC FAND 4.2 on the ported engine](docs/images/fand-desktop.png)

*The FAND desktop (`npm run dev -- -- --fand`): PC FAND's own development environment, run by
the TypeScript engine and drawn by the React console.*

## Layout

| Path | What |
|---|---|
| `src/engine/fand/` | File formats: data files (`.000`), text/memo files (`.T00`/`.TTT`/`.TRO`), projects (`.RDB`/`.PRO`), number codecs, de-obfuscation |
| `src/engine/console/` | CRT unit equivalent: `Screen` (cells, windows, CP852), BIOS keyboard codes, blocking `KeyQueue` (SharedArrayBuffer + Atomics) |
| `src/engine/pas/` | The PC FAND port: one module per Pascal unit (see [docs/PORTING.md](docs/PORTING.md)); `fand.ts` `main` is the FAND main program |
| `src/engine/runtime/` | Engine entry (`runFand` = `UFAND.EXE task`: runs the ported FAND; `browse: true` opens the read-only chapter browser instead), EXEC hook for the helper programs |
| `src/engine/worker.ts` | Engine worker thread (the Pascal-style synchronous code blocks on the keyboard here) |
| `src/engine/testing/driver.ts` | Headless driver: start a task, type keys, read the screen as text |
| `src/main`, `src/preload`, `src/renderer` | Electron shell and the React/canvas console |
| `src/tools/fand-dump.ts` | Dump all chapters of all projects as text |
| `scripts/fetch-ucto.sh` | Download + extract Účto (cached backup in `vendor/`) |
| `scripts/build-ref-fand.sh` | Build the reference PC FAND (Free Pascal port) used as test oracle, see [docs/REFERENCE.md](docs/REFERENCE.md) |

## Getting started

```sh
npm install
scripts/fetch-ucto.sh --install work/ucto   # download, extract (innoextract, or --wine), working copy
npm run dev                                  # Electron app against work/ucto
npm test
node src/tools/fand-dump.ts work/ucto work/source   # decoded sources of all 5420 chapters
```

The app looks for the installation in `--app-dir=…`, `$UCTO_DIR`, the folder chosen last
time, the folder the packaged app is placed in, then `work/ucto` (development).

If none of them has one, a dialog asks for the folder of the FAND application. It must contain
a task (`*.RDB`) and `FAND.RES`. The choice is saved in `settings.json` in the app's user-data
folder, and `--choose-app-dir` asks again. The packaged app then copies itself into that folder
(`ucto-electron/`, the `.app` bundle or the AppImage) and restarts from there.

It runs the task like `U.BAT` does: `--task=…` or `$FAND_TASK`, by default the newest
`UCTOyyyy.RDB`; with several other tasks it asks which one. `--browse` (or `FAND_BROWSE=1`)
opens the chapter browser instead.

`--fand` (or `FAND_DESKTOP=1`) starts PC FAND's own development environment, the FAND desktop:
'Ladit úlohu' (the chapter editor, compile, Ctrl+F9 to run), 'Provést úlohu', 'Instalace
úlohy' and 'Editace textu'. It asks once for a workspace folder (`--app-dir=` or `$FAND_DIR`
to override), which may be empty. A folder without its own `FAND.RES`/`FAND.CFG` uses the ones
bundled from ALIS PC FAND (MIT, `resources/fand`).

Examples: `npm run dev -- -- --fand`, `npm run dev -- -- --choose-app-dir`. The ported FAND keeps the FPC limit on the task directory: its
path may have at most 61 characters (the catalog stores absolute paths in 80 characters).

## What is known about the files (verified on Účto 2026.14)

See [docs/FORMATS.md](docs/FORMATS.md).
