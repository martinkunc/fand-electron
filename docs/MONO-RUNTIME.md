# Bundled Mono runtime (macOS/Linux helpers)

Decision: on macOS and Linux the original Účto .NET helpers run under a Mono that ships
with the app (see [HELPERS-PLATFORMS.md](HELPERS-PLATFORMS.md) for the shims:
`UctoMonoHost`, the substitute Rebex, `UctoPatch`). On Windows EXEC starts the original
`.exe` and no Mono is shipped.

This document covers how the runtime is produced, what it contains, how the app must start
it, the certificate store, packaging, and the macOS limits.

## Layout

Every platform gets the same relocatable prefix. The build output goes to
`resources/mono/<platform>-<arch>/` (git-ignored, reproducible by the scripts):

```
bin/mono                         the runtime (mono-sgen); keep this name, see "Starting mono"
lib/mono/4.5/mscorlib.dll        corlib; also cert-sync.exe
lib/mono/gac/<name>/<ver>__<token>/<name>.dll[.config]
                                 every other framework assembly (Mono loads them from the GAC
                                 only, not from 4.5/)
lib/*.so | lib/*.dylib           P/Invoke libraries: libmono-native, libMonoPosixHelper,
                                 libmono-btls-shared (Linux), libgdiplus + private deps
etc/mono/config                  dllmaps ($mono_libdir = <prefix>/lib)
etc/mono/4.5/machine.config
etc/fonts/                       macOS only: fontconfig configuration for libgdiplus
MONO-RUNTIME.txt                 versions, sources, checksums, required system libraries
```

| Target | Script | Mono | Size (unpacked) |
|---|---|---|---|
| `linux-x64`, `linux-arm64` | `scripts/mono/build-linux.sh <x64\|arm64>` | 6.12.0.200 | 38 MB (29 MB managed); 14 MB gzip, 10.4 MB xz |
| `darwin-x64` | `scripts/mono/build-macos.sh x64` (on macOS) | 6.12.0.206, x86_64, macOS 10.9+ | 46 MB (Linux dry run) |
| `darwin-arm64` | `scripts/mono/build-macos.sh arm64` (on macOS) | 6.14.1, arm64, macOS 15+ | 48 MB (Linux dry run) |

### Which assemblies

`scripts/mono/closure.sh` reads every managed assembly in `vendor/extracted/app` and the
shims with `monodis --assemblyref` and follows the framework references recursively, plus
seeds for what is only loaded by name: `I18N*` (code pages 852/1250), `Mono.Security` and
`System.Security` (TLS, certificates), `Mono.Posix` (WinForms X11 driver), `cert-sync.exe`.
The result is committed as `scripts/mono/assemblies.txt` (49 files, 29 MB) and rewritten by
every Linux build; `build-macos.sh` uses the committed file unless `monodis` and bash 4
are available. No Facades are needed: every helper targets .NET 2.0–4.8 without
netstandard references. Unresolved references are only `PresentationCore` (WPF, used by
`{tisk}\zxing.presentation.dll`, never loaded by UctoQR) and `Mono.Data.Sqlite`
(referenced by `System.Web`, never used).

## Linux (`scripts/mono/build-linux.sh <x64|arm64> [--offline]`)

* Sources: the official Mono repository `download.mono-project.com/repo/debian`,
  suite `stable-buster` (Mono 6.12.0.200, built against glibc 2.28), and for the image
  libraries the Debian 10 archive (`archive.debian.org`, main + security). The x64 build
  works on an arm64 host and vice versa; nothing is executed from the downloaded packages.
* Every `.deb` is checked against the SHA256 in the repository index, and the Mono
  version is pinned (`MONO_VERSION`). Packages are unpacked with `dpkg-deb -x`; nothing is
  installed, no root needed. Downloads are cached in `vendor/downloads/mono/linux-<arch>/`.
  Two runs produce byte-identical output (checked).
* Build host needs: bash 4, curl, gzip, dpkg-deb, readelf, sha256sum; `monodis` only to
  recompute the closure. `patchelf` is taken from PATH or downloaded as the static
  0.18.0 release binary from GitHub.

### libgdiplus and system libraries

`System.Drawing` (UctoQR draws the QR bitmap; WinForms) needs libgdiplus. Decision:
**bundle libgdiplus 6.0.5 and the image libraries whose sonames differ between
distributions; require the rest from the system.**

