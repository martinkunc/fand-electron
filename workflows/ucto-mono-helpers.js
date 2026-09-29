export const meta = {
  name: 'ucto-mono-helpers',
  description: 'Run original Účto .NET helpers on macOS/Linux via bundled relocatable Mono + substitute assemblies + IL patching; Windows runs originals natively',
  phases: [
    { title: 'Build', detail: 'runtime bundles, Rebex substitute, patcher + Windows substitutes, engine integration' },
    { title: 'Verify', detail: 'run every .NET helper under the bundled runtime' },
    { title: 'Report', detail: 'matrix, docs, cleanup' },
  ],
}

const ROOT = '/home/mkunc/src/fand-electron'
const CTX = `
PROJECT: Electron app that runs the Czech accounting program Účto 2026 (originally DOS PC FAND + Windows helper programs) natively on Windows/macOS/Linux. It is installed INTO an existing Účto folder. Decision by the user: HYBRID helpers –
 * Windows: EXEC runs the original helper .exe directly.
 * macOS/Linux: original .NET helpers run under a BUNDLED relocatable Mono (shipped with the app), made compatible without modifying the originals by (1) the launcher shims/mono/host/UctoMonoHost.cs (own AppDomain with the helper's X.xml as config, preloads substitute assemblies), (2) substitute assemblies with the original identity (e.g. shims/mono/rebex: Rebex.* 6.0.8000.0, public key token 1c4638788972655d, delay-signed with rebex-public.snk – Mono does not verify strong-name signatures) implemented over Mono's own APIs, (3) the IL patcher shims/mono/patch/UctoPatch.cs (Mono.Cecil) writing PATCHED COPIES into a cache: Environment.GetCommandLineArgs -> original exe path, System.IO path args -> UctoShim.PathFix.Fix (backslashes, X:\\ drives via UCTO_DRIVE_X env, case-insensitive), StreamWriter NewLine CRLF, Environment.NewLine -> CRLF. Native VB6/Delphi helpers (printing etc.) use TypeScript ports in src/helpers (fand2pdf, utisk04...).
PROVEN on this Linux arm64 box (see docs/HELPERS-PLATFORMS.md): original Ares2.exe + Nepl2.exe (patched copy) + UctoQR.exe work, including with a relocated Mono copy (bin/mono + lib/mono + etc/mono + native libs libmono-native, libMonoPosixHelper, libmono-btls-shared, libgdiplus in <prefix>/lib) and a private certificate store: XDG_CONFIG_HOME=<dir> mono <prefix>/lib/mono/4.5/cert-sync.exe --quiet --user /etc/ssl/certs/ca-certificates.crt. WinForms needs an X display on Linux (use 'xvfb-run -a' in tests).
Tools here: mono 6.8 (mcs, monodis, sn), Mono.Cecil at /usr/lib/mono/gac/Mono.Cecil/0.11.0.0__0738eb9f132ed756/, ilspycmd (export DOTNET_ROOT=/opt/dotnet PATH=$PATH:/opt/dotnet:$HOME/.dotnet/tools DOTNET_ROLL_FORWARD=Major), xvfb-run, zbarimg, node 24.
Paths: pristine Účto ${ROOT}/vendor/extracted/app (NEVER modify; copy to ${ROOT}/work/tmp-<label>/ for tests). Decompiled C# of every .NET helper: ${ROOT}/work/decompiled/<folder>_<exe>/. Helper specs: ${ROOT}/docs/helpers/*.md (how Účto calls each helper, exchange files, formats). Decoded Účto FAND sources: ${ROOT}/work/source/.
RULES: never git commit. Stay within your assigned files. Build outputs (*.dll/*.exe) are gitignored; every build must be reproducible by a script. Live network calls are OK for manual verification against public read-only endpoints (ARES, MF ČR, VIES), never submit filings; no credentials exist here.
`

const RES = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    files: { type: 'array', items: { type: 'string' } },
    verified: { type: 'array', items: { type: 'string' } },
    untested: { type: 'array', items: { type: 'string' } },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'files', 'verified', 'untested', 'issues'],
}

