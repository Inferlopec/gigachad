import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Message } from '@gryt/bot';
import { createRuntime } from '../src/runtime.ts';
import type { complete } from '../src/llm.ts';
import { config, message } from './support/fixtures.ts';

async function fixture(
  t: test.TestContext,
  enabled = false,
  completion?: typeof complete,
  searchLlmOverrides: NodeJS.ProcessEnv = {},
) {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-runtime-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const prompt = join(dir, 'custom.md');
  await writeFile(prompt, 'custom system prompt');
  const c = config({ SYSTEM_PROMPT_PATH: prompt,
    ...(enabled ? { SEARCH_ENABLED: 'true', ...searchLlmOverrides } : {}) });
  let emit!: (m: Message) => void;
  let available = false;
  const calls: string[] = [];
  const logs: string[] = [];
  let sent!: () => void;
  const replied = new Promise<void>((resolve) => { sent = resolve; });
  let system = '';
  const runtime = createRuntime(c, {
    log: (m) => logs.push(m), logError: (m) => logs.push(m),
    createGryt: (received, onMessage) => {
      assert.equal(received, c);
      emit = onMessage;
      return {
        start: async () => { available = true; calls.push('start'); },
        stop: async () => { available = false; calls.push('stop'); },
        available: () => available, selfId: () => 'bot-1',
        send: async (channel, text) => {
          assert.equal(channel, 'allowed'); calls.push(`send:${text}`); sent();
        },
        typing: () => {}, stopTyping: () => {},
      };
    },
    complete: completion ?? (async (received, input, conversation, signal) => {
      assert.equal(received, c);
      assert.equal(signal?.aborted, false);
      assert.equal(conversation.at(-1)?.content, 'User: hello');
      system = input; calls.push('complete'); return 'answer';
    }),
    extractQuery: async (_conversation, deps) => {
      assert.equal(deps.config.model, c.searchLlmModel);
      assert.equal(deps.config.baseUrl, c.searchLlmBaseUrl);
      assert.equal(deps.config.apiKey, c.searchLlmApiKey);
      calls.push('extract'); return 'test query';
    },
    search: async (query, received, _state, signal) => {
      assert.equal(query, 'test query'); assert.equal(received, c);
      assert.equal(signal?.aborted, false); calls.push('search');
      return [{ title: 'Result', url: 'https://example.com', content: 'Web context', engine: 'test', score: 1 }];
    },
  });
  t.after(() => runtime.stop());
  return { runtime, emit: (m = message()) => emit(m), calls, logs, replied, system: () => system };
}

test('runtime uses configured prompt and existing handler without search dependencies when disabled', async (t) => {
  const f = await fixture(t);
  await f.runtime.start();
  f.emit(message({ conversationId: 'other' }));
  f.emit();
  await f.replied;
  assert.equal(f.system(), 'custom system prompt');
  assert.deepEqual(f.calls, ['start', 'complete', 'send:answer']);
  await f.runtime.stop();
  f.emit(message({ messageId: 'late' }));
  await f.runtime.start();
  assert.deepEqual(f.calls, ['start', 'complete', 'send:answer', 'stop']);
});

test('runtime wires optional query extraction and search before the configured LLM', async (t) => {
  const f = await fixture(t, true, undefined, {
    SEARCH_LLM_BASE_URL: 'https://search-llm.example/v1',
    SEARCH_LLM_API_KEY: 'search-only-secret',
    SEARCH_LLM_MODEL: 'query-model',
  });
  await f.runtime.start(); f.emit(); await f.replied;
  assert.deepEqual(f.calls, ['start', 'extract', 'search', 'complete', 'send:answer']);
  assert.match(f.system(), /^custom system prompt/);
  assert.match(f.system(), /Web context/);
});

test('runtime shutdown aborts an in-flight request, drains handlers and suppresses late replies', async (t) => {
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const f = await fixture(t, false, async (_c, _s, _m, signal) => {
    entered();
    return new Promise((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('secret detail', 'AbortError')), { once: true });
    });
  });
  await f.runtime.start(); f.emit(); await started;
  await Promise.all([f.runtime.stop(), f.runtime.stop()]);
  assert.deepEqual(f.calls, ['start', 'stop']);
  assert.doesNotMatch(f.logs.join('\n'), /secret/);
});

test('runtime startup failure aborts and stops the integration', async () => {
  let stops = 0;
  const runtime = createRuntime(config(), {
    log: () => {}, logError: () => {},
    createGryt: () => ({
      start: async () => { throw new Error('failed'); }, stop: async () => { stops++; },
      selfId: () => null, available: () => false, send: async () => {}, typing: () => {}, stopTyping: () => {},
    }),
  });
  await assert.rejects(runtime.start(), /failed/);
  assert.equal(stops, 1);
});
