import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import test from 'node:test';
import { complete, describeLlmFailure } from '../src/llm.ts';
import { loadConfig } from '../src/config.ts';

async function server(t: test.TestContext, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const http = createServer(handler);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => {
    http.closeAllConnections();
    http.close((error) => error ? reject(error) : resolve());
  }));
  const address = http.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}
const config = {
  baseUrl: '', apiKey: 'test-key', model: 'qwen3.8-27b-unleashed-web',
  timeoutMs: 2000, maxTokens: 1024, contextTokens: 131000,
};

test('LLM diagnostics report actionable failures without logging private error text', () => {
  assert.equal(describeLlmFailure(new Error('LLM HTTP 401')), 'LLM HTTP 401');
  assert.equal(describeLlmFailure(new Error('Input exceeds conservative context budget')), 'Input exceeds conservative context budget');
  assert.equal(describeLlmFailure(new DOMException('private timeout details', 'TimeoutError')), 'LLM request timed out');
  assert.equal(describeLlmFailure(new SyntaxError('private response body')), 'LLM returned invalid JSON');
  assert.equal(describeLlmFailure(new TypeError('fetch failed')), 'LLM network or TLS connection failed');
  assert.equal(describeLlmFailure(new Error('private API key or message text')), 'Unexpected LLM failure');
  assert.equal(describeLlmFailure('private response'), 'Unexpected LLM failure');
});

test('LLM sends configured Chat Completions request and reads answer', async (t) => {
  let payload: unknown;
  let auth: string | undefined;
  let url: string | undefined;
  const baseUrl = await server(t, async (req, res) => {
    url = req.url; auth = req.headers.authorization;
    assert.equal(req.method, 'POST');
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString());
    res.end(JSON.stringify({ choices: [{ message: { content: ' answer ' } }] }));
  });
  assert.equal(await complete({ ...config, baseUrl }, 'system', [{ role: 'user', content: 'hello' }]), 'answer');
  assert.equal(url, '/v1/chat/completions');
  assert.equal(auth, 'Bearer test-key');
  assert.deepEqual(payload, {
    model: config.model, stream: false, max_tokens: 1024,
    chat_template_kwargs: { enable_thinking: false },
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }],
  });
});

test('LLM drops oldest history before exceeding the context budget', async (t) => {
  let payload: { messages: unknown[] } | undefined;
  const baseUrl = await server(t, async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    payload = JSON.parse(Buffer.concat(chunks).toString());
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }));
  });
  const conversation = [
    { role: 'user' as const, content: 'old'.repeat(100) },
    { role: 'assistant' as const, content: 'middle'.repeat(50) },
    { role: 'user' as const, content: 'latest question' },
  ];
  await complete({ ...config, baseUrl, contextTokens: 380, maxTokens: 50 }, 'system', conversation);
  assert.deepEqual(payload?.messages, [
    { role: 'system', content: 'system' },
    { role: 'user', content: 'latest question' },
  ]);
});

test('LLM rejects HTTP errors, invalid answers, oversized bodies and timeouts', async (t) => {
  let mode = '401';
  const baseUrl = await server(t, (_req, res) => {
    if (['401', '429', '500'].includes(mode)) { res.writeHead(Number(mode)); res.end('private error'); }
    else if (mode === 'invalid') res.end('not JSON');
    else if (mode === 'empty') res.end('{"choices":[]}');
    else if (mode === 'oversize') res.end('x'.repeat(1024 * 1024 + 1));
    // timeout mode intentionally leaves the response open.
  });
  for (const status of ['401', '429', '500']) {
    mode = status;
    await assert.rejects(complete({ ...config, baseUrl }, 's', [{ role: 'user', content: 'u' }]), new RegExp(`HTTP ${status}`));
  }
  for (mode of ['invalid', 'empty', 'oversize']) {
    await assert.rejects(complete({ ...config, baseUrl }, 's', [{ role: 'user', content: 'u' }]));
  }
  mode = 'timeout';
  await assert.rejects(complete({ ...config, baseUrl, timeoutMs: 30 }, 's', [{ role: 'user', content: 'u' }]), { name: 'TimeoutError' });
});

test('context guard rejects oversized input and shutdown aborts requests', async () => {
  await assert.rejects(complete(config, 'x'.repeat(131000), [{ role: 'user', content: 'hi' }]), /context budget/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(complete(config, 's', [{ role: 'user', content: 'u' }], controller.signal));
});

test('configuration requires channel, credentials and valid budgets', () => {
  const env = {
    GRYT_HOST: 'https://chat.inferlo.xyz', GRYT_ALLOWED_CHANNEL_ID: 'channel-1',
    GRYT_IDENTITY_PATH: './data/identity.json', LLM_BASE_URL: 'https://example.com/v1',
    LLM_MODEL: config.model, LLM_API_KEY: 'test', LLM_CONTEXT_TOKENS: '131000',
    LLM_MAX_TOKENS: '1024', LLM_TIMEOUT_MS: '60000',
  };
  assert.equal(loadConfig(env).contextTokens, 131000);
  assert.equal(loadConfig(env).timeoutMs, 60000);
  assert.equal(loadConfig({ ...env, LLM_TIMEOUT_MS: undefined }).timeoutMs, 120000);
  assert.equal(loadConfig({ ...env, LLM_TIMEOUT_MS: '180000' }).timeoutMs, 180000);
  assert.throws(() => loadConfig({ ...env, GRYT_ALLOWED_CHANNEL_ID: '' }), /GRYT_ALLOWED_CHANNEL_ID/);
  assert.throws(() => loadConfig({ ...env, LLM_API_KEY: '' }), /LLM_API_KEY/);
  assert.throws(() => loadConfig({ ...env, LLM_MAX_TOKENS: '131000' }), /leave room/);
  assert.throws(() => loadConfig({ ...env, LLM_TIMEOUT_MS: '-1' }), /positive integer/);
  assert.throws(() => loadConfig({ ...env, LLM_TIMEOUT_MS: '' }), /LLM_TIMEOUT_MS/);
});
