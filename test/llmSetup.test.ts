import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import test from 'node:test';
import { loadLlmConfig } from '../src/config.ts';
import { checkLlmDraft, runLlmSetup } from '../src/llmSetup.ts';
import { readLlmSetupStore } from '../src/llmSetupStore.ts';
import { env } from './support/fixtures.ts';

const prompt = 'You are a helpful assistant.';
const response = () => new Response(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));

test('unsafe stored LLM endpoints are never offered as visible defaults', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-llm-url-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const endpoint of ['https://user:private-password@example.com/v1', 'https://example.com/v1?key=private-key']) {
    const envPath = join(dir, '.env');
    const original = `LLM_BASE_URL=${endpoint}\n`;
    await writeFile(envPath, original);
    const controller = new AbortController();
    const result = await runLlmSetup({ envPath, signal: controller.signal, terminal: {
      ask: async (_label, initial) => {
        assert.equal(initial, undefined);
        controller.abort();
        throw new DOMException('Cancelled', 'AbortError');
      },
      askMultiline: async () => '', write: () => {},
    } });
    assert.deepEqual(result, { status: 'cancelled' });
    assert.equal(await readFile(envPath, 'utf8'), original);
  }
});

test('full output budget is validated before probing or persisting a prompt', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-llm-budget-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  const original = 'SYSTEM_PROMPT_PATH=system.md\n';
  await writeFile(envPath, original);
  await writeFile(join(dir, 'system.md'), 'old prompt');
  const store = await readLlmSetupStore(envPath, dir);
  const draftEnv = { ...env, LLM_CONTEXT_TOKENS: '1024', LLM_MAX_TOKENS: '700' };
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(); };
  const result = await checkLlmDraft({ env: draftEnv, prompt: 'x'.repeat(400), signal: new AbortController().signal });
  assert.equal(result.status, 'failed');
  if (result.status === 'failed') assert.equal(result.code, 'context_budget');
  assert.equal(calls, 0);
  await assert.rejects(store.save({ ...loadLlmConfig(draftEnv), prompt: 'x'.repeat(400) }), /context budget/);
  assert.equal(await readFile(envPath, 'utf8'), original);
  assert.equal(await readFile(join(dir, 'system.md'), 'utf8'), 'old prompt');
  assert.deepEqual((await readdir(dir)).sort(), ['.env', 'system.md']);
  // The boundary still permits a short probe with the configured full reserve.
  assert.deepEqual(await checkLlmDraft({ env: draftEnv, prompt: 'short prompt', signal: new AbortController().signal }), { status: 'success' });
  assert.equal(calls, 1);
});

test('cancelling after preparation preserves both files and removes prepared versions', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-llm-save-abort-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  const promptPath = join(dir, 'system.md');
  const original = `SYSTEM_PROMPT_PATH=${promptPath}\n`;
  await writeFile(envPath, original);
  await writeFile(promptPath, 'old prompt');
  const controller = new AbortController();
  const originalWrite = fs.writeFile;
  const mockWrite = t.mock.method(fs, 'writeFile', async (...args: Parameters<typeof fs.writeFile>) => {
    await originalWrite(...args);
    if (String(args[0]).startsWith(`${envPath}.`)) controller.abort();
  });
  syncBuiltinESMExports();
  t.after(() => { mockWrite.mock.restore(); syncBuiltinESMExports(); });
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async () => response();
  const answers = [env.LLM_BASE_URL, env.LLM_MODEL, env.LLM_API_KEY, '8192', '1024', '120000', 'y', 'y'];
  const result = await runLlmSetup({ envPath, signal: controller.signal, terminal: {
    ask: async () => answers.shift() ?? '', askMultiline: async () => 'new prompt', write: () => {},
  } });
  assert.equal(controller.signal.aborted, true);
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(await readFile(envPath, 'utf8'), original);
  assert.equal(await readFile(promptPath, 'utf8'), 'old prompt');
  assert.deepEqual((await readdir(dir)).sort(), ['.env', 'system.md']);
});

