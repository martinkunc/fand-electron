#!/usr/bin/env bash
# Builds the bundled, relocatable Mono runtime for Linux:
#
#   scripts/mono/build-linux.sh <x64|arm64> [--offline]
#
# Output: resources/mono/linux-<arch>/
#   bin/mono                      mono-sgen (static libmonosgen; needs only glibc/libstdc++/zlib)
#   lib/mono/4.5/*.dll, *.exe     trimmed framework (closure of what the Účto helpers use)
#   lib/*.so*                     libmono-native, libMonoPosixHelper, libmono-btls-shared,
#                                 libgdiplus.so.0 + the image libraries whose sonames differ
#                                 between distributions (RUNPATH $ORIGIN)
#   etc/mono/config, etc/mono/4.5/machine.config
#   MONO-RUNTIME.txt              versions, packages and checksums used
#
# Sources (no root, nothing is installed; packages are unpacked with dpkg-deb -x):
#   * Mono 6.12.0.200 from the official repository download.mono-project.com
#     (Debian 10 "stable-buster", built against glibc 2.28, so it runs on any distro
#     from 2019 on);
#   * libgdiplus 6.0.5 from the same repository;
#   * libtiff5/libjpeg62-turbo/libgif7/libexif12/libjbig0/libwebp6 from the Debian 10
#     archive (archive.debian.org, incl. buster security updates).
# Every .deb is verified against the SHA256 in the (HTTPS) repository index. Downloads
# are cached in vendor/downloads/mono/; --offline uses only the cache.
# Build host requirements: bash, curl, gzip, dpkg-deb, readelf (binutils), sha256sum,
# monodis (only to recompute the assembly closure; otherwise scripts/mono/assemblies.txt
# is used). The build host can be any CPU architecture.
# See docs/MONO-RUNTIME.md.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ARCH="${1:-}"; shift || true
OFFLINE=0
for a in "$@"; do case "$a" in --offline) OFFLINE=1 ;; *) echo "unknown option $a" >&2; exit 2 ;; esac; done
case "$ARCH" in
  x64)   DEBARCH=amd64 ;;
  arm64) DEBARCH=arm64 ;;
  *) echo "usage: $0 <x64|arm64> [--offline]" >&2; exit 2 ;;
esac

MONO_VERSION="6.12.0.200"
MONO_REPO="https://download.mono-project.com/repo/debian"
MONO_SUITE="stable-buster"
DEB_ARCHIVE="https://archive.debian.org"
PATCHELF_VERSION="0.18.0"

CACHE="$ROOT/vendor/downloads/mono/linux-$ARCH"
BUILD="$ROOT/work/mono-build/linux-$ARCH"
STAGE="$BUILD/stage"
OUT="$ROOT/resources/mono/linux-$ARCH"
mkdir -p "$CACHE" "$BUILD"

log() { echo "[mono linux-$ARCH] $*"; }
. "$HERE/common.sh"

fetch() { # url dest
  if [[ -s "$2" ]]; then return 0; fi
  [[ $OFFLINE == 1 ]] && { echo "offline: $2 missing from cache" >&2; exit 1; }
  curl -fsSL --retry 3 -o "$2.part" "$1"
  mv "$2.part" "$2"
}

# --- package indexes ---------------------------------------------------------------
# name -> "version filename sha256 baseurl" of the newest version in the given indexes.
declare -A PKG=()
load_index() { # baseurl index-url cache-name
  local base="$1" url="$2" f="$CACHE/$3"
  fetch "$url" "$f.gz"
  gzip -dc "$f.gz" > "$f"
  while read -r name ver fn sha; do
    local cur="${PKG[$name]:-}"
    if [[ -z "$cur" ]] || dpkg --compare-versions "$ver" gt "${cur%% *}"; then
      PKG[$name]="$ver $fn $sha $base"
    fi
  done < <(awk -v RS= -F'\n' '{n=v=f=s=""; for(i=1;i<=NF;i++){
      if($i~/^Package: /)n=substr($i,10); else if($i~/^Version: /)v=substr($i,10);
      else if($i~/^Filename: /)f=substr($i,11); else if($i~/^SHA256: /)s=substr($i,9)}
      if(n!="")print n, v, f, s}' "$f")
}

