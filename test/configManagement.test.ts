import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { runConfigManagement } from '../src/configManagement.ts';
import { readConfigSetupStore } from '../src/configSetupStore.ts';
import { env } from './support/fixtures.ts';

const successCheck = async () => ({ status: 'success' as const });

test('search endpoint defaults never expose credentials, query tokens or fragments', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'gigachad-config-url-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const field of ['SEARCH_LLM_BASE_URL', 'LLM_BASE_URL']) {
    for (const value of ['https://user:private-password@example.com/v1',
      'https://example.com/v1?key=private-token', 'https://example.com/v1#private-token']) {
      const original = `${field}="${value}"\n`;
      await writeFile(join(cwd, '.env'), original);
      const answers = ['3', 'y', 'y'];
      const controller = new AbortController();
      let endpointAsked = false;
      const logs: string[] = [];
      let endpointDefault: string | undefined;
      const result = await runConfigManagement({ command: 'config', envPath: '.env', cwd, signal: controller.signal,
        terminal: { write: (message) => logs.push(message), ask: async (label, initial) => {
          if (label === 'Search LLM API base URL') {
            endpointAsked = true;
            endpointDefault = initial;
            controller.abort();
            throw new DOMException('Cancelled', 'AbortError');
          }
          const answer = answers.shift();
          if (answer === undefined) throw new Error('Unexpected question');
          return answer;
        }, askMultiline: async () => '' },
      });
      assert.equal(endpointAsked, true);
      assert.equal(endpointDefault, undefined);
      assert.deepEqual(result, { status: 'cancelled' });
      assert.doesNotMatch(logs.join('\n'), /private-password|private-token/);
      assert.equal(await readFile(join(cwd, '.env'), 'utf8'), original);
    }
  }
});

test('explicit cancellation after a failed LLM check returns cancelled without an aborted signal', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'gigachad-config-check-cancel-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const original = '# saved configuration\nCUSTOM=keep-me\n';
  await writeFile(join(cwd, '.env'), original);
  const controller = new AbortController();
  const answers = [env.GRYT_HOST, env.GRYT_NICKNAME, join(cwd, 'identity.json'), 'n', 'channel',
    env.LLM_BASE_URL, env.LLM_MODEL, env.LLM_API_KEY, '8192', '1024', '120000', 'y', ''];
  const logs: string[] = [];
  let checks = 0;
  const result = await runConfigManagement({ command: 'setup', envPath: '.env', cwd, signal: controller.signal,
    checkLlm: async () => { checks++; return { status: 'failed', code: 'network', message: 'Network failure' }; },
    terminal: { write: (message) => logs.push(message), ask: async () => {
      const answer = answers.shift();
      if (answer === undefined) throw new Error('Unexpected question');
      return answer;
    }, askMultiline: async () => 'New prompt' },
  });
  assert.equal(checks, 1);
  assert.equal(answers.length, 0);
  assert.equal(controller.signal.aborted, false);
  assert.deepEqual(result, { status: 'cancelled' });
  assert.match(logs.join('\n'), /Cancelled; saved settings and prompt are unchanged/);
  assert.equal(await readFile(join(cwd, '.env'), 'utf8'), original);
  assert.deepEqual(await readdir(cwd), ['.env']);
});

