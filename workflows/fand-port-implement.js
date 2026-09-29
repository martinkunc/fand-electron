export const meta = {
  name: 'fand-port-implement',
  description: 'Implement all PC FAND units in TypeScript (15 packages), then integrate, bring Účto up against the reference FAND and run targeted audits where behaviour differs',
  phases: [
    { title: 'Implement', detail: 'port each package from the FPC/BP7 Pascal into the skeleton modules, with tests' },
    { title: 'Integrate', detail: 'typecheck + full test run, compile all Účto chapters' },
    { title: 'BringUp', detail: 'run Účto in our engine vs the reference FAND, find discrepancies' },
    { title: 'Audit', detail: 'targeted audits of modules implicated by discrepancies' },
  ],
}

const ROOT = '/home/mkunc/src/fand-electron'
const CTX = `
PROJECT: TypeScript re-implementation of PC FAND 4.2 (Czech DOS RDBMS/4GL) to run the accounting app Účto 2026 natively in Electron (no emulator). Repo ${ROOT} (Node 24 ESM, TS run by Node type stripping, relative imports with '.ts'; 'npx tsc -p .'; 'npx vitest run').
The port lives in src/engine/pas/ – one module per Pascal file, ALREADY SKELETONED: all types, unit state objects (<Unit>Vars) and every interface routine exist as typed stubs calling notImpl(). READ docs/PORTING.md FIRST and follow it exactly (byte strings = CP852 bytes as char codes, Ref<T> var params, exceptions for RunError/GoExit, heap = GC, no top-level use of other units, BP7 semantics win over FPC where data compatibility is concerned – e.g. Real48 index keys, Czech 'ch' collation).
Pascal sources: PRIMARY ${ROOT}/vendor/reference/standa_pcfand/pas (branch fpc-migration: asm/DOS rewritten in Pascal); ORIGINAL ${ROOT}/vendor/reference/alisoss_pcfand/pas (BP7, authoritative semantics); ${ROOT}/vendor/reference/spainhell_cppfand (C++ rewrite, read-only aid, never copy code).
Existing helpers to reuse: src/engine/fand/{numbers,coding,tfile,datafile,rdb}.ts, src/engine/console/{screen,crt,keys,keyqueue,cp852}.ts, src/engine/pas/pasrt.ts. Docs: docs/FORMATS.md, docs/REFERENCE.md (reference FAND = FPC build that runs Účto on this machine, driven by src/engine/testing/refdriver.ts; use it to observe real behaviour when useful).
Test data: pristine Účto install ${ROOT}/vendor/extracted/app (NEVER modify; copy to ${ROOT}/work/tmp-<label>/ if you need writable files). Decoded Účto FAND sources: ${ROOT}/work/source/*/ (useful for realistic compiler inputs). FAND language help: vendor/reference/standa_pcfand help files (and branch fand-help has Markdown: 'git -C vendor/reference/standa_pcfand show origin/fand-help:docs/help/...').
RULES: never git commit. Edit ONLY the modules of your package; other agents are concurrently editing other modules. If you truly need a change in a module outside your package (a missing type/field), keep it minimal and additive, re-read the file right before editing, and report it. Do not replace other packages' stubs with implementations. Keep existing file style (2-space, single quotes, comments with '// PAS: FILE.PAS Routine').
`

