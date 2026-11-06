function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env.`);
  return value;
}

function integer(env: NodeJS.ProcessEnv, name: string, fallback?: number): number {
  const value = env[name] === undefined && fallback !== undefined ? fallback : Number(required(env, name));
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function endpoint(env: NodeJS.ProcessEnv, name: string): string {
  const url = new URL(required(env, name));
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment.`);
  }
  return url.href.replace(/\/+$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = {
    host: endpoint(env, 'GRYT_HOST'),
    channelId: required(env, 'GRYT_ALLOWED_CHANNEL_ID'),
    identityPath: required(env, 'GRYT_IDENTITY_PATH'),
    botToken: env.GRYT_BOT_TOKEN?.trim() || undefined,
    baseUrl: endpoint(env, 'LLM_BASE_URL'),
    model: required(env, 'LLM_MODEL'),
    apiKey: required(env, 'LLM_API_KEY'),
    contextTokens: integer(env, 'LLM_CONTEXT_TOKENS'),
    maxTokens: integer(env, 'LLM_MAX_TOKENS'),
    timeoutMs: integer(env, 'LLM_TIMEOUT_MS', 120_000),
    searxngUrl: env.SEARXNG_URL?.trim() || undefined,
    searchTimeoutMs: integer(env, 'SEARCH_TIMEOUT_MS', 15_000),
    searchMaxResults: integer(env, 'SEARCH_MAX_RESULTS', 3),
    searchRateLimit: integer(env, 'SEARCH_RATE_LIMIT', 5),
    searchRateWindowMs: integer(env, 'SEARCH_RATE_WINDOW_MS', 60_000),
    searchCacheTtlMs: integer(env, 'SEARCH_CACHE_TTL_MS', 300_000),
  };
  if (config.maxTokens + 256 >= config.contextTokens) throw new Error('LLM_MAX_TOKENS must leave room for input.');
  return config;
}

export type Config = ReturnType<typeof loadConfig>;
