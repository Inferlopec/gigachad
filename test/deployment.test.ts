import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';

const installer = resolve('scripts/install.sh');
const packager = resolve('scripts/package-release.sh');
const version = 'v0.0.0-m3.1-test';
const image = `ghcr.io/inferlopec/gigachad:${version}`;

async function fixture(t: TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-deployment-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const bundleDir = join(dir, 'bundles');
  const packed = spawnSync('bash', [packager, version, bundleDir], { encoding: 'utf8' });
  assert.equal(packed.status, 0, packed.stderr);
  const bundle = join(bundleDir, `gigachad-${version}-linux-amd64.tar.gz`);
  const tools = join(dir, 'tools');
  await mkdir(tools);
  const executable = async (name: string, content: string) => {
    await writeFile(join(tools, name), `#!/bin/bash\nset -eu\n${content}\n`, { mode: 0o755 });
  };
  await executable('id', 'echo 0');
  await executable('uname', 'if [[ $1 == -s ]]; then echo Linux; else echo x86_64; fi');
  await executable('chown', 'exit 0');
  await executable('docker', `
printf '%s\\n' "$*" >> "$DOCKER_CALLS"
case "$*" in
  info) exit 0 ;;
  'compose version --short') echo 2.39.4 ;;
  'image inspect --format {{.Os}}/{{.Architecture}} '*) echo linux/amd64 ;;
  'image inspect --format {{.Config.User}} '*) echo node ;;
  'pull --platform linux/amd64 '*) exit 0 ;;
  'compose --project-directory '*) exit 0 ;;
  *) echo 'Unexpected Docker operation' >&2; exit 1 ;;
esac`);
  const destination = join(dir, 'installation with spaces');
  const binDir = join(dir, 'bin');
  const env: NodeJS.ProcessEnv & { DOCKER_CALLS: string } = { ...process.env, PATH: `${tools}:/usr/bin:/bin`, DOCKER_CALLS: join(dir, 'docker.calls') };
  const args = ['--version', version, '--install-dir', destination, '--bin-dir', binDir];
  const run = (extra = ['--bundle', bundle, '--offline']) => spawnSync('bash', [installer, ...args, ...extra], { env, encoding: 'utf8' });
  return { dir, bundle, destination, binDir, tools, env, args, executable, run };
}

test('release package contains only versioned deployment assets and verifies checksums', async (t) => {
  const f = await fixture(t);
  const names = spawnSync('tar', ['-tzf', f.bundle], { encoding: 'utf8' });
  assert.equal(names.status, 0);
  assert.deepEqual(names.stdout.trim().split('\n').sort(), [
    'SHA256SUMS', 'compose.yaml', 'gigachad', 'install.sh', 'manifest', 'settings.yml', 'system.md.example',
  ].sort());
  const extracted = join(f.dir, 'extracted');
  await mkdir(extracted);
  assert.equal(spawnSync('tar', ['-xzf', f.bundle, '-C', extracted]).status, 0);
  assert.equal(spawnSync('sha256sum', ['--check', '--status', 'SHA256SUMS'], { cwd: extracted }).status, 0);
  assert.equal(await readFile(join(extracted, 'manifest'), 'utf8'), `${version}\n${image}\n`);
  const compose = await readFile(join(extracted, 'compose.yaml'), 'utf8');
  assert.doesNotMatch(compose, /\bbuild:|\bports:|docker\.sock|env_file:/);
  assert.match(compose, /--env-file=\/data\/\.env/);
  assert.match(compose, /profiles: \[search\]/);
  assert.notEqual(spawnSync('bash', [packager, version, join(f.dir, 'bundles')]).status, 0);
  assert.notEqual(spawnSync('bash', [packager, '../bad', join(f.dir, 'bad')]).status, 0);
});

