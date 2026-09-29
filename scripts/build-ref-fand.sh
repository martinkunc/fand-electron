#!/usr/bin/env bash
# Build the reference PC FAND (standa/pcfand, branch fpc-migration: the Free Pascal
# port of the original sources) into vendor/reference/standa_pcfand/bin/fand.
# Applies scripts/ref-fand-arm64.patch first (aarch64 pointer range, case-insensitive
# DOS paths on Linux, FANDRES/FANDCFG lookup, build.sh fixes); see docs/REFERENCE.md.
#
#   scripts/build-ref-fand.sh          build (clones the pinned commit when missing)
#   scripts/build-ref-fand.sh -gl      any options go to fpc (-gl: line info in tracebacks)
#
# Needs FPC 3.2.2+ (apt install fpc / brew install fpc).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REF="$ROOT/vendor/reference/standa_pcfand"
PATCH="$ROOT/scripts/ref-fand-arm64.patch"
REPO="${REF_FAND_REPO:-https://github.com/standa/pcfand}"
COMMIT="${REF_FAND_COMMIT:-3cdf8e8}"   # the patch is made against this fpc-migration commit

command -v fpc >/dev/null || { echo "build-ref-fand: fpc not found (apt install fpc)" >&2; exit 1; }
if [[ ! -d "$REF/.git" ]]; then
  git clone -b fpc-migration "$REPO" "$REF"
  git -C "$REF" checkout -q "$COMMIT"
fi
if git -C "$REF" apply --reverse --check "$PATCH" 2>/dev/null; then
  echo "build-ref-fand: patch already applied"
else
  git -C "$REF" apply "$PATCH"
  echo "build-ref-fand: patch applied"
fi
"$REF/tools/build.sh" "$@"
echo "build-ref-fand: $REF/bin/fand"
