import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { runSetup } from '../src/setup.ts';
import { readSetupStore } from '../src/setupStore.ts';
import { loadConfig, loadGrytConfig } from '../src/config.ts';
import { env } from './support/fixtures.ts';

async function fixture(t: test.TestContext, original?: string) {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-setup-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, '.env');
  if (original !== undefined) await writeFile(path, original, { mode: 0o600 });
  const controller = new AbortController();
  const logs: string[] = [];
  let closes = 0;
  const input = { host: 'https://chat.example.com', nickname: 'Assistant', identityPath: join(dir, 'identity.json') };
  const answers = [input.host, input.nickname, input.identityPath, 'private-token', '1', 'yes'];
  let calls = 0;
  const run = () => runSetup({ envPath: path, signal: controller.signal,
    terminal: {
      write: (m) => logs.push(m),
      ask: async (label, _initial, secret) => {
        if (calls === 3) assert.equal(secret, true);
        logs.push(label);
        const answer = answers[calls++];
        assert.notEqual(answer, undefined, 'unexpected question');
        return answer!;
      },
    },
    register: async (received, options) => {
      assert.equal(received.botToken, 'private-token');
      options.onProgress?.('identity-loaded');
      options.onProgress?.('waiting');
      return { status: 'ready', channels: [{ id: 'channel-1', name: 'General' }], close: async () => { closes++; } };
    },
  });
  return { dir, path, controller, logs, input, answers, run, closes: () => closes };
}

test('fresh Gryt-only setup explicitly saves validated fields without LLM or registration token', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.run(), { status: 'saved' });
  const values = parseEnv(await readFile(f.path, 'utf8'));
  assert.deepEqual(values, { GRYT_HOST: f.input.host, GRYT_NICKNAME: f.input.nickname,
    GRYT_IDENTITY_PATH: f.input.identityPath, GRYT_ALLOWED_CHANNEL_ID: 'channel-1' });
  assert.equal((await stat(f.path)).mode & 0o777, 0o600);
  assert.equal(f.closes(), 1);
  assert.doesNotMatch(f.logs.join('\n'), /private-token/);
  assert.match(f.logs.join('\n'), /waiting|Waiting/);
});

test('repeat setup preserves unrelated setting values, removes old token and supports manual ID', async (t) => {
  const original = '# custom comment\nLLM_API_KEY="private-api-key"\nLLM_MODEL="a # model"\nGRYT_BOT_TOKEN="old-token"\nCUSTOM="line1\nline2"\n';
  const f = await fixture(t, original);
  f.answers.splice(4, 2, '0', 'manual-channel', 'yes');
  assert.deepEqual(await f.run(), { status: 'saved' });
  const saved = parseEnv(await readFile(f.path, 'utf8'));
  assert.equal(saved.LLM_API_KEY, 'private-api-key');
  assert.equal(saved.LLM_MODEL, 'a # model');
  assert.equal(saved.CUSTOM, 'line1\nline2');
  assert.equal(saved.GRYT_ALLOWED_CHANNEL_ID, 'manual-channel');
  assert.equal(saved.GRYT_BOT_TOKEN, undefined);
  assert.doesNotMatch(f.logs.join('\n'), /private-api-key|old-token/);
});

test('declining save and invalid input leave existing configuration byte-for-byte unchanged', async (t) => {
  for (const invalid of [false, true]) {
    const original = '# keep formatting\nLLM_API_KEY=private-key\n';
    const f = await fixture(t, original);
    if (invalid) f.answers[0] = 'https://user:private-password@chat.example.com';
    else f.answers[5] = 'no';
    assert.deepEqual(await f.run(), { status: invalid ? 'failed' : 'cancelled' });
    assert.equal(await readFile(f.path, 'utf8'), original);
    assert.match(f.logs.join('\n'), /identity.*retained|identity.*kept/);
    assert.doesNotMatch(f.logs.join('\n'), /private-key|private-password/);
    assert.equal(f.closes(), invalid ? 0 : 1);
  }
});