test('a cancellation arriving after the dotenv rename keeps a successful save', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-llm-save-committed-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  await writeFile(envPath, 'SYSTEM_PROMPT_PATH=system.md\n');
  await writeFile(join(dir, 'system.md'), 'old prompt');
  const store = await readLlmSetupStore(envPath, dir);
  const controller = new AbortController();
  const originalRename = fs.rename;
  const mockRename = t.mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
    await originalRename(...args);
    if (args[1] === envPath) controller.abort();
  });
  syncBuiltinESMExports();
  t.after(() => { mockRename.mock.restore(); syncBuiltinESMExports(); });
  const saved = await store.save({ ...loadLlmConfig(env), prompt: 'new prompt' }, controller.signal);
  assert.equal(controller.signal.aborted, true);
  assert.equal(parseEnv(await readFile(envPath, 'utf8')).SYSTEM_PROMPT_PATH, saved.promptPath);
  assert.equal(await readFile(join(dir, saved.promptPath), 'utf8'), 'new prompt');
});

test('cancellation at the last concurrency check prevents the dotenv rename', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-llm-save-last-check-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  const promptPath = join(dir, 'system.md');
  const original = 'SYSTEM_PROMPT_PATH=system.md\n';
  await writeFile(envPath, original);
  await writeFile(promptPath, 'old prompt');
  const store = await readLlmSetupStore(envPath, dir);
  const controller = new AbortController();
  let promptReads = 0;
  const originalRead = fs.readFile;
  const mockRead = t.mock.method(fs, 'readFile', async (...args: Parameters<typeof fs.readFile>) => {
    const content = await originalRead(...args);
    if (args[0] === promptPath && ++promptReads === 2) controller.abort();
    return content;
  });
  syncBuiltinESMExports();
  t.after(() => { mockRead.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(store.save({ ...loadLlmConfig(env), prompt: 'new prompt' }, controller.signal), { name: 'AbortError' });
  assert.equal(promptReads, 2);
  assert.equal(await readFile(envPath, 'utf8'), original);
  assert.equal(await readFile(promptPath, 'utf8'), 'old prompt');
  assert.deepEqual((await readdir(dir)).sort(), ['.env', 'system.md']);
});

test('standalone LLM config does not require Gryt and validates credentials and budgets', () => {
  const config = loadLlmConfig({ LLM_BASE_URL: env.LLM_BASE_URL, LLM_MODEL: env.LLM_MODEL,
    LLM_API_KEY: env.LLM_API_KEY, LLM_CONTEXT_TOKENS: '8192', LLM_MAX_TOKENS: '1024' });
  assert.equal(config.timeoutMs, 120000);
  assert.equal(loadLlmConfig({ LLM_BASE_URL: 'http://localhost:8080/v1///', LLM_MODEL: ' local ',
    LLM_API_KEY: ' key ', LLM_CONTEXT_TOKENS: '2048', LLM_MAX_TOKENS: '100', LLM_TIMEOUT_MS: '50' }).baseUrl,
  'http://localhost:8080/v1');
  assert.throws(() => loadLlmConfig({ LLM_BASE_URL: env.LLM_BASE_URL, LLM_MODEL: 'bad\nmodel',
    LLM_API_KEY: env.LLM_API_KEY, LLM_CONTEXT_TOKENS: '8192', LLM_MAX_TOKENS: '1024' }), /LLM_MODEL/);
  assert.throws(() => loadLlmConfig({ LLM_BASE_URL: env.LLM_BASE_URL, LLM_MODEL: env.LLM_MODEL,
    LLM_API_KEY: 'secret\nheader', LLM_CONTEXT_TOKENS: '8192', LLM_MAX_TOKENS: '1024' }), (error: Error) => {
    assert.match(error.message, /LLM_API_KEY/);
    assert.doesNotMatch(error.message, /secret/);
    return true;
  });
  assert.throws(() => loadLlmConfig({ LLM_BASE_URL: env.LLM_BASE_URL, LLM_MODEL: env.LLM_MODEL,
    LLM_API_KEY: env.LLM_API_KEY, LLM_CONTEXT_TOKENS: '1024', LLM_MAX_TOKENS: '768' }), /leave room/);
});

test('LLM check returns structured success and sends one generic short request', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let request: { url: string; init: RequestInit } | undefined;
  globalThis.fetch = async (input, init) => { request = { url: String(input), init: init ?? {} }; return response(); };
  const events: string[] = [];
  const result = await checkLlmDraft({ env: { LLM_BASE_URL: env.LLM_BASE_URL, LLM_MODEL: env.LLM_MODEL,
    LLM_API_KEY: 'private-key', LLM_CONTEXT_TOKENS: '8192', LLM_MAX_TOKENS: '1024' }, prompt,
    signal: new AbortController().signal, onProgress: (event) => events.push(event.phase) });
  assert.deepEqual(result, { status: 'success' });
  assert.deepEqual(events, ['checking', 'complete']);
  assert.equal(request?.url, `${env.LLM_BASE_URL}/chat/completions`);
  assert.equal(new Headers(request?.init.headers).get('authorization'), 'Bearer private-key');
  const payload = JSON.parse(String(request?.init.body));
  assert.equal(payload.model, env.LLM_MODEL);
  assert.equal(payload.max_tokens, 16);
  assert.deepEqual(payload.messages, [
    { role: 'system', content: prompt }, { role: 'user', content: 'Reply with OK.' },
  ]);
  assert.equal(Object.hasOwn(payload, 'chat_template_kwargs'), false);
});