const PKGS = [
  { key: 'lexer-frml', mods: 'compile.ts, lexanal.ts, rdmix.ts, rdfrml.ts, rdfrml1.ts, rdfildcl.ts', pas: 'COMPILE.PAS, LEXANAL.PAS, RDMIX.PAS, RDFRML.PAS, RDFRML1.PAS, RDFILDCL.PAS', notes: 'Lexer, formula compiler, file declaration compiler (F chapters, #K keys, #L/#C/#D ... sections). Test: compile EVERY F chapter and D chapter of all Účto projects from work/source (or via src/engine/fand/rdb.ts) without errors; unit tests for formulas.' },
  { key: 'rdproc', mods: 'rdproc.ts, rdmerg.ts', pas: 'RDPROC.PAS, RDMERG.PAS', notes: 'Procedure compiler (all statements) and merge (M chapter) compiler. Test: compile all P and M chapters of Účto (after the F/D chapters they depend on; if the lexer/formula package is not ready yet, write the tests so they will pass once it is, and test what you can).' },
  { key: 'rdedit-rprt', mods: 'rdedit.ts, rdrprt.ts, rdrun.ts', pas: 'RDEDIT.PAS, RDRPRT.PAS, RDRUN.PAS', notes: 'Edit form (E chapters) and report (R chapters) compilers and the RDRUN runtime structure helpers. Test: compile all E and R chapters of Účto.' },
  { key: 'runfrml-proc', mods: 'runfrml.ts, runproc.ts', pas: 'RUNFRML.PAS, RUNPROC.PAS', notes: 'Formula evaluator (all functions: strings, dates, math, file functions) and the procedure interpreter (all instructions, CALL/EXEC dispatch into fanddos/helper registry). Unit tests for built-in functions with expected values from the FAND help text / BP7 semantics.' },
  { key: 'runedit', mods: 'runedi.ts, runedit1.ts, runedit2.ts, runedit3.ts', pas: 'RUNEDI.PAS, RUNEDIT1.PAS, RUNEDIT2.PAS, RUNEDIT3.PAS', notes: 'Data editing (browse/table/form modes, keys, validations, links). This is the core UI Účto users live in – be faithful to every key binding.' },
  { key: 'report-menu', mods: 'runrprt.ts, runmerg.ts, genrprt.ts, wwmenu.ts', pas: 'RUNRPRT.PAS, RUNMERG.PAS, GENRPRT.PAS, WWMENU.PAS', notes: 'Report runtime (output to screen viewer / print spool files), merge runtime, generated reports, menus (box/bar menus, help).' },
  { key: 'proj-main', mods: 'wwmix.ts, runproj.ts, projmgr.ts, projmgr1.ts, runfand.ts, runbatch.ts, fand.ts', pas: 'WWMIX.PAS, RUNPROJ.PAS, PROJMGR.PAS, PROJMGR1.PAS, RUNFAND.PAS, RUNBATCH.PAS, FAND.PAS', notes: 'Task (RDB) loading and compilation order, chapter management, main program start-up (command line "ufand ucto2026", env FANDOVRB/FANDCFG/UCTODBOX), dialogs in WWMIX. Provide in fand.ts a main(crt, {appDir, task, env}) that src/engine/runtime/fand.ts will call instead of the project browser (do not rewire runtime/fand.ts yourself; export the entry and describe how).' },
  { key: 'editor', mods: 'editor.ts, edglobal.ts, edtextf.ts, ededit.ts, edscreen.ts, edevent.ts, edevinpt.ts, edevproc.ts', pas: 'EDITOR.PAS, EDGLOBAL.PAS, EDTEXTF.PAS, EDEDIT.PAS, EDSCREEN.PAS, EDEVENT.PAS, EDEVINPT.PAS, EDEVPROC.PAS', notes: 'Text editor/viewer used for T fields, help, report viewing and chapter editing.' },
  { key: 'expimp', mods: 'expimp.ts', pas: 'EXPIMP.PAS', notes: 'Import/export (DBF, text, FAND formats), CodingCRdb/XEncode (encoding needed only for writing; XDecode already exists in src/engine/fand/coding.ts), copy/compress files.' },
  { key: 'prolog', mods: 'rdprolg.ts, runprolg.ts', pas: 'RDPROLG.PAS, RUNPROLG.PAS', notes: 'FAND Prolog (L chapters – Účto has 13). Test by compiling Účto L chapters and running small programs.' },
]

const RESULT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    implemented: { type: 'integer', description: 'routines implemented' },
    remainingStubs: { type: 'array', items: { type: 'string' }, description: 'routines still notImpl in your modules, with reason' },
    externalEdits: { type: 'array', items: { type: 'string' }, description: 'edits made outside your package' },
    tests: { type: 'string', description: 'test files and pass/fail counts' },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'remainingStubs', 'externalEdits', 'tests', 'issues'],
}

const results = await pipeline(
  PKGS,
  (p) => agent(`${CTX}
YOUR PACKAGE "${p.key}": implement modules ${p.mods} from ${p.pas}.
${p.notes}
Implement EVERY routine (interface and implementation section) faithfully; keep Pascal structure and names so the code can be audited side by side. Graphics/SQL/DML paths inside your units stay notSupported. Write focused vitest tests in test/pas-${p.key}.test.ts using real Účto files where possible. Before finishing: 'npx tsc -p .' clean for your files, your tests pass. Report precisely what remains.`, { label: `impl:${p.key}`, phase: 'Implement', schema: RESULT, effort: 'high' }).then(impl => ({ key: p.key, impl })),
)

const CMP = `
BRING-UP SETUP: reference FAND = FPC build (vendor/reference/standa_pcfand/bin/fand, see docs/REFERENCE.md) driven by src/engine/testing/refdriver.ts (RefFandDriver); our engine driven by src/engine/testing/driver.ts (EngineDriver). src/engine/testing/ucto.ts answers Účto's first-run screens for both. Always use fresh copies of the pristine install (RefFandDriver.copyTask or cp -a vendor/extracted/app work/tmp-<label>/...). Known intentional differences: BP7 semantics win over the FPC reference where data compatibility is concerned (docs/PORTING.md: Real48 index keys, Czech 'ch' collation) – do not 'fix' those towards FPC.`

