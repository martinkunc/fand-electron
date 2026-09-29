export const meta = {
  name: 'fand-port-foundation',
  description: 'Foundation for the PC FAND -> TypeScript port: conventions, core types, unit skeletons; reference FAND on arm64; specs for replacing Windows helpers',
  phases: [
    { title: 'Foundation', detail: 'conventions, Pascal runtime, core unit skeletons' },
    { title: 'Skeletons', detail: 'typed skeletons for all remaining units' },
    { title: 'Typecheck', detail: 'make the whole skeleton tree typecheck' },
    { title: 'Reference', detail: 'make the FPC reference FAND run on arm64' },
    { title: 'Helpers', detail: 'spec cross-platform replacements of Windows helpers' },
  ],
}

const ROOT = '/home/mkunc/src/fand-electron'
const CTX = `
PROJECT CONTEXT (read carefully):
We are building a cross-platform re-implementation of PC FAND 4.2 (Czech DOS RDBMS/4GL) in TypeScript/Node, to run the accounting app "Účto 2026" natively inside Electron with a React DOS-text console. No emulator.
Repo: ${ROOT} (Node 24, ESM, TypeScript 7 run directly by Node type-stripping; relative imports MUST use the '.ts' extension; typecheck with 'npx tsc -p .' from the repo root; tests 'npx vitest run').
Already existing and working (read them, reuse, do not rewrite):
- src/engine/fand/{numbers,coding,tfile,datafile,rdb}.ts – codecs (Real48, fixed-point F fields, BCD, TP Random, XOR/XDecode), T-file reader, data file reader, RDB chapter loader.
- src/engine/console/{screen,crt,keys,keyqueue,cp852}.ts – virtual text screen (cells hold Unicode chars), Crt with BLOCKING readKey() (engine runs in a worker thread; keyboard is a SharedArrayBuffer queue with Atomics.wait), BIOS key codes, CP852 tables.
- src/engine/runtime/fand.ts (engine entry runFand), src/engine/worker.ts, src/engine/testing/driver.ts (headless EngineDriver: press keys, waitFor screen text), src/engine/testing/refdriver.ts (drives the reference FAND in a pty).
- docs/FORMATS.md – verified file-format knowledge. README.md.
Pascal sources:
- ${ROOT}/vendor/reference/standa_pcfand (git checkout, branch fpc-migration): Free Pascal port of PC FAND where the x86 asm and DOS specifics are already rewritten in Pascal (FANDDOS.PAS batch interpreter, FANDPDF.PAS, FANDCP.PAS code pages, COMMONFPC/DISKFPC). THIS IS THE PRIMARY SOURCE for porting logic.
- ${ROOT}/vendor/reference/alisoss_pcfand/pas: the original Borland Pascal 7 sources (MIT) – cross-check semantics, especially where the FPC port uses {$ifdef FPC}.
- ${ROOT}/vendor/reference/spainhell_cppfand: a C++ rewrite (no license – read only for understanding, never copy code).
- The Účto installation (pristine, NEVER modify): ${ROOT}/vendor/extracted/app. Decoded chapter sources of Účto: ${ROOT}/work/source/<PROJECT>_<EXT>/NNNN_<type>_<name>.txt (+ _index.tsv). Decompiled .NET helpers: ${ROOT}/work/decompiled/<folder>_<exe>/ (C#).
RULES: Never run git commit/push (the user forbade commits). Never modify vendor/extracted or work/ucto; if you need a writable Účto copy make your own under ${ROOT}/work/tmp-<yourname>/. Keep the code style of existing files (2-space indent, single quotes, short purposeful comments).
`

