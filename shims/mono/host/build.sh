#!/usr/bin/env bash
# Builds UctoMonoHost.exe, the launcher that runs an original Účto .NET helper under Mono.
# Requires Mono's mcs. Usage: ./build.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MCS="${MCS:-mcs}"
cd "$HERE"
"$MCS" -target:exe -sdk:4.7.2 -optimize+ -debug- -out:UctoMonoHost.exe -r:System.dll -r:System.Core.dll UctoMonoHost.cs
echo "built $HERE/UctoMonoHost.exe"
