#!/usr/bin/env bash
# Opt-in integration check. The test-host container has Docker access; the
# application container never receives the Docker socket.
set -euo pipefail
[[ $# == 2 ]] || { printf 'Usage: check-deployment-image.sh VERSION BUNDLE\n' >&2; exit 1; }
version=$1
[[ $version =~ ^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9]+([.-][A-Za-z0-9]+)*)?$ ]] || exit 1
bundle=$(realpath -- "$2")
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
scratch=$(mktemp -d)
name="gigachad-m31-$(basename -- "$scratch")"
name=${name,,}
cleanup() {
  docker rm -f "$name-cli" >/dev/null 2>&1 || true
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker volume rm "$name" >/dev/null 2>&1 || true
  docker image rm "$name-host" >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'printf "Deployment smoke failed near line %s.\n" "$LINENO" >&2' ERR
trap 'exit 130' INT
trap 'exit 143' TERM
cat > "$scratch/Dockerfile" <<'DOCKERFILE'
FROM docker:28.3.3-cli
RUN apk add --no-cache bash coreutils tar curl && apk del git
ENTRYPOINT []
CMD ["sleep", "infinity"]
DOCKERFILE
docker build -q -t "$name-host" "$scratch" >/dev/null
docker volume create "$name" >/dev/null
docker run -d --name "$name" --network none \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$name:/sandbox" "$name-host" >/dev/null
docker cp "$root/scripts/install.sh" "$name:/tmp/install.sh" >/dev/null
docker cp "$bundle" "$name:/tmp/bundle.tar.gz" >/dev/null
docker exec "$name" bash -ceu '
  ! command -v node
  ! command -v npm
  ! command -v git
  docker compose version
  bash /tmp/install.sh --version "$1" --bundle /tmp/bundle.tar.gz --offline \
    --install-dir /sandbox/gigachad --bin-dir /usr/local/bin
  gigachad --version
  cd /sandbox/gigachad
  docker compose --env-file release.env config --quiet
  test "$(docker compose --env-file release.env config --services)" = gigachad
  docker compose --env-file release.env --profile search config --quiet
  test "$(stat -c %u:%g data)" = 1000:1000
  test "$(stat -c %a data/.env)" = 600
  test "$(stat -c %a data/prompts)" = 700
  test "$(stat -c %a data/prompts/system.md)" = 600
' bash "$version"
image="ghcr.io/inferlopec/gigachad:$version"
mount="type=volume,src=$name,dst=/data,volume-subpath=gigachad/data"
if docker run --rm --network none --mount "$mount" -w /data "$image" \
  node --env-file=/data/.env /app/dist/index.js > "$scratch/runtime.log" 2>&1; then
  printf 'Unconfigured runtime unexpectedly succeeded.\n' >&2; exit 1
fi
grep -q 'Set LLM_BASE_URL' "$scratch/runtime.log"
docker exec "$name" test ! -e /sandbox/gigachad/data/identity/gryt-bot-identity.json
# Exercise the compiled configuration action, persistent SDK identity and real
# ownership lock as the image's non-root user, without any network.
docker run --rm -i --network none --mount "$mount" -w /data "$image" \
  node --input-type=module <<'JAVASCRIPT'
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { loadIdentity } from '/app/node_modules/@gryt/bot/dist/index.js';
import { readConfigSetupStore } from '/app/dist/configSetupStore.js';
import { acquireIdentityLease } from '/app/dist/identityLease.js';
assert.equal(process.getuid(), 1000);
assert.deepEqual(await readdir('/app/prompts'), ['system.md.example']);
const before = await readFile('.env', 'utf8');
const store = await readConfigSetupStore('.env');
assert.ok(store.prompt.length > 0);
const identityPath = '/data/identity/gryt-bot-identity.json';
const identity = await loadIdentity(identityPath);
const identityBytes = await readFile(identityPath);
const draft = { ...store.env, GRYT_HOST: 'https://chat.example.com',
  GRYT_NICKNAME: 'Assistant', GRYT_ALLOWED_CHANNEL_ID: 'channel',
  LLM_BASE_URL: 'https://llm.example.com/v1', LLM_MODEL: 'test-model',
  LLM_API_KEY: 'synthetic-smoke-key', LLM_CONTEXT_TOKENS: '8192', LLM_MAX_TOKENS: '1024' };
const controller = new AbortController();
controller.abort();
await assert.rejects(store.save(draft, 'Cancelled prompt', controller.signal));
assert.equal(await readFile('.env', 'utf8'), before);
assert.deepEqual(await readFile(identityPath), identityBytes);
const saved = await store.save(draft, 'A saved smoke prompt');
assert.match(saved.promptPath, /^\/data\/prompts\/system\..+\.md$/);
assert.equal(await readFile(saved.promptPath, 'utf8'), 'A saved smoke prompt');
assert.equal((await stat('.env')).mode & 0o777, 0o600);
assert.equal((await stat(saved.promptPath)).mode & 0o777, 0o600);
const lease = await acquireIdentityLease(identityPath);
await assert.rejects(acquireIdentityLease(identityPath));
await lease.release();
assert.equal((await loadIdentity(identityPath)).subject, identity.subject);
assert.deepEqual(await readFile(identityPath), identityBytes);
console.log('Compiled image: private save/cancel, prompt versions, persistent identity and ownership PASS.');
JAVASCRIPT
# A new container must read the committed dotenv and reuse the same data.
docker run --rm --network none --mount "$mount" -w /data "$image" \
  node --env-file=/data/.env --input-type=module -e '
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { loadConfig } from "/app/dist/config.js";
    const config = loadConfig();
    assert.equal(config.searchEnabled, false);
    assert.equal(await readFile(config.promptPath, "utf8"), "A saved smoke prompt");
    assert.ok((await readFile(config.identityPath, "utf8")).length > 0);
    console.log("Fresh container: persisted runtime configuration PASS.");
  '
# The real CLI must reject non-TTY input without changing the saved settings.
docker exec "$name" sha256sum /sandbox/gigachad/data/.env > "$scratch/before"
if docker run --rm --network none --mount "$mount" -w /data "$image" \
  node /app/dist/cli.js config --env-file /data/.env > "$scratch/cli.log" 2>&1; then
  printf 'Non-TTY CLI unexpectedly succeeded.\n' >&2; exit 1
fi
grep -q 'interactive terminal' "$scratch/cli.log"
docker exec "$name" sha256sum /sandbox/gigachad/data/.env > "$scratch/after"
cmp "$scratch/before" "$scratch/after"
# A real PTY enters the compiled wizard; SIGINT must settle it with cancellation.
docker run -d -i -t --name "$name-cli" --network none --mount "$mount" -w /data "$image" \
  node /app/dist/cli.js config --env-file /data/.env >/dev/null
ready=false
for ((attempt = 0; attempt < 50; attempt++)); do
  if docker logs "$name-cli" 2>&1 | grep -q '1. Gryt and channel'; then ready=true; break; fi
  sleep 0.1
done
[[ $ready == true ]] || { docker logs "$name-cli" >&2; printf 'PTY wizard did not become ready.\n' >&2; exit 1; }
docker kill --signal=SIGINT "$name-cli" >/dev/null
test "$(docker wait "$name-cli")" = 130
docker exec "$name" sha256sum /sandbox/gigachad/data/.env > "$scratch/after"
cmp "$scratch/before" "$scratch/after"
printf 'Deployment installation/image smoke checks PASS (disposable container host, not a VM).\n'