const CONVENTIONS = `
PORTING CONVENTIONS (the foundation agent writes these into docs/PORTING.md; everyone follows them):
1. One TS module per Pascal source file, lowercase, in src/engine/pas/ (e.g. ACCESS.PAS -> src/engine/pas/access.ts, include file FILEACC.PAS -> src/engine/pas/fileacc.ts, RUNEDIT1.PAS -> runedit1.ts). Include files become their own modules that the unit module re-exports (export * from './fileacc.ts').
2. Keep Pascal identifiers verbatim (CFile, CRecPtr, RdPrefix, FileD, FieldDescr ...). Every ported routine gets a comment with its origin, e.g. '// PAS: FILEACC.PAS TFile.RdPrefix'.
3. Unit-level interface variables: ES module bindings cannot be assigned from other modules, so each unit exports ONE mutable state object named after the unit with a trailing underscore-free PascalCase name + 'Vars', e.g. 'export const AccessVars = { CFile: null as FileD | null, CRecPtr: null as Uint8Array | null, ... }'. Implementation-private globals may be plain module 'let'.
4. Strings: Pascal string/ShortString/char data are BYTE STRINGS: JS strings whose char codes are the raw CP852 bytes 0..255 (never Unicode). Convert to Unicode only at the screen boundary (drivers layer writes cells via cp852 byteToChar) and for host file names. 'char' = 1-char byte string. LongStr (LongStrPtr) = Uint8Array (length = LL). Record buffers (CRecPtr etc.) = Uint8Array with DataView helpers.
5. Pointers to records = object references (null for nil). Variant records (case ... of) = a TS class/interface with all variant fields optional, discriminated by the tag (e.g. FrmlElem.Op). 'absolute' overlays = explicit conversions.
6. Numbers: real/float/extended/comp = number; integer/word/byte/longint = number with explicit wrap helpers (pasrt.ts: word(), byte(), int16(), int32()) where overflow semantics matter. Stored formats use src/engine/fand/numbers.ts.
7. Heap (MEMORY.PAS GetStore/ReleaseStore/Mark/Release, MemAvail): JS GC; implement as allocation of fresh objects/arrays and no-op releases; MemAvail/MaxAvail return large constants. Overlays: ignore.
8. Non-local exits: Pascal RunError/GoExit/NewExit/RestoreExit (longjmp in the modified BP7 RTL) become exceptions: class FandRunError / GoExitSignal etc. in pasrt.ts; NewExit/RestoreExit become try/catch at the same places.
9. Everything synchronous. Screen/keyboard via the existing Crt (src/engine/console/crt.ts) – the DRIVERS unit owns a module-level reference to the active Crt set at start-up. Files via node:fs sync APIs with a handle table (HANDLE.PAS). Record locking for shared/network use: implement in-process semantics (single user) with a clear TODO.
10. Not ported now – provide typed stubs that throw 'not supported': BGI graphics (GR*.PAS, RUNGRAPH), SQL/Channel (CHANNEL/CHNNEL), DML/FANDDML, IPX. Prolog (RDPROLG/RUNPROLG) IS needed (Účto has Prolog chapters) – ported later.
11. Circular imports between units are allowed but no module may USE another unit's exports at module top level (only inside functions), to be safe with cycles.
12. Stubs: every not-yet-implemented routine is 'export function Name(...): T { return notImpl('UNIT.Name') }' with notImpl from pasrt.ts, keeping the exact parameter list (var params -> use { v: T } boxes, named Ref<T> in pasrt.ts, or return tuples – choose ONE convention and document it).
`

const RESULT = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    openQuestions: { type: 'array', items: { type: 'string' } },
    typecheckClean: { type: 'boolean' },
  },
  required: ['summary', 'files', 'openQuestions'],
}

