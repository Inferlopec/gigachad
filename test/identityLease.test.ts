import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { acquireIdentityLease, IdentityBusyError } from '../src/identityLease.ts';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-lease-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'identity.json');
}

test('identity ownership excludes an independent process and releases for the next owner', async (t) => {
  const path = await fixture(t);
  const lease = await acquireIdentityLease(path);
  assert.equal((await stat(`${path}.lock`)).mode & 0o777, 0o700);
  const source = `import { acquireIdentityLease } from ${JSON.stringify(new URL('../src/identityLease.ts', import.meta.url).href)};
    try { const lease = await acquireIdentityLease(process.argv[1]); await lease.release(); process.exitCode = 2; }
    catch (error) { if (error.constructor.name !== 'IdentityBusyError') process.exitCode = 3; }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, path], { encoding: 'utf8', timeout: 3000 });
  assert.equal(child.status, 0, child.stderr);
  await lease.release();
  await lease.release();
  const next = await acquireIdentityLease(path);
  await next.release();
});

test('pre-existing lock is never removed or guessed stale, and does not create an identity', async (t) => {
  const path = await fixture(t);
  await mkdir(`${path}.lock`);
  await assert.rejects(acquireIdentityLease(path), IdentityBusyError);
  assert.ok((await stat(`${path}.lock`)).isDirectory());
  await assert.rejects(stat(path), { code: 'ENOENT' });
});
