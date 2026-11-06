import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import {
  CircuitBreaker,
  RateLimiter,
  createSearchState,
  describeSearchFailure,
  formatSearchResults,
  normalizeQuery,
  searchWeb,
  type SearchConfig,
  type SearchResult,
} from '../src/search.ts';

const config: SearchConfig = {
  searxngUrl: 'http://127.0.0.1:1',
  searchTimeoutMs: 2000,
  searchMaxResults: 3,
  searchRateLimit: 5,
  searchRateWindowMs: 60_000,
  searchCacheTtlMs: 300_000,
};

function jsonResponse(results: Array<Record<string, unknown>>) {
  return JSON.stringify({ query: 'test', results, answers: [], corrections: [], infoboxes: [], suggestions: [] });
}

async function searxngServer(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse, count: number) => void) {
  let count = 0;
  const http = createServer((req, res) => { count++; handler(req, res, count); });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    http.closeAllConnections();
    http.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

test('describeSearchFailure reports fixed diagnostics', () => {
  assert.equal(describeSearchFailure(new Error('Search HTTP 403')), 'Search HTTP 403');
  assert.equal(describeSearchFailure(new DOMException('private', 'TimeoutError')), 'Search request timed out');
  assert.equal(describeSearchFailure(new DOMException('private', 'AbortError')), 'Search request aborted');
  assert.equal(describeSearchFailure(new SyntaxError('private body')), 'Search returned invalid JSON');
  assert.equal(describeSearchFailure(new TypeError('fetch failed')), 'Search network or TLS connection failed');
  assert.equal(describeSearchFailure(new Error('private detail')), 'Unexpected search failure');
  assert.equal(describeSearchFailure('private'), 'Unexpected search failure');
});

test('normalizeQuery lowercases, trims and collapses whitespace', () => {
  assert.equal(normalizeQuery('  Hello   World  '), 'hello world');
  assert.equal(normalizeQuery('  '), '');
});

test('formatSearchResults returns empty string for no results', () => {
  assert.equal(formatSearchResults('query', []), '');
});

test('formatSearchResults formats title, content and source URL', () => {
  const results: SearchResult[] = [
    { title: 'Page A', url: 'https://a.example', content: 'Snippet A', engine: 'bing', score: 1 },
    { title: '', url: 'https://b.example', content: '', engine: 'google', score: 2 },
  ];
  const text = formatSearchResults('query', results);
  assert.ok(text.includes('Веб-поиск по запросу «query»'));
  assert.ok(text.includes('1. Page A — Snippet A'));
  assert.ok(text.includes('Источник: https://a.example'));
  assert.ok(text.includes('2. https://b.example'));
  assert.ok(text.includes('Используй эти результаты'));
});

test('searchWeb returns empty array when searxngUrl is empty', async () => {
  const state = createSearchState({ ...config, searxngUrl: undefined });
  const results = await searchWeb('test', { ...config, searxngUrl: undefined }, state);
  assert.deepEqual(results, []);
});

test('searchWeb returns results from SearXNG JSON', async (t) => {
  const baseUrl = await searxngServer(t, (_req, res) => {
    res.end(jsonResponse([
      { title: 'Result 1', url: 'https://r1.example', content: 'Content 1', engine: 'bing', score: 1 },
      { title: 'Result 2', url: 'https://r2.example', content: 'Content 2', engine: 'google', score: 2 },
      { title: 'Result 3', url: 'https://r3.example', content: 'Content 3', engine: 'ddg', score: 3 },
    ]));
  });
  const state = createSearchState({ ...config, searxngUrl: baseUrl });
  const results = await searchWeb('test query', { ...config, searxngUrl: baseUrl }, state);
  assert.equal(results.length, 3);
  assert.equal(results[0]!.title, 'Result 1');
  assert.equal(results[0]!.url, 'https://r1.example');
  assert.equal(results[0]!.content, 'Content 1');
  assert.equal(results[0]!.engine, 'bing');
});

test('searchWeb limits results to searchMaxResults', async (t) => {
  const baseUrl = await searxngServer(t, (_req, res) => {
    res.end(jsonResponse([
      { title: 'A', url: 'https://a', content: 'a', engine: 'e', score: 1 },
      { title: 'B', url: 'https://b', content: 'b', engine: 'e', score: 2 },
      { title: 'C', url: 'https://c', content: 'c', engine: 'e', score: 3 },
      { title: 'D', url: 'https://d', content: 'd', engine: 'e', score: 4 },
    ]));
  });
  const cfg = { ...config, searxngUrl: baseUrl, searchMaxResults: 2 };
  const state = createSearchState(cfg);
  const results = await searchWeb('test', cfg, state);
  assert.equal(results.length, 2);
});

test('searchWeb truncates long content to ~300 chars', async (t) => {
  const longContent = 'x'.repeat(500);
  const baseUrl = await searxngServer(t, (_req, res) => {
    res.end(jsonResponse([
      { title: 'Long', url: 'https://long', content: longContent, engine: 'e', score: 1 },
    ]));
  });
  const state = createSearchState({ ...config, searxngUrl: baseUrl });
  const results = await searchWeb('test', { ...config, searxngUrl: baseUrl }, state);
  assert.ok(results[0]!.content.length <= 301);
  assert.ok(results[0]!.content.endsWith('…'));
});

test('searchWeb returns cached result on second identical call', async (t) => {
  let calls = 0;
  const baseUrl = await searxngServer(t, (_req, res) => {
    calls++;
    res.end(jsonResponse([
      { title: 'Cached', url: 'https://cached', content: 'c', engine: 'e', score: 1 },
    ]));
  });
  const state = createSearchState({ ...config, searxngUrl: baseUrl });
  await searchWeb('same query', { ...config, searxngUrl: baseUrl }, state);
  await searchWeb('same query', { ...config, searxngUrl: baseUrl }, state);
  assert.equal(calls, 1);
});

test('searchWeb returns empty array on SearXNG HTTP error', async (t) => {
  const baseUrl = await searxngServer(t, (_req, res) => {
    res.writeHead(503);
    res.end('unavailable');
  });
  const state = createSearchState({ ...config, searxngUrl: baseUrl });
  const results = await searchWeb('test', { ...config, searxngUrl: baseUrl }, state);
  assert.deepEqual(results, []);
});

test('searchWeb returns empty array on network failure', async () => {
  const state = createSearchState({ ...config, searxngUrl: 'http://127.0.0.1:1' });
  const results = await searchWeb('test', { ...config, searxngUrl: 'http://127.0.0.1:1' }, state);
  assert.deepEqual(results, []);
});

test('searchWeb returns empty array on invalid JSON', async (t) => {
  const baseUrl = await searxngServer(t, (_req, res) => {
    res.end('not json');
  });
  const state = createSearchState({ ...config, searxngUrl: baseUrl });
  const results = await searchWeb('test', { ...config, searxngUrl: baseUrl }, state);
  assert.deepEqual(results, []);
});

test('searchWeb returns empty array on timeout', async (t) => {
  const http = createServer((req) => { req.socket.destroy(); });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    http.closeAllConnections();
    http.close((error) => (error ? reject(error) : resolve()));
  }));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cfg = { ...config, searxngUrl: baseUrl, searchTimeoutMs: 100 };
  const state = createSearchState(cfg);
  const results = await searchWeb('test', cfg, state);
  assert.deepEqual(results, []);
});