test('cancelled fresh setup creates no configuration file', async (t) => {
  const f = await fixture(t);
  f.answers[5] = 'n';
  assert.deepEqual(await f.run(), { status: 'cancelled' });
  await assert.rejects(stat(f.path), { code: 'ENOENT' });
});

test('abort during channel selection closes the registration session and preserves settings', async (t) => {
  const f = await fixture(t, 'LLM_API_KEY=private-key\n');
  let calls = 0;
  let closed = false;
  const logs: string[] = [];
  const result = await runSetup({ envPath: f.path, signal: f.controller.signal,
    terminal: { write: (m) => logs.push(m), ask: async () => {
      if (++calls === 5) { f.controller.abort(); throw new Error('private abort'); }
      return f.answers[calls - 1]!;
    } },
    register: async () => ({ status: 'ready', channels: [], close: async () => { closed = true; } }),
  });
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(closed, true);
  assert.equal(await readFile(f.path, 'utf8'), 'LLM_API_KEY=private-key\n');
  assert.doesNotMatch(logs.join('\n'), /private/);
  assert.match(logs.join('\n'), /identity.*retained/);
});

test('manual fallback works with an empty channel list and invalid menu choice retries', async (t) => {
  const f = await fixture(t);
  f.answers.splice(4, 2, '99', '0', 'manual', 'yes');
  let calls = 0;
  const result = await runSetup({ envPath: f.path, signal: f.controller.signal,
    terminal: { write: (m) => f.logs.push(m), ask: async () => f.answers[calls++]! },
    register: async () => ({ status: 'ready', channels: [], close: async () => {} }),
  });
  assert.deepEqual(result, { status: 'saved' });
  assert.equal(parseEnv(await readFile(f.path, 'utf8')).GRYT_ALLOWED_CHANNEL_ID, 'manual');
  assert.match(f.logs.join('\n'), /Select a listed number/);
});

test('store refuses concurrent edits and preserves them; safe quotes round-trip through runtime validation', async (t) => {
  const f = await fixture(t, 'LLM_MODEL=old\n');
  const store = await readSetupStore(f.path);
  await writeFile(f.path, 'LLM_MODEL=concurrent-edit\n');
  await assert.rejects(store.save(f.input, 'one'), /changed during setup/);
  assert.equal(await readFile(f.path, 'utf8'), 'LLM_MODEL=concurrent-edit\n');
  assert.deepEqual(await readdir(f.dir), ['.env']);
  const fullEnv = Object.entries(env).map(([key, value]) => `${key}=${value}`).join('\n');
  await writeFile(f.path, fullEnv);
  const fresh = await readSetupStore(f.path);
  await fresh.save({ ...f.input, nickname: 'Bot "quoted" # name' }, 'one');
  const loaded = loadConfig(parseEnv(await readFile(f.path, 'utf8')));
  assert.equal(loaded.nickname, 'Bot "quoted" # name');
  assert.equal(loaded.channelId, 'one');
});

test('shared Gryt validation rejects controls and token line injection without disclosing values', () => {
  for (const field of ['GRYT_NICKNAME', 'GRYT_IDENTITY_PATH', 'GRYT_BOT_TOKEN']) {
    assert.throws(() => loadGrytConfig({ GRYT_HOST: 'https://chat.example.com', GRYT_NICKNAME: 'Assistant',
      GRYT_IDENTITY_PATH: './identity', [field]: 'private-value\nINJECT=1' }), (error: Error) => {
      assert.doesNotMatch(error.message, /private-value|INJECT/);
      return true;
    });
  }
});

test('unsafe stored host is never offered as a visible default', async (t) => {
  const f = await fixture(t, 'GRYT_HOST=https://user:private-password@chat.example.com\n');
  const result = await runSetup({ envPath: f.path, signal: f.controller.signal,
    terminal: { write: (m) => f.logs.push(m), ask: async (_label, initial) => {
      assert.equal(initial, undefined);
      f.controller.abort();
      throw new Error('cancelled');
    } },
  });
  assert.deepEqual(result, { status: 'cancelled' });
  assert.doesNotMatch(f.logs.join('\n'), /private-password/);
});
