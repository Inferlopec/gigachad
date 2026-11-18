# Deployment assets (M3.1)

M3.1 provides a fresh installer and release package. Publishing images/releases
is M4 work; host lifecycle commands are M3.2 and update/uninstall are M3.3.
The root `compose.yaml` is retained for source development. Installed systems
use `deploy/compose.yaml` from a versioned package.

## Release asset contract

From the source checkout, with Bash, GNU coreutils and tar:

```sh
bash scripts/package-release.sh v0.0.0-m3.1-test /tmp/gigachad-assets
# Equivalent with npm available:
npm run package:release -- v0.0.0-m3.1-test /tmp/gigachad-assets
```

The output is `gigachad-<version>-linux-amd64.tar.gz` and its `.sha256` file.
Existing artifacts are refused. The flat archive contains:

- `install.sh`, `compose.yaml`, and the minimal `gigachad` launcher body;
- `system.md.example` and `settings.yml`, without runtime data;
- `manifest`: version on line one, matching GHCR image reference on line two;
- `SHA256SUMS`: checksums for the preceding six files in that order.

Use an explicit `MAJOR.MINOR.PATCH` version, optionally prefixed by `v` and/or
followed by a prerelease suffix. The GitHub tag, package version and GHCR image
tag must match exactly. There is no implicit `latest`, provider-specific image
or host-side application build. M4 must also attach a standalone `install.sh`
to each release to support the bootstrap command in the README.

Online installation downloads only from the selected GitHub Release over HTTPS,
verifies the archive checksum and internal asset checksums, verifies the
manifest, pulls the matching linux/amd64 image and validates its platform and
non-root user. Checksums detect corruption; they are not independent signatures.
The bootstrap script itself must come from a trusted release.

## Local validation before publication

Build on a development machine, not the installation host:

```sh
version=v0.0.0-m3.1-test
docker build --platform linux/amd64 \
  -t "ghcr.io/inferlopec/gigachad:$version" .
bash scripts/package-release.sh "$version" /tmp/gigachad-assets
docker save "ghcr.io/inferlopec/gigachad:$version" \
  -o /tmp/gigachad-image.tar
```

Transfer the image archive, package archive and installer to a clean supported
host with Docker Engine and Compose v2. No source checkout, Git, npm or Node.js
is required there:

```sh
docker load -i gigachad-image.tar
sudo bash install.sh --version v0.0.0-m3.1-test \
  --bundle gigachad-v0.0.0-m3.1-test-linux-amd64.tar.gz --offline
gigachad --version
```

`--bundle` bypasses the release download. Without `--offline` it still pulls the
selected image; with `--offline` that exact image must already exist locally.
Local bundles are explicit trusted inputs and must pass their internal checksums.
No image or release needs to be published for this check.

An opt-in smoke harness is also available on a development host with local
Docker socket access:

```sh
bash scripts/check-deployment-image.sh v0.0.0-m3.1-test \
  /tmp/gigachad-assets/gigachad-v0.0.0-m3.1-test-linux-amd64.tar.gz
```

It builds a disposable Alpine Docker CLI host with Compose v2.39.2, removes
Git, verifies that Node.js/npm/Git are absent, installs the local package, and
checks compiled actions, non-root storage, fresh-container reuse and PTY
cancellation. Only this test-host container receives the Docker socket; the
application containers run with networking disabled and no socket. Test
containers, volume and harness image are removed on exit. This is additional
smoke evidence, not a clean-VM test.

## Installation layout and permissions

Defaults are `/opt/gigachad` and `/usr/local/bin/gigachad`. Options
`--install-dir ABSOLUTE_PATH` and `--bin-dir ABSOLUTE_PATH` support alternative
destinations. The bin directory must be outside the installation directory;
the installation directory must not equal the launcher path. Newly created
parents use `0755`; existing directory permissions are preserved.
Run as root; the installer does not invoke sudo or install prerequisites.
Supported prerequisites are Linux x86_64, Bash, GNU coreutils, tar, Docker Engine
with reachable daemon and Compose **v2**. Online mode additionally needs curl.
Compose v1 and other major versions are rejected explicitly.

| Path inside installation | Purpose |
| --- | --- |
| `compose.yaml` | Prebuilt deployment, no source build |
| `manifest`, `release.env` | Selected version/image, no user secrets |
| `data/.env` | Shared runtime/setup configuration, initially only storage paths and disabled search |
| `data/identity/` | Persistent identity and adjacent ownership lock |
| `data/prompts/` | Initial generic prompt and private saved prompt versions |
| `searxng-settings/settings.yml` | Existing managed search settings with a fresh random server key |

