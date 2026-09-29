#!/usr/bin/env bash
# End-to-end check of the bundled Linux Mono (resources/mono/linux-<host arch>) with the
# system Mono made invisible, so nothing can silently come from /usr/lib/mono, /etc/mono,
# ~/.mono or the system libgdiplus/libmono-* libraries.
#
#   scripts/mono/verify-linux.sh            hide system Mono in a private mount namespace
#                                           (needs root or unprivileged user namespaces;
#                                           the rest of the machine is not affected)
#   scripts/mono/verify-linux.sh --rename   hide it by renaming the files instead (root);
#                                           a trap always renames them back
#   scripts/mono/verify-linux.sh --no-hide  run against the bundle without hiding anything
#
# Runs, from a copy of the pristine Účto helpers in work/tmp-runtime/:
#   1. cert-sync.exe into a private certificate store (XDG_CONFIG_HOME),
#   2. Ares2.exe (original)  + substitute Rebex   -> live ARES lookup of IČO 00006947,
#   3. Nepl2.exe (patched copy made by UctoPatch.exe running on the bundled Mono)
#                             + substitute Rebex   -> live MF ČR SOAP call,
#   4. UctoQR.exe (original) -> QR payment code stamped into a PDF, decoded with zbarimg.
# WinForms needs an X display, so every helper runs under xvfb-run.
# Requires: the built shims (shims/mono/{host,rebex,patch,shimlib}, or $UCTO_SHIMS), xvfb-run, zbarimg,
# iconv, network access to ares.gov.cz and adisrws.mfcr.cz.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
case "$(uname -m)" in x86_64|amd64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "unsupported $(uname -m)" >&2; exit 2 ;; esac
PREFIX="${MONO_PREFIX:-$ROOT/resources/mono/linux-$ARCH}"
APP="$ROOT/vendor/extracted/app"
SHIMS="${UCTO_SHIMS:-$ROOT/shims/mono}"   # override to test another shim build
T="$ROOT/work/tmp-runtime"
# Rebex substitutes: shims/mono/rebex/build.sh puts one set per version under bin/.
REBEX="$SHIMS/rebex/bin/6.0.8000.0"; [[ -d "$REBEX" ]] || REBEX="$SHIMS/rebex"
MODE="${1:-ns}"

# Everything a system Mono installation could contribute.
HIDE_DIRS=(/usr/lib/mono /etc/mono /usr/share/.mono /usr/local/lib/mono /usr/local/etc/mono)
hide_files() {
  compgen -G '/usr/lib/libgdiplus*' || true
  compgen -G '/usr/lib/*/libgdiplus*' || true
  compgen -G '/usr/lib/libmono*' || true
  compgen -G '/usr/lib/libMono*' || true
  compgen -G '/usr/bin/mono*' || true
  compgen -G '/usr/bin/cert-sync' || true
}