test('LLM check reports safe actionable failures and validates before making a request', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return new Response('private upstream body with key', { status: 401 }); };
  const failed = await checkLlmDraft({ env: { LLM_BASE_URL: env.LLM_BASE_URL, LLM_MODEL: env.LLM_MODEL,
    LLM_API_KEY: 'private-key', LLM_CONTEXT_TOKENS: '8192', LLM_MAX_TOKENS: '1024' }, prompt,
    signal: new AbortController().signal });
  assert.deepEqual(failed, { status: 'failed', code: 'authorization',
    message: 'LLM HTTP 401. Check the API key and endpoint permissions.' });
  assert.doesNotMatch(JSON.stringify(failed), /private-key|upstream body/);
  assert.equal(calls, 1);
  const invalid = await checkLlmDraft({ env: { LLM_BASE_URL: env.LLM_BASE_URL, LLM_MODEL: env.LLM_MODEL,
    LLM_API_KEY: 'private-key', LLM_CONTEXT_TOKENS: '8192', LLM_MAX_TOKENS: '9000' }, prompt,
    signal: new AbortController().signal });
  assert.equal(invalid.status, 'failed');
  if (invalid.status === 'failed') {
    assert.match(invalid.message, /LLM_MAX_TOKENS/);
    assert.doesNotMatch(invalid.message, /private-key/);
  }
  assert.equal(calls, 1);
});

test('LLM connectivity check settles as cancelled when its request is aborted', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const controller = new AbortController();
  globalThis.fetch = async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('private', 'AbortError')), { once: true });
    setTimeout(() => controller.abort(), 5);
  });
  const result = await checkLlmDraft({ env: { LLM_BASE_URL: env.LLM_BASE_URL, LLM_MODEL: env.LLM_MODEL,
    LLM_API_KEY: 'private-key', LLM_CONTEXT_TOKENS: '8192', LLM_MAX_TOKENS: '1024' }, prompt,
    signal: controller.signal });
  assert.deepEqual(result, { status: 'cancelled' });
});

test('LLM store saves a versioned private prompt and atomically points dotenv at it', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-llm-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'prompts'));
  const envPath = join(dir, '.env');
  const promptPath = join(dir, 'prompts', 'system.md');
  const oldPrompt = 'old prompt';
  await writeFile(promptPath, oldPrompt);
  await writeFile(envPath, `LLM_BASE_URL=${env.LLM_BASE_URL}\nLLM_MODEL=${env.LLM_MODEL}\nLLM_API_KEY=old-key\nLLM_CONTEXT_TOKENS=8192\nLLM_MAX_TOKENS=1024\nGRYT_NICKNAME=Bot\nSEARCH_ENABLED=false\nSYSTEM_PROMPT_PATH=prompts/system.md\n`);
  const store = await readLlmSetupStore(envPath, dir);
  const saved = await store.save({ baseUrl: 'https://other.example/v1', model: 'new-model', apiKey: 'new-key',
    contextTokens: 16384, maxTokens: 2048, timeoutMs: 90000, prompt: 'new prompt\nwith two lines' });
  const values = parseEnv(await readFile(envPath, 'utf8'));
  assert.equal(values.LLM_BASE_URL, 'https://other.example/v1');
  assert.equal(values.LLM_MODEL, 'new-model');
  assert.equal(values.LLM_API_KEY, 'new-key');
  assert.equal(values.GRYT_NICKNAME, 'Bot');
  assert.equal(values.SEARCH_ENABLED, 'false');
  assert.equal(values.SYSTEM_PROMPT_PATH, saved.promptPath);
  assert.match(saved.promptPath, /^prompts\/system\.[0-9a-f-]+\.md$/);
  assert.equal(await readFile(join(dir, saved.promptPath), 'utf8'), 'new prompt\nwith two lines');
  assert.equal((await stat(join(dir, saved.promptPath))).mode & 0o777, 0o600);
  assert.equal(await readFile(promptPath, 'utf8'), oldPrompt);
  assert.deepEqual((await readdir(join(dir, 'prompts'))).sort(), ['system.md', saved.promptPath.split('/').at(-1)].sort());
});