test('offline install seeds private writable data, never starts services, and refuses replacement', async (t) => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /No setup or service was started/);
  const envPath = join(f.destination, 'data/.env');
  assert.equal(await readFile(envPath, 'utf8'), 'GRYT_IDENTITY_PATH=/data/identity/gryt-bot-identity.json\nSYSTEM_PROMPT_PATH=/data/prompts/system.md\nSEARCH_ENABLED=false\n');
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  for (const part of ['data', 'data/prompts', 'data/identity']) {
    assert.equal((await stat(join(f.destination, part))).mode & 0o777, 0o700);
  }
  assert.equal((await stat(join(f.destination, 'data/prompts/system.md'))).mode & 0o777, 0o600);
  const searchSettings = await readFile(join(f.destination, 'searxng-settings/settings.yml'), 'utf8');
  assert.match(searchSettings, /secret_key: "[a-f0-9]{64}"/);
  assert.doesNotMatch(searchSettings, /@@SEARXNG_SECRET@@/);
  const launcher = join(f.binDir, 'gigachad');
  const display = spawnSync('bash', [launcher, '--version'], { encoding: 'utf8' });
  assert.equal(display.status, 0, display.stderr);
  assert.equal(display.stdout, `gigachad ${version}\n`);
  assert.equal(spawnSync('bash', [launcher, '--help']).status, 0);
  assert.equal(spawnSync('bash', [launcher, 'start']).status, 1);
  const calls = await readFile(f.env.DOCKER_CALLS, 'utf8');
  assert.doesNotMatch(calls, /\bpull\b|\bup\b|\brun\b|\bstart\b/);
  assert.match(calls, /--profile search config --quiet/);
  const identity = join(f.destination, 'data/identity/gryt-bot-identity.json');
  await writeFile(identity, 'durable identity');
  assert.equal(f.run().status, 1);
  assert.equal(await readFile(identity, 'utf8'), 'durable identity');
  assert.equal(await readFile(envPath, 'utf8'), 'GRYT_IDENTITY_PATH=/data/identity/gryt-bot-identity.json\nSYSTEM_PROMPT_PATH=/data/prompts/system.md\nSEARCH_ENABLED=false\n');
});

test('installer rejects installation at the normalized launcher path before creating destinations', async (t) => {
  const f = await fixture(t);
  f.args[3] = `${f.binDir}/unused/../gigachad`;
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /must not be the launcher path/);
  await assert.rejects(stat(f.binDir), { code: 'ENOENT' });
  assert.doesNotMatch(await readFile(f.env.DOCKER_CALLS, 'utf8'), /image inspect|config --quiet/);
});

test('installer creates traversable nested parents without changing existing or private directory modes', async (t) => {
  const f = await fixture(t);
  const existing = join(f.dir, 'existing');
  await mkdir(existing, { mode: 0o710 });
  const destination = join(existing, 'apps', 'nested', 'gigachad');
  const binDir = join(existing, 'tools', 'nested', 'bin');
  f.args[3] = destination;
  f.args[5] = binDir;
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal((await stat(existing)).mode & 0o777, 0o710);
  for (const part of ['apps', 'apps/nested', 'tools', 'tools/nested', 'tools/nested/bin']) {
    assert.equal((await stat(join(existing, part))).mode & 0o777, 0o755, part);
  }
  assert.equal((await stat(join(destination, 'data'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(destination, 'data/.env'))).mode & 0o777, 0o600);
  const launcher = join(binDir, 'gigachad');
  assert.equal((await stat(launcher)).isFile(), true);
  const display = spawnSync('bash', [launcher, '--version'], { encoding: 'utf8' });
  assert.equal(display.status, 0, display.stderr);
  assert.equal(display.stdout, `gigachad ${version}\n`);
});

test('installer fails safely when a directory appears at the launcher path during preparation', async (t) => {
  const f = await fixture(t);
  f.env.RACE_BIN = f.binDir;
  const docker = await readFile(join(f.tools, 'docker'), 'utf8');
  await writeFile(join(f.tools, 'docker'), docker.replace(
    "'compose --project-directory '*) exit 0",
    "'compose --project-directory '*) mkdir -p -- \"$RACE_BIN/gigachad\"; exit 0",
  ));
  const result = f.run();
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /Prepared installation was retained/);
  assert.deepEqual(await readdir(join(f.binDir, 'gigachad')), []);
  assert.deepEqual(await readdir(f.binDir), ['gigachad']);
  assert.equal((await stat(join(f.destination, 'data/.env'))).mode & 0o777, 0o600);
  await assert.rejects(stat(`${f.destination}.install.lock`), { code: 'ENOENT' });
});

test('normal installation downloads versioned assets, verifies checksum and pulls matching image', async (t) => {
  const f = await fixture(t);
  await executableCurl(f);
  const result = f.run([]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(f.env.DOCKER_CALLS, 'utf8'), new RegExp(`pull --platform linux/amd64 ghcr.io/inferlopec/gigachad:${version}`));
});

async function executableCurl(f: Awaited<ReturnType<typeof fixture>>, body?: string) {
  f.env['FIXTURE_BUNDLE'] = f.bundle;
  await f.executable('curl', body ?? `
url= output=
while [[ $# -gt 0 ]]; do
  case $1 in
    -o) output=$2; shift 2 ;;
    https:*) url=$1; shift ;;
    *) shift ;;
  esac
done
case "$url" in
  */${version}/gigachad-${version}-linux-amd64.tar.gz) cp "$FIXTURE_BUNDLE" "$output" ;;
  */${version}/gigachad-${version}-linux-amd64.tar.gz.sha256) cp "$FIXTURE_BUNDLE.sha256" "$output" ;;
  *) exit 1 ;;
esac`);
}