test('RateLimiter allows up to max acquisitions within window', () => {
  const limiter = new RateLimiter(3, 1000);
  const t0 = 1_000_000;
  assert.equal(limiter.tryAcquire(t0), true);
  assert.equal(limiter.tryAcquire(t0 + 100), true);
  assert.equal(limiter.tryAcquire(t0 + 200), true);
  assert.equal(limiter.tryAcquire(t0 + 300), false);
  assert.equal(limiter.tryAcquire(t0 + 1100), true);
});

test('CircuitBreaker opens after threshold failures and closes after cooldown', () => {
  const breaker = new CircuitBreaker(3, 1000);
  const t0 = 1_000_000;
  assert.equal(breaker.isClosed(t0), true);
  breaker.recordFailure(t0);
  breaker.recordFailure(t0 + 10);
  assert.equal(breaker.isClosed(t0 + 20), true);
  breaker.recordFailure(t0 + 30);
  assert.equal(breaker.isClosed(t0 + 40), false);
  assert.equal(breaker.isClosed(t0 + 999), false);
  // Cooldown expired — half-open: isClosed() resets the failure count so the
  // next attempt starts from a clean slate.
  assert.equal(breaker.isClosed(t0 + 1030), true);
});

test('CircuitBreaker half-open: single failure does not immediately re-open', () => {
  const breaker = new CircuitBreaker(3, 1000);
  const t0 = 1_000_000;
  // Open the breaker with 3 failures.
  breaker.recordFailure(t0);
  breaker.recordFailure(t0 + 1);
  breaker.recordFailure(t0 + 2);
  assert.equal(breaker.isClosed(t0 + 3), false);
  // Cooldown expires — half-open, failure count reset.
  assert.equal(breaker.isClosed(t0 + 1030), true);
  // A single failure in the half-open window must NOT re-open the breaker for
  // a full cooldown (the old behavior); the breaker stays closed and the
  // failure count is now 1.
  breaker.recordFailure(t0 + 1040);
  assert.equal(breaker.isClosed(t0 + 1050), true);
  // Two more failures (total 3) re-open the breaker.
  breaker.recordFailure(t0 + 1060);
  breaker.recordFailure(t0 + 1070);
  assert.equal(breaker.isClosed(t0 + 1080), false);
  assert.equal(breaker.isClosed(t0 + 1100), false);
  // Cooldown expires again — half-open.
  assert.equal(breaker.isClosed(t0 + 2100), true);
});

test('CircuitBreaker resets on success', () => {
  const breaker = new CircuitBreaker(3, 1000);
  const t0 = 1_000_000;
  breaker.recordFailure(t0);
  breaker.recordFailure(t0 + 10);
  breaker.recordSuccess(t0 + 20);
  assert.equal(breaker.isClosed(t0 + 30), true);
});