log "reading package indexes"
load_index "$MONO_REPO" "$MONO_REPO/dists/$MONO_SUITE/main/binary-$DEBARCH/Packages.gz" "mono-$MONO_SUITE.Packages"
load_index "$DEB_ARCHIVE/debian" "$DEB_ARCHIVE/debian/dists/buster/main/binary-$DEBARCH/Packages.gz" "debian-buster.Packages"
load_index "$DEB_ARCHIVE/debian-security" "$DEB_ARCHIVE/debian-security/dists/buster/updates/main/binary-$DEBARCH/Packages.gz" "debian-buster-security.Packages"

got="${PKG[mono-runtime-sgen]%% *}"
[[ "$got" == "$MONO_VERSION"-* ]] || { echo "expected Mono $MONO_VERSION, repository has $got" >&2; exit 1; }

# Mono: runtime + every class-library package (the trim step keeps only the closure).
MONO_PKGS=(mono-runtime-sgen mono-runtime-common ca-certificates-mono libgdiplus)
for p in "${!PKG[@]}"; do
  [[ "${PKG[$p]}" == *"$MONO_REPO"* ]] || continue
  if [[ "$p" =~ ^libmono-.*-cil$ ]] && ! [[ "$p" =~ reactive|nunit|cecil|microsoft-build|xbuild|mvc|razor|webpages|oracle|db2|rabbitmq|sqlite|fsharp ]]; then
    MONO_PKGS+=("$p")
  fi
done
# Image libraries libgdiplus links against whose sonames are not the same on current
# distributions (libtiff.so.5, libjpeg.so.62, libjbig.so.0, libwebp.so.6, libexif, libgif).
IMG_PKGS=(libtiff5 libjpeg62-turbo libjbig0 libwebp6 libgif7 libexif12)

log "downloading ${#MONO_PKGS[@]} Mono packages + ${#IMG_PKGS[@]} image libraries"
DEBS=()
MANIFEST_PKGS=""
for p in "${MONO_PKGS[@]}" "${IMG_PKGS[@]}"; do
  [[ -n "${PKG[$p]:-}" ]] || { echo "package $p not found for $DEBARCH" >&2; exit 1; }
  read -r ver fn sha base <<<"${PKG[$p]}"
  deb="$CACHE/$(basename "$fn")"
  fetch "$base/$fn" "$deb"
  echo "$sha  $deb" | sha256sum -c --quiet - || { rm -f "$deb"; echo "checksum mismatch: $deb" >&2; exit 1; }
  DEBS+=("$deb")
  MANIFEST_PKGS+="  $p $ver sha256:$sha"$'\n'
done

log "extracting"
rm -rf "${STAGE:?}"; mkdir -p "$STAGE"
for d in "${DEBS[@]}"; do dpkg-deb -x "$d" "$STAGE"; done
FW="$STAGE/usr/lib/mono/4.5"

# --- patchelf (static binary for the build host) ------------------------------------
case "$(uname -m)" in x86_64|amd64) PEA=x86_64 ;; aarch64|arm64) PEA=aarch64 ;; *) PEA="$(uname -m)" ;; esac
PATCHELF="$(command -v patchelf || true)"
if [[ -z "$PATCHELF" ]]; then
  pt="$ROOT/vendor/downloads/mono/patchelf-$PATCHELF_VERSION-$PEA.tar.gz"
  fetch "https://github.com/NixOS/patchelf/releases/download/$PATCHELF_VERSION/patchelf-$PATCHELF_VERSION-$PEA.tar.gz" "$pt"
  mkdir -p "$BUILD/patchelf"; tar -xzf "$pt" -C "$BUILD/patchelf"
  PATCHELF="$BUILD/patchelf/bin/patchelf"
fi

# --- assembly closure ----------------------------------------------------------------
LIST="$HERE/assemblies.txt"
if command -v monodis >/dev/null && [[ -d "$ROOT/vendor/extracted/app" ]]; then
  log "computing assembly closure"
  { echo "# Generated by scripts/mono/closure.sh (via build-linux.sh). Framework assemblies"
    echo "# (relative to lib/mono/4.5) bundled with the app; build-macos.sh reads this file."
    "$HERE/closure.sh" "$FW"; } > "$LIST.new"
  mv "$LIST.new" "$LIST"
