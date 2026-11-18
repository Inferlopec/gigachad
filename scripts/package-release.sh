#!/usr/bin/env bash
set -euo pipefail
umask 022
fail() { printf '%s\n' "$*" >&2; exit 1; }
[[ $# -ge 1 && $# -le 2 ]] || fail 'Usage: package-release.sh VERSION [OUTPUT_DIRECTORY]'
version=$1
[[ $version =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9]+([.-][A-Za-z0-9]+)*)?$ ]] || fail 'Use an explicit version, for example v1.0.0-rc.1.'
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
mkdir -p -- "${2:-$root/dist-release}"
output=$(cd -- "${2:-$root/dist-release}" && pwd)
archive="gigachad-$version-linux-amd64.tar.gz"
[[ ! -e $output/$archive && ! -e $output/$archive.sha256 ]] || fail 'Release package already exists; choose an empty output directory.'
stage=$(mktemp -d "$output/.gigachad-package.XXXXXX")
trap 'rm -rf -- "$stage"' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
cp -- "$root/scripts/install.sh" "$stage/install.sh"
cp -- "$root/deploy/compose.yaml" "$stage/compose.yaml"
cp -- "$root/deploy/gigachad" "$stage/gigachad"
cp -- "$root/prompts/system.md.example" "$stage/system.md.example"
cp -- "$root/deploy/settings.yml" "$stage/settings.yml"
printf '%s\nghcr.io/inferlopec/gigachad:%s\n' "$version" "$version" > "$stage/manifest"
files=(install.sh compose.yaml gigachad system.md.example settings.yml manifest)
chmod 0644 "${files[@]/#/$stage/}"
chmod 0755 "$stage/install.sh"
(cd -- "$stage" && sha256sum "${files[@]}" > SHA256SUMS)
tar -czf "$stage/$archive" -C "$stage" "${files[@]}" SHA256SUMS
# Refuse to overwrite an existing artifact, including when packagers race.
ln -- "$stage/$archive" "$output/$archive"
(cd -- "$output" && sha256sum "$archive" > "$archive.sha256")
printf '%s\n' "$output/$archive"