test('saving a fresh draft creates private dotenv and prompt parent directories', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'gigachad-config-directories-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const store = await readConfigSetupStore('settings/nested/config.env', cwd);
  const saved = await store.save(env, 'A test prompt');
  const envPath = join(cwd, 'settings/nested/config.env');
  const values = parseEnv(await readFile(envPath, 'utf8'));
  assert.equal(values.SYSTEM_PROMPT_PATH, saved.promptPath);
  assert.equal(await readFile(join(cwd, saved.promptPath), 'utf8'), 'A test prompt');
  assert.equal((await stat(envPath)).mode & 0o777, 0o600);
  assert.equal((await stat(join(cwd, 'settings'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(cwd, 'settings/nested'))).mode & 0o777, 0o700);
  assert.equal((await stat(join(cwd, saved.promptPath))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(join(cwd, 'settings/nested')), ['config.env']);
});

test('fresh setup stages registration, LLM, prompt and search in one explicit save', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'gigachad-config-fresh-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'prompts'));
  await writeFile(join(cwd, 'prompts', 'system.md.example'), 'Example prompt');
  const answers = [
    'https://chat.example.com', 'Assistant', join(cwd, 'identity.json'), 'y', 'private-registration-token', '1',
    env.LLM_BASE_URL, env.LLM_MODEL, 'private-llm-key', '8192', '1024', '120000', 'y',
    'n', 'y',
  ];
  const logs: string[] = [];
  let registrationClosed = 0;
  let registrationToken = '';
  const result = await runConfigManagement({ command: 'setup', envPath: '.env', cwd, signal: new AbortController().signal,
    checkLlm: successCheck,
    terminal: { write: (message) => logs.push(message), ask: async (label, _initial, secret) => {
      if (label.startsWith('Optional single-use')) assert.equal(secret, true);
      if (label.startsWith('API key')) assert.equal(secret, true);
      const answer = answers.shift();
      assert.notEqual(answer, undefined, `unexpected question: ${label}`);
      if (label.startsWith('Optional single-use')) registrationToken = answer!;
      return answer!;
    }, askMultiline: async () => 'A test system prompt' },
    register: async (_config, options) => {
      options.onProgress?.('identity-loaded');
      return { status: 'ready', channels: [{ id: 'channel-1', name: 'General' }], close: async () => { registrationClosed++; } };
    },
  });
  assert.deepEqual(result, { status: 'saved' });
  assert.equal(answers.length, 0);
  assert.equal(registrationToken, 'private-registration-token');
  assert.equal(registrationClosed, 1);
  assert.doesNotMatch(logs.join('\n'), /private-registration-token|private-llm-key/);
  const saved = parseEnv(await readFile(join(cwd, '.env'), 'utf8'));
  assert.equal(saved.GRYT_ALLOWED_CHANNEL_ID, 'channel-1');
  assert.equal(saved.GRYT_BOT_TOKEN, undefined);
  assert.equal(saved.LLM_API_KEY, 'private-llm-key');
  assert.equal(saved.SEARCH_ENABLED, 'false');
  assert.match(saved.SYSTEM_PROMPT_PATH!, /^prompts\/system\.[0-9a-f-]+\.md$/);
  assert.equal(await readFile(join(cwd, saved.SYSTEM_PROMPT_PATH!), 'utf8'), 'A test system prompt');
  assert.deepEqual((await readdir(join(cwd, 'prompts'))).sort(), ['system.md.example', saved.SYSTEM_PROMPT_PATH!.split('/').at(-1)!].sort());
});

test('config can enable inherited search and commit it without testing unchanged LLM settings', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'gigachad-config-search-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'prompts'));
  const promptPath = join(cwd, 'prompts', 'active.md');
  await writeFile(promptPath, 'Existing prompt');
  const original = Object.entries({ ...env, GRYT_IDENTITY_PATH: './identity.json',
    SYSTEM_PROMPT_PATH: promptPath, CUSTOM_SETTING: 'keep-me' }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  await writeFile(join(cwd, '.env'), original, { mode: 0o600 });
  const answers = ['3', 'y', 'n', '8000', '100', '8192', '10000', '5', '5', '60000', '300000', '4', 'y'];
  let checkCalls = 0;
  const result = await runConfigManagement({ command: 'config', envPath: '.env', cwd, signal: new AbortController().signal,
    checkLlm: async () => { checkCalls++; return { status: 'success' }; },
    terminal: { write: () => {}, ask: async (label) => {
      const answer = answers.shift();
      assert.notEqual(answer, undefined, `unexpected question: ${label}`);
      return answer!;
    }, askMultiline: async () => { throw new Error('prompt should not be edited'); } },
  });
  assert.deepEqual(result, { status: 'saved' });
  assert.equal(answers.length, 0);
  assert.equal(checkCalls, 0);
  const saved = parseEnv(await readFile(join(cwd, '.env'), 'utf8'));
  assert.equal(saved.SEARCH_ENABLED, 'true');
  assert.equal(saved.SEARCH_LLM_BASE_URL, undefined);
  assert.equal(saved.SEARCH_LLM_API_KEY, undefined);
  assert.equal(saved.SEARCH_LLM_MODEL, undefined);
  assert.equal(saved.SEARCH_MAX_RESULTS, '5');
  assert.equal(saved.CUSTOM_SETTING, 'keep-me');
  assert.equal(saved.SYSTEM_PROMPT_PATH, promptPath);
  assert.equal(await readFile(promptPath, 'utf8'), 'Existing prompt');
});

