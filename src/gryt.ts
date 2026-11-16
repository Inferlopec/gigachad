import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { GrytBot, loadIdentity } from '@gryt/bot';
import type { GrytBotOptions, Message } from '@gryt/bot';
import type { Config } from './config.ts';

export type GrytClient = Pick<GrytBot,
  'on' | 'off' | 'start' | 'stop' | 'socket' | 'permissions' | 'channels' | 'send' | 'typing' | 'stopTyping'>;
export type GrytIntegration = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  selfId: () => string | null;
  available: () => boolean;
  send: (channel: string, text: string) => Promise<unknown>;
  typing: (channel: string) => void;
  stopTyping: (channel: string) => void;
};
type Dependencies = {
  onMessage: (message: Message) => void;
  log: (message: string) => void;
  logError: (message: string) => void;
  createBot?: (options: GrytBotOptions) => GrytClient;
  loadIdentity?: typeof loadIdentity;
};

// Only this module knows about SDK 0.3.1's socket timing and private self-ID.
export function createGrytIntegration(config: Config, deps: Dependencies): GrytIntegration {
  let bot: GrytClient | undefined;
  let socket: GrytClient['socket'] = null;
  let selfId: string | null = null;
  let stopped = false;
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let finishWaiting!: () => void;
  const stopRequested = new Promise<void>((resolve) => { finishWaiting = resolve; });
  const available = () => !stopped && selfId !== null && !!bot &&
    bot.permissions.includes('read_messages') && bot.permissions.includes('send_messages');
  const onJoined = (payload: unknown) => {
    selfId = null;
    if (stopped) return;
    try {
      const token = (payload as { accessToken?: unknown } | null)?.accessToken;
      if (typeof token !== 'string') throw new Error('Missing token');
      const part = token.split('.')[1];
      const claims: unknown = JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8'));
      const id = (claims as { serverUserId?: unknown } | null)?.serverUserId;
      if (typeof id !== 'string' || !id.trim()) throw new Error('Missing ID');
      // Identification only; SDK/server remain responsible for authorization.
      selfId = id;
      deps.log('Server join confirmed.');
    } catch {
      deps.logError('Cannot identify this bot; messages will be ignored.');
    }
  };
  const onDisconnected = () => {
    selfId = null;
    if (!stopped) deps.log('Disconnected; SDK will reconnect.');
  };
  const onError = () => deps.logError('Gryt SDK error. Check registration, permissions and connectivity.');
  const onWaiting = () => deps.log('Waiting for administrator approval.');
  const onReady = () => {
    deps.log('Gryt connection ready.');
    if (!bot?.channels.some((channel) => channel.id === config.channelId)) {
      deps.logError('Configured channel is not visible. Check GRYT_ALLOWED_CHANNEL_ID and channel access.');
    }
  };
  const cleanup = () => {
    socket?.off('server:joined', onJoined);
    bot?.off('message', deps.onMessage);
    bot?.off('disconnected', onDisconnected);
    bot?.off('waiting', onWaiting);
    bot?.off('ready', onReady);
    bot?.off('error', onError);
  };
  const stop = (): Promise<void> => {
    stopped = true;
    selfId = null;
    finishWaiting();
    return stopping ??= (async () => {
      try { await bot?.stop(); }
      finally { cleanup(); }
    })();
  };
  const start = async () => {
    if (stopped) return;
    try {
      await mkdir(dirname(resolve(config.identityPath)), { recursive: true, mode: 0o700 });
      if (stopped) return;
      const identity = await Promise.race([
        (deps.loadIdentity ?? loadIdentity)(config.identityPath),
        stopRequested.then(() => undefined),
      ]);
      if (stopped || !identity) return;
      deps.log('Bot identity loaded.');
      bot = (deps.createBot ?? ((options) => new GrytBot(options)))({
        host: config.host, nickname: config.nickname, identity,
        wants: ['read_messages', 'send_messages'],
        description: 'Answers direct mentions in one configured channel.',
        botToken: config.botToken, prefix: '', helpCommand: false,
      });
      bot.on('message', deps.onMessage);
      bot.on('error', onError);
      bot.on('waiting', onWaiting);
      bot.on('disconnected', onDisconnected);
      bot.on('ready', onReady);
      // With preloaded identity, SDK 0.3.1 creates its socket before start returns.
      const starting = bot.start();
      void starting.catch(() => {});
      socket = bot.socket;
      if (!socket) throw new Error('Gryt SDK did not create a socket');
      socket.on('server:joined', onJoined);
      // SDK stop() does not settle start() while approval is pending.
      await Promise.race([starting, stopRequested]);
      if (!stopped && !available()) {
        deps.logError('Missing bot identity or read_messages/send_messages permission.');
      }
    } catch (error) {
      await stop();
      throw error;
    }
  };
  return {
    start: () => startup ??= start(), stop,
    selfId: () => selfId, available,
    send: async (channel, text) => {
      if (!available() || !bot) throw new Error('Gryt connection unavailable');
      return bot.send(channel, text);
    },
    typing: (channel) => { if (available()) bot?.typing(channel); },
    stopTyping: (channel) => { if (available()) bot?.stopTyping(channel); },
  };
}
