import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadIdentity } from '@gryt/bot';
import { createGrytIntegration } from '../src/gryt.ts';
import { config, FakeBot } from './support/fixtures.ts';

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

test('Gryt integration reuses the persisted identity across runtime instances', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-reuse-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'identity.json');
  let subject: string | undefined;
  let stored: string | undefined;
  for (let run = 0; run < 2; run++) {
    const bot = new FakeBot();
    const adapter = createGrytIntegration(config({ GRYT_IDENTITY_PATH: path }), {
      createBot: bot.create, onMessage: () => {}, log: () => {}, logError: () => {},
    });
    t.after(() => adapter.stop());
    const starting = adapter.start(); await bot.started; bot.connect(); await starting;
    if (run === 0) { subject = bot.options?.identity?.subject; stored = await readFile(path, 'utf8'); }
    assert.equal(bot.options?.identity?.subject, subject);
    assert.equal(await readFile(path, 'utf8'), stored);
    await adapter.stop();
  }
});

test('corrupt existing identities are rejected without replacement or a Gryt connection', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'identity.json');
  for (const stored of ['not JSON', '{"v":2}', '{"v":1,"privateJwk":{"kty":"invalid"}}']) {
    await writeFile(path, stored, { mode: 0o600 });
    const adapter = createGrytIntegration(config({ GRYT_IDENTITY_PATH: path }), {
      createBot: () => { assert.fail('must not connect with corrupt identity'); },
      onMessage: () => {}, log: () => {}, logError: () => {},
    });
    await assert.rejects(adapter.start());
    assert.equal(await readFile(path, 'utf8'), stored);
  }
});
