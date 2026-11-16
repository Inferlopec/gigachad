import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGrytIntegration, type GrytProgress } from '../src/gryt.ts';
import { loadGrytConfig } from '../src/config.ts';
import { registerGryt } from '../src/registration.ts';
import { FakeBot } from './support/fixtures.ts';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-registration-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = loadGrytConfig({ GRYT_HOST: 'https://chat.example.com', GRYT_NICKNAME: 'Assistant',
    GRYT_IDENTITY_PATH: join(dir, 'identity.json'), GRYT_BOT_TOKEN: 'private-token' });
  const bot = new FakeBot();
  bot.channels.push({ id: 'voice', name: 'Voice', type: 'voice' });
  const controller = new AbortController();
  const progress: GrytProgress[] = [];
  const register = () => registerGryt(config, {
    signal: controller.signal, onProgress: (event) => progress.push(event),
    createIntegration: (c, deps) => createGrytIntegration(c, { ...deps, createBot: bot.create }),
  });
  t.after(() => controller.abort());
  return { config, bot, controller, progress, register, dir };
}

test('registration uses real persistent identity, token and text channels without LLM or terminal', async (t) => {
  const f = await fixture(t);
  let original: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const bot = attempt === 0 ? f.bot : new FakeBot();
    const pending = attempt === 0 ? f.register() : registerGryt(f.config, {
      signal: f.controller.signal,
      createIntegration: (c, deps) => createGrytIntegration(c, { ...deps, createBot: bot.create }),
    });
    await bot.started;
    bot.emit('waiting', 'private-token');
    bot.connect();
    const result = await pending;
    assert.equal(result.status, 'ready');
    if (result.status !== 'ready') assert.fail('registration must succeed');
    assert.deepEqual(result.channels, [{ id: 'allowed', name: 'General' }]);
    assert.equal(bot.options?.botToken, 'private-token');
    const stored = await readFile(f.config.identityPath, 'utf8');
    if (attempt === 0) original = stored;
    assert.equal(stored, original);
    assert.equal((await stat(f.config.identityPath)).mode & 0o777, 0o600);
    assert.equal(bot.sent.length, 0);
    await result.close();
    assert.equal(bot.stopCount, 1);
    assert.equal(bot.listenerCount('message'), 0);
    assert.equal(bot.socket?.listenerCount('server:joined'), 0);
  }
  assert.deepEqual(f.progress, ['identity-loaded', 'connecting', 'waiting', 'ready']);
});

test('approval cancellation settles, cleans owned listeners and releases ownership without deleting identity', { timeout: 3000 }, async (t) => {
  const f = await fixture(t);
  const pending = f.register();
  await f.bot.started;
  f.bot.emit('waiting', 'private-server-payload');
  const stored = await readFile(f.config.identityPath, 'utf8');
  f.controller.abort();
  assert.deepEqual(await pending, { status: 'cancelled' });
  assert.equal(await readFile(f.config.identityPath, 'utf8'), stored);
  assert.equal(f.bot.stopCount, 1);
  for (const event of ['message', 'waiting', 'ready', 'error', 'disconnected']) assert.equal(f.bot.listenerCount(event), 0);
  await assert.rejects(stat(`${f.config.identityPath}.lock`), { code: 'ENOENT' });
  f.bot.fail(new Error('private late rejection'));
  await new Promise((resolve) => setImmediate(resolve));
});

test('runtime and setup exclude each other even via symlink, and closed setup allows runtime', async (t) => {
  const f = await fixture(t);
  const pending = f.register();
  await f.bot.started;
  f.bot.connect();
  const registered = await pending;
  assert.equal(registered.status, 'ready');
  if (registered.status !== 'ready') assert.fail();
  const alias = join(f.dir, 'alias.json');
  await symlink(f.config.identityPath, alias);
  const otherBot = new FakeBot();
  const runtime = createGrytIntegration({ ...f.config, identityPath: alias, channelId: 'allowed' }, {
    createBot: otherBot.create, onMessage: () => {}, log: () => {}, logError: () => {},
  });
  await assert.rejects(runtime.start(), /Identity is locked/);
  assert.equal(otherBot.startCount, 0);
  await registered.close();
  const runningBot = new FakeBot();
  const running = createGrytIntegration(f.config, {
    createBot: runningBot.create, onMessage: () => {}, log: () => {}, logError: () => {},
  });
  t.after(() => running.stop());
  const starting = running.start();
  await runningBot.started;
  runningBot.connect();
  await starting;
  const blocked = await registerGryt(f.config, { signal: new AbortController().signal });
  assert.equal(blocked.status, 'failed');
  if (blocked.status === 'failed') assert.equal(blocked.code, 'identity-busy');
  await running.stop();
});

test('registration failures are safe, preserve identity and release lock', async (t) => {
  for (const mode of ['sdk', 'permissions', 'corrupt'] as const) {
    const f = await fixture(t);
    if (mode === 'corrupt') await writeFile(f.config.identityPath, 'private-corrupt-identity');
    const pending = f.register();
    if (mode !== 'corrupt') {
      await f.bot.started;
      if (mode === 'sdk') f.bot.fail(new Error('private-token private SDK response'));
      else { f.bot.permissions = ['read_messages']; f.bot.connect(); }
    }
    const result = await pending;
    assert.equal(result.status, 'failed');
    assert.doesNotMatch(JSON.stringify(result), /private-/);
    await assert.rejects(stat(`${f.config.identityPath}.lock`), { code: 'ENOENT' });
    if (mode === 'corrupt') assert.equal(await readFile(f.config.identityPath, 'utf8'), 'private-corrupt-identity');
  }
});

test('already cancelled or invalid registration never constructs a client', async () => {
  const input = { host: 'https://secret@bad.example', nickname: 'Assistant', identityPath: './unused' };
  const result = await registerGryt(input, { signal: new AbortController().signal,
    createIntegration: () => { assert.fail('invalid input must not connect'); } });
  assert.equal(result.status, 'failed');
  assert.doesNotMatch(JSON.stringify(result), /secret/);
  assert.deepEqual(await registerGryt(input, { signal: AbortSignal.abort() }), { status: 'cancelled' });
});

test('cancelling from identity/connection progress cannot start a late SDK client', async (t) => {
  for (const event of ['identity-loaded', 'connecting'] as const) {
    const f = await fixture(t);
    const result = await registerGryt(f.config, {
      signal: f.controller.signal,
      onProgress: (progress) => { if (progress === event) f.controller.abort(); },
      createIntegration: (c, deps) => createGrytIntegration(c, { ...deps, createBot: f.bot.create }),
    });
    assert.deepEqual(result, { status: 'cancelled' });
    assert.equal(f.bot.startCount, 0);
    assert.ok(await readFile(f.config.identityPath, 'utf8'));
    await assert.rejects(stat(`${f.config.identityPath}.lock`), { code: 'ENOENT' });
  }
});

test('failed SDK shutdown retains ownership and exposes only a safe cleanup error', async (t) => {
  const f = await fixture(t);
  const pending = f.register();
  await f.bot.started;
  f.bot.connect();
  const result = await pending;
  if (result.status !== 'ready') assert.fail('must connect');
  f.bot.stop = async () => { throw new Error('private SDK shutdown detail'); };
  await assert.rejects(result.close(), (error: Error) => {
    assert.match(error.message, /identity lock retained/);
    assert.doesNotMatch(error.message, /private/);
    return true;
  });
  assert.ok((await stat(`${f.config.identityPath}.lock`)).isDirectory());
  assert.ok(await readFile(f.config.identityPath, 'utf8'));
});
