# Shared by build-linux.sh and build-macos.sh (sourced, not executed; bash 3.2 compatible).

# copy_managed <target lib/mono> <assemblies.txt> <source lib/mono>...
# Copies the listed framework assemblies, each from the first source that has it.
# Mono loads mscorlib from lib/mono/4.5 but every other strong-named framework assembly
# only from the GAC (lib/mono/gac/<name>/<version>__<token>/), so entries that are GAC
# symlinks in the distribution are copied into the GAC (with their .dll.config dllmaps);
# real files (mscorlib, cert-sync.exe, Facades) stay in 4.5. Only real files are
# written, no symlinks.
copy_managed() {
  local dst="$1" list="$2" a src s link dir
  shift 2
  mkdir -p "$dst/4.5"
  while IFS= read -r a; do
    [[ -z "$a" || "$a" == \#* ]] && continue
    src=""
    for s in "$@"; do if [[ -e "$s/4.5/$a" ]]; then src="$s"; break; fi; done
    [[ -n "$src" ]] || { echo "copy_managed: $a not found in: $*" >&2; return 1; }
    link="$(readlink "$src/4.5/$a" || true)"
    if [[ "$link" == *gac/* ]]; then
      dir="gac/${link#*gac/}"; dir="${dir%/*}"
      mkdir -p "$dst/$dir"
      cp "$src/$dir"/*.dll "$dst/$dir/"
      if compgen -G "$src/$dir/*.dll.config" >/dev/null; then cp "$src/$dir"/*.dll.config "$dst/$dir/"; fi
    else
      mkdir -p "$dst/4.5/$(dirname "$a")"
      cp -L "$src/4.5/$a" "$dst/4.5/$a"
    fi
  done < "$list"
}
