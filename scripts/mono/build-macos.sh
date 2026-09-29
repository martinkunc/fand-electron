#!/usr/bin/env bash
# Builds the bundled, relocatable Mono runtime for macOS. Run ON macOS (needs pkgutil,
# plutil, lipo, otool, install_name_tool and codesign: Xcode command line tools).
#
#   scripts/mono/build-macos.sh [--rosetta] [--update-lock] [x64|arm64|universal]...
#                                                            (default: x64 arm64)
#
# Output: resources/mono/darwin-<arch>/, the same layout as on Linux:
#   bin/mono                     mono-sgen
#   lib/mono/4.5, lib/mono/gac   trimmed framework (scripts/mono/assemblies.txt)
#   lib/*.dylib                  libmono-native, libMonoPosixHelper, libgdiplus and the
#                                private libraries they link (cairo, pixman, fontconfig,
#                                freetype, png, tiff, jpeg, gif, glib, intl, ...), flat,
#                                with install names rewritten to @loader_path
#   etc/mono/config (+4.5/machine.config), etc/fonts/ (fontconfig for libgdiplus)
#   MONO-RUNTIME.txt
#
# Two sources, because no single official build covers both CPUs:
#  * x64 and universal: the official Mono 6.12.0.206 package
#    (MonoFramework-MDK-...macos10.xamarin.universal.pkg). Its "universal" means
#    i386 + x86_64; there is no arm64 slice. i386 is stripped (lipo -thin x86_64).
#    Runs on macOS 10.9+ Intel, and on Apple Silicon only under Rosetta 2.
#  * arm64: Mono 6.14.1 (WineHQ) arm64 bottles from Homebrew (mono, mono-libgdiplus and
#    every formula their dylibs link), pinned by sha256 in scripts/mono/homebrew-arm64.lock
#    (--update-lock re-resolves against formulae.brew.sh and rewrites it). Homebrew's
#    mono lacks Microsoft.VisualBasic.dll (mono-basic, used by several VB.NET helpers);
#    it is taken from the official Mono Debian package (managed code, any CPU).
#    --rosetta builds arm64 from the x86_64 package instead.
# See docs/MONO-RUNTIME.md ("macOS") for why, and for signing/notarization.
#
# After install_name_tool the original signatures are invalid, so every Mach-O file is
# ad-hoc signed (codesign -s -); electron-builder re-signs them with the Developer ID and
# the hardened runtime (bin/mono needs scripts/mono/entitlements.mono.plist).
#
# Written for the stock /bin/bash 3.2 of macOS (no associative arrays).
# Testing hooks: MONO_FRAMEWORK=<.../Mono.framework/Versions/6.12.0> uses an already
# extracted framework instead of downloading and expanding the package.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
. "$HERE/common.sh"

PKG_VERSION="6.12.0.206"
PKG_NAME="MonoFramework-MDK-$PKG_VERSION.macos10.xamarin.universal.pkg"
PKG_URL="https://download.mono-project.com/archive/6.12.0/macos-10-universal/$PKG_NAME"
PKG_SHA256="80b0dbfa59ba9ed76dbf1393998e6a2ed2d1ccc8f5850c7a46fbe31a2aea88d8"
FW_ABS="/Library/Frameworks/Mono.framework/Versions/6.12.0"

HB_LOCK="$HERE/homebrew-arm64.lock"
HB_ROOTS="mono mono-libgdiplus"
HB_TAGS="arm64_sonoma arm64_sequoia arm64_tahoe arm64_golden_gate"  # oldest macOS first
HB_API="https://formulae.brew.sh/api/formula"
VB_URL="https://download.mono-project.com/repo/debian/pool/main/m/mono-basic/libmono-microsoft-visualbasic10.0-cil_4.7-0xamarin3+debian10b1_all.deb"
VB_SHA256="d607e4c63febc2a1afc83e3a1e4c11b9f9af97580936ba0934ca131181a7700e"

ROSETTA=0 UPDATE_LOCK=0 TARGETS=()
for a in "$@"; do
  case "$a" in
    --rosetta) ROSETTA=1 ;;
    --update-lock) UPDATE_LOCK=1 ;;
    x64|arm64|universal) TARGETS+=("$a") ;;
    *) echo "usage: $0 [--rosetta] [--update-lock] [x64|arm64|universal]..." >&2; exit 2 ;;
  esac