phase('Build')
const runtime = () => agent(`${CTX}
TASK "runtime": reproducible scripts that produce the bundled relocatable Mono runtime per platform, output layout resources/mono/<platform>-<arch>/{bin/mono, lib/mono/4.5/*.dll (+Facades), lib/mono/gac/..., etc/mono/..., lib/*.so|*.dylib}:
- scripts/mono/build-linux.sh <x64|arm64>: download official packages (download.mono-project.com Debian 'stable-buster' or 'stable-focal' repo, or Debian/Ubuntu archive) for the arch, extract with dpkg-deb -x (no root install), assemble the prefix. TRIM to what the helpers need: compute the closure of framework assemblies referenced by all .NET helpers in vendor/extracted/app (monodis --assemblyref recursively incl. their third-party dlls) plus what mono needs (mscorlib, System, System.Core, System.Configuration, System.Xml, System.Windows.Forms + deps, System.Drawing, System.Web.Services, System.Security, Mono.Security, Facades if needed, cert-sync.exe) – measure the size. libgdiplus: include it and list its system deps (cairo, fontconfig, libpng, libjpeg, libtiff, libgif, libexif, glib) – decide: bundle or require (typical desktop has cairo/fontconfig); document.
- Verify linux-arm64 end-to-end with system Mono HIDDEN (temporarily rename /usr/lib/mono, /etc/mono, /usr/share/.mono and move /usr/lib/libgdiplus*, libmono-native*, libmono-btls-shared.so, libMonoPosixHelper.so aside; ALWAYS restore them, use a trap): run shims/mono/host/UctoMonoHost.exe with Ares2 and UctoQR as in docs/HELPERS-PLATFORMS.md, with the private cert store.
- scripts/mono/build-macos.sh: for macOS (must run ON macOS; cannot be tested here): download the official universal Mono 6.12 .pkg, extract Mono.framework payload (pkgutil --expand-full), assemble the same trimmed layout, rewrite absolute dylib install names with install_name_tool to @loader_path/@executable_path, ad-hoc re-sign (codesign -s -), note notarization requirements and the hardened-runtime entitlements Mono JIT needs (com.apple.security.cs.allow-jit, allow-unsigned-executable-memory, disable-library-validation). Also research and document (with sources) whether Mono 6.12 System.Windows.Forms works on 64-bit macOS (Cocoa driver vs X11/XQuartz) – this decides whether helper dialogs work on macOS.
- Cert store init: document the exact first-run commands (Linux: CA bundle paths for Debian/Fedora/Arch/openSUSE; macOS: 'security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain' + /Library/Keychains/System.keychain) – the integration agent implements it in Node.
- electron-builder: add extraResources config for resources/mono/<platform>-<arch> (per-target filter), document in docs/MONO-RUNTIME.md.
Files you own: scripts/mono/*, docs/MONO-RUNTIME.md, electron-builder.yml (extraResources section only).`, { label: 'runtime', phase: 'Build', schema: RES, effort: 'high' })

const rebex = () => agent(`${CTX}
TASK "rebex": complete the Rebex substitute (shims/mono/rebex/*.cs; you own this folder) so EVERY Rebex member used by the helpers exists with the exact signature and working semantics over Mono's System.Net / System.Security APIs. Inventory with 'monodis --memberref' and '--typeref' on each helper and on each helper's own dlls: {ap02}/Ares2, Nepl2, UctoDS, UctoDS2; {ap03}/UctoZP2 (also references Rebex.Castle/Curve25519/Ed25519 – decide: substitute or keep originals if pure managed and unused paths); {tisk}/UctoApep, ELDOTAZ, UctoMD, ENESCHOP, ELPODPI2 (note: {ap03} and {tisk} ship DIFFERENT Rebex versions – check each version/identity and produce substitutes per version if needed). Include Rebex.Net.WebClient, HttpRequestCreator/HttpRequest/HttpResponse, SslSettings members, logging (FileLogWriter/ILogWriter/LogLevel with correct enum values from the original assembly metadata), Rebex.Security.Certificates.Certificate/CertificateChain/CertificateStore/CertificateStoreName (over System.Security.Cryptography.X509Certificates and Mono's X509Store), Rebex.Security.Cryptography.Pkcs.ContentInfo/EnvelopedData/SignedData (over System.Security.Cryptography.Pkcs as available in Mono, or a managed implementation) – read the decompiled helper code to see exactly how each is used and replicate observable behaviour (exceptions types/messages the helpers catch, response classes they cast to). Enum constant values MUST match the originals (read them with monodis --fielddef / ikdasm of the original dlls).
Write shims/mono/rebex/build.sh producing the dlls per Rebex version, and a Mono test harness (shims/mono/rebex/tests/) that exercises the API offline (local HTTPS test server with a self-signed cert + SslAcceptAllCertificates; CMS round-trip) plus one live GET to ARES. Report which helper call paths are covered.`, { label: 'rebex', phase: 'Build', schema: RES, effort: 'high' })

