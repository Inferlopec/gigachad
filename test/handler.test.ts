import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Message } from '@gryt/bot';
import { createHandler, limitReply, stripOwnMention } from '../src/handler.ts';

const mention = '[@gigachad](mention:bot-123)';
function message(overrides: Partial<Message> = {}): Message {
  return {
    conversationId: 'allowed', messageId: '1', senderServerUserId: 'user-1',
    senderNickname: 'User', text: `${mention} hello`, attachments: [],
    createdAt: new Date(), editedAt: null, replyToMessageId: null, threadId: null,
    isOwn: false, isSystem: false, ...overrides,
  };
}

test('mentions compare complete IDs and ignore names, code, images, escapes and mass mentions', () => {
  assert.equal(stripOwnMention(`${mention} hello`, 'bot-123'), 'hello');
  assert.equal(stripOwnMention('[@changed](mention:bot-123) hi', 'bot-123'), 'hi');
  for (const text of [
    '@gigachad hi', '[@gigachad](mention:bot-1234)', '[@gigachad](mention:other)',
    `\`${mention}\``, `\`\`\`md\n${mention}\n\`\`\``, `~~~\n${mention}\n~~~`,
    `\\${mention}`, `!${mention}`, '[@everyone](mention:everyone)',
    '[bad](mention:bot-123 extra)', '[bad](mention:bot-123',
  ]) assert.equal(stripOwnMention(text, 'bot-123'), null, text);
  assert.equal(stripOwnMention(`\`${mention}\` ${mention} question`, 'bot-123'), `\`${mention}\`  question`);
});

test('reply truncation respects UTF-16 limit and does not split a surrogate pair', () => {
  assert.equal(limitReply('ok'), 'ok');
  const reply = limitReply('😀'.repeat(3000));
  assert.ok(reply.length <= 4000);
  assert.ok(reply.endsWith('[Response truncated]'));
  assert.ok(!/[\uD800-\uDBFF]$/.test(reply.split('\n')[0]!));
});

test('channel, self, system, readiness, permission and duplicate guards precede LLM calls', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-handler-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const promptPath = join(dir, 'system.md');
  await writeFile(promptPath, 'system one');
  const calls: { system: string; messages: unknown[] }[] = [];
  const sent: string[][] = [];
  let id: string | null = 'bot-123';
  let available = true;
  const handler = createHandler({
    channelId: 'allowed', selfId: () => id, available: () => available, promptPath,
    complete: async (system, messages) => { calls.push({ system, messages }); return 'answer'; },
    send: async (channel, text) => { sent.push([channel, text]); },
    typing: () => {}, stopTyping: () => {}, log: () => {},
  });
  for (const [index, overrides] of [
    { conversationId: 'other' }, { isOwn: true }, { senderServerUserId: 'bot-123' },
    { isSystem: true }, { text: null }, { text: '@gigachad hi' },
  ].entries()) await handler(message({ messageId: `ignored-${index}`, ...overrides }));
  id = null;
  await handler(message());
  id = 'bot-123'; available = false;
  await handler(message());
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);
  available = true;
  await handler(message());
  await handler(message());
  assert.deepEqual(calls, [{ system: 'system one', messages: [
    { role: 'user', content: 'User: @gigachad hi' },
    { role: 'user', content: 'User: hello' },
  ] }]);
  assert.deepEqual(sent, [['allowed', 'answer']]);
  await writeFile(promptPath, 'system two');
  await handler(message({ messageId: '2' }));
  assert.equal(calls[1]?.system, 'system two');
  assert.deepEqual(calls[1]?.messages, [
    { role: 'user', content: 'User: @gigachad hi' },
    { role: 'user', content: 'User: hello' },
    { role: 'assistant', content: 'answer' },
    { role: 'user', content: 'User: hello' },
  ]);
  await writeFile(promptPath, '');
  await handler(message({ messageId: '3' }));
  assert.equal(calls.length, 2);
  assert.match(sent[2]![1]!, /couldn’t complete/);
});

test('recent channel messages are included, bounded, and isolated from other channels', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-history-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const promptPath = join(dir, 'system.md');
  await writeFile(promptPath, 'system');
  let captured: unknown;
  const handler = createHandler({
    channelId: 'allowed', selfId: () => 'bot-123', available: () => true, promptPath,
    complete: async (_system, messages) => { captured = messages; return 'answer'; },
    send: async () => {}, typing: () => {}, stopTyping: () => {}, log: () => {},
  });
  for (let i = 0; i < 12; i++) {
    await handler(message({ messageId: String(i), text: `line ${i}`, senderNickname: 'Alice' }));
  }
  await handler(message({ messageId: 'outside', conversationId: 'other', text: 'secret' }));
  await handler(message({ messageId: 'self', isOwn: true, text: 'own' }));
  await handler(message({ messageId: 'ask', text: `${mention} recap` }));
  assert.deepEqual(captured, [
    ...Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `Alice: line ${i + 2}` })),
    { role: 'user', content: 'User: recap' },
  ]);
});

test('busy requests are bounded and send failures are caught without retrying', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'gigachad-busy-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const promptPath = join(dir, 'system.md');
  await writeFile(promptPath, 'system');
  let release!: (answer: string) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let requests = 0;
  const sent: string[] = [];
  const handler = createHandler({
    channelId: 'allowed', selfId: () => 'bot-123', available: () => true, promptPath,
    complete: () => { requests++; entered(); return new Promise((resolve) => { release = resolve; }); },
    send: async (_channel, text) => { sent.push(text); throw new Error('send failed'); },
    typing: () => {}, stopTyping: () => {}, log: () => {},
  });
  const first = handler(message());
  await started;
  await handler(message({ messageId: '2' }));
  assert.equal(requests, 1);
  assert.match(sent[0]!, /busy/);
  release('answer');
  await first;
  assert.equal(sent.length, 2);
});
