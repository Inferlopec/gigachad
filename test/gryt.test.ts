import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createGrytIntegration } from '../src/gryt.ts';
import { config, FakeBot, identity, joined, message } from './support/fixtures.ts';

async function fixture(t: test.TestContext, bot = new FakeBot()) {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-gryt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const logs: string[] = [];
  const messages: unknown[] = [];
  const c = config({ GRYT_IDENTITY_PATH: join(dir, 'identity.json'), GRYT_BOT_TOKEN: 'secret-token' });
  const adapter = createGrytIntegration(c, {
    createBot: bot.create, loadIdentity: async () => identity,
    onMessage: (m) => messages.push(m), log: (m) => logs.push(m), logError: (m) => logs.push(m),
  });
  t.after(() => adapter.stop());
  return { adapter, bot, c, logs, messages };
}

test('Gryt adapter preserves SDK options, fails closed on malformed claims and uses current permissions', async (t) => {
  const { adapter, bot, c, logs, messages } = await fixture(t);
  const starting = adapter.start();
  assert.equal(adapter.start(), starting);
  await bot.started;
  assert.equal(bot.options?.host, c.host);
  assert.equal(bot.options?.nickname, c.nickname);
  assert.equal(bot.options?.identity, identity);
  assert.equal(bot.options?.botToken, 'secret-token');
  assert.deepEqual(bot.options?.wants, ['read_messages', 'send_messages']);
  assert.equal(bot.options?.prefix, '');
  assert.equal(bot.options?.helpCommand, false);
  bot.connect();
  await starting;
  assert.equal(adapter.selfId(), 'bot-1');
  await adapter.send('allowed', 'answer');
  assert.deepEqual(bot.sent, ['answer']);
  bot.emit('message', message());
  assert.equal(messages.length, 1);
  for (const payload of [null, {}, { accessToken: 123 }, { accessToken: 'secret-bad-token' },
    joined(null), joined({}), joined({ serverUserId: 1 }), joined({ serverUserId: '  ' })]) {
    bot.socket?.emit('server:joined', payload);
    assert.equal(adapter.selfId(), null);
    assert.equal(adapter.available(), false);
  }
  bot.socket?.emit('server:joined', joined());
  bot.permissions = ['read_messages'];
  assert.equal(adapter.available(), false);
  await assert.rejects(adapter.send('allowed', 'blocked'), /unavailable/);
  bot.permissions.push('send_messages');
  assert.equal(adapter.available(), true);
  bot.emit('waiting', 'secret approval reason');
  bot.emit('error', new Error('secret SDK response'));
  assert.doesNotMatch(logs.join('\n'), /secret/);
});

test('disconnect clears self-ID, rejoin works without a second ready, stop removes only owned listeners', async (t) => {
  const { adapter, bot } = await fixture(t);
  const observer = () => {};
  bot.on('message', observer);
  bot.socket?.on('server:joined', observer);
  const starting = adapter.start();
  await bot.started;
  bot.connect();
  await starting;
  bot.emit('disconnected', 'secret reason');
  assert.equal(adapter.selfId(), null);
  assert.equal(adapter.available(), false);
  bot.socket?.emit('server:joined', joined({ serverUserId: 'bot-2' }));
  assert.equal(adapter.selfId(), 'bot-2');
  assert.equal(adapter.available(), true);
  await Promise.all([adapter.stop(), adapter.stop()]);
  assert.equal(bot.stopCount, 1);
  assert.equal(adapter.available(), false);
  assert.equal(adapter.selfId(), null);
  assert.deepEqual(bot.listeners('message'), [observer]);
  assert.deepEqual(bot.socket?.listeners('server:joined'), [observer]);
  for (const event of ['error', 'waiting', 'ready', 'disconnected']) assert.equal(bot.listenerCount(event), 0);
  bot.socket?.emit('server:joined', joined());
  assert.equal(adapter.selfId(), null);
});

test('stop settles startup while waiting for approval and observes a later SDK rejection', { timeout: 2000 }, async (t) => {
  const { adapter, bot } = await fixture(t);
  const starting = adapter.start();
  await bot.started;
  bot.emit('waiting', 'approval required');
  await adapter.stop();
  await starting;
  bot.fail(new Error('late failure'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(bot.stopCount, 1);
});

test('missing socket and failed startup stop the client and clean up listeners', async (t) => {
  for (const missing of [true, false]) {
    const bot = new FakeBot();
    if (missing) bot.socket = null;
    const { adapter } = await fixture(t, bot);
    const rejected = assert.rejects(adapter.start());
    await bot.started;
    if (!missing) bot.fail(new Error('startup failed'));
    await rejected;
    assert.equal(bot.stopCount, 1);
    assert.equal(bot.listenerCount('message'), 0);
    assert.equal(adapter.available(), false);
  }
});

test('stop before start prevents identity loading and client construction', async () => {
  const adapter = createGrytIntegration(config(), {
    loadIdentity: async () => { assert.fail('must not load identity'); },
    createBot: () => { assert.fail('must not construct client'); },
    onMessage: () => {}, log: () => {}, logError: () => {},
  });
  await adapter.stop();
  await adapter.start();
});

test('stop during identity loading settles startup and prevents a late connection', { timeout: 2000 }, async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-loading-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let entered!: () => void;
  const loading = new Promise<void>((resolve) => { entered = resolve; });
  let finish!: (value: typeof identity) => void;
  const adapter = createGrytIntegration(config({ GRYT_IDENTITY_PATH: join(dir, 'identity.json') }), {
    loadIdentity: () => { entered(); return new Promise((resolve) => { finish = resolve; }); },
    createBot: () => { assert.fail('must not connect after stop'); },
    onMessage: () => {}, log: () => {}, logError: () => {},
  });
  const starting = adapter.start();
  await loading;
  await adapter.stop();
  await starting;
  finish(identity);
  await new Promise((resolve) => setImmediate(resolve));
});