Bundled (in `lib/`, RUNPATH `$ORIGIN` so they win over system copies):
`libgdiplus.so.0`, `libtiff.so.5`, `libjpeg.so.62`, `libjbig.so.0`, `libwebp.so.6`,
`libgif.so.7`, `libexif.so.12`. Current distributions ship `libtiff.so.6`, Ubuntu and Arch
ship `libjpeg.so.8`, `libwebp.so.7` and so on, so these cannot be expected on the system.

Required from the system (all present wherever Electron itself runs, because Electron
depends on GTK 3, which pulls in cairo, fontconfig, freetype, glib, libpng and X11):
`libc.so.6` (glibc ≥ 2.27), `libstdc++.so.6`, `libgcc_s.so.1`, `libz.so.1`,
`libgssapi_krb5.so.2` (libmono-native), `libglib-2.0.so.0`, `libcairo.so.2`,
`libfontconfig.so.1`, `libfreetype.so.6`, `libpng16.so.16`, `libX11.so.6`, `liblzma.so.5`,
`libzstd.so.1`. The exact list is written to `MONO-RUNTIME.txt` by every build.
`libgssapi_krb5` is the only one not implied by GTK; it is in the default install of
Debian/Ubuntu (`libgssapi-krb5-2`), Fedora (`krb5-libs`), openSUSE and Arch (`krb5`, a
dependency of curl).

### Verification (`scripts/mono/verify-linux.sh`)

Hides the system Mono, then runs the original helpers from a copy of the pristine Účto
(`work/tmp-runtime/`) against live public endpoints:

| Check | Result on linux-arm64 (2026-09-28) |
|---|---|
| system Mono visible | no (`/usr/lib/mono`, `/etc/mono`, `/usr/share/.mono`, `/usr/lib/lib{mono,Mono,gdiplus}*`, `/usr/bin/mono*` hidden) |
| cert-sync into a private store | 121 roots |
| Ares2.exe (original) + substitute Rebex | `Ministerstvo financí\|Letenská 525/15\|Praha\|11800\|00006947\|CZ00006947\|325\|A` |
| Nepl2.exe patched by UctoPatch.exe running on the bundled Mono | `00006947  N01.01.00013328001/0710,19-3328001/0710,27-3328001/0710` (flag `N`, date, accounts from column 24) |
| UctoQR.exe (original) | PDF written; `zbarimg` decodes `SPD*1.0*ACC:CZ6508000000192000145399*AM:1234.50*CC:CZK*DT:20260315*MSG:FAKTURA 1*X-VS:2026001*RN:STEHLIK` |

The same checks passed against the tree electron-builder produced
(`<output>/linux-arm64-unpacked/resources/mono`, run with `MONO_PREFIX=… verify-linux.sh`).

By default the script hides the system Mono in a private mount namespace
(`unshare --mount`: tmpfs over the directories, `/dev/null` bind-mounted over the
libraries), so nothing on the machine is renamed and other processes are unaffected.
`--rename` renames the files instead and restores them from an `EXIT/INT/TERM/HUP` trap;
`--no-hide` skips hiding. `MONO_PREFIX` and `UCTO_SHIMS` select another runtime or shim
build. linux-x64 is built by the same script but was not run here (arm64 host).

Ares2 and UctoQR also succeed with no X display at all; `DISPLAY` is only needed when a
helper shows a WinForms dialog (MessageBox on errors). Without a display that call fails
and the helper exits with 1.

## Starting mono (for the integration code)

```
<prefix>/bin/mono <shims>/host/UctoMonoHost.exe <helper.exe>[=<patched copy>] <config|-> <shim dirs> [args]
```

`<prefix>` is `process.resourcesPath + '/mono'` when packaged, and
`resources/mono/<process.platform>-<process.arch>` (e.g. `linux-arm64`, `darwin-x64`) in
development.

* **No environment is needed for relocation.** On Linux Mono derives its prefix from
  `/proc/self/exe` if the executable is called `mono` (or `mono-sgen`) and sits in a
  directory called `bin` next to `lib/mono/4.5`; otherwise it silently falls back to
  `/usr/lib/mono`. So never rename or symlink-rename `bin/mono`. On macOS it uses
  `_NSGetExecutablePath` + `../lib` + `../etc` (source: `mono/metadata/assembly.c`,
  `mono_set_rootdir`).