test('installer rejects wrong platform, privilege, missing Docker, Compose version, and image platform before writing destinations', async (t) => {
  for (const scenario of ['platform', 'privilege', 'missing-docker', 'daemon', 'compose', 'architecture', 'image-user', 'missing-image']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      if (scenario === 'platform') await f.executable('uname', 'echo Darwin');
      if (scenario === 'privilege') await f.executable('id', 'echo 1000');
      const docker = await readFile(join(f.tools, 'docker'), 'utf8');
      if (scenario === 'missing-docker') {
        await f.executable('bash', 'exec /bin/bash "$@"');
        await rm(join(f.tools, 'docker'));
        f.env.PATH = f.tools;
      }
      const replacements: Record<string, [string, string]> = {
        daemon: ['info) exit 0', 'info) exit 1'],
        compose: ['echo 2.39.4', 'echo 5.7.0'],
        architecture: ['echo linux/amd64', 'echo linux/arm64'],
        'image-user': ['echo node', 'echo root'],
        'missing-image': ['echo linux/amd64', 'exit 1'],
      };
      if (replacements[scenario]) await writeFile(join(f.tools, 'docker'), docker.replace(...replacements[scenario]));
      const result = f.run();
      assert.equal(result.status, 1, result.stderr);
      await assert.rejects(stat(f.destination), { code: 'ENOENT' });
      await assert.rejects(stat(f.binDir), { code: 'ENOENT' });
    });
  }
});

test('installer rejects corrupt assets, mismatched version and existing launcher without overwriting', async (t) => {
  for (const scenario of ['corrupt', 'version', 'launcher', 'incomplete', 'checksum-path']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      if (scenario === 'launcher') {
        await mkdir(f.binDir);
        await writeFile(join(f.binDir, 'gigachad'), 'existing launcher');
      } else {
        const unpacked = join(f.dir, 'unpacked');
        await mkdir(unpacked);
        assert.equal(spawnSync('tar', ['-xzf', f.bundle, '-C', unpacked]).status, 0);
        if (scenario === 'corrupt') await writeFile(join(unpacked, 'compose.yaml'), 'corrupted');
        if (scenario === 'version') f.args[1] = 'v0.0.1';
        if (scenario === 'incomplete') await rm(join(unpacked, 'manifest'));
        if (scenario === 'checksum-path') await writeFile(join(unpacked, 'SHA256SUMS'), `${'a'.repeat(64)}  ../../outside\n`);
        const names = await readdir(unpacked);
        assert.equal(spawnSync('tar', ['-czf', f.bundle, '-C', unpacked, ...names]).status, 0);
      }
      const result = f.run();
      assert.equal(result.status, 1, result.stderr);
      await assert.rejects(stat(f.destination), { code: 'ENOENT' });
      if (scenario === 'launcher') assert.equal(await readFile(join(f.binDir, 'gigachad'), 'utf8'), 'existing launcher');
    });
  }
});

test('download, checksum, pull, Compose failure and cancellation clean prepared files', async (t) => {
  for (const scenario of ['download', 'checksum', 'pull', 'compose', 'cancel']) {
    await t.test(scenario, async (t) => {
      const f = await fixture(t);
      await executableCurl(f, scenario === 'download' ? 'exit 22' : undefined);
      if (scenario === 'checksum') await writeFile(`${f.bundle}.sha256`, `${'a'.repeat(64)}  ${f.bundle.split('/').at(-1)}\n`);
      const docker = await readFile(join(f.tools, 'docker'), 'utf8');
      if (scenario === 'pull') await writeFile(join(f.tools, 'docker'), docker.replace("'pull --platform linux/amd64 '*) exit 0", "'pull --platform linux/amd64 '*) exit 1"));
      if (scenario === 'compose' || scenario === 'cancel') {
        await writeFile(join(f.tools, 'docker'), docker.replace("'compose --project-directory '*) exit 0", `'compose --project-directory '*) ${scenario === 'cancel' ? 'kill -TERM "$PPID"; exit 0' : 'exit 1'}`));
      }
      // Use an isolated TMPDIR to verify staging cleanup as well as destinations.
      const scratch = join(f.dir, 'scratch');
      await mkdir(scratch);
      f.env['TMPDIR'] = scratch;
      const result = f.run([]);
      assert.equal(result.status, scenario === 'cancel' ? 143 : 1, result.stderr);
      await assert.rejects(stat(f.destination), { code: 'ENOENT' });
      assert.deepEqual(await readdir(scratch), []);
      assert.equal((await readdir(f.dir)).some((name) => name.startsWith('.gigachad-install.') || name.endsWith('.install.lock')), false);
      if (await stat(f.binDir).catch(() => null)) assert.deepEqual(await readdir(f.binDir), []);
    });
  }
});