phase('Integrate')
const integ = await agent(`${CTX}
All 15 packages of src/engine/pas were implemented (base, drivers, access, index-sort, oaccess in an earlier run) (no audits yet). Make the tree consistent: run 'npx tsc -p .' and 'npx vitest run'; fix type errors and failing tests caused by cross-package interactions (wrong signatures across modules, duplicated helpers, top-level cross-module use violating the PORTING.md cycle rule – verify every module loads on its own). List all remaining notImpl stubs in src/engine/pas with owners and implement the ones on the start-up path. Then wire the engine: src/engine/runtime/fand.ts must run the ported FAND main (pas/fand.ts entry from the proj-main package) for the task (keep the project browser reachable via an option, e.g. RunOptions.browse). Write test/smoke-compile.test.ts that loads UCTO2026.RDB (and each .PRO) through the ported project loader and compiles ALL chapters; fix compile failures that stem from porting bugs (compare with the Pascal) until all chapters compile, or report the remaining ones precisely.
Package reports: ${JSON.stringify(results.filter(Boolean).map(r => ({ key: r.key, remaining: r.impl?.remainingStubs, issues: r.impl?.issues })))}`, { label: 'integrate', phase: 'Integrate', schema: RESULT, effort: 'high' })

const DISC = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    reachedMainMenu: { type: 'boolean' },
    discrepancies: { type: 'array', items: { type: 'object', properties: {
      scenario: { type: 'string' }, expected: { type: 'string' }, actual: { type: 'string' },
      suspectModules: { type: 'array', items: { type: 'string' } }, pascalRoutines: { type: 'array', items: { type: 'string' } },
    }, required: ['scenario', 'expected', 'actual', 'suspectModules'] } },
    fixedDirectly: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'reachedMainMenu', 'discrepancies', 'fixedDirectly'],
}

const rounds = []
let last = null
for (let round = 1; round <= 3; round++) {
  phase('BringUp')
  const bu = await agent(`${CTX}${CMP}
BRING-UP round ${round}. Integration result: ${JSON.stringify(integ?.summary ?? '')}. Previous round: ${JSON.stringify(last ? { summary: last.bu?.summary, audits: last.audits.map(a => a?.summary) } : null)}
Goal: Účto 2026 runs in OUR engine exactly like in the reference FAND. Write/extend test/bringup-ucto.test.ts: start both on fresh copies, answer the first-run screens (ucto.ts), reach the main menu, then walk representative scenarios: open main menu items, the address book (ADRESY) browse/edit, add and save a record, the cash book/deník entry, a report shown on screen, exit. After each step compare screen text (normalize only cursor/clock/date noise) and at the end compare the resulting data files byte-for-byte (.0xx/.Txx/.Xxx; for index files mind the BP7-vs-FPC notes).
Fix small, obvious problems directly (report them in fixedDirectly). For everything non-trivial, report a discrepancy with the scenario, expected (reference) vs actual (ours), and the suspect TS modules + Pascal routines. Set reachedMainMenu truthfully.`, { label: `bringup:${round}`, phase: 'BringUp', schema: DISC, effort: 'high' })
  const groups = {}
  for (const d of (bu?.discrepancies ?? [])) {
    const k = (d.suspectModules?.[0] ?? 'unknown').replace(/\.ts$/, '')
    ;(groups[k] = groups[k] || []).push(d)
  }
  const keys = Object.keys(groups).slice(0, 6)
  if (Object.keys(groups).length > keys.length) log(`round ${round}: ${Object.keys(groups).length - keys.length} further module groups deferred to next round`)
  phase('Audit')
  const audits = await parallel(keys.map(k => () => agent(`${CTX}${CMP}
TARGETED AUDIT of module ${k}.ts (and closely related modules named below) driven by these concrete discrepancies between our engine and the reference FAND:
${JSON.stringify(groups[k], null, 1)}
Audit the implicated routines line by line against the Pascal (FPC branch + BP7 original): control flow, 1-based strings/arrays, integer wrap, byte strings vs Unicode, var params, exit/exception paths, silently simplified logic. Fix the root causes, add regression tests (test/pas-audit-${k}.test.ts), rerun the relevant bring-up scenario to confirm the discrepancy is gone, and report anything that remains.`, { label: `audit:${k}:r${round}`, phase: 'Audit', schema: RESULT, effort: 'high' })))
  last = { bu, audits }
  rounds.push(last)
  if (bu?.reachedMainMenu && (bu?.discrepancies?.length ?? 0) === 0) break
}

return { results, integ, rounds }
