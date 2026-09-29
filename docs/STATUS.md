# Project status (2026-09-29)

Nothing is committed (the user asked for no commits until the work is done). Everything
below is on disk in this folder. Backup tarballs: `/home/mkunc/src/fand-electron-backup-20260928-2000.tar.gz`
(current, without node_modules and work/tmp-*) and the older
`/home/mkunc/src/fand-electron-backup-20260928-1340.tar.gz`; it predates the engine
implementation below.

## Done

* **Download and extraction.** `scripts/fetch-ucto.sh` downloads and extracts Účto 2026.14.
  * Pristine backup: `vendor/extracted/app` (never modify).
  * Working copy: `work/ucto`.
* **File formats and protection** (`docs/FORMATS.md`, `src/engine/fand/*`). All 5,420
  chapters of all 49 projects decode.
* **Electron shell and React VGA console** (CP852 font, worker-thread engine, headless
  `EngineDriver`).
* **Reference FAND** (FPC build) runs on arm64 (`scripts/build-ref-fand.sh`,
  `docs/REFERENCE.md`, `RefFandDriver`).
* **Engine port to TypeScript, all 15 packages implemented** (`src/engine/pas/`, rules in
  `docs/PORTING.md`):
  * 0 `notImpl` left; only 2 intentional ones remain in `pasrt.ts`. Graphics and SQL/DML
    stay notSupported.
  * `npx tsc -p .` is clean, and `npx vitest run` passed after integration (about 470 tests).
  * `src/engine/runtime/fand.ts` runs the ported FAND `main` (like `U.BAT`: `ufand ucto2026`,
    `FANDOVRB=80`). `RunOptions.browse` keeps the project browser reachable.
  * The engine is generic PC FAND; Účto's files run unmodified. Účto-specific pieces are
    only launch defaults, helpers and test fixtures.
* **Bring-up against the reference** (`test/bringup-ucto.test.ts`, about 100 s or more):
  * Our engine reaches Účto's main menu, and the screens and data files match the
    reference in the tested scenarios.
  * Differences that remain are intentional, where BP7 semantics win over the FPC
    reference:
    * Real48 index keys: the VAT label shows 21%/12% in ours but fails in the reference.
    * The random generator: tips are clock-seeded, so they are masked in the test.
    * `WriteH` with 0 bytes truncates the file, as on DOS.
    * `printtxt`/printing: our UTISK04 port versus the reference's fallback.
* **DOS utilities:** `fanddos.ts` `DosExtra` now tries the `registerHelper` registry, then
  `FandDosExtra`, then built-in TS ports of five Účto DOS tools. These include `FILESIZE`
  and `SETDATE`, and they make the new-company flow with the `{NOVA}` templates work.
  * Bring-up runs our engine with `FAND_DOSTOOLS=0`, because the reference cannot run them.
  * Not yet ported (still go to `/bin/sh`): DELFILE, FNDFILES, SEARCHX, SETFILES, RO,
    NUMKB/NUMKB3/NUMKB4, SUDLICH, VYBERTXT, TXTNARTF, FANDHTML and others.
* **Helpers.** Hybrid decision; see `docs/HELPERS-PLATFORMS.md`:
  * Windows runs the original exes.
  * On macOS/Linux, the .NET helpers run under a bundled Mono (`shims/mono/`,
    `scripts/mono/`, partial `src/helpers/mono.ts` and `dispatch.ts`).
  * TS ports: `utisk04`, `fand2pdf`, `uctoexp` (temporary). Specs are in `docs/helpers/*.md`.

## Workflow `workflows/fand-port-implement.js` (run `wf_1c5521e8-664`)

* The script now contains only the 10 packages that were unfinished at 13:40. All of
  them are done.
* Timeline:
  * Implement: 13:37–14:53.
  * Integrate: to 15:21.
  * Bring-up 1 and its audits: to 16:52.
  * Bring-up 2: its first try died and was retried, then its audits ran; to about 19:35.
  * Bring-up 3 was still running at 20:00, as the last round.
* The final report (the round 3 result) must be read from the session transcript, or from
  `~/.claude/projects/-home-mkunc-src-fand-electron/5578a102-2c68-4a6b-86b8-b450c53954b7/subagents/workflows/wf_1c5521e8-664/journal.jsonl`.
* To resume in a new session, **do not** re-run the whole script, which would redo all the
  implementation agents. Instead, run only a bring-up and audit loop: copy the BringUp/Audit
  part of the script and pass the last summaries in.

## DOS paths (2026-09-29)

Tiskopisy > Faktura > Faktury failed with 'kapitola neexistuje' and then 630 'úloha MODUL06 není
odladěna'; the FPC reference fails there too. The cause: Účto parses paths as on DOS. Its
`LogName` takes a file's name with `EndTxt('\',F.Path)`, so a host path gave an empty name.

* The engine now shows the task DOS paths (`HANDLE.DosView`, see PORTING.md). `C:` is the
  parent of the app directory, so the app is `C:\UCTO`, and `Z:` is `/`.
* The catalogue stores DOS paths, as on Windows.
* The 'Přemístění programu' warning no longer appears on every start. It compared the stored
  path with `/…/ucto/\`, which never matched.
* Tests: `test/ucto-dospaths.test.ts` is new, and `pas-proj-main` expects DOS paths. The
  bring-up runs ours with `FAND_DOSPATHS=0` so it can be compared with the reference.
* An old `work/ucto` still has host paths in its catalogue. They are converted when read, and
  the relocation warning appears once.

## Next steps

1. ~~Read the round 3 bring-up result.~~ Done 2026-09-29. Round 3 was killed before it
   finished, but not by the engine: our run peaks at about 240 MB. Its unfinished scenario is
   now scenario D in `test/bringup-ucto.test.ts`: reports, fixed assets, and the VAT and
   calendar calculators. It passes. Its only differences are two known reference faults:
   * SAZDPH VAT rates (Real48);
   * the FPC TypeDay skips the FAND.CFG holiday table, so the reference counts 261 working
     days in 2026 and ours counts the correct 250.
2. Extend the bring-up scenarios: daily bookkeeping, reports, printing and export paths.
3. Port the remaining MZ DOS utilities listed above, or register TS replacements for them.
4. Restart `workflows/ucto-mono-helpers.js` for the .NET helpers under Mono. It was
   stopped on purpose; the engine now reaches the EXEC calls.
5. Run the Electron app end to end (`npm run dev`) and package it with electron-builder.

## Known issues and notes

* `test/bringup-ucto.test.ts` is slow, and in one audit it hit a 590 s timeout. Run it on
  its own.
* Účto's main menu depends on the task path. Under long paths the menu has no
  'Nápověda', so tests use short `/tmp/fandbu-*` directories.
* `runfrml.ts` has its own copy of `DiskFree` (drive 0 uses '.'); the hardened copy is in
  `disk.ts`. These should be unified.
* `numbers.ts` `writeReal48`: ties round up, not to even as on the 8087 (minor).
* The editor modules still have redundant truncation workarounds; they are harmless now
  that `WriteH(h,0)` truncates.
* Toolchain on the machine (outside the repo): Node 24, .NET 8 SDK in /opt/dotnet plus
  ilspycmd, fpc 3.2.2, mono 6.8, xvfb, innoextract, poppler-utils, zbar-tools,
  fonts-liberation.