* Environment to set for every helper run:
  * `XDG_CONFIG_HOME=<userData>/mono`: private certificate store (see below). Mono's
    `ApplicationData` folder follows it, so it also moves anything a helper keeps there
    (none of the Účto helpers do; SkodaXml reads `DesktopDirectory`, which Mono resolves
    through `$XDG_CONFIG_HOME/user-dirs.dirs`, so copy `~/.config/user-dirs.dirs` into
    the private directory when initialising it).
  * `MONO_XMLSERIALIZER_THS=no`: never try to compile XmlSerializer assemblies (no C#
    compiler is bundled).
  * macOS: `FONTCONFIG_PATH=<prefix>/etc/fonts` (libgdiplus text rendering).
  * Remove inherited `MONO_PATH`, `MONO_GAC_PREFIX`, `MONO_CFG_DIR`, `MONO_CONFIG`,
    `MONO_ENV_OPTIONS`, `MONO_TLS_PROVIDER`, so a user's own Mono setup cannot interfere.
  * Linux: keep `DISPLAY` (X11/XWayland) for helper dialogs.
* The cache of patched helper copies (UctoPatch output) must go to `<userData>`, never
  into the prefix (read-only inside an AppImage or a signed `.app`).

## Certificate store (first run)

Mono does not read the OS trust store. On Linux, `HttpWebRequest`/`SslStream` (BTLS) trust
only the roots in Mono's own store, so the store must be filled before the first network
helper runs. The integration code implements this in Node:

1. Find the system CA bundle (PEM), first existing path wins (the list Go's
   `crypto/x509` uses, `root_linux.go`):

   | Distribution | Path |
   |---|---|
   | Debian, Ubuntu, Arch, Gentoo, Alpine | `/etc/ssl/certs/ca-certificates.crt` |
   | Fedora, RHEL 6 | `/etc/pki/tls/certs/ca-bundle.crt` |
   | openSUSE, SLES | `/etc/ssl/ca-bundle.pem` |
   | OpenELEC | `/etc/pki/tls/cacert.pem` |
   | CentOS, RHEL 7+ | `/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem` |
   | Alpine, others | `/etc/ssl/cert.pem` |

   Fallback when none exists: write `require('tls').rootCertificates.join('\n')` (the
   Mozilla bundle compiled into Node) to a temporary file.
2. Run (about 0.1 s):
   ```
   XDG_CONFIG_HOME=<userData>/mono <prefix>/bin/mono <prefix>/lib/mono/4.5/cert-sync.exe --quiet --user <bundle.pem>
   ```
   The roots land in `<userData>/mono/.mono/certs/Trust` (and `.mono/new-certs/`).
3. Record `{bundlePath, size, mtime, appVersion}` in `<userData>/mono/cert-sync.json` and
   repeat step 2 when any of them changes (a CA update, an app update). cert-sync is
   idempotent ("I already trust 121, your new list has 121").

macOS: Mono 6.12/6.14 use AppleTLS for `SslStream`/`HttpWebRequest`, which validates
against the Keychain, so TLS works without this step. Do it anyway, because code that uses
`X509Chain`/`X509Store` directly (certificate checks in the helpers and in the Rebex
substitute) reads Mono's store:
```
security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain >  <tmp>/roots.pem
security find-certificate -a -p /Library/Keychains/System.keychain                     >> <tmp>/roots.pem
XDG_CONFIG_HOME=<userData>/mono FONTCONFIG_PATH=<prefix>/etc/fonts \
  <prefix>/bin/mono <prefix>/lib/mono/4.5/cert-sync.exe --quiet --user <tmp>/roots.pem
```
The second keychain adds roots an administrator installed (corporate proxies); it also
contains non-root certificates, which cert-sync imports as well (harmless).

## Packaging (electron-builder)

`electron-builder.yml` copies only the target's runtime into `<resources>/mono`:

```yaml
mac:
  extraResources:
    - { from: resources/mono/darwin-${arch}, to: mono, filter: ["**/*"] }
linux:
  extraResources:
    - { from: resources/mono/linux-${arch}, to: mono, filter: ["**/*"] }
```

Checked with `electron-builder --linux dir --arm64`: `resources/mono/bin/mono` is
executable and the tree passes `verify-linux.sh`.

Required follow-ups outside the `extraResources` keys:

* **`files` must exclude `resources/mono/**`.** `files: resources/**` plus
  `asarUnpack: resources/**` currently copies the other built runtimes into
  `app.asar.unpacked/resources/mono` as well (seen: `linux-x64` inside the arm64 build,
  +38 MB). Add `- "!resources/mono/**"` to `files`.
* `.gitignore`: add `resources/mono/` (build output).
* macOS: `mac.hardenedRuntime: true` (electron-builder default) and
  `mac.entitlementsInherit: scripts/mono/entitlements.mono.plist`, see below.
