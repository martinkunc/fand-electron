#!/usr/bin/env bash
# Download Účto (ucto2000.cz) and extract it into vendor/extracted/app.
# The pristine download and extraction are kept as a backup; later runs reuse them.
#
#   scripts/fetch-ucto.sh            reuse cached installer/extraction
#   scripts/fetch-ucto.sh --force    re-download and re-extract
#   scripts/fetch-ucto.sh --wine     extract by running the installer under Wine
#                                    (default is innoextract, which unpacks the Inno Setup
#                                    archive natively and works on any CPU architecture)
#
# The working copy used by the app is created separately: work/ucto (see --install).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
VENDOR="$ROOT/vendor"
DL="$VENDOR/downloads"
EXTRACTED="$VENDOR/extracted"
INSTALLER="${UCTO_INSTALLER:-ucto2026_14.exe}"
BASE_URL="https://www.ucto2000.cz/DOWNLOAD"
DOCS=(dek2026.zip navod-na-instalaci-ucto-2026.htm uzivatelska-prirucka.pdf poh16_popis_txt.pdf opravy.htm)

FORCE=0 USE_WINE=0 INSTALL_TO=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --force) FORCE=1 ;;
    --wine) USE_WINE=1 ;;
    --install) INSTALL_TO="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 2 ;;
  esac
  shift
done

mkdir -p "$DL"
if [[ $FORCE == 1 || ! -s "$DL/$INSTALLER" ]]; then
  echo "Downloading $INSTALLER ..."
  curl -fL --retry 3 -o "$DL/$INSTALLER.part" "$BASE_URL/$INSTALLER"
  mv "$DL/$INSTALLER.part" "$DL/$INSTALLER"
  for f in "${DOCS[@]}"; do curl -fsSL -o "$DL/$f" "$BASE_URL/$f" || echo "warning: $f not downloaded"; done
fi
sha256sum "$DL/$INSTALLER" > "$DL/$INSTALLER.sha256"

if [[ $FORCE == 1 || ! -d "$EXTRACTED/app" ]]; then
  rm -rf "$EXTRACTED"
  mkdir -p "$EXTRACTED"
  if [[ $USE_WINE == 1 ]]; then
    command -v wine >/dev/null || { echo "wine not installed" >&2; exit 1; }
    export WINEPREFIX="$VENDOR/wineprefix" WINEDEBUG=-all
    # Inno Setup silent install into a Wine drive path.
    wine "$DL/$INSTALLER" /VERYSILENT /SUPPRESSMSGBOXES /NORESTART /NOICONS "/DIR=Z:${EXTRACTED//\//\\}\\app"
  else
    command -v innoextract >/dev/null || { echo "install innoextract (apt install innoextract / brew install innoextract)" >&2; exit 1; }
    innoextract --silent --codepage 1250 -d "$EXTRACTED" "$DL/$INSTALLER"
  fi
  # Brace-named folders ({glob}, {prik}, {dbx1}...) are the literal install layout.
  if [[ -f "$DL/dek2026.zip" ]]; then
    mkdir -p "$VENDOR/docs" && unzip -oq "$DL/dek2026.zip" -d "$VENDOR/docs"
  fi
  echo "Extracted to $EXTRACTED/app"
fi

if [[ -n "$INSTALL_TO" ]]; then
  # Working installation: a writable copy the engine runs against. Never overwrite data.
  if [[ -e "$INSTALL_TO" ]]; then
    echo "$INSTALL_TO exists; not overwriting (remove it to reinstall)" >&2
  else
    mkdir -p "$INSTALL_TO"
    cp -a "$EXTRACTED/app/." "$INSTALL_TO/"
    echo "Installed working copy to $INSTALL_TO"
  fi
fi