else
  log "monodis or vendor/extracted/app missing: using the committed $LIST"
fi

# --- assemble the prefix ----------------------------------------------------------------
log "assembling $OUT"
rm -rf "${OUT:?}"
mkdir -p "$OUT/bin" "$OUT/lib/mono/4.5" "$OUT/etc/mono/4.5"
cp -L "$STAGE/usr/bin/mono-sgen" "$OUT/bin/mono"
copy_managed "$OUT/lib/mono" "$LIST" "$STAGE/usr/lib/mono"
cp "$STAGE/etc/mono/config" "$OUT/etc/mono/config"
cp "$STAGE/etc/mono/4.5/machine.config" "$OUT/etc/mono/4.5/machine.config"

# Native libraries, stored under the exact names the runtime asks for (no symlinks:
# they do not survive every packaging format).
L="$STAGE/usr/lib"
cp -L "$L/libmono-native.so"      "$OUT/lib/libmono-native.so"
cp -L "$L/libMonoPosixHelper.so"  "$OUT/lib/libMonoPosixHelper.so"
cp -L "$L/libmono-btls-shared.so" "$OUT/lib/libmono-btls-shared.so"
cp -L "$L/libgdiplus.so.0"        "$OUT/lib/libgdiplus.so.0"
TRIPLET="$(ls "$STAGE/usr/lib" | grep -E -- '-linux-gnu$' | head -n1)"
for so in libtiff.so.5 libjpeg.so.62 libjbig.so.0 libwebp.so.6 libgif.so.7 libexif.so.12; do
  src="$(find "$STAGE/usr/lib/$TRIPLET" "$STAGE/lib/$TRIPLET" -name "$so" 2>/dev/null | head -n1 || true)"
  [[ -n "$src" ]] || { echo "$so not found in the image packages" >&2; exit 1; }
  cp -L "$src" "$OUT/lib/$so"
done
# Resolve the bundled image libraries next to libgdiplus first; everything else
# (cairo, fontconfig, freetype, glib, libpng16, X11, zlib, lzma, zstd) comes from the
# system, where Electron's own GTK dependency already guarantees it.
for f in "$OUT"/lib/*.so*; do
  if readelf -d "$f" | grep -q 'NEEDED.*\(libtiff\|libjpeg\|libjbig\|libwebp\|libgif\|libexif\)'; then
    "$PATCHELF" --set-rpath '$ORIGIN' "$f"
  fi
done

# --- report -------------------------------------------------------------------------------
needed="$(for f in "$OUT/bin/mono" "$OUT"/lib/*.so*; do readelf -d "$f" | sed -n 's/.*NEEDED.*\[\(.*\)\]/\1/p'; done | sort -u)"
bundled="$(cd "$OUT/lib" && ls *.so* | sort)"
system="$(comm -23 <(echo "$needed") <(echo "$bundled") | tr '\n' ' ')"
glibc="$(for f in "$OUT/bin/mono" "$OUT"/lib/*.so*; do readelf -V "$f" 2>/dev/null | grep -o 'GLIBC_[0-9.]*'; done | sort -uV | tail -n1)"
{
  echo "Bundled Mono runtime linux-$ARCH"
  echo "Mono $MONO_VERSION ($MONO_REPO $MONO_SUITE, $DEBARCH); built by scripts/mono/build-linux.sh"
  echo "Highest glibc symbol version required: $glibc"
  echo "System libraries required: $system"
  echo "Packages:"
  printf '%s' "$MANIFEST_PKGS" | sort
} > "$OUT/MONO-RUNTIME.txt"

log "done: $(du -sh "$OUT" | cut -f1) ($(du -sh "$OUT/lib/mono" | cut -f1) managed, $(find "$OUT/lib/mono" -type f \( -name "*.dll" -o -name "*.exe" \) | wc -l) assemblies)"
log "system libraries required: $system"
log "glibc: $glibc"