The data directories are `0700`, dotenv and prompt files are `0600`, owned by
UID/GID `1000:1000` (`node` in the pinned application image). The installation
and launcher are root-owned. Host root or UID 1000 can access private data; this
is filesystem protection, not encryption. Search settings remain readable by
the existing SearXNG image. Search is disabled by default and uses its existing
Compose profile and fixed internal address.

Runtime and CLI share the writable directory mount `/data` and working directory
`/data`. Runtime loads `/data/.env` using Node's env-file reader at each start;
Compose does not interpolate credentials or inject an older dotenv snapshot
into the wizard. The CLI reads the same file through its existing store and
retains atomic save, prompt versioning, cancellation and identity ownership.
Do not export application settings into the container separately.

The installer stages on the destination filesystem, validates Compose, then
moves the prepared installation and creates the launcher without overwriting
existing paths. Signals and pre-commit failures clean staging and release the
installer lock. After the installation directory has moved, a failure to create
the launcher leaves that directory intact and reports it for inspection. A hard
crash can leave staging or `<install-dir>.install.lock`; stop all installers and
inspect these before removing them. Never remove an existing data directory to
retry installation. Application identity locks have separate recovery rules.

## Manual operations until M3.2

See the [README](../README.md#install-a-prebuilt-version-m31) for setup, config,
start and logs. Stop runtime before registration/configuration; one-shot CLI
containers use `run --rm --no-deps` and the same identity lock. Ctrl+C cancels
the existing wizard and closes its connection. Persisted identity survives.
Installation itself never launches runtime or setup.

`gigachad` currently supports only `--help` and `--version`. Full host operations,
structured diagnostics and host/container command results belong to M3.2.
No new application API or configuration schema is introduced here.

## Acceptance evidence

Run typecheck, standard tests and build, Bash syntax checks, Compose v2 validation
with and without `--profile search`, and Linux amd64 image build/smoke checks.
Installer tests use fake Docker/download commands and temporary destinations;
they cover checksums, version mismatch, unsupported hosts, missing prerequisites,
existing data/launcher, failed pull/configuration and cancellation cleanup.

Clean-VM acceptance must record the OS, architecture, Docker/Compose versions,
selected package/image, absence of host Node.js/Git, installed paths and file
permissions. Verify setup save/cancel and data reuse without connecting CI to
live Gryt/LLM/search. A disposable container is useful additional coverage, but
does not prove the clean-VM criterion. Keep #7 open if that verification or
integration into `next` remains incomplete. Public release/GHCR download is
verified in M4; live E2E begins after M3.1 and final release acceptance is M5.

### Local implementation verification — 2026-11-18

Prepared on `next` above `72ed2ed`, uncommitted and unpushed:

- Node.js 24.22.2: typecheck and build passed; standard `npm test` passed
  **147/147**, with all 16 `test/*.test.ts` files discovered and no skips.
  This includes 27 deployment checks; local mocked HTTP/CLI checks required
  execution outside the filesystem/network sandbox. Strict TypeScript checking
  of the new deployment test also passed.
- `bash -n` for all three scripts and launcher body, plus `git diff --check`,
  passed.
- Linux/amd64 runtime image built locally as
  `ghcr.io/inferlopec/gigachad:v0.0.0-m3.1-test`; no image was pushed.
- The final package was installed by the opt-in smoke harness on a disposable
  Alpine container host with Docker CLI 28.3.3 and Compose **v2.39.2**, using
  the local Docker Desktop Engine 29.9.3. The host had no Node.js/npm/Git.
- Compose validation passed with and without search; default services contained
  only the bot. Installation did not start services. Actual UID/GID and private
  modes were verified; the app image contained only the prompt template.
- With application networking disabled: unconfigured runtime failed before
  identity creation; compiled configuration saved private dotenv/prompt versions,
  cancelled saves preserved prior data/identity, ownership excluded a second
  lease, and a fresh container read the saved runtime configuration.
- The actual CLI refused non-TTY input and opened its menu with a PTY. SIGINT
  exited with code 130 and preserved the saved dotenv. Temporary harness
  containers, volume and image were removed.
- Review fixes reject overlapping installation/launcher paths before writing,
  create all new parents with `0755` while preserving existing/private modes,
  and reject a directory appearing at the launcher destination during staging.
  Regression tests and the rebuilt package/image smoke passed after these fixes.

**Remaining:** a separate clean-VM check has not been run; the disposable
container check does not replace it. Public GitHub Release/GHCR downloads remain
for M4 (online installer behavior was tested with fake downloads). No live
Gryt/LLM/search E2E, release publication or production changes were performed.
Issue #7 remains open pending remaining acceptance and integration into `next`.