done
[[ ${#TARGETS[@]} -gt 0 ]] || TARGETS=(x64 arm64)

CACHE="$ROOT/vendor/downloads/mono/darwin"
BUILD="$ROOT/work/mono-build/darwin"
mkdir -p "$CACHE" "$BUILD"
log() { echo "[mono darwin] $*" >&2; }
die() { echo "[mono darwin] error: $*" >&2; exit 1; }
need() { command -v "$1" >/dev/null || die "$1 not found (run on macOS with the Xcode command line tools)"; }
for t in lipo otool install_name_tool codesign plutil shasum curl; do need "$t"; done

fetch() { # url dest sha256 [curl args...]
  local url="$1" dest="$2" sha="$3"; shift 3
  if [[ ! -s "$dest" ]]; then
    curl -fsSL --retry 3 "$@" -o "$dest.part" "$url"
    mv "$dest.part" "$dest"
  fi
  echo "$sha  $dest" | shasum -a 256 -c --quiet - || { rm -f "$dest"; die "checksum mismatch: $dest"; }
}

# --- Mach-O helpers (otool -l, so the dylib's own id is never mistaken for a dep) ---
deps() {
  otool -l "$1" | awk '$1=="cmd"{c=$2} $1=="name" && (c=="LC_LOAD_DYLIB"||c=="LC_LOAD_WEAK_DYLIB"||c=="LC_REEXPORT_DYLIB"||c=="LC_LOAD_UPWARD_DYLIB"){print $2}'
}
rpaths() { otool -l "$1" | awk '$1=="cmd"{c=$2} $1=="path" && c=="LC_RPATH"{print $2}'; }
is_system() { [[ "$1" == /usr/lib/* || "$1" == /System/* ]]; }
thin() { # src dst slice
  local archs; archs="$(lipo -archs "$1")"
  if [[ "$archs" == "$3" ]]; then cp "$1" "$2"
  elif [[ " $archs " == *" $3 "* ]]; then lipo "$1" -thin "$3" -output "$2"
  else die "$1 has no $3 slice ($archs)"; fi
  chmod u+w "$2"
}

# ================= source 1: official x86_64 package =====================================
pkg_prepare() {
  [[ -n "${FW:-}" ]] && return 0
  if [[ -n "${MONO_FRAMEWORK:-}" ]]; then FW="$MONO_FRAMEWORK"
  else
    need pkgutil
    log "package $PKG_NAME (370 MB download on first run)"
    fetch "$PKG_URL" "$CACHE/$PKG_NAME" "$PKG_SHA256"
    local x="$BUILD/pkg"
    if [[ ! -d "$x/mono.pkg/Payload" ]]; then rm -rf "${x:?}"; pkgutil --expand-full "$CACHE/$PKG_NAME" "$x"; fi
    FW="$x/mono.pkg/Payload/Library/Frameworks/Mono.framework/Versions/6.12.0"
  fi
  [[ -x "$FW/bin/mono-sgen64" && -f "$FW/lib/mono/4.5/mscorlib.dll" ]] || die "not a Mono framework: $FW"
  [[ "$(cat "$FW/VERSION" 2>/dev/null)" == "$PKG_VERSION" ]] || die "expected Mono $PKG_VERSION in $FW"
}
pkg_resolve() { # install name -> source file ("" = system)
  if is_system "$1"; then echo ""
  elif [[ "$1" == "$FW_ABS/lib/"* ]]; then echo "$FW/lib/${1#$FW_ABS/lib/}"
  else die "unexpected dependency $1"; fi
}

# ================= source 2: Homebrew arm64 bottles ======================================
HB="$BUILD/homebrew"
NEWLOCK="$BUILD/homebrew-arm64.lock.new"
hb_prefix() { local v; v="$(ls "$HB/$1" 2>/dev/null | head -n1)"; [[ -n "$v" ]] || die "formula $1 not fetched"; echo "$HB/$1/$v"; }
hb_ensure() { # formula
  local f="$1" line ver tag sha url json
  [[ -d "$HB/$f" ]] && return 0
  line=""
  [[ $UPDATE_LOCK == 0 && -f "$HB_LOCK" ]] && line="$(grep "^formula $f " "$HB_LOCK" || true)"
  if [[ -n "$line" ]]; then
    read -r _ _ ver tag sha url <<<"$line"
  else
    [[ $UPDATE_LOCK == 1 || ! -f "$HB_LOCK" ]] || die "formula $f is not in $HB_LOCK (run with --update-lock)"
    json="$CACHE/homebrew/$f.json"; mkdir -p "$CACHE/homebrew"
    curl -fsSL --retry 3 -o "$json" "$HB_API/$f.json"
    ver="$(plutil -extract versions.stable raw -o - "$json")"
    sha=""
    for tag in $HB_TAGS; do
      sha="$(plutil -extract "bottle.stable.files.$tag.sha256" raw -o - "$json" 2>/dev/null || true)"
      [[ -n "$sha" ]] && break
    done
    [[ -n "$sha" ]] || die "no arm64 bottle for $f"
    url="$(plutil -extract "bottle.stable.files.$tag.url" raw -o - "$json")"
  fi
  echo "formula $f $ver $tag $sha $url" >> "$NEWLOCK"
  log "bottle $f $ver ($tag)"
  mkdir -p "$CACHE/homebrew" "$HB"
  fetch "$url" "$CACHE/homebrew/$f-$ver.$tag.bottle.tar.gz" "$sha" -H "Authorization: Bearer QQ=="
  tar -xzf "$CACHE/homebrew/$f-$ver.$tag.bottle.tar.gz" -C "$HB"
}
hb_resolve() { # install name -> source file ("" = system)
  local d="$1" f rest n hit
  if is_system "$d"; then echo ""; return 0; fi
  case "$d" in
    @@HOMEBREW_PREFIX@@/opt/*)
      f="${d#@@HOMEBREW_PREFIX@@/opt/}"; rest="${f#*/}"; f="${f%%/*}"
      hb_ensure "$f"; echo "$(hb_prefix "$f")/$rest" ;;
    @@HOMEBREW_CELLAR@@/*)
      f="${d#@@HOMEBREW_CELLAR@@/}"; rest="${f#*/*/}"; f="${f%%/*}"
      hb_ensure "$f"; echo "$(hb_prefix "$f")/$rest" ;;
    @rpath/*|@loader_path/*|@@HOMEBREW_PREFIX@@/lib/*)
      n="${d##*/}"; hit="$(ls "$HB"/*/*/lib/"$n" 2>/dev/null | head -n1 || true)"
      [[ -n "$hit" ]] || die "cannot resolve $d among the fetched bottles"
      echo "$hit" ;;
    *) die "unexpected dependency $d" ;;
  esac
}
hb_prepare() {
  [[ -n "${MP:-}" ]] && return 0
  [[ -d "$HB" ]] && chmod -R u+w "$HB"   # bottles unpack read-only
  rm -rf "${HB:?}" "$NEWLOCK"; mkdir -p "$HB"
  local f; for f in $HB_ROOTS; do hb_ensure "$f"; done
  MP="$(hb_prefix mono)"
  [[ -x "$MP/bin/mono-sgen" && -f "$MP/lib/mono/4.5/mscorlib.dll" ]] || die "unexpected mono bottle layout: $MP"
  # Microsoft.VisualBasic (mono-basic) from the official Debian package (a .deb is an ar
  # archive; ar and tar both exist on macOS).
  local vb="$CACHE/$(basename "$VB_URL")"
  fetch "$VB_URL" "$vb" "$VB_SHA256"
  VBDIR="$BUILD/visualbasic"; rm -rf "${VBDIR:?}"; mkdir -p "$VBDIR"
  (cd "$VBDIR" && ar p "$vb" data.tar.xz | tar -xJf -)
}

# ================= assembly ===================================================================
LIST="$HERE/assemblies.txt"

# copy_fonts <fonts.conf> <conf.d> <conf.avail dir>: fontconfig setup for libgdiplus;
# absolute paths become relative (found through FONTCONFIG_PATH=<prefix>/etc/fonts).
copy_fonts() {
  local OUT="$1" conf="$2" confd="$3" avail="$4" c
  mkdir -p "$OUT/etc/fonts/conf.d"
  sed -e "s#$FW_ABS/etc/fonts/conf.d#conf.d#g" \
      -e "s#@@HOMEBREW_PREFIX@@/etc/fonts/conf.d#conf.d#g" \
      -e "s#<cachedir>$FW_ABS/[^<]*</cachedir>##g" \
      -e "s#<cachedir>@@HOMEBREW_PREFIX@@/[^<]*</cachedir>##g" "$conf" > "$OUT/etc/fonts/fonts.conf"
  for c in "$confd"/*.conf; do
    if [[ -L "$c" && "$(readlink "$c")" == /* ]]; then
      cp "$avail/$(basename "$(readlink "$c")")" "$OUT/etc/fonts/conf.d/$(basename "$c")"
    else cp -L "$c" "$OUT/etc/fonts/conf.d/"; fi
  done
}

assemble() { # arch source(pkg|hb)
  local arch="$1" src="$2" OUT="$ROOT/resources/mono/darwin-$1" slice resolver
  local -a queue
  if [[ $src == pkg ]]; then
    pkg_prepare; slice=x86_64; resolver=pkg_resolve
    queue=("$FW/lib/libmono-native-compat.0.dylib:libmono-native-compat.dylib"
           "$FW/lib/libMonoPosixHelper.dylib:libMonoPosixHelper.dylib"
           "$FW/lib/libmono-btls-shared.dylib:libmono-btls-shared.dylib"
           "$FW/lib/libgdiplus.0.dylib:libgdiplus.0.dylib")
  else
    hb_prepare; slice=arm64; resolver=hb_resolve
    queue=("$MP/lib/libmono-native.0.dylib:libmono-native.dylib"
           "$MP/lib/libMonoPosixHelper.dylib:libMonoPosixHelper.dylib"
           "$(hb_prefix mono-libgdiplus)/lib/libgdiplus.0.dylib:libgdiplus.0.dylib")
  fi
  log "assembling $OUT ($slice from $src)"
  rm -rf "${OUT:?}"
  mkdir -p "$OUT/bin" "$OUT/lib" "$OUT/etc/mono/4.5"

  # --- managed code + runtime configuration
  if [[ $src == pkg ]]; then
    thin "$FW/bin/mono-sgen64" "$OUT/bin/mono" "$slice"
    copy_managed "$OUT/lib/mono" "$LIST" "$FW/lib/mono"
    # The gdiplus dllmaps use the absolute framework path of the symlink libgdiplus.dylib.
    sed -e "s#$FW_ABS/lib/libgdiplus.dylib#\$mono_libdir/libgdiplus.0.dylib#g" \
        -e "s#$FW_ABS/lib/#\$mono_libdir/#g" "$FW/etc/mono/config" > "$OUT/etc/mono/config"
    cp "$FW/etc/mono/4.5/machine.config" "$OUT/etc/mono/4.5/"
    copy_fonts "$OUT" "$FW/etc/fonts/fonts.conf" "$FW/etc/fonts/conf.d" "$FW/share/fontconfig/conf.avail"
  else
    thin "$MP/bin/mono-sgen" "$OUT/bin/mono" "$slice"
    copy_managed "$OUT/lib/mono" "$LIST" "$MP/lib/mono" "$VBDIR/usr/lib/mono"
    sed -e 's#target="libgdiplus.dylib"#target="$mono_libdir/libgdiplus.0.dylib"#g' "$MP/etc/mono/config" > "$OUT/etc/mono/config"
    cp "$MP/etc/mono/4.5/machine.config" "$OUT/etc/mono/4.5/"
  fi

  # --- native libraries: roots under the names etc/mono/config uses, then every
  #     non-system library they link, stored flat in lib/.
  local done_=" " i=0 item from name d s
  while (( i < ${#queue[@]} )); do
    item="${queue[$i]}"; i=$((i+1))
    from="${item%:*}"; name="${item##*:}"
    [[ "$done_" == *" $name "* ]] && continue
    done_="$done_$name "
    [[ -e "$from" ]] || die "missing $from"
    thin "$from" "$OUT/lib/$name" "$slice"
    while IFS= read -r d; do
      s="$($resolver "$d")"
      [[ -n "$s" ]] && queue+=("$s:${d##*/}")
    done < <(deps "$OUT/lib/$name")
  done
  if [[ $src == hb ]]; then
    local fc; fc="$(hb_prefix fontconfig)"
    copy_fonts "$OUT" "$fc/.bottle/etc/fonts/fonts.conf" "$fc/.bottle/etc/fonts/conf.d" "$fc/share/fontconfig/conf.avail"
  fi

  # --- install names: ids -> @rpath/<name>, deps -> @loader_path/<name> (bin/mono:
  #     @executable_path/../lib/<name>), no rpaths.
  local f r
  for f in "$OUT/bin/mono" "$OUT"/lib/*.dylib; do
    [[ "$f" == *.dylib ]] && install_name_tool -id "@rpath/$(basename "$f")" "$f"
    while IFS= read -r d; do
      is_system "$d" && continue
      if [[ "$f" == */bin/mono ]]; then
        [[ -f "$OUT/lib/${d##*/}" ]] || die "bin/mono links ${d}, not bundled"
        install_name_tool -change "$d" "@executable_path/../lib/${d##*/}" "$f"
      else
        install_name_tool -change "$d" "@loader_path/${d##*/}" "$f"
      fi
    done < <(deps "$f")
    while IFS= read -r r; do install_name_tool -delete_rpath "$r" "$f"; done < <(rpaths "$f")
  done

  # --- checks
  local t
  for t in $(sed -n 's/.*target="\$mono_libdir\/\([^"]*\)".*/\1/p' "$OUT/etc/mono/config" | sort -u); do
    [[ -f "$OUT/lib/$t" ]] && continue
    if [[ $t == libmono-btls-shared.dylib && $src == hb ]]; then continue; fi  # not built by Homebrew; BTLS is never the default on macOS
    die "etc/mono/config maps to missing lib/$t"
  done
  for f in "$OUT/bin/mono" "$OUT"/lib/*.dylib; do
    while IFS= read -r d; do
      is_system "$d" && continue
      [[ -f "$OUT/lib/${d##*/}" && ( "$d" == @loader_path/* || "$d" == @executable_path/../lib/* ) ]] \
        || die "unresolved dependency $d in $f"
    done < <(deps "$f")
    [[ -z "$(rpaths "$f")" ]] || die "rpath left in $f"
  done
  [[ -z "$(find "$OUT" -type l)" ]] || die "symlinks left in $OUT"
  if grep -rqE "$FW_ABS|@@HOMEBREW" "$OUT/etc" || grep -rqE --include='*.config' "$FW_ABS|@@HOMEBREW" "$OUT/lib/mono"; then
    grep -rnE "$FW_ABS|@@HOMEBREW" "$OUT/etc" >&2 || true; die "absolute paths left in $OUT/etc or lib/mono/**/*.config"
  fi

  # --- ad-hoc signatures (install_name_tool invalidated the original ones)
  for f in "$OUT"/lib/*.dylib "$OUT/bin/mono"; do codesign --force --sign - "$f"; done

  {
    echo "Bundled Mono runtime darwin-$arch, $slice code"
    if [[ $src == pkg ]]; then
      echo "Mono $PKG_VERSION: $PKG_URL (sha256 $PKG_SHA256)"
      [[ $arch == x64 ]] || echo "Runs under Rosetta 2 on Apple Silicon (the official package has no arm64 slice)."
      echo "Minimum macOS: 10.9 (official Mono package requirement)"
    else
      echo "Mono $(basename "$MP") (WineHQ) from Homebrew bottles, lock: scripts/mono/homebrew-arm64.lock"
      sed 's/^formula /  /' "$NEWLOCK" | awk '{print "  " $1, $2, $3, "sha256:" $4}' | sort
      echo "Microsoft.VisualBasic.dll: $VB_URL (sha256 $VB_SHA256)"
      local min=14 tg
      for tg in $(awk '{print $4}' "$NEWLOCK"); do
        case "$tg" in arm64_sequoia) [[ $min -lt 15 ]] && min=15 ;; arm64_tahoe) [[ $min -lt 26 ]] && min=26 ;; arm64_golden_gate) min=27 ;; esac
      done
      echo "Minimum macOS: $min (newest bottle tag above; arm64_sonoma=14, sequoia=15, tahoe=26, golden_gate=27)"
    fi
    echo "Built by scripts/mono/build-macos.sh"
    echo "Native libraries: $(cd "$OUT/lib" && ls *.dylib | tr '\n' ' ')"
  } > "$OUT/MONO-RUNTIME.txt"
  log "done: $(du -sh "$OUT" | cut -f1) in $OUT"
}

for t in "${TARGETS[@]}"; do
  if [[ $t == arm64 && $ROSETTA == 0 ]]; then assemble arm64 hb; else assemble "$t" pkg; fi
done
if [[ -f "$NEWLOCK" ]] && { [[ $UPDATE_LOCK == 1 ]] || [[ ! -f "$HB_LOCK" ]]; }; then
  { echo "# Homebrew arm64 bottles bundled into resources/mono/darwin-arm64 (scripts/mono/build-macos.sh)."
    echo "# formula <name> <version> <bottle tag> <sha256> <url>; regenerate with --update-lock."
    sort -u "$NEWLOCK"; } > "$HB_LOCK"
  log "wrote $HB_LOCK (commit it)"
fi
