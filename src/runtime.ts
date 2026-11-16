import { resolve } from 'node:path';
import type { Message } from '@gryt/bot';
import type { Config } from './config.ts';
import { createGrytIntegration, type GrytIntegration } from './gryt.ts';
import { createHandler } from './handler.ts';
import { complete } from './llm.ts';
import { extractSearchQuery } from './searchQuery.ts';
import { searchWeb, createSearchState } from './search.ts';

export type Runtime = { start: () => Promise<void>; stop: () => Promise<void> };
type Dependencies = {
  log: (message: string) => void;
  logError: (message: string) => void;
  createGryt?: (config: Config, onMessage: (message: Message) => void) => GrytIntegration;
  complete?: typeof complete;
  extractQuery?: typeof extractSearchQuery;
  search?: typeof searchWeb;
};

export function createRuntime(config: Config, deps: Dependencies): Runtime {
  const shutdown = new AbortController();
  const pending = new Set<Promise<void>>();
  const onMessage = (message: Message) => {
    const task = handler(message).catch(() => deps.logError('Message handler failed.'));
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };
  const gryt = deps.createGryt
    ? deps.createGryt(config, onMessage)
    : createGrytIntegration(config, { onMessage, log: deps.log, logError: deps.logError });
  const searchState = config.searxngUrl ? createSearchState(config) : null;
  const searchModel = config.searchLlmModel;
  const handler = createHandler({
    channelId: config.channelId,
    selfId: gryt.selfId,
    available: () => !shutdown.signal.aborted && gryt.available(),
    promptPath: resolve(config.promptPath),
    complete: (system, messages) => (deps.complete ?? complete)(config, system, messages, shutdown.signal),
    send: gryt.send, typing: gryt.typing, stopTyping: gryt.stopTyping,
    log: deps.logError,
    ...(searchState && searchModel ? {
      extractQuery: (conversation) => (deps.extractQuery ?? extractSearchQuery)(conversation, {
        config: {
          baseUrl: config.baseUrl, apiKey: config.apiKey, model: searchModel,
          timeoutMs: config.searchLlmTimeoutMs, maxTokens: config.searchLlmMaxTokens,
          contextTokens: config.searchLlmContextTokens,
        },
        log: deps.logError, shutdown: shutdown.signal,
      }),
      search: (query: string) => (deps.search ?? searchWeb)(query, config, searchState, shutdown.signal),
    } : {}),
  });
  let stopping: Promise<void> | undefined;
  const stop = () => {
    shutdown.abort();
    return stopping ??= (async () => {
      try { await gryt.stop(); }
      finally { await Promise.allSettled(pending); }
    })();
  };
  return {
    start: async () => {
      if (shutdown.signal.aborted) return;
      try { await gryt.start(); }
      catch (error) {
        await stop();
        throw error;
      }
    },
    stop,
  };
}
