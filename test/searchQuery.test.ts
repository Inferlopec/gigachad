import assert from 'node:assert/strict';
import test from 'node:test';
import {
  extractSearchQuery,
  stripSenderNicknames,
  collectNicknames,
  EXTRACT_SYSTEM,
  type ExtractDeps,
} from '../src/searchQuery.ts';
import type { ChatMessage } from '../src/llm.ts';

function makeDeps(overrides: Partial<ExtractDeps> = {}): ExtractDeps {
  return {
    config: {
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'key',
      model: 'test-model',
      timeoutMs: 2000,
      maxTokens: 100,
      contextTokens: 8192,
    },
    log: () => {},
    ...overrides,
  };
}

// ── stripSenderNicknames ───────────────────────────────────────────────────

test('stripSenderNicknames removes exact nickname match (case-insensitive)', () => {
  assert.equal(stripSenderNicknames('inferlo path of exile 2 dev stream', ['Inferlo']), 'path of exile 2 dev stream');
  assert.equal(stripSenderNicknames('INFERLO poe2 stream', ['Inferlo']), 'poe2 stream');
  assert.equal(stripSenderNicknames('Inferlo', ['Inferlo']), '');
});

test('stripSenderNicknames does not remove substring matches', () => {
  assert.equal(stripSenderNicknames('inferlopec poe2 guide', ['Inferlo']), 'inferlopec poe2 guide');
});

test('stripSenderNicknames removes multiple nicknames', () => {
  assert.equal(stripSenderNicknames('Alice Bob rust memory model', ['Alice', 'Bob']), 'rust memory model');
});

test('stripSenderNicknames returns query unchanged when no nicknames', () => {
  assert.equal(stripSenderNicknames('rust memory model', []), 'rust memory model');
});

test('stripSenderNicknames collapses leftover spaces', () => {
  assert.equal(stripSenderNicknames('inferlo  path of exile', ['Inferlo']), 'path of exile');
});

test('stripSenderNicknames handles nicknames with special chars', () => {
  assert.equal(stripSenderNicknames('bob.c rust guide', ['bob.c']), 'rust guide');
});

// ── collectNicknames ───────────────────────────────────────────────────────

test('collectNicknames extracts sender nicknames from user messages', () => {
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'Alice: what is rust?' },
    { role: 'assistant', content: 'Rust is a systems language.' },
    { role: 'user', content: 'Bob: and what about its memory model?' },
  ];
  assert.deepEqual(collectNicknames(conversation), ['Alice', 'Bob']);
});

test('collectNicknames deduplicates (case-insensitive)', () => {
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'Alice: hello' },
    { role: 'user', content: 'alice: again' },
    { role: 'user', content: 'ALICE: once more' },
  ];
  assert.deepEqual(collectNicknames(conversation), ['Alice']);
});

test('collectNicknames ignores assistant messages', () => {
  const conversation: ChatMessage[] = [
    { role: 'assistant', content: 'Some reply' },
    { role: 'user', content: 'Bob: question' },
  ];
  assert.deepEqual(collectNicknames(conversation), ['Bob']);
});

test('collectNicknames handles messages without colon', () => {
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'no colon here' },
    { role: 'user', content: 'Bob: with colon' },
  ];
  assert.deepEqual(collectNicknames(conversation), ['Bob']);
});

test('collectNicknames returns empty for empty conversation', () => {
  assert.deepEqual(collectNicknames([]), []);
});

// ── extractSearchQuery (integration, LLM fails fast) ───────────────────────

test('extractSearchQuery returns null for short messages without calling LLM', async () => {
  const deps = makeDeps({
    config: {
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'key',
      model: 'm',
      timeoutMs: 100,
      maxTokens: 100,
      contextTokens: 8192,
    },
  });
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'Inferlo: hello there' },
  ];
  const result = await extractSearchQuery(conversation, deps);
  assert.equal(result, null);
});

test('extractSearchQuery returns null on LLM error (graceful degradation)', async () => {
  const logs: string[] = [];
  const deps = makeDeps({
    config: {
      baseUrl: 'http://127.0.0.1:1/v1',
      apiKey: 'key',
      model: 'm',
      timeoutMs: 100,
      maxTokens: 100,
      contextTokens: 8192,
    },
    log: (msg) => { logs.push(msg); },
  });
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'Inferlo: what is the capital of France in 2026?' },
  ];
  const result = await extractSearchQuery(conversation, deps);
  assert.equal(result, null);
  assert.ok(logs.length >= 1, 'should log the extraction failure');
  assert.ok(logs[0].includes('extraction failed'), `unexpected log: ${logs[0]}`);
});

test('extractSearchQuery strips sender nickname from query (deterministic)', () => {
  const conversation: ChatMessage[] = [
    { role: 'user', content: 'Inferlo: what is the capital of France in 2026?' },
  ];
  const nicknames = collectNicknames(conversation);
  assert.deepEqual(nicknames, ['Inferlo']);
  const simulatedLlmOutput = 'inferlo capital of france 2026';
  const stripped = stripSenderNicknames(simulatedLlmOutput, nicknames);
  assert.equal(stripped, 'capital of france 2026');
  assert.ok(!stripped.toLowerCase().includes('inferlo'), 'nickname must be removed');
});

test('EXTRACT_SYSTEM contains required instructions', () => {
  assert.ok(EXTRACT_SYSTEM.includes('NOSEARCH'), 'must mention NOSEARCH sentinel');
  assert.ok(EXTRACT_SYSTEM.includes('ОДНУ поисковую фразу'), 'must require a single query');
  assert.ok(EXTRACT_SYSTEM.includes('ключевые слова'), 'must require keywords');
  assert.ok(EXTRACT_SYSTEM.includes('английском'), 'must mention English for tech topics');
  assert.ok(EXTRACT_SYSTEM.includes('КТО спрашивает'), 'must explain nickname is the asker');
  assert.ok(EXTRACT_SYSTEM.includes('Inferlo'), 'must have an Inferlo example');
});