* macOS universal builds: the per-arch sub-builds get `darwin-x64` and `darwin-arm64`,
  which contain different Mach-O files that `@electron/universal` cannot merge. Either
  ship separate x64/arm64 builds (recommended), or build the universal app from the
  x86_64 runtime: `build-macos.sh universal`, point `from` at `darwin-universal`, and set
  `mac.x64ArchFiles: "Contents/Resources/mono/**"` so the x86_64-only files are accepted.

## macOS

### Why two sources

* The official Mono 6.12.0.206 macOS package (`macos-10-universal`) is universal in the
  old sense: **i386 + x86_64, no arm64** (verified by reading the Mach-O headers of
  `mono-sgen64`, `libgdiplus.0.dylib`, `libmono-native-compat.0.dylib`, …). On Apple
  Silicon it only runs under Rosetta 2.
* Apple: macOS 27 (September 2026) is the last release with full Rosetta 2; after that
  only a subset for old games remains
  ([AppleInsider](https://appleinsider.com/articles/25/06/10/macos-27-will-be-the-last-operating-system-to-fully-support-rosetta-2),
  [MacRumors](https://www.macrumors.com/2026/06/10/macos-golden-gate-last-to-support-intel-apps/)).
  An x86_64-only Mono stops working on Apple Silicon with macOS 28.
* Mono 6.14 (WineHQ, 2025) has native arm64 macOS support, but WineHQ publishes only
  sources ([WineHQ news](https://www.winehq.org/news/2025030801),
  [heise](https://www.heise.de/en/news/First-release-under-Wine-Framework-Mono-6-14-now-with-ARM64-support-for-macOS-10312438.html)).
  Homebrew builds it: `mono` 6.14.1 and `mono-libgdiplus` 6.2 have arm64 bottles.

So `darwin-x64` (and `universal`) come from the official package, `darwin-arm64` from the
Homebrew bottles (`--rosetta` builds arm64 from the package instead).

### `scripts/mono/build-macos.sh`

Run on macOS with the Xcode command line tools (bash 3.2 compatible):

1. **x64**: download the pinned package (sha256 `80b0dbfa…88d8`, 370 MB),
   `pkgutil --expand-full`, take `Payload/Library/Frameworks/Mono.framework/Versions/6.12.0`.
   **arm64**: download the bottles listed in `scripts/mono/homebrew-arm64.lock` from ghcr.io
   (anonymous token, sha256-checked), starting at `mono` and `mono-libgdiplus` and adding
   every formula whose dylibs are linked (`@@HOMEBREW_PREFIX@@/opt/<formula>/lib/...`).
   `--update-lock` re-resolves against `formulae.brew.sh` (oldest arm64 bottle tag
   first) and rewrites the lock. Homebrew's mono lacks `Microsoft.VisualBasic.dll`
   (mono-basic; referenced by ELDOTAZ, UCTOFTP2, WFDETECT, CERTINFO, ENESCHOP, ELPODPI2,
   UCTOOL2), so it comes from the official Debian package
   `libmono-microsoft-visualbasic10.0-cil` 4.7 (managed code, pinned sha256).
2. Copy the managed closure, `etc/mono/config` (absolute `libgdiplus` paths become
   `$mono_libdir/libgdiplus.0.dylib`), `machine.config`, and fontconfig's `fonts.conf` +
   `conf.d` (absolute include/cache paths removed; symlinks resolved).
3. Copy the P/Invoke roots (`libmono-native(-compat)`, `libMonoPosixHelper`,
   `libmono-btls-shared` (package only), `libgdiplus.0.dylib`) and, recursively, every
   non-system dylib they link, flat into `lib/`. `lipo -thin` keeps only the target slice
   (drops i386 from the package).
4. Rewrite install names: ids to `@rpath/<name>`, dependencies to `@loader_path/<name>`
   (`@executable_path/../lib/<name>` for `bin/mono`), delete all `LC_RPATH`. Then check
   that no absolute framework/Homebrew path, rpath or symlink is left.
5. Ad-hoc sign every Mach-O file (`codesign --force --sign -`), because
   `install_name_tool` invalidates the signatures (arm64 code must be signed to run).

Not run on a Mac here. It was dry-run on Linux with stand-ins for `lipo`, `otool -l`,
`install_name_tool` and `plutil` (a Python Mach-O editor), against the real package
and bottles (x64, arm64, universal; with `--update-lock` and then from the lock):
every dependency resolved to a bundled file or `/usr/lib`/`/System`, and all install
names were rewritten and re-checked. The arm64 runtime bundles 38 dylibs from 29
formulas (mono, mono-libgdiplus, pango, cairo, harfbuzz, glib, fontconfig, freetype,
libpng, libtiff, jpeg-turbo, giflib, libexif, pixman, fribidi, libthai, graphite2,
pcre2, webp, zstd, xz, gettext, the X11 client libraries). Still to do on a Mac: the
real run, then `FONTCONFIG_PATH=… bin/mono --version`, `cert-sync`, and UctoQR/Ares2
tests like the Linux ones (without WinForms dialogs, see below).

Homebrew caveats (arm64): `pango` and `cairo` bottles exist only from `arm64_sequoia`,
so the arm64 runtime needs **macOS 15+**; the lock records the tag of each bottle. The
mono bottle is marked non-relocatable: `mono-sgen` has the Homebrew prefix compiled in,
but only as a fallback that relocation (above) never reaches. Homebrew's cairo links the
Homebrew X11 client libraries (libX11, libxcb, …); they are bundled and never used to
connect anywhere.

### Signing and notarization

electron-builder signs everything inside the `.app`, including `Contents/Resources/mono`,
with the Developer ID. For notarization every Mach-O file needs the hardened runtime,
a secure timestamp and no unsigned code. The ad-hoc signatures from the build script are
replaced. `bin/mono` runs JIT-compiled code, so under the hardened runtime it needs the
entitlements in `scripts/mono/entitlements.mono.plist`
(pass it as `mac.entitlementsInherit`):

| Entitlement | Why |
|---|---|
| `com.apple.security.cs.allow-jit` | the JIT maps pages with `MAP_JIT` |
| `com.apple.security.cs.allow-unsigned-executable-memory` | Mono 6.x also creates executable memory (trampolines) without `MAP_JIT` |
| `com.apple.security.cs.disable-library-validation` | Mono `dlopen`s its P/Invoke libraries; this avoids failures if one is signed differently |

`allow-dyld-environment-variables` is not needed: no `DYLD_*` variables are used, all
paths are `@loader_path`. The `.dll`/`.exe` files are PE files, not Mach-O, and are not
signed. The x64 runtime has no i386 slices after `lipo -thin`.

### WinForms on macOS: dialogs do not work

* Mono's `System.Windows.Forms` picks its driver in `XplatUI`'s static constructor:
  `MONO_MWF_DRIVER` (an external driver assembly), else `MONO_MWF_MAC_FORCE_X11` → X11,
  else `uname() == "Darwin"` → **XplatUICarbon**
  ([XplatUI.cs, mono 2020-02 = 6.12](https://github.com/mono/mono/blob/2020-02/mcs/class/System.Windows.Forms/System.Windows.Forms/XplatUI.cs)).
* The Carbon driver was never ported to 64-bit. Mono's own docs say "Our Windows.Forms
  implementation uses Carbon, and as such, it would not work with a 64-bit Mono"
  ([mono-project.com: macOS](https://www.mono-project.com/docs/about-mono/supported-platforms/macos/)),
  and 64-bit Mono prints "The Carbon driver has not been ported to 64bits, and very few
  parts of Windows.Forms will work properly, or at all"
  ([mono#6701](https://github.com/mono/mono/issues/6701),
  [Homebrew#14684](https://github.com/Homebrew/homebrew-core/issues/14684)). 32-bit
  processes do not run on macOS 10.15 or later.
* X11 through XQuartz (`MONO_MWF_MAC_FORCE_X11=1`) fails with the official package:
  its libgdiplus/cairo have no X11 support, so the first form throws
  `EntryPointNotFoundException: GdipCreateFromXDrawable_linux`
  ([libgdiplus#719](https://github.com/mono/libgdiplus/issues/719)). It would also require
  users to install XQuartz.
* A Cocoa driver exists only as an experiment built on Xamarin.Mac
  ([migueldeicaza/CocoaDriver](https://github.com/migueldeicaza/CocoaDriver),
  [mono#7100](https://github.com/mono/mono/pull/7100)). It is not usable here.

Consequence: on macOS the helpers work only on paths that never create a window. Ares2
and UctoQR run to completion on Linux without any display, which shows that their
success paths never create a window; their error paths call `MessageBox.Show`. Next steps
for the shims: have `UctoPatch` redirect
`System.Windows.Forms.MessageBox.Show(...)` to a UctoShim method that reports the text
to the Electron host (stderr/JSON line) and returns the default button, on macOS (and
optionally Linux for native-looking dialogs). Helpers whose main path is a form stay
unavailable on macOS unless they are ported to TypeScript.
