# Running Účto's original helper programs on each platform

Investigation 2026-09-28. The Electron app is installed into an existing Účto folder,
so the original helpers are on disk. Question: which can be run as-is, and where?

## Windows: run all originals

Every helper was built for Windows and runs unchanged: .NET 2.0/4.0/4.8 programs, VB6,
Delphi, and the small DOS utilities. The engine's EXEC starts the real `.exe` from the
Účto folder with the same arguments and working directory. FAND code already builds
Windows paths (`PROGRAM.Path+'{AP02}\…'`), and on Windows the engine's paths are real
Windows paths. **No replacements are needed on Windows.**

## Linux / macOS

### Mono (tested on Linux arm64, Mono 6.8)

Two general problems, both confirmed by testing:

1. **Config loading.** The helpers read their settings via
   `AppDomain.SetData("APP_CONFIG_FILE", "X.xml")`, which Mono ignores; it only reads
   `X.exe.config`. A launcher shim could copy the file across.
2. **Paths inside exchange files.** FAND writes DOS paths with backslashes into the
   XML/TXT exchange files. Mono on Unix doesn't translate them, so every path needs
   rewriting per helper.

Results:

| Helper | Result | Reason |
|---|---|---|
| UctoQR (QR payment code on invoice PDF) | **works** with the config shim | managed iTextSharp and MessagingToolkit; the QR code decodes to a valid `SPD*1.0…` string |
| Ares2 (ARES company lookup) | **fails** | TLS handshake failure (Rebex 6.0 under Mono) |
| Rebex against the other endpoints: ISDS, tax portal, VIES, the unreliable-payer service, ucto2000.cz | **fails** | handshake failure, or the revocation check / certificate verifier fails |
| UctoExp (Excel export) | **fails** | Jet OLEDB is Windows-only; the error MessageBox then crashed as well |

Scanned but not run:

| Helper | Expected result | Reason |
|---|---|---|
| UEmail17 (e-mail) | **fails** | uses MAPI32.DLL (Windows mail) |
| UctoApep, UctoZP2, CERTINFO (ČSSZ, health insurance, certificate info) | **fails** | Windows certificate store, CMS signing/encryption, WinForms WebBrowser |
| UctoQR2, UctoApep, ENESCHOP | **fails** | COM PDFCreatorPilot (a Windows COM component) |
| AlisFand, DISXBUT, UctoFoD | **fails** | Win32 GDI/user32 calls, registry, short-path API |
| UctoXml, UctoConv, XmlP, SkodaXml, Ubox2, Uctool3, uctoGuid, WFDETECT, Oprava | **probably works** | pure managed code; needs the config shim and path rewriting |

Conclusion: under Mono the helpers that matter all fail: every network helper (the
bundled Rebex TLS stack), mail, certificates and Excel. Only small offline helpers work,
and even those need per-helper shims.

### Native VB6/Delphi helpers (about 40)

Printing (UTISK04, POSTTISK, PDFTISK*), FAND2PDF, e-mail (UEMAIL*), FTP, clipboard and the
like are native Win32 programs. On Unix they run only under **Wine**.

### Wine (not testable on this arm64 machine)

In principle Wine plus wine-mono runs almost everything: DOS paths are native, and
VB6/Delphi printing goes through CUPS. Downsides:

* **Installation:** the user must install Wine separately. On Apple Silicon that means
  Rosetta plus an x86 Wine build; on ARM Linux it effectively doesn't work.
* **Size:** about 0.5 GB with wine-mono.
* **Unverified:** Rebex TLS through Wine's CNG emulation has not been tested.
* **Gaps:** no MAPI, and Jet needs winetricks.
* **Look and feel:** Windows-style dialogs appear on top of the app.

## Update: substitute assemblies + IL patching under Mono (proof of concept, works)

The failures are mostly *not* in Win32 itself, so they can be fixed without modifying
the originals (`shims/mono/`):

1. **`UctoMonoHost.exe` (launcher).** It runs the helper in its own AppDomain whose
   config file is the `X.xml` the helper expects. That fixes the `APP_CONFIG_FILE`
   problem. It also preloads substitute assemblies into that domain.
2. **Substitute Rebex** (`Rebex.Common/Networking/Http` 6.0.8000.0, same public-key token
   `1c4638788972655d`, delay-signed; Mono doesn't verify strong-name signatures). It
   implements the small API the helpers use on top of Mono's `HttpWebRequest`, and Mono's
   own TLS reaches every endpoint (ARES, the MF ČR services, ISDS, adisspr, VIES,
   eportal.cssz.cz, vzp.cz).
3. **`UctoPatch.exe`** (Mono.Cecil) writes a *patched copy* into a cache:
   * `Environment.GetCommandLineArgs()` returns the original exe path, so helpers find
     their files next to it;
   * every `System.IO` path argument goes through `UctoShim.PathFix.Fix`, which converts
     backslashes and `X:\` drive paths (`UCTO_DRIVE_X`) and resolves names
     case-insensitively;
   * files written with StreamWriter and `Environment.NewLine` get CRLF.

Verified on Linux arm64 with live services:

* **Ares2.exe**, original: correct ARES record.
* **Nepl2.exe**, patched copy: live SOAP call to MF ČR, correct CRLF output.
* **UctoQR.exe**, original: valid QR payment code in the PDF.

The same technique extends to the remaining .NET blockers (not built yet):

| Blocker | Substitute |
|---|---|
| Jet OLEDB (UctoExp) | the patcher redirects `OleDbConnection`/`OleDbDataAdapter` to a managed DBF reader |
| MAPI32 P/Invoke (UEmail17) | redirected to a managed implementation (write `.eml`, open it in the default mail client) |
| user32/kernel32/gdi32 P/Invokes (UctoXml, UctoFoD, AlisFand) | managed stubs (no-ops, or the path returned unchanged) |
| COM PDFCreatorPilot (UctoQR2, UctoApep, ENESCHOP) | a managed class implementing the used `IPDFDocument4` subset over iTextSharp, which ships with Účto |
| WinForms WebBrowser previews (UctoDS2, UctoApep, UctoZP2) | redirect to opening the HTML in the system browser |
| Windows certificate store (UctoApep, UctoZP2, CERTINFO) | Mono's own X509Store after importing the .pfx; to be tested |

Still impossible this way: the native **VB6/Delphi** helpers (printing UTISK04,
FAND2PDF, PDFTISK*, POSTTISK, UEMAIL*, UCTOFTP, clipboard tools…). They need Wine or a
TypeScript port.

Runtime requirement: Mono ≥ 6.8 on Linux (distribution packages) and macOS (mono 6.12/6.14
universal package, arm64 native). Mono is now maintained by WineHQ. It can be installed
by the user or bundled (~100–150 MB per platform).

## Recommendation (original version, before the proof of concept)

1. **Windows:** EXEC always runs the original helper. Zero porting, 100% original
   behaviour.
2. **macOS/Linux:** TypeScript replacements only for the helpers that matter. These are
   the ones Mono cannot run anyway:
   * printing: UTISK04, FAND2PDF, PDFTISK2
   * ARES, Nepl2, VIES
   * Excel export
   * e-mail draft
   * QR payment
   * ISDS data box
   * ČSSZ/health-insurance e-filing (later; needs certificate handling)

   Everything else gets an informative message ("not available on this platform").
   Wine is an optional fallback if the user has it installed.
3. Mono is not recommended: it adds a runtime dependency but only covers helpers of
   little importance.

Already done: ares2, nepl2, fand2pdf, utisk04 (plus utisk01/98), uctoexp, in
`src/helpers/`.
