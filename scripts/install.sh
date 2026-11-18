#!/usr/bin/env bash
set -euo pipefail
umask 077
fail() { printf 'gigachad install: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: install.sh --version VERSION [--install-dir /opt/gigachad] [--bin-dir /usr/local/bin] [--bundle ARCHIVE --offline]'
}
version= install_dir=/opt/gigachad bin_dir=/usr/local/bin bundle= offline=false
while [[ $# -gt 0 ]]; do
  case $1 in
    --version|--install-dir|--bin-dir|--bundle)
      [[ $# -ge 2 && -n $2 ]] || fail 'An option needs a value.'
      case $1 in
        --version) version=$2 ;; --install-dir) install_dir=$2 ;;
        --bin-dir) bin_dir=$2 ;; --bundle) bundle=$2 ;;
      esac
      shift 2 ;;
    --offline) offline=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) fail 'Unknown option. Use --help.' ;;
  esac
done
[[ $version =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9]+([.-][A-Za-z0-9]+)*)?$ ]] || fail 'Choose an explicit version with --version (for example v1.0.0-rc.1).'
[[ $install_dir == /* && $install_dir != / && $bin_dir == /* ]] || fail 'Installation and bin paths must be absolute; installation cannot be /.'
[[ $install_dir != *[$'\n\r\t']* && $bin_dir != *[$'\n\r\t']* ]] || fail 'Paths must not contain control characters.'
[[ $offline == false || -n $bundle ]] || fail '--offline requires --bundle ARCHIVE.'
for utility in uname id docker tar sha256sum mktemp mkdir rmdir cp mv ln rm chmod chown dirname realpath cat od tr; do
  command -v "$utility" >/dev/null || fail "Missing prerequisite: $utility. Install it first."
done
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || fail 'Supported platform: Linux amd64 (x86_64) only.'
[[ $(id -u) == 0 ]] || fail 'Run the installer as root; it does not invoke sudo automatically.'
docker info >/dev/null 2>&1 || fail 'Docker daemon is unavailable. Install/start Docker and check access.'
compose_version=$(docker compose version --short 2>/dev/null) || fail 'Docker Compose v2 is required. Install the Compose v2 plugin.'
[[ $compose_version =~ ^v?2\. ]] || fail 'Docker Compose v2 is required.'
if [[ -z $bundle ]]; then
  command -v curl >/dev/null || fail 'Missing prerequisite: curl. Install it first.'
fi
install_dir=$(realpath -m -- "$install_dir")
bin_dir=$(realpath -m -- "$bin_dir")
[[ $install_dir != / && $bin_dir != "$install_dir" && $bin_dir != "$install_dir/"* ]] || fail 'The bin directory must be outside the installation directory.'
[[ $install_dir != "${bin_dir%/}/gigachad" ]] || fail 'Installation directory must not be the launcher path.'
[[ ! -e $install_dir && ! -L $install_dir ]] || fail 'Installation directory already exists; update/recovery is not supported by this installer.'
[[ ! -e $bin_dir/gigachad && ! -L $bin_dir/gigachad ]] || fail 'A launcher already exists; it will not be overwritten.'
scratch= stage= launcher= lock=
cleanup() {
  [[ -z $launcher ]] || rm -f -- "$launcher"
  [[ -z $stage ]] || rm -rf -- "$stage"
  [[ -z $scratch ]] || rm -rf -- "$scratch"
  [[ -z $lock ]] || rmdir -- "$lock"
  return 0
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
scratch=$(mktemp -d)
archive="gigachad-$version-linux-amd64.tar.gz"
if [[ -z $bundle ]]; then
  base="https://github.com/Inferlopec/gigachad/releases/download/$version"
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$base/$archive" -o "$scratch/$archive" || fail 'Could not download the selected release package.'
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' "$base/$archive.sha256" -o "$scratch/archive.sha256" || fail 'Could not download the package checksum.'
  # Never let checksum files select paths outside the staging directory.
  IFS=' ' read -r digest checksum_name < "$scratch/archive.sha256" || fail 'Invalid package checksum.'
  [[ $digest =~ ^[a-f0-9]{64}$ && $checksum_name == "$archive" ]] || fail 'Invalid package checksum.'
  printf '%s  %s\n' "$digest" "$scratch/$archive" | sha256sum --check --status || fail 'Package checksum mismatch.'
  bundle="$scratch/$archive"
fi
[[ -f $bundle ]] || fail 'Local package archive does not exist.'
mkdir -- "$scratch/assets"
files=(install.sh compose.yaml gigachad system.md.example settings.yml manifest SHA256SUMS)
# Extract only known file contents. Archive paths, symlinks and permissions never
# control writes to the host, even if a package is malformed.
for file in "${files[@]}"; do
  tar -xzOf "$bundle" -- "$file" > "$scratch/assets/$file" 2>/dev/null || fail 'Invalid or incomplete package archive.'
done
checked=0
while IFS=' ' read -r digest file; do
  [[ $digest =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid asset checksum.'
  [[ $file == "${files[$checked]:-}" && $checked -lt 6 ]] || fail 'Unexpected asset checksum entry.'
  printf '%s  %s\n' "$digest" "$scratch/assets/$file" | sha256sum --check --status || fail 'Asset checksum mismatch.'
  checked=$((checked + 1))
done < "$scratch/assets/SHA256SUMS"
[[ $checked == 6 ]] || fail 'Incomplete asset checksums.'
image="ghcr.io/inferlopec/gigachad:$version"
[[ $(cat -- "$scratch/assets/manifest") == "$version"$'\n'"$image" ]] || fail 'Package version and image do not match the requested version.'
if [[ $offline == false ]]; then
  docker pull --platform linux/amd64 "$image" >/dev/null 2>&1 || fail 'Could not pull the selected runtime image.'
fi
image_platform=$(docker image inspect --format '{{.Os}}/{{.Architecture}}' "$image" 2>/dev/null) || fail 'Selected image is missing. For offline installation, load it with docker load first.'
[[ $image_platform == linux/amd64 ]] || fail 'Selected image must be linux/amd64.'
image_user=$(docker image inspect --format '{{.Config.User}}' "$image" 2>/dev/null) || fail 'Could not inspect the selected image.'
[[ $image_user == node ]] || fail 'Selected image must use the non-root node user (UID/GID 1000).'
parent=$(dirname -- "$install_dir")
# mkdir -m affects only the leaf. Use a public umask for every new parent,
# without changing existing directories or the private data umask below.
(umask 022; mkdir -p -m 0755 -- "$parent" "$bin_dir")
mkdir -- "$install_dir.install.lock" 2>/dev/null || fail 'Another installation is active, or an installation lock remains.'
lock="$install_dir.install.lock"
[[ ! -e $install_dir && ! -L $install_dir && ! -e $bin_dir/gigachad && ! -L $bin_dir/gigachad ]] || fail 'Installation destination is occupied.'
stage=$(mktemp -d "$parent/.gigachad-install.XXXXXX")
chmod 0755 "$stage"
cp -- "$scratch/assets/compose.yaml" "$scratch/assets/manifest" "$stage/"
printf 'GIGACHAD_IMAGE=%s\n' "$image" > "$stage/release.env"
mkdir -- "$stage/data" "$stage/data/identity" "$stage/data/prompts" "$stage/searxng-settings"
printf 'GRYT_IDENTITY_PATH=/data/identity/gryt-bot-identity.json\nSYSTEM_PROMPT_PATH=/data/prompts/system.md\nSEARCH_ENABLED=false\n' > "$stage/data/.env"
cp -- "$scratch/assets/system.md.example" "$stage/data/prompts/system.md"
search_secret=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')
[[ $search_secret =~ ^[a-f0-9]{64}$ ]] || fail 'Could not generate the search service secret.'
search_settings=$(cat -- "$scratch/assets/settings.yml")
[[ $search_settings == *@@SEARXNG_SECRET@@* ]] || fail 'Missing search secret placeholder.'
printf '%s\n' "${search_settings//@@SEARXNG_SECRET@@/$search_secret}" > "$stage/searxng-settings/settings.yml"
chmod 0644 "$stage/compose.yaml" "$stage/manifest" "$stage/release.env" "$stage/searxng-settings/settings.yml"
chmod 0755 "$stage/searxng-settings"
chmod 0700 "$stage/data" "$stage/data/identity" "$stage/data/prompts"
chmod 0600 "$stage/data/.env" "$stage/data/prompts/system.md"
chown -R 1000:1000 "$stage/data"
docker compose --project-directory "$stage" --env-file "$stage/release.env" -f "$stage/compose.yaml" --profile search config --quiet >/dev/null 2>&1 || fail 'Deployment Compose validation failed.'
launcher=$(mktemp "$bin_dir/.gigachad-launcher.XXXXXX")
{
  printf '#!/usr/bin/env bash\nreadonly GIGACHAD_INSTALL_DIR=%q\n' "$install_dir"
  cat -- "$scratch/assets/gigachad"
} > "$launcher"
chmod 0755 "$launcher"
mv -T --no-clobber -- "$stage" "$install_dir"
[[ ! -d $stage ]] || fail 'Installation destination became occupied.'
stage=
# A hard link installs the launcher without ever overwriting another file.
if ! ln -T -- "$launcher" "$bin_dir/gigachad"; then
  fail 'Could not install launcher. Prepared installation was retained; inspect it before retrying.'
fi
printf 'Installed gigachad %s in %s.\n' "$version" "$install_dir"
printf 'No setup or service was started. See the installation guide for setup and Compose commands.\n'