const patcherAndWin = () => agent(`${CTX}
TASK "patcher+windows-substitutes" (you own shims/mono/patch/*, shims/mono/shimlib/* and shims/mono/host/*):
1. Make UctoPatch production-ready: idempotent cache keyed by SHA-256 of the original exe (+ patcher version), patch ALL assemblies of a helper folder that need it (exe + its private dlls if they do file IO), handle instance methods with path args (FileInfo/DirectoryInfo ctors are newobj; File.* static), Process.Start (redirect: opening documents/URLs -> xdg-open/open via UctoShim.Os.Open; starting other helper exes -> run them through the same host), Environment.GetFolderPath special folders if helpers use them.
2. P/Invoke redirection: rewrite calls to [DllImport] methods of known Windows libraries to managed stubs in UctoShim (user32: ShowWindow, GetSystemMenu/RemoveMenu/GetMenuItemCount/MoveWindow/SendMessage -> no-op; kernel32: AllocConsole/FreeConsole/GetConsoleWindow -> no-op, GetShortPathName -> copy path; gdi32 AddFontResource / WriteProfileString -> no-op true). MAPI32 (UEmail17 SimpleMapi: MAPILogon/Logoff/SendMail/FindNext/ReadMail/FreeBuffer/DeleteMail/Address): implement MAPISendMail by building an RFC 5322 .eml (recipients, subject, body, attachments from MapiFileDesc) and opening it with the default mail client (xdg-open / open); others return MAPI error codes that make the helper fall back gracefully – read the decompiled UEmail17 to choose.
3. System.Data.OleDb (UctoExp uses Jet 'dBASE IV' provider): redirect OleDbConnection/OleDbCommand/OleDbDataAdapter usage in the patched copy to UctoShim.Dbf classes that read the DBF (CP852 text since language-driver byte is 0, types as Jet maps them: C/M->string trimmed, N->double, D->DateTime, L->bool, nulls) into the same DataTable. Verify UctoExp produces the XLSX (DocumentFormat.OpenXml is managed) on Mono.
4. WinForms WebBrowser (preview forms in UctoDS2, UctoApep, UctoZP2): patch so previews open the HTML in the system browser (write temp .html, UctoShim.Os.Open) instead of the embedded control; keep the rest of the form working.
Tests: a script shims/mono/test-helpers.sh running each touched helper under Mono (xvfb-run) in a work/tmp-patch copy with realistic exchange files per docs/helpers; report per helper.`, { label: 'patcher', phase: 'Build', schema: RES, effort: 'high' })

