#!/usr/bin/env bash
# Builds UctoPatch.exe (Mono.Cecil based IL patcher) and places Mono.Cecil.dll next to it.
# Mono.Cecil comes from $MONO_CECIL, else Mono's GAC (Linux/macOS Mono packages ship
# 0.11.x), else the NuGet package (downloaded into vendor/downloads/mono/).
# Requires Mono's mcs. Usage: ./build.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
MCS="${MCS:-mcs}"
CECIL_NUGET_VERSION="0.11.6"

find_cecil() {
  if [[ -n "${MONO_CECIL:-}" ]]; then echo "$MONO_CECIL"; return; fi
  local prefix gac
  prefix="$(dirname "$(dirname "$(readlink -f "$(command -v mono)")")")"
  for gac in "$prefix/lib/mono/gac" /usr/lib/mono/gac /Library/Frameworks/Mono.framework/Versions/Current/lib/mono/gac; do
    local f
    f="$(ls -d "$gac"/Mono.Cecil/0.11.*/Mono.Cecil.dll 2>/dev/null | sort | tail -1 || true)"
    if [[ -n "$f" ]]; then echo "$f"; return; fi
  done
  local pkg="$ROOT/vendor/downloads/mono/mono.cecil.$CECIL_NUGET_VERSION.nupkg"
  if [[ ! -f "$pkg" ]]; then
    mkdir -p "$(dirname "$pkg")"
    curl -fsSL -o "$pkg" "https://www.nuget.org/api/v2/package/Mono.Cecil/$CECIL_NUGET_VERSION"
  fi
  local out="$ROOT/vendor/downloads/mono/mono.cecil.$CECIL_NUGET_VERSION"
  [[ -f "$out/lib/net40/Mono.Cecil.dll" ]] || { mkdir -p "$out"; (cd "$out" && unzip -qo "$pkg"); }
  echo "$out/lib/net40/Mono.Cecil.dll"
}

CECIL="$(find_cecil)"
cp -f "$CECIL" "$HERE/Mono.Cecil.dll"
cd "$HERE"
"$MCS" -target:exe -sdk:4.7.2 -optimize+ -debug- -out:UctoPatch.exe -r:Mono.Cecil.dll -r:System.dll -r:System.Core.dll \
  UctoPatch.cs Rewriter.cs
echo "built $HERE/UctoPatch.exe (Mono.Cecil: $CECIL)"
