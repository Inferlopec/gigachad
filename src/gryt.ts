import { GrytBot, loadIdentity } from '@gryt/bot';
import type { GrytBotOptions, Message } from '@gryt/bot';
import type { GrytConfig } from './config.ts';
import { acquireIdentityLease } from './identityLease.ts';

export type GrytProgress = 'identity-loaded' | 'connecting' | 'waiting' | 'ready';

export type GrytClient = Pick<GrytBot,
  'on' | 'off' | 'start' | 'stop' | 'socket' | 'permissions' | 'channels' | 'send' | 'typing' | 'stopTyping'>;
export type GrytIntegration = {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  selfId: () => string | null;
  available: () => boolean;
  channels: () => { id: string; name: string }[];
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
  onProgress?: (event: GrytProgress) => void;
};

// Only this module knows about SDK 0.3.1's socket timing and private self-ID.
export function createGrytIntegration(config: GrytConfig & { channelId?: string }, deps: Dependencies): GrytIntegration {
  let bot: GrytClient | undefined;
  let socket: GrytClient['socket'] = null;
  let selfId: string | null = null;
  let stopped = false;
  let startup: Promise<void> | undefined;
  let stopping: Promise<void> | undefined;
  let lease: Awaited<ReturnType<typeof acquireIdentityLease>> | undefined;
  let loading: ReturnType<typeof loadIdentity> | undefined;
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
  const onWaiting = () => {
    deps.log('Waiting for administrator approval.');
    deps.onProgress?.('waiting');
  };
  const onReady = () => {
    deps.log('Gryt connection ready.');
    deps.onProgress?.('ready');
    if (config.channelId && !bot?.channels.some((channel) => channel.id === config.channelId)) {
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
      let disconnected = false;
      try { await bot?.stop(); disconnected = true; }
      finally {
        cleanup();
        // SDK identity generation is not abortable. Keep ownership until that
        // write settles, even though approval/start cancellation settles now.
        if (!disconnected) {
          // Keep ownership if the SDK could not confirm shutdown.
          deps.logError('Gryt shutdown failed; identity lock retained.');
        } else if (loading) {
          void loading.then(() => lease?.release(), () => lease?.release())
            .catch(() => deps.logError('Could not release identity lock.'));
        } else await lease?.release();
      }
    })();
  };
  const start = async () => {
    if (stopped) return;
    try {
      lease = await acquireIdentityLease(config.identityPath);
      if (stopped) { await lease.release(); return; }
      loading = (deps.loadIdentity ?? loadIdentity)(lease.path);
      void loading.finally(() => { loading = undefined; }).catch(() => {});
      const identity = await Promise.race([
        loading,
        stopRequested.then(() => undefined),
      ]);
      if (stopped || !identity) return;
      deps.log('Bot identity loaded.');
      deps.onProgress?.('identity-loaded');
      if (stopped) return;
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
      deps.onProgress?.('connecting');
      if (stopped) return;
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
    channels: () => available() ? (bot?.channels ?? [])
      .filter((channel) => channel.type === 'text')
      .map(({ id, name }) => ({ id, name })) : [],
    send: async (channel, text) => {
      if (!available() || !bot) throw new Error('Gryt connection unavailable');
      return bot.send(channel, text);
    },
    typing: (channel) => { if (available()) bot?.typing(channel); },
    stopTyping: (channel) => { if (available()) bot?.stopTyping(channel); },
  };
}
