import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { GrytBot, loadIdentity } from '@gryt/bot';
import { loadConfig } from './config.ts';
import { createHandler } from './handler.ts';
import { complete } from './llm.ts';

async function main() {
  let config: ReturnType<typeof loadConfig>;
  try { config = loadConfig(); }
  catch (error) {
    console.error(error instanceof Error ? error.message : 'Invalid .env configuration.');
    process.exitCode = 1;
    return;
  }
  await mkdir(dirname(resolve(config.identityPath)), { recursive: true, mode: 0o700 });
  const identity = await loadIdentity(config.identityPath);
  const shutdown = new AbortController();
  const bot = new GrytBot({
    host: config.host,
    nickname: 'gigachad',
    identity,
    wants: ['read_messages', 'send_messages'],
    description: 'Answers direct mentions in one configured channel.',
    botToken: config.botToken,
    prefix: '',
    helpCommand: false,
  });
  let selfId: string | null = null;
  let joined = false;
  const available = () => joined && !shutdown.signal.aborted &&
    bot.permissions.includes('read_messages') && bot.permissions.includes('send_messages');
  const handler = createHandler({
    channelId: config.channelId,
    selfId: () => selfId,
    available,
    promptPath: resolve('prompts/system.md'),
    complete: (system, messages) => complete(config, system, messages, shutdown.signal),
    send: (channel, text) => bot.send(channel, text),
    typing: (channel) => bot.typing(channel),
    stopTyping: (channel) => bot.stopTyping(channel),
    log: console.error,
  });
  bot.on('message', (message) => { void handler(message).catch(() => console.error('Message handler failed.')); });
  bot.on('error', () => console.error('Gryt reported an error. Check registration, permissions, and connectivity.'));
  bot.on('waiting', () => console.log('Waiting for administrator approval in Server settings → Bots.'));
  bot.on('disconnected', () => { joined = false; selfId = null; console.log('Gryt disconnected; SDK will reconnect.'); });
  bot.on('ready', () => console.log('gigachad ready.'));
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      shutdown.abort();
      void bot.stop().catch(() => { process.exitCode = 1; });
    });
  }

  // With a preloaded identity, start() creates the socket synchronously before returning.
  // SDK 0.3.1 has no public self-ID getter. Mirror its server:joined claim extraction.
  const starting = bot.start();
  bot.socket!.on('server:joined', (payload: { accessToken?: string }) => {
    selfId = null;
    joined = false;
    try {
      const part = payload.accessToken?.split('.')[1];
      const claims = JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));
      if (typeof claims.serverUserId !== 'string' || !claims.serverUserId) throw new Error('Missing ID');
      selfId = claims.serverUserId;
      joined = true;
    } catch { console.error('Cannot identify this bot; messages will be ignored.'); }
  });
  try { await starting; }
  catch (error) { await bot.stop(); throw error; }
  if (!bot.channels.some((channel) => channel.id === config.channelId)) {
    console.error('Configured channel is not visible. Check GRYT_ALLOWED_CHANNEL_ID and channel access.');
  }
  if (!available()) console.error('Missing bot identity or read_messages/send_messages permission.');
}

main().catch(() => {
  console.error('Startup failed. Check .env, identity storage, registration, and connectivity.');
  process.exitCode = 1;
});