// ---------------- Track 1: foundation -> skeletons -> typecheck ----------------
const foundationTrack = async () => {
  phase('Foundation')
  const foundation = await agent(`${CTX}\n${CONVENTIONS}\n
YOUR TASK (foundation for a parallel port; other agents will build on exactly what you produce):
1. Write docs/PORTING.md with the conventions above, made precise (include the var-parameter convention you choose, the exception classes, the state-object pattern, how byte strings meet the Screen, examples).
2. Write src/engine/pas/pasrt.ts: Pascal runtime helpers used everywhere: Ref<T>, notImpl, FandRunError/GoExit exceptions, byte-string helpers (Copy, Pos, Delete, Insert, UpCase with the FAND/CP852 semantics where relevant, Str/Val for integers and reals with Pascal formatting 'Str(r:w:d)', FillChar/Move equivalents on Uint8Array, ord/chr, word/byte wrap), date/time host access (Today, Time). Unit test it in test/pasrt.test.ts.
3. Write COMPLETE typed skeletons (all interface types, constants, the unit state object with all interface variables, and every interface procedure/function as a typed stub) for: BASE.PAS, DRIVERS.PAS, ACCESS.PAS together with its includes TYPE.PAS/FILEACC.PAS/INDEX.PAS/RECACC.PAS, and RDRUN.PAS. Use the FPC branch sources. These are the core types (FileD, FieldDescr, FrmlElem, KeyD/XKey, LinkD, LocVar, RdbD, InstrPtr and all instruction records, EditD, report types...) that every other unit uses – be exhaustive and faithful.
4. 'npx tsc -p .' must pass. Do not implement procedure bodies beyond trivial ones.
Return summary, files written, open questions for the orchestrator.`, { label: 'foundation', phase: 'Foundation', schema: RESULT, effort: 'high' })

  phase('Skeletons')
  const GROUPS = [
    { key: 'base-layer', units: 'OBASE.PAS, OBASEWW.PAS, KEYBD.PAS, KBDWW.PAS, HANDLE.PAS, MEMORY.PAS, COMMON.PAS (+COMMONFPC.PAS), DISK.PAS (+DISKFPC.PAS), FANDCP.PAS, FANDDOS.PAS, FANDPDF.PAS (FPC additions), SORT.PAS; typed stubs only for GR*.PAS, RUNGRAPH.PAS, CHANNEL.PAS, CHNNEL.PAS, DML.PAS, FANDDML.PAS, IPX.PAS' },
    { key: 'data-layer', units: 'OACCESS.PAS, OLONGSTR.PAS, OLDTXX.PAS, EXPIMP.PAS, PRINTTXT.PAS, NLQ.PAS' },
    { key: 'compiler', units: 'COMPILE.PAS with includes LEXANAL.PAS, RDMIX.PAS, RDFRML.PAS, RDFRML1.PAS; RDFILDCL.PAS, RDPROC.PAS, RDEDIT.PAS, RDRPRT.PAS, RDMERG.PAS, RDPROLG.PAS' },
    { key: 'runtime-ui', units: 'RUNFRML.PAS, RUNPROC.PAS, RUNEDI.PAS with RUNEDIT1/2/3.PAS, RUNRPRT.PAS, RUNMERG.PAS, RUNPROJ.PAS with PROJMGR.PAS/PROJMGR1.PAS, RUNFAND.PAS, RUNBATCH.PAS, WWMENU.PAS, WWMIX.PAS, EDITOR.PAS with EDGLOBAL/EDTEXTF/EDEDIT/EDSCREEN/EDEVENT/EDEVINPT/EDEVPROC.PAS, GENRPRT.PAS, RUNPROLG.PAS, FAND.PAS (main program -> src/engine/pas/fand.ts exporting a main entry)' },
  ]
  const skeletons = await parallel(GROUPS.map(g => () => agent(`${CTX}\n
The foundation agent has written docs/PORTING.md, src/engine/pas/pasrt.ts and the core skeletons (base, drivers, access+includes, rdrun) in src/engine/pas/. Read docs/PORTING.md first and follow it exactly; import core types from those modules (do NOT redefine them; if something core is missing, add it to the right core module minimally and mention it).
Foundation agent summary: ${JSON.stringify(foundation?.summary ?? '')}

YOUR TASK: write complete typed skeletons (interface types, constants, unit state object, every interface routine as a typed notImpl stub; implementation-section routines are NOT needed yet) for these Pascal sources (FPC branch): ${g.units}.
Also list, per unit, a short porting note at the top of each file: which routines are asm/DOS-specific, key global state, tricky parts.
'npx tsc -p .' should pass for your files (other agents write other files concurrently; ignore errors that are clearly in their files).
Return summary, files, open questions.`, { label: `skeleton:${g.key}`, phase: 'Skeletons', schema: RESULT })))

  phase('Typecheck')
  const tc = await agent(`${CTX}\n
Several agents just wrote typed skeletons of all PC FAND units under src/engine/pas/ following docs/PORTING.md. Make the whole tree consistent: run 'npx tsc -p .' and fix every error (duplicate/conflicting type definitions -> keep the one in the unit that owns it per Pascal; missing imports; wrong signatures vs the Pascal interface). Verify every Pascal unit/include of the FPC branch has its module (list any missing and create them). Run 'npx vitest run'. Report remaining problems.
Agent summaries: ${JSON.stringify(skeletons.filter(Boolean).map(s => s.summary))}`, { label: 'typecheck-fix', phase: 'Typecheck', schema: RESULT })
  return { foundation, skeletons, tc }
}

