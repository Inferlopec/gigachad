import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadIdentity } from '@gryt/bot';

test('SDK identity survives reload with a private key file', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-identity-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'identity.json');
  const first = await loadIdentity(path);
  const second = await loadIdentity(path);
  assert.equal(first.subject, second.subject);
  assert.match(first.subject, /^BOT_/);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