const comAndCerts = (prev) => agent(`${CTX}
Previous agent (patcher) result: ${JSON.stringify(prev?.summary ?? '')}; issues: ${JSON.stringify(prev?.issues ?? [])}
TASK "com+certificates" (you may extend shims/mono/patch and shims/mono/shimlib – coordinate by reading the current files first):
1. PDFCreatorPilot COM (PDFCreatorPilotLib.PDFDocument4 / IPDFDocument4 embedded ComImport types, GUID A6AF52AE-5767-49FA-8A9E-7D22643D6301) used by UctoQR2, UctoApep, ENESCHOP: list every member the helpers call (decompiled code), implement a managed class UctoShim.Com.PDFDocument4 with those members over iTextSharp (the itextsharp.dll shipped in {tisk}) or PDFsharp-free managed code, and patch 'new PDFDocument4()' / interface calls to use it. Verify UctoQR2 produces a correct PDF with a decodable QR payment code (zbarimg).
2. Certificates: UctoApep/UctoZP2/CERTINFO select signing certificates from the Windows 'My' store (X509Store(StoreName.My, StoreLocation.CurrentUser)) and use SignedCms/EnvelopedCms. Determine whether Mono's X509Store + SignedCms/EnvelopedCms (System.Security.dll in Mono) work for this: import a self-signed test PKCS#12 into Mono's user store (certmgr -add -c -m My or X509Store.Add with private key) under a private XDG_CONFIG_HOME, run the helpers' signing/encryption code paths (write a harness calling the same helper classes via reflection) and verify outputs with openssl cms -verify/-decrypt. Provide a first-run 'import certificate' flow design for the Electron app (choose .pfx, password via OS keychain, import into the private Mono store) and implement the Mono-side importer tool (shims/mono/shimlib/UctoCertImport.cs).
Report exactly what works, what is inferred, what must be tested with real ČSSZ/ZP test gateways.`, { label: 'com-certs', phase: 'Build', schema: RES, effort: 'high' })

const integration = () => agent(`${CTX}
TASK "integration" (you own src/helpers/mono.ts, src/helpers/dispatch.ts, src/helpers/registry.ts, src/engine/exechelper.ts, test/helpers-mono.test.ts, test/exechelper.test.ts; read src/helpers/{types,sync,worker,util}.ts and src/main/{index,host}.ts first):
1. src/helpers/mono.ts: MonoRuntime – locate runtime (process.env.UCTO_MONO_ROOT, else <resources>/mono/<platform>-<arch>, else system 'mono' on PATH for development), first-run init of the private cert store (per docs from the runtime agent; implement Linux CA bundle search and macOS 'security find-certificate' export) in a per-user dir (process.env.UCTO_USER_DATA or os-appropriate app data), ensure patched copy in cache (run UctoPatch.exe via the runtime; cache dir under user data), run 'mono UctoMonoHost.exe <exe>=<patched> <config> <shimdirs> args' with cwd = FAND task dir, env XDG_CONFIG_HOME, UCTO_DRIVE_C etc., DISPLAY passthrough; resolve exit code. Detect .NET assemblies by the PE CLI header (not by extension). Determine the <config> argument per helper: helpers set APP_CONFIG_FILE to a name relative to their dir (e.g. 'Ares2.xml', 'UctoExp.xml', 'UCTOQR.XML') – extract it automatically from the helper IL (ldstr before AppDomain.SetData("APP_CONFIG_FILE")) during patching, else '<exe>.config'.
2. src/helpers/dispatch.ts: platform policy used by execHelper: win32 -> spawn the original exe (child_process, windowsHide false, wait for exit) – EXCEPT keep TS ports available only if explicitly configured; darwin/linux -> .NET assembly => Mono runner; native helper with a TS port (fand2pdf, utisk04/01/98, nic) => TS port; else => ui.message('Program X není na této platformě dostupný') and exit code 1. Remove the TS ports that duplicate .NET helpers now handled by Mono: src/helpers/ares2.ts and nepl2.ts (and their tests) – but keep uctoexp.ts until the verification phase confirms the original UctoExp runs under Mono (leave a TODO).
3. execHelper(crt, exePath, ...) in src/engine/exechelper.ts delegates to dispatch; keep the synchronous bridge (runHelperSync). Ensure DISPLAY/WAYLAND for Linux GUI helpers, and on macOS nothing special.
4. Main process: pass UCTO_MONO_ROOT (packaged: process.resourcesPath/mono/<plat>-<arch>) and UCTO_USER_DATA (app.getPath('userData')) via env in src/main/index.ts (minimal additive edit).
5. Tests (vitest): dispatch decisions per platform (mock), .NET detection on real helper files, and an end-to-end test (skipped when mono is missing) running the original UctoQR through the runner in a work/tmp copy and decoding the QR with zbarimg if present.
Run 'npx tsc -p .' (ignore src/engine/pas errors – another workflow edits it) and your tests.`, { label: 'integration', phase: 'Build', schema: RES, effort: 'high' })