test('LLM store rejects concurrent edits and invalid drafts without changing prior files', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-llm-race-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, 'prompts'));
  const envPath = join(dir, '.env');
  const promptPath = join(dir, 'prompts', 'system.md');
  await writeFile(envPath, 'LLM_BASE_URL=https://llm.example/v1\nLLM_MODEL=model\nLLM_API_KEY=old-key\nLLM_CONTEXT_TOKENS=8192\nLLM_MAX_TOKENS=1024\nSYSTEM_PROMPT_PATH=prompts/system.md\n');
  await writeFile(promptPath, 'old prompt');
  const store = await readLlmSetupStore(envPath, dir);
  const draft = { baseUrl: 'https://llm.example/v1', model: 'model', apiKey: 'new-key', contextTokens: 8192,
    maxTokens: 1024, timeoutMs: 120000, prompt: 'new prompt' };
  await writeFile(envPath, 'concurrent edit');
  await assert.rejects(store.save(draft), /Configuration changed during setup/);
  assert.equal(await readFile(promptPath, 'utf8'), 'old prompt');
  assert.deepEqual((await readdir(join(dir, 'prompts'))), ['system.md']);

  await writeFile(envPath, 'LLM_BASE_URL=https://llm.example/v1\nLLM_MODEL=model\nLLM_API_KEY=old-key\nLLM_CONTEXT_TOKENS=8192\nLLM_MAX_TOKENS=1024\nSYSTEM_PROMPT_PATH=prompts/system.md\n');
  const fresh = await readLlmSetupStore(envPath, dir);
  await assert.rejects(fresh.save({ ...draft, maxTokens: 9000 }), /leave room/);
  assert.equal(await readFile(envPath, 'utf8'), 'LLM_BASE_URL=https://llm.example/v1\nLLM_MODEL=model\nLLM_API_KEY=old-key\nLLM_CONTEXT_TOKENS=8192\nLLM_MAX_TOKENS=1024\nSYSTEM_PROMPT_PATH=prompts/system.md\n');
  assert.deepEqual((await readdir(join(dir, 'prompts'))), ['system.md']);
});

test('LLM wizard cancellation preserves saved dotenv and prompt data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-llm-cancel-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const envPath = join(dir, '.env');
  const original = `LLM_BASE_URL=${env.LLM_BASE_URL}\nLLM_MODEL=${env.LLM_MODEL}\nLLM_API_KEY=private-key\nLLM_CONTEXT_TOKENS=8192\nLLM_MAX_TOKENS=1024\n`;
  await writeFile(envPath, original);
  const oldFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = oldFetch; });
  globalThis.fetch = async () => response();
  const answers = [env.LLM_BASE_URL, env.LLM_MODEL, 'private-key', '8192', '1024', '120000', 'y', 'n'];
  const logs: string[] = [];
  const result = await runLlmSetup({ envPath, signal: new AbortController().signal, terminal: {
    ask: async () => answers.shift() ?? '', askMultiline: async () => 'edited but cancelled prompt',
    write: (message) => logs.push(message),
  } });
  assert.deepEqual(result, { status: 'cancelled' });
  assert.equal(await readFile(envPath, 'utf8'), original);
  assert.deepEqual(await readdir(dir), ['.env']);
  assert.doesNotMatch(logs.join('\n'), /private-key/);
});
