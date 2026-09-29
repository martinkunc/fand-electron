# The reference PC FAND (test oracle)

`vendor/reference/standa_pcfand` is standa/pcfand, branch `fpc-migration`: the original
PC FAND 4.2x sources ported to Free Pascal (64-bit, native, no DOS). It runs Účto 2026
unchanged, so it tells us what a screen should look like after a sequence of keys and
what the data files should contain afterwards. Our engine is compared against it.

## Building

```sh
scripts/build-ref-fand.sh        # -> vendor/reference/standa_pcfand/bin/fand (+ FAND.RES, FAND.CFG)
scripts/build-ref-fand.sh -gl    # fpc options pass through; -gl puts line numbers in tracebacks
```

Needs FPC 3.2.2 (`apt install fpc`). The script clones the pinned commit (3cdf8e8) when
the directory is missing, applies `scripts/ref-fand-arm64.patch` (idempotent) and runs
the port's `tools/build.sh`, which also builds `examples/hello` as a smoke test.

What the patch changes and why (the upstream port was developed on x86_64 macOS):

| File | Change | Why |
|---|---|---|
| `pas/COMMONFPC.PAS` `ChainLast` | pointer sanity bound `$7FFFFFFFFFFF` -> `$FFFFFFFFFFFF` | On Linux aarch64, mmap'd memory (the 256 MB arenas, heap) lies above `0x7FFF_FFFF_FFFF` (e.g. `0xE51D…`), so every chain was cut after its first element. `CompileHelpCatDcl` then dereferenced nil: `EAccessViolation`, exit 217, at start-up. |
| `pas/HANDLE.PAS` `UnixPath` (+ new `CasePath`) | resolves each path component case-insensitively against the disk; also used by delete, rename and get/set attributes | DOS names are case-insensitive. Účto's catalogue says `{STAN}\PARAM3.000` while the directory is `{stan}`. macOS hides this; Linux does not. |
| `pas/HANDLE.PAS` `OpenH` | `ENOENT` in a missing directory gives DOS error 3, not 2 | Účto's `PathExist` checks a directory by opening `dir\PARAM1.$$$` and relies on 3 = "path not found". With 2, `{SEST}` was never created and every report failed with "soubor …\{SEST}\SEST00.TXT neexistuje". |
| `pas/HANDLE.PAS` `MyFExpand` | `$FANDRES`/`$FANDCFG` directories use the same case-insensitive lookup as the other places | `FANDRES=dir` looked for `dir/Fand.Res` only, but the file is `FAND.RES`. |
| `tools/build.sh` | deletes the old `FAND` before compiling; builds hello in a `mktemp` dir | A failed compile went unnoticed. The checkout path (93 characters) is longer than the catalogue's 79, so hello always failed with "cesta je příliš dlouhá pro katalog". |

gdb does not work in this container ("Unable to fetch SVE/SSVE vector length"). Build
with `-gl` and read FPC's own traceback (unit, line) instead.

## Running it by hand

```sh
cp -a vendor/extracted/app /tmp/u        # keep the task path short (<= ~60 chars)
cd /tmp/u && FANDRES=$PWD_OF_REPO/vendor/reference/standa_pcfand/bin \
  $PWD_OF_REPO/vendor/reference/standa_pcfand/bin/fand UCTO2026
```

- The task name is the RDB's file name, case-sensitive on Linux: `UCTO2026`, not
  `ucto2026` ("úloha …/ucto2026.RDB neexistuje"). `RefFandDriver` fixes the case for you.
- FAND.RES and FAND.CFG are looked up in `$FANDRES`/`$FANDCFG`, then the task
  directory, then beside the binary, then on `PATH`. Use the reference's own FAND.RES,
  which matches the binary's message numbers: Účto ships an older 4.20 FAND.RES in its
  folder, so set `FANDRES`. Use Účto's own FAND.CFG from the task directory (colours,
  printers, the same version 4.20).
- `FAND_SIZE=80x25` fixes the screen size and `FAND_ENCODING=utf8` sets the terminal
  encoding (FAND paints CP852).
- Never run it in `vendor/extracted/app` or `work/ucto`: it writes to the task
  directory (see below).

## Getting to the main menu

First run of a pristine copy (about 5.5 s):

