#!/usr/bin/env bash
# Builds UctoShim.dll, the runtime support library the patched helper copies call into
# (see ../patch/UctoPatch.cs). Requires Mono's mcs. Usage: ./build.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCS="${MCS:-mcs}"
cd "$HERE"
"$MCS" -target:library -sdk:4.7.2 -optimize+ -debug- -nowarn:67,1591 -out:UctoShim.dll \
  -r:System.dll -r:System.Core.dll -r:System.Data.dll -r:System.Drawing.dll -r:System.Windows.Forms.dll \
  Core.cs Win32.cs Data.cs Forms.cs
echo "built $HERE/UctoShim.dll"