const built = await parallel([
  runtime,
  rebex,
  () => patcherAndWin().then(p => comAndCerts(p).then(c => ({ patcher: p, com: c }))),
  integration,
])
const [rt, rb, pc, integ] = built

phase('Verify')
const HELPER_SETS = [
  '{ap02}/Ares2.exe, {ap02}/Nepl2.exe, {ap02}/UctoDS.exe, {ap02}/UctoDS2.exe, {tisk}/ELDOTAZ.EXE, {tisk}/UctoMD.exe, {tisk}/UctoVIES.exe, {tisk}/FileDown.exe, {tisk}/UctoFoD.exe, {tisk}/uctoGuid.exe, {tisk}/WFDETECT.EXE, {tisk}/UCTOFTP2.EXE, {tisk}/UctoFtp3.exe, {tisk}/UEmail17.exe',
  '{ap03}/UctoZP2.exe, {tisk}/UctoApep.exe, {tisk}/CERTINFO.EXE, {tisk}/ELPODPI2.EXE, {tisk}/ENESCHOP.EXE, {ap04}/UctoExp.exe, {ap05}/UctoXml.exe, {ap05}/UctoConv.exe, {tisk}/XmlP.exe, {free}/SkodaXml.exe, {tisk}/UctoQR.exe, {tisk}/UctoQR2.exe, {tisk}/AlisFand.exe, {tisk}/Ubox2.exe, {tisk}/Oprava.exe, {tisk}/UCTOOL2.EXE, {tisk}/Uctool3.exe, {dbx1}/DISXBUT.EXE',
]
const verify = await parallel(HELPER_SETS.map((set, i) => () => agent(`${CTX}
Build phase results: runtime=${JSON.stringify(rt?.summary ?? '')}; rebex=${JSON.stringify(rb?.summary ?? '')}; patcher=${JSON.stringify(pc?.patcher?.summary ?? '')}; com/certs=${JSON.stringify(pc?.com?.summary ?? '')}; integration=${JSON.stringify(integ?.summary ?? '')}
TASK "verify-${i + 1}": for each helper in [${set}], run the ORIGINAL helper through the production path (src/helpers/mono.ts runner or the same command line it builds, using the bundled linux-arm64 runtime from resources/mono if the runtime agent produced it, else system mono) in a fresh work/tmp-verify${i + 1} copy of the Účto folder, with realistic exchange files exactly as Účto's FAND code writes them (read docs/helpers/<exe>.md and the calling chapters in work/source; paths as the engine will present them: host path of the Účto folder + FAND-style backslash suffixes like '{AP02}\\ARES2.TXT'). Use read-only live endpoints where the helper only queries (ARES, MF ČR, VIES, ČSSZ status without credentials); for submitting helpers (ISDS send, ČSSZ/ZP filings) verify up to the point before submission (config parsing, XML/CMS building, TLS connect to the TEST gateways if public, graceful error on missing credentials). Fix small problems in the shims directly if clearly needed (report them); otherwise report. OBSOLETE helpers (DOSBox launcher DISXBUT etc.): just confirm they don't crash or mark obsolete.
Return per helper: status works/partial/fails/obsolete, evidence (output snippet), remaining gaps.`, { label: `verify-${i + 1}`, phase: 'Verify', schema: RES, effort: 'high' })))

phase('Report')
const report = await agent(`${CTX}
All build and verification results: ${JSON.stringify({ rt, rb, pc, integ, verify })}
TASK: (1) update docs/HELPERS-PLATFORMS.md with the final per-helper matrix (Windows: original; macOS/Linux: mono-original / TS port / unavailable) including evidence and remaining gaps, and what must be verified on real macOS and x64 Linux and against real gateways; (2) if the verification confirms UctoExp original works under Mono, remove src/helpers/uctoexp.ts + lib/dbf.ts usage and its tests and registry entry; (3) run 'npx vitest run test/helpers*.test.ts test/exechelper.test.ts' and 'npx tsc -p .' (ignore src/engine/pas errors from the other workflow) and fix breakage in helper/integration code; (4) summarise open decisions for the user.`, { label: 'report', phase: 'Report', schema: RES, effort: 'high' })
return { rt, rb, pc, integ, verify, report }