| Screen | Keys |
|---|---|
| "Přemístění programu" (the data are elsewhere than last time) | Enter |
| "VYBERTE VERZI": 1) ostrá verze/upgrade (needs licence data), 2) demoverze, 3) prohlížecí verze | Down, Enter (demo) |
| "Přepnout na Demonstrační verzi účta ? N" | `A` |
| Help page "DEMOVERZE PROGRAMU ÚČTO" | Esc |
| "Hlášení: Děkujeme Vám za zájem o program účto 2026." | Enter |
| "(U141) Jednorázové upozornění: LETNÍ PROVOZNÍ DOBA" | Enter |
| "(U002) Upozornění: VYHRAZENÝ ADRESÁŘ {PRIK}" (sample company STEHLÍK & SYN NOVÝ BOR) | Enter |
| Report "NEUHRAZENÉ ZÁVAZKY SPLATNÉ DO 7 DNŮ" | Esc |
| Main menu: `Finance Inventář Přehledy Tiskopisy Ostatní Nápověda`, Finance pull-down open | |

Later starts on the same copy (about 2.5 s): "Přemístění programu" (Enter), then "Demoverze:
… bude normálně pracovat ještě 30 dnů" (Enter), then the main menu. There is no date
prompt; FAND uses the system date. The demo expires 30 days after the first run, so
tests start from a fresh copy. To quit: Esc closes the pull-down, Esc asks "Ukončit
program účto ? A", Enter exits with code 0.

"Přemístění programu" appears on every start under the reference. Účto appends `\` to
the directory unless it already ends in `\`, but the port hands it Unix paths ending in
`/` ("minule: …/ucto/", "nyní: …/ucto/\"). It is a port artefact, harmless.

`src/engine/testing/ucto.ts` has this as data (`UCTO_START_ANSWERS`), and
`startUcto(driver)` answers whatever of it shows up until the main menu is up. It
works with both `RefFandDriver` and `EngineDriver`.

## As a test oracle

```ts
import { RefFandDriver, copyTask } from '../src/engine/testing/refdriver.ts';
import { startUcto } from '../src/engine/testing/ucto.ts';
import { K } from '../src/engine/console/keys.ts';

const dir = copyTask('vendor/extracted/app');          // fresh copy in /tmp/fandref-XXXX/task
const ref = new RefFandDriver({ taskDir: dir, task: 'ucto2026' });
await startUcto(ref);
ref.press(K.Enter, K.Down, K.Down, K.Enter);           // Finance > Peněžní deník > Seznam
const screen = await ref.waitFor('PENĚŽNÍ DENÍK');     // 80x25 text, same as EngineDriver.text()
```

- **Screens:** `RefFandDriver` has the same `press`/`waitFor`/`text` API as `EngineDriver`.
  Run the same keys in both (each on its own copy) and compare `text()`. Only
  characters are compared now. The headless xterm also holds colours
  (`buffer.getLine(y).getCell(x)`), if attributes are needed later.
- **Data files:** after the keys, quit Účto (Esc, Esc, Enter; wait for `exited`) so that
  FAND flushes its cache. Then compare the copy's files with the engine's copy using the
  readers in `src/engine/fand` (`DataFile`, `TFile`), record by record. Byte-exact
  comparison also works for files both sides write, but `.X??` indexes and free-space
  layout may legitimately differ. The first run alone creates or changes these (from
  the diff against the pristine app):
  - `UCTO2026.CAT`, `TIPY.000`, `{glob}/MODULY.000` (changed);
  - `{glob}/FIRMY.000`, `{glob}/PARAM1.000`;
  - `{stan}/PARAM3.000/.T00`, `PAR01A3.001/.T01`, `PGM.000`, `STAT.000`;
  - `{prik}/PARAM4.000/.T00`, `PAR01A2.001`, `PAR01A4.001`, `PAREET.001/.T01`;
  - indexes `*.X0?`, `TIPY.X00`, `UCTOTXT.UUU`;
  - directories `{SEST}` and `{OBNV}`.
- `test/reffand.test.ts` is the smoke test: start, main menu, quit, files written. It is
  skipped when `bin/fand` or the extracted Účto is missing.

Limits of the oracle:

- Commands Účto runs through `exec` go to FANDDOS, whose builtins (`md`, `del`, `copy`,
  `ren`, masks) do not resolve case. `md {SEST}` creates `{SEST}` next to any existing
  lowercase directory, and `del {STAN}\X` misses `{stan}/X`. Real `.EXE` helpers
  (UTISK, FANDHTML, …) are not available. Printing becomes a PDF (FANDPDF).
- Not ported upstream: graphics, DML, the SQL client, XEncode export compression.
  Compiled FileD segments in the RDB are not read either (`RdFDSegment` is a stub under
  FPC), so the reference always compiles file declarations from source.
- It is the development FAND (`FANDHLP`, not the run-time `UFAND`/`UFANDHLP`). Účto
  runs the same way, but help and error texts come from the reference's FAND.RES.
