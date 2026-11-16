import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

const cli = resolve('src/cli.ts');

test('CLI refuses unknown commands without reading configuration or printing supplied values', () => {
  const result = spawnSync(process.execPath, [cli, 'private-unknown-command'], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-unknown-command/);
});

test('CLI requires TTY before reading secrets or creating data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-cli-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, '.env'), 'GRYT_BOT_TOKEN=private-token\n');
  const result = spawnSync(process.execPath, [cli, 'setup'], { cwd: dir, encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /interactive terminal/);
  assert.doesNotMatch(result.stdout + result.stderr, /private-token/);
  assert.deepEqual(await readdir(dir), ['.env']);
});
