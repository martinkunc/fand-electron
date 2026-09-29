#!/usr/bin/env bash
# Builds the Rebex substitute assemblies for Mono, once per Rebex version shipped with Účto:
#   bin/6.0.8000.0/  for {AP02} (Ares2, Nepl2, UctoDS, UctoDS2)
#   bin/5.0.7320.0/  for {AP03} (UctoZP2) and {TISK} (UctoApep, ELDOTAZ, ELPODPI2, ENESCHOP, UctoMD)
# Each set has the original identity (name, version, public key token 1c4638788972655d) and
# is delay-signed with rebex-public.snk (public key only; Mono does not verify signatures).
# Requires Mono's mcs. Usage: ./build.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
cd "$HERE"
MCS="${MCS:-mcs}"

# The public key blob is committed; it can be re-extracted from any original Rebex dll.
if [[ ! -s rebex-public.snk ]]; then
  ORIG="$ROOT/vendor/extracted/app/{ap02}/Rebex.Common.dll"
  sn -q -e "$ORIG" rebex-public.snk
fi

PUBKEY="$(od -An -tx1 -v rebex-public.snk | tr -d ' \n')"

build_version() {
  local ver="$1" define="$2" out="$HERE/bin/$1" obj="$HERE/bin/obj/$1"
  mkdir -p "$out" "$obj"
  for name in Common Networking Http; do
    cat > "$obj/AssemblyInfo.$name.cs" <<CS
using System.Reflection;
[assembly: AssemblyTitle("Rebex.$name")]
[assembly: AssemblyDescription("Účto Mono substitute for Rebex.$name $ver (API subset used by the Účto helpers, over Mono's System.Net/System.Security)")]
[assembly: AssemblyProduct("Účto for Electron - Mono helper shims")]
[assembly: AssemblyVersion("$ver")]
[assembly: AssemblyFileVersion("$ver")]
[assembly: System.CLSCompliant(true)]
[assembly: System.Runtime.InteropServices.ComVisible(false)]
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Rebex.Networking, PublicKey=$PUBKEY")]
[assembly: System.Runtime.CompilerServices.InternalsVisibleTo("Rebex.Http, PublicKey=$PUBKEY")]
CS
  done
  local common=(-target:library -sdk:4.7.2 -optimize+ -debug- -nowarn:1591,618,649,1699 -keyfile:"$HERE/rebex-public.snk" -delaysign+ ${define:+-define:$define})
  "$MCS" "${common[@]}" -out:"$out/Rebex.Common.dll" -r:System.dll -r:System.Core.dll -r:System.Security.dll \
    "$obj/AssemblyInfo.Common.cs" Common.cs Certificates.cs Pkcs.cs
  "$MCS" "${common[@]}" -out:"$out/Rebex.Networking.dll" -r:System.dll -r:"$out/Rebex.Common.dll" \
    "$obj/AssemblyInfo.Networking.cs" Networking.cs
  "$MCS" "${common[@]}" -out:"$out/Rebex.Http.dll" -r:System.dll -r:System.Core.dll -r:"$out/Rebex.Common.dll" -r:"$out/Rebex.Networking.dll" \
    "$obj/AssemblyInfo.Http.cs" Http.cs WebClient.cs
  echo "built $out"
}

build_version 6.0.8000.0 REBEX6
build_version 5.0.7320.0 REBEX5
rm -rf "$HERE/bin/obj"