test('config stores a separate search LLM draft without exposing its API key', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'gigachad-config-search-override-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, 'prompts'));
  const promptPath = join(cwd, 'prompts', 'active.md');
  await writeFile(promptPath, 'Existing prompt');
  const original = Object.entries({ ...env, GRYT_IDENTITY_PATH: './identity.json',
    SYSTEM_PROMPT_PATH: promptPath }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
  await writeFile(join(cwd, '.env'), original, { mode: 0o600 });
  const answers = ['3', 'y', 'y', 'https://search-llm.example/v1', 'private-search-key', 'search-model',
    '8000', '100', '8192', '10000', '5', '5', '60000', '300000', '4', 'y'];
  const logs: string[] = [];
  const result = await runConfigManagement({ command: 'config', envPath: '.env', cwd, signal: new AbortController().signal,
    checkLlm: successCheck,
    terminal: { write: (message) => logs.push(message), ask: async (label, _initial, secret) => {
      if (label.startsWith('Search LLM API key')) assert.equal(secret, true);
      const answer = answers.shift();
      assert.notEqual(answer, undefined, `unexpected question: ${label}`);
      return answer!;
    }, askMultiline: async () => { throw new Error('prompt should not be edited'); } },
  });
  assert.deepEqual(result, { status: 'saved' });
  assert.equal(answers.length, 0);
  assert.doesNotMatch(logs.join('\n'), /private-search-key/);
  const saved = parseEnv(await readFile(join(cwd, '.env'), 'utf8'));
  assert.equal(saved.SEARCH_ENABLED, 'true');
  assert.equal(saved.SEARCH_LLM_BASE_URL, 'https://search-llm.example/v1');
  assert.equal(saved.SEARCH_LLM_API_KEY, 'private-search-key');
  assert.equal(saved.SEARCH_LLM_MODEL, 'search-model');
  const disableAnswers = ['3', 'n', '4', 'y'];
  const disabled = await runConfigManagement({ command: 'config', envPath: '.env', cwd, signal: new AbortController().signal,
    terminal: { write: () => {}, ask: async () => disableAnswers.shift()!, askMultiline: async () => '' },
  });
  assert.deepEqual(disabled, { status: 'saved' });
  const disabledEnv = parseEnv(await readFile(join(cwd, '.env'), 'utf8'));
  assert.equal(disabledEnv.SEARCH_ENABLED, 'false');
  assert.equal(disabledEnv.SEARCH_LLM_API_KEY, 'private-search-key');
  assert.equal(disabledEnv.SEARCH_LLM_MODEL, 'search-model');
});

test('cancelling during channel selection closes registration and leaves all saved files untouched', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'gigachad-config-cancel-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const envPath = join(cwd, '.env');
  const original = 'CUSTOM=keep-me\n';
  await writeFile(envPath, original);
  const controller = new AbortController();
  const logs: string[] = [];
  let closed = false;
  const answers = ['https://chat.example.com', 'Assistant', join(cwd, 'identity.json'), 'y', 'private-token'];
  const result = await runConfigManagement({ command: 'setup', envPath, cwd, signal: controller.signal,
    terminal: { write: (message) => logs.push(message), ask: async (label, _initial, secret) => {
      if (label.startsWith('Optional single-use')) assert.equal(secret, true);
      if (label === 'Channel number') { controller.abort(); throw new DOMException('Cancelled', 'AbortError'); }
      return answers.shift()!;
    }, askMultiline: async () => '' },
    register: async (_config, options) => {
      options.onProgress?.('identity-loaded');
      return { status: 'ready', channels: [{ id: 'channel-1', name: 'General' }], close: async () => { closed = true; } };
    },
  });
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(closed, true);
  assert.equal(await readFile(envPath, 'utf8'), original);
  assert.match(logs.join('\n'), /identity.*kept/i);
  assert.deepEqual(await readdir(cwd), ['.env']);
});