tests() {
  local fail=0
  export XDG_CONFIG_HOME="$T/xdg" HOME="$T/home" MONO_XMLSERIALIZER_THS=no
  mkdir -p "$XDG_CONFIG_HOME" "$HOME"
  echo "== system Mono visible?"
  if [[ -e /usr/lib/mono/4.5/mscorlib.dll || -e /etc/mono/config ]]; then echo "   yes (not hidden)"; else echo "   no"; fi
  local M="$PREFIX/bin/mono"
  "$M" --version | head -n1

  echo "== cert-sync into the private store"
  local bundle
  for bundle in /etc/ssl/certs/ca-certificates.crt /etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem \
                /etc/ssl/ca-bundle.pem /etc/ssl/cert.pem; do [[ -s $bundle ]] && break; done
  "$M" "$PREFIX/lib/mono/4.5/cert-sync.exe" --quiet --user "$bundle"
  echo "   $(ls "$XDG_CONFIG_HOME/.mono/certs/Trust" | wc -l) trusted roots in $XDG_CONFIG_HOME/.mono/certs/Trust"

  echo "== Ares2 (original exe, substitute Rebex)"
  cat > "$T/{ap02}/Ares2.xml" <<X
<?xml version="1.0" encoding="utf-8" ?>
<configuration><appSettings>
<add key="outputEncoding" value="852" />
<add key="outputFilename" value="$T/{ap02}/ARES2.TXT" />
<add key="regNo" value="00006947" />
<add key="logFilename" value="$T/{ap02}/ARES2.LOG"/>
</appSettings></configuration>
X
  rm -f "${T:?}/{ap02}/ARES2.TXT"
  xvfb-run -a "$M" "$SHIMS/host/UctoMonoHost.exe" "$T/{ap02}/Ares2.exe" "$T/{ap02}/Ares2.xml" "$REBEX" || true
  if [[ -s "$T/{ap02}/ARES2.TXT" ]] && iconv -f CP852 "$T/{ap02}/ARES2.TXT" | head -n1 | grep -q 'Ministerstvo financí'; then
    echo "   OK: $(iconv -f CP852 "$T/{ap02}/ARES2.TXT" | tr -d '\r' | paste -sd'|')"
  else echo "   FAIL"; cat "$T/{ap02}/ARES2.LOG" 2>/dev/null || true; fail=1; fi

  echo "== Nepl2 (patched copy, substitute Rebex)"
  mkdir -p "$T/cache"
  "$M" "$SHIMS/patch/UctoPatch.exe" "$T/{ap02}/Nepl2.exe" "$T/cache/Nepl2.exe" "$SHIMS/shimlib/UctoShim.dll"
  printf '00006947\r\n27082440\r\n' > "$T/{ap02}/neplin.txt"; rm -f "${T:?}/{ap02}/neplout.txt"
  xvfb-run -a "$M" "$SHIMS/host/UctoMonoHost.exe" "$T/{ap02}/Nepl2.exe=$T/cache/Nepl2.exe" - "$REBEX;$SHIMS/shimlib" || true
  if [[ -s "$T/{ap02}/neplout.txt" ]] && grep -q $'^00006947  [AN].*\r$' "$T/{ap02}/neplout.txt"; then
    echo "   OK: $(head -c 120 "$T/{ap02}/neplout.txt" | tr -d '\r' | head -n1)..."
  else echo "   FAIL"; cat "$T/{ap02}/Nepl2-app.log" 2>/dev/null || true; fail=1; fi

  echo "== UctoQR (original exe)"
  cat > "$T/{tisk}/UctoQR.xml" <<X
<?xml version="1.0" encoding="utf-8" ?><configuration><appSettings>
<add key="scale" value="2"/><add key="left" value="25"/><add key="bottom" value="55"/><add key="qrtype" value="1"/><add key="pageDisplay" value="1"/>
<add key="outputPDF" value="$T/{tisk}/out.pdf"/><add key="inputPDF" value="$T/{tisk}/ENP1.PDF"/><add key="qrImage" value="$T/{tisk}/qr.jpg"/>
<add key="runAR" value="N"/><add key="overwriteSource" value="N"/><add key="prefix" value="19"/><add key="account" value="2000145399"/><add key="code" value="0800"/>
<add key="konstanta" value="123500"/><add key="amount" value="1234.50"/><add key="currency" value="CZK"/><add key="dueDate" value="20260315"/>
<add key="msg" value="Faktura 1"/><add key="vs" value="2026001"/><add key="ks" value=""/><add key="ss" value=""/><add key="password" value=""/><add key="attachFilename" value=""/><add key="rn" value="STEHLIK"/>
</appSettings></configuration>
X
  rm -f "${T:?}/{tisk}/out.pdf" "${T:?}/{tisk}/qr.jpg"
  (cd "$T" && xvfb-run -a "$M" "$SHIMS/host/UctoMonoHost.exe" "$T/{tisk}/UctoQR.exe" "$T/{tisk}/UctoQR.xml" -) || true
  local want='SPD*1.0*ACC:CZ6508000000192000145399*AM:1234.50*CC:CZK*DT:20260315*MSG:FAKTURA 1*X-VS:2026001*RN:STEHLIK'
  local got; got="$(zbarimg -q --raw "$T/{tisk}/qr.jpg" 2>/dev/null || true)"
  if [[ -s "$T/{tisk}/out.pdf" && "$got" == "$want" ]]; then
    echo "   OK: out.pdf $(stat -c %s "$T/{tisk}/out.pdf") bytes, QR = $got"
  else echo "   FAIL: QR='$got'"; cat "$T/{tisk}/uctoqr.log" 2>/dev/null || true; fail=1; fi

  [[ $fail == 0 ]] && echo "ALL OK" || echo "SOME TESTS FAILED"
  return $fail
}

if [[ "$MODE" == --inner ]]; then
  # Inside the private mount namespace: cover the directories with empty tmpfs mounts
  # and the individual libraries with /dev/null (dlopen then fails as if absent).
  for d in "${HIDE_DIRS[@]}"; do [[ -d $d ]] && mount -t tmpfs -o ro,size=1k none "$d"; done
  while IFS= read -r f; do [[ -e $f && ! -d $f ]] && mount --bind /dev/null "$f"; done < <(hide_files)
  tests; exit $?
fi

# --- prepare the test folder from the pristine installation ---------------------------
[[ -x "$PREFIX/bin/mono" ]] || { echo "no bundle at $PREFIX (run scripts/mono/build-linux.sh $ARCH)" >&2; exit 1; }
[[ -f "$REBEX/Rebex.Http.dll" ]] || { echo "missing Rebex substitutes in $REBEX (run shims/mono/rebex/build.sh)" >&2; exit 1; }
for f in host/UctoMonoHost.exe patch/UctoPatch.exe patch/Mono.Cecil.dll shimlib/UctoShim.dll; do
  [[ -f "$SHIMS/$f" ]] || { echo "missing shim $SHIMS/$f (build the shims first)" >&2; exit 1; }
done
rm -rf "${T:?}"; mkdir -p "$T/{ap02}" "$T/{tisk}"
cp "$APP/{ap02}/Ares2.exe" "$APP/{ap02}/Nepl2.exe" "$APP"/{ap02}/Rebex.*.dll "$T/{ap02}/"
cp "$APP/{tisk}/UctoQR.exe" "$APP/{tisk}/itextsharp.dll" "$APP/{tisk}/MessagingToolkit.QRCode.dll" "$APP/{tisk}/ENP1.PDF" "$T/{tisk}/"

case "$MODE" in
  ns)
    exec unshare --mount --propagation private -- "$0" --inner ;;
  --no-hide)
    tests ;;
  --rename)
    [[ $(id -u) == 0 ]] || { echo "--rename needs root" >&2; exit 1; }
    moved=()
    restore() {
      local i
      for (( i=${#moved[@]}-1; i>=0; i-- )); do mv -f "${moved[$i]}.hidden-by-verify" "${moved[$i]}" && echo "restored ${moved[$i]}"; done
    }
    trap restore EXIT INT TERM HUP
    while IFS= read -r f; do
      [[ -e $f || -L $f ]] || continue
      mv "$f" "$f.hidden-by-verify"; moved+=("$f")
    done < <(printf '%s\n' "${HIDE_DIRS[@]}"; hide_files)
    tests ;;
  *) echo "unknown option $MODE" >&2; exit 2 ;;
esac
