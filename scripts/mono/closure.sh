#!/usr/bin/env bash
# Computes which Mono framework assemblies the bundled runtime must contain.
#
#   scripts/mono/closure.sh <framework dir> [scan dir...]
#
# <framework dir> is lib/mono/4.5 of an extracted (untrimmed) Mono. Every .NET assembly
# found under the scan dirs (default: vendor/extracted/app and shims/mono) is read with
# `monodis --assemblyref`; referenced names that exist in the framework dir (or its
# Facades/) are followed recursively. The seeds below add what is loaded by name at run
# time and so never shows up as a reference (code pages, TLS, cert-sync, ...).
#
# Output (stdout): one path per line, relative to the framework dir, sorted.
# Diagnostics (stderr): references that are neither framework nor shipped with Účto.
# Needs `monodis` (Mono) on PATH; it only reads metadata, so any Mono version and CPU
# architecture works for any target.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
FW="${1:?usage: closure.sh <framework dir> [scan dir...]}"; shift
FW="$(cd "$FW" && pwd)"
SCAN=("$@")
[[ ${#SCAN[@]} -gt 0 ]] || SCAN=("$ROOT/vendor/extracted/app" "$ROOT/shims/mono")
command -v monodis >/dev/null || { echo "closure.sh: monodis not found (install mono-utils)" >&2; exit 1; }

# Loaded by name / reflection, never referenced statically:
#  * mscorlib and the basic stack every helper and UctoMonoHost use,
#  * I18N.*: Encoding.GetEncoding(852/1250/...) (Ares2 writes CP852),
#  * Mono.Security + System.Security: TLS and certificate validation,
#  * cert-sync.exe: imports the system CA bundle into the private Mono cert store,
#  * Mono.Posix: System.Windows.Forms' X11 driver, Mono.Unix,
#  * System.Web.Services: SOAP clients (Nepl2, VIES...), also reached by reference.
SEEDS=(mscorlib System System.Core System.Configuration System.Xml System.Xml.Linq
  System.Security Mono.Security System.Drawing System.Windows.Forms System.Web.Services
  System.Numerics System.Data Mono.Posix Accessibility
  I18N I18N.West I18N.Other I18N.MidEast I18N.Rare I18N.CJK cert-sync.exe)

declare -A seen=() app=() missing=()
queue=()

resolve() { # name -> relative path in FW, or empty
  local n="$1"
  if [[ "$n" == *.exe ]]; then [[ -f "$FW/$n" ]] && echo "$n"; return 0; fi
  if [[ -f "$FW/$n.dll" ]]; then echo "$n.dll"
  elif [[ -f "$FW/Facades/$n.dll" ]]; then echo "Facades/$n.dll"; fi
}
refs() { monodis --assemblyref "$1" 2>/dev/null | sed -n 's/^[[:space:]]*Name=//p' | tr -d '\r'; }
add() {
  local n="$1" rel
  [[ -n "${seen[$n]:-}" ]] && return 0
  rel="$(resolve "$n")"
  if [[ -n "$rel" ]]; then seen[$n]="$rel"; queue+=("$rel")
  elif [[ -z "${app[${n,,}]:-}" ]]; then missing[$n]=1; fi
}

# 1. Every managed assembly shipped with Účto (and the shims).
files=()
for d in "${SCAN[@]}"; do
  [[ -d "$d" ]] || continue
  while IFS= read -r -d '' f; do
    if monodis --assembly "$f" >/dev/null 2>&1; then
      files+=("$f"); b="$(basename "$f")"; b="${b%.*}"; app[${b,,}]=1
    fi
  done < <(find "$d" -type f \( -iname '*.exe' -o -iname '*.dll' \) -print0)
done
echo "closure.sh: ${#files[@]} managed assemblies scanned" >&2
for f in "${files[@]}"; do while IFS= read -r n; do add "$n"; done < <(refs "$f"); done
for n in "${SEEDS[@]}"; do add "$n"; done

# 2. Follow framework references transitively.
i=0
while (( i < ${#queue[@]} )); do
  rel="${queue[$i]}"; i=$((i+1))
  while IFS= read -r n; do add "$n"; done < <(refs "$FW/$rel")
done

for n in "${!missing[@]}"; do echo "closure.sh: unresolved reference $n" >&2; done
printf '%s\n' "${seen[@]}" | sort -u
