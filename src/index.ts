import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { GrytBot, loadIdentity } from '@gryt/bot';
import { loadConfig } from './config.ts';
import { createHandler } from './handler.ts';
import { complete } from './llm.ts';

const log = (msg: string) => console.log(`[${new Date().toISOString()}] [gigachad] ${msg}`);
const logErr = (msg: string) => console.error(`[${new Date().toISOString()}] [gigachad] ${msg}`);

async function main() {
  let config: ReturnType<typeof loadConfig>;
  try { config = loadConfig(); }
  catch (error) {
    logErr(error instanceof Error ? error.message : 'Invalid .env configuration.');
    process.exitCode = 1;
    return;
  }
  await mkdir(dirname(resolve(config.identityPath)), { recursive: true, mode: 0o700 });
  const identity = await loadIdentity(config.identityPath);
  log(`Identity loaded from ${config.identityPath}`);
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
    log: logErr,
  });
  bot.on('message', (message) => { void handler(message).catch(() => logErr('Message handler failed.')); });
  bot.on('error', (err) => {
    const code = (err as { code?: string }).code;
    logErr(`SDK error${code ? ` [${code}]` : ''}: ${err.message}`);
  });
  bot.on('waiting', (reason) => log(`Waiting for administrator approval: ${reason}`));
  bot.on('disconnected', (reason) => {
    joined = false;
    selfId = null;
    log(`Disconnected (${reason}); SDK will reconnect.`);
  });
  bot.on('ready', (info) => {
    log(`Ready on ${info.name} (server ${info.serverId}). Permissions: ${info.permissions.join(', ') || 'none'}. Role: ${info.role || 'unknown'}.`);
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      log(`Received ${signal}; shutting down.`);
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
      log(`Server join confirmed. Bot ID: ${selfId}.`);
    } catch { logErr('Cannot identify this bot; messages will be ignored.'); }
  });
  try { await starting; }
  catch (error) { await bot.stop(); throw error; }
  if (!bot.channels.some((channel) => channel.id === config.channelId)) {
    logErr('Configured channel is not visible. Check GRYT_ALLOWED_CHANNEL_ID and channel access.');
  }
  if (!available()) logErr('Missing bot identity or read_messages/send_messages permission.');
}

main().catch(() => {
  logErr('Startup failed. Check .env, identity storage, registration, and connectivity.');
  process.exitCode = 1;
});
