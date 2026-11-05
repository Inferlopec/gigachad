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
  for (let i = 0; i < 22; i++) {
    await handler(message({ messageId: String(i), text: `line ${i}`, senderNickname: 'Alice' }));
  }
  await handler(message({ messageId: 'outside', conversationId: 'other', text: 'secret' }));
  await handler(message({ messageId: 'self', isOwn: true, text: 'own' }));
  await handler(message({ messageId: 'ask', text: `${mention} recap` }));
  // Only the 4 most recent channel messages plus the trigger are sent to the model.
  assert.deepEqual(captured, [
    { role: 'user', content: 'Alice: line 18' },
    { role: 'user', content: 'Alice: line 19' },
    { role: 'user', content: 'Alice: line 20' },
    { role: 'user', content: 'Alice: line 21' },
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
  // Busy requests are silently dropped, not replied to.
  assert.equal(requests, 1);
  assert.equal(sent.length, 0);
  release('answer');
  await first;
  assert.equal(sent.length, 1);
  assert.equal(sent[0], 'answer');
});

for (const outcome of ['success', 'timeout', 'send failure']) {
  test(`typing stays active through slow requests and stops after ${outcome}`, async (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const dir = await mkdtemp(join(tmpdir(), 'gigachad-typing-'));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const promptPath = join(dir, 'system.md');
    await writeFile(promptPath, 'system');
    let finish!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pending = new Promise<string>((resolve, reject) => {
      finish = () => outcome === 'timeout'
        ? reject(new DOMException('Timed out', 'TimeoutError')) : resolve('answer');
    });
    let finishSend!: () => void;
    let enteredSend!: () => void;
    const sending = new Promise<void>((resolve) => { enteredSend = resolve; });
    const pendingSend = new Promise<void>((resolve) => { finishSend = resolve; });
    let available = true;
    const typing: string[] = [];
    const stopped: string[] = [];
    const handler = createHandler({
      channelId: 'allowed', selfId: () => 'bot-123', available: () => available, promptPath,
      complete: () => { entered(); return pending; },
      send: async () => {
        enteredSend();
        await pendingSend;
        if (outcome === 'send failure') throw new Error('send failed');
      },
      typing: (channel) => { typing.push(channel); },
      stopTyping: (channel) => { stopped.push(channel); }, log: () => {},
    });
    const request = handler(message());
    await started;
    assert.deepEqual(typing, ['allowed']);
    t.mock.timers.tick(15000);
    assert.equal(typing.length, 4);
    available = false;
    t.mock.timers.tick(5000);
    assert.equal(typing.length, 4);
    available = true;
    finish();
    await sending;
    t.mock.timers.tick(5000);
    assert.equal(typing.length, 5);
    assert.equal(stopped.length, 0);
    finishSend();
    await request;
    assert.deepEqual(stopped, ['allowed']);
    t.mock.timers.tick(15000);
    assert.equal(typing.length, 5);
  });
}
