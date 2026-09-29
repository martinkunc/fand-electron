#!/usr/bin/env bash
# Builds the Rebex substitutes (../build.sh) and runs
#   1. ApiCheck: every Rebex member referenced by the Účto helpers exists in the substitute of
#      its version; the substitutes add no invented API; enum values match the originals;
#   2. RebexTests for 6.0.8000.0 and 5.0.7320.0: offline HTTPS/HTTP/SOAP/CMS tests.
# Options: --live     also query the public ARES REST API (read-only)
#          --openssl  also cross-check CMS with the openssl tool
# Mono state (certificate stores) goes to a temporary XDG_CONFIG_HOME, never to ~/.config.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REBEX="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$REBEX/../../.." && pwd)"
APP="${UCTO_APP:-$ROOT/vendor/extracted/app}"
BIN="$REBEX/bin"
OUT="$BIN/tests"
CECIL="${CECIL:-/usr/lib/mono/gac/Mono.Cecil/0.11.0.0__0738eb9f132ed756/Mono.Cecil.dll}"
[[ -f "$CECIL" ]] || CECIL="$REBEX/../patch/Mono.Cecil.dll"
ARGS=("$@")

"$REBEX/build.sh"
mkdir -p "$OUT"

echo "== ApiCheck"
cp "$CECIL" "$OUT/Mono.Cecil.dll"
mcs -sdk:4.7.2 -nologo -r:"$OUT/Mono.Cecil.dll" -out:"$OUT/ApiCheck.exe" "$HERE/ApiCheck.cs"
mono "$OUT/ApiCheck.exe" "$APP" "$BIN" | tee "$OUT/apicheck.txt" | grep -v '^  ok ' || true
grep -q '^API check passed' "$OUT/apicheck.txt"

export XDG_CONFIG_HOME="$(mktemp -d)"
trap 'rm -rf "$XDG_CONFIG_HOME"' EXIT
if [[ " ${ARGS[*]-} " == *" --live "* ]]; then
  # Private Mono trust store filled from the system CA bundle (as the app does for users).
  MONO_PREFIX="$(cd "$(dirname "$(command -v mono)")/.." && pwd)"
  CERTSYNC="$MONO_PREFIX/lib/mono/4.5/cert-sync.exe"
  BUNDLE=/etc/ssl/certs/ca-certificates.crt
  if [[ ! -f $BUNDLE && "$(uname)" == Darwin ]]; then
    BUNDLE="$XDG_CONFIG_HOME/roots.pem"
    security find-certificate -a -p /System/Library/Keychains/SystemRootCertificates.keychain > "$BUNDLE"
  fi
  mono "$CERTSYNC" --quiet --user "$BUNDLE"
fi

status=0
for ver in 6.0.8000.0 5.0.7320.0; do
  echo
  echo "== RebexTests $ver"
  d="$OUT/$ver"; mkdir -p "$d"
  cp "$BIN/$ver"/Rebex.*.dll "$d/"
  extra=(); def=REBEX6
  if [[ $ver == 5.* ]]; then
    def=REBEX5
    for p in Rebex.Castle Rebex.Curve25519 Rebex.Ed25519; do cp "$APP/{ap03}/$p.dll" "$d/"; extra+=(-r:"$d/$p.dll"); done
    extra+=("$HERE/ZpPlugins.cs")
  fi
  mcs -sdk:4.7.2 -nologo -define:$def -out:"$d/RebexTests.exe" \
    -r:"$d/Rebex.Common.dll" -r:"$d/Rebex.Networking.dll" -r:"$d/Rebex.Http.dll" \
    -r:System.dll -r:System.Core.dll -r:System.Security.dll -r:System.Web.Services.dll -r:System.Xml.dll -r:Mono.Security.dll \
    "${extra[@]}" "$HERE/RebexTests.cs" "$HERE/TestServer.cs" "$HERE/TestCerts.cs"
  (cd "$d" && mono --debug RebexTests.exe "${ARGS[@]}") || status=1
done
exit $status