// ---------------- Track 2: reference FAND on arm64 ----------------
const referenceTrack = () => agent(`${CTX}\n
TASK: make the reference PC FAND (Free Pascal port, ${ROOT}/vendor/reference/standa_pcfand, branch fpc-migration, built by tools/build.sh into bin/fand; FPC 3.2.2 is installed) run on THIS machine (Linux aarch64). Currently 'bin/fand ucto2026' started in a copy of the Účto folder crashes immediately: 'EAccessViolation' exit 217 (also examples/hello fails to build/run). You may modify files inside vendor/reference/standa_pcfand (it is a separate throw-away clone, gitignored in our repo); keep changes minimal and list them. Likely causes: x86_64 assumptions (pointer size, alignment, calling conventions, inline asm guarded by CPUX86_64, packed records, SizeOf(pointer)=8 but code assumes Intel). Build with debug info (tools/build.sh -gl), use gdb if available (apt-get install gdb is allowed) to find the crash.
Test in your own copy: cp -a ${ROOT}/vendor/extracted/app ${ROOT}/work/tmp-ref/ucto (plus FAND.RES/FAND.CFG from bin). Drive it with ${ROOT}/src/engine/testing/refdriver.ts (RefFandDriver: pty + headless xterm; it may need fixes – e.g. FANDRES env handling, case of Fand.Res) until the Účto 2026 start screen / main menu is visible, and note which keys get into the main menu. Účto may ask for first-run setup, date, or license – document what appears.
Deliverables: working bin/fand on aarch64, a script ${ROOT}/scripts/build-ref-fand.sh that reproduces your fixes (applies a patch file ${ROOT}/scripts/ref-fand-arm64.patch then builds), a vitest ${ROOT}/test/reffand.test.ts (skipped when bin/fand is missing) that starts Účto in the reference and waits for the main menu, and a short doc section appended to docs/FORMATS.md or a new docs/REFERENCE.md describing how to use the reference as a test oracle (screens + resulting data files).`, { label: 'reference-fand-arm64', phase: 'Reference', schema: RESULT, effort: 'high' })

