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
  const calls: string[][] = [];
  const sent: string[][] = [];
  let id: string | null = 'bot-123';
  let available = true;
  const handler = createHandler({
    channelId: 'allowed', selfId: () => id, available: () => available, promptPath,
    complete: async (system, user) => { calls.push([system, user]); return 'answer'; },
    send: async (channel, text) => { sent.push([channel, text]); },
    typing: () => {}, stopTyping: () => {}, log: () => {},
  });
  for (const overrides of [
    { conversationId: 'other' }, { isOwn: true }, { senderServerUserId: 'bot-123' },
    { isSystem: true }, { text: null }, { text: '@gigachad hi' },
  ]) await handler(message(overrides));
  id = null;
  await handler(message());
  id = 'bot-123'; available = false;
  await handler(message());
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 0);
  available = true;
  await handler(message());
  await handler(message());
  assert.deepEqual(calls, [['system one', 'hello']]);
  assert.deepEqual(sent, [['allowed', 'answer']]);
  await writeFile(promptPath, 'system two');
  await handler(message({ messageId: '2' }));
  assert.equal(calls[1]?.[0], 'system two');
  await writeFile(promptPath, '');
  await handler(message({ messageId: '3' }));
  assert.equal(calls.length, 2);
  assert.match(sent[2]![1]!, /couldn’t complete/);
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