// ---------------- Track 3: helper specs ----------------
const HELPER_GROUPS = [
  { key: 'gov-lookups', list: '{ap02}/Ares2.exe, {ap02}/Nepl2.exe, {tisk}/UctoVIES.exe, {tisk}/ELDOTAZ.EXE, {tisk}/UctoFoD.exe, {tisk}/FileDown.exe, {tisk}/uctoGuid.exe, {tisk}/WFDETECT.EXE' },
  { key: 'datove-schranky', list: '{ap02}/UctoDS.exe, {ap02}/UctoDS2.exe, {tisk}/CERTINFO.EXE, {tisk}/ELPODPI2.EXE, {tisk}/ELPODPIS.EXE (native), {tisk}/ENESCHOP.EXE, {tisk}/sifrcssz.exe (native installer)' },
  { key: 'efiling-xml', list: '{ap05}/UctoXml.exe (+ Xsd/), {ap05}/UctoConv.exe, {tisk}/XmlP.exe, {free}/SkodaXml.exe, {tisk}/UctoApep.exe' },
  { key: 'exports-insurance', list: '{ap04}/UctoExp.exe (OpenXml/Excel export), {ap03}/UctoZP2.exe (health insurance e-filing), {tisk}/Oprava.exe, {tisk}/UctoMD.exe, {tisk}/UCTOOL2.EXE, {tisk}/Uctool3.exe, {tisk}/UCTOOL.EXE (native)' },
  { key: 'print-pdf-qr', list: 'printing and documents: {tisk}/Utisk04.exe, UTISK01.EXE, utisk98.exe, UBOX.exe, Ubox2.exe, CALLER.exe, CALLASOC.EXE, FAND2PDF.EXE, PDFMERGE.EXE, PDFTISK1/2/3.EXE, POSTTISK.EXE, AlisFand.exe, UctoQR.exe, UctoQR2.exe, TOUTF8.EXE, UCTOGRAF.EXE; the DOSBox print spool {dbx2}\\print#.prn and FAND.CFG printer definitions' },
  { key: 'comm-misc', list: 'communication and misc: {tisk}/UEmail17.exe, UEMAIL.EXE, UEMAIL06.EXE, UCTOFTP.EXE, UCTOFTP2.EXE, UctoFtp3.exe, UCTOFT98.EXE, ClipFand.exe, FANDCLIP.EXE, CONFIG2.EXE, UCTOCONF.EXE, DELFILE2.EXE, DISKSIZW.EXE, DISKY.EXE, FNDFILE2.EXE, SEARCHW.EXE, REGISTER.EXE, WINVERZE.EXE, UCTOLNK*.EXE, NUMKBVD.exe, SETUP*.EXE; plus the small DOS utilities in the app root (DELFILE, DISKSIZE, FILESIZE, FNDFILES, ISSHARE, NIC, NUMKB*, RO, SEARCHX, SETDATE, SETFILES, SUBDIR, SUDLICH, VYBERTXT, TXTNARTF, FANDHTML, FANDT602, FANDINST) and all .BAT files' },
]
const helperTrack = () => parallel(HELPER_GROUPS.map(h => () => agent(`${CTX}\n
TASK: Účto calls Windows helper programs from FAND code (EXEC / CALL statements in chapters, .BAT files, parameter/exchange files). We will replace each with a cross-platform Node/TypeScript equivalent that the engine's EXEC layer invokes in-process. Produce the SPECIFICATION (not the implementation yet) for these helpers: ${h.list} (paths relative to ${ROOT}/vendor/extracted/app).
For each helper:
- How Účto invokes it: grep the decoded chapter sources ${ROOT}/work/source (and .BAT files, FAND.CFG strings) for the exe name; quote the calling FAND code (file + snippet), command-line args, working dir, exchange files written before / read after, return codes, and which Účto feature/menu uses it.
- What it does: for .NET helpers read the decompiled C# in ${ROOT}/work/decompiled/ (exact file formats, encodings (CP852/CP1250/UTF-8), URLs/web-service endpoints and SOAP/REST payloads, certificates, UI dialogs shown). For native/VB6 binaries use 'strings -el' and 'strings' plus the calling code to infer behaviour; mark inferences clearly.
- Replacement design in Node (npm libraries to use, e.g. fast-xml-parser, pdf-lib, qrcode, nodemailer, basic-ftp, exceljs, node-forge; which OS integration is needed: open file/URL, print, clipboard via Electron), whether it still makes sense (e.g. DOSBox/vDos launchers, Windows shortcuts are obsolete), and a test approach (fixtures from decompiled logic / sample files in {prik}).
Write one markdown file per helper to ${ROOT}/docs/helpers/<exe-name-lowercase>.md and return a compact summary table in 'summary' (helper | purpose | invoked from | replacement | priority high/med/low | effort S/M/L).`, { label: `helpers:${h.key}`, phase: 'Helpers', schema: RESULT })))

const [core, reference, helpers] = await parallel([foundationTrack, referenceTrack, helperTrack])
return { core, reference, helpers }
