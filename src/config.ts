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
    // Dedicated model for extracting the web-search query from the user's
    // message. Kept separate from LLM_MODEL so the extraction call (small,
    // fast) does not compete for the same inference slot as the final answer.
    searchLlmModel: env.SEARCH_LLM_MODEL?.trim() || undefined,
    // Extraction is a tiny single-line task: short output budget and a short
    // timeout so a stalled extraction degrades to "no search" quickly.
    searchLlmTimeoutMs: integer(env, 'SEARCH_LLM_TIMEOUT_MS', 8_000),
    searchLlmMaxTokens: integer(env, 'SEARCH_LLM_MAX_TOKENS', 100),
    searchLlmContextTokens: integer(env, 'SEARCH_LLM_CONTEXT_TOKENS', 8_192),
    searchTimeoutMs: integer(env, 'SEARCH_TIMEOUT_MS', 10_000),
    searchMaxResults: integer(env, 'SEARCH_MAX_RESULTS', 5),
    searchRateLimit: integer(env, 'SEARCH_RATE_LIMIT', 5),
    searchRateWindowMs: integer(env, 'SEARCH_RATE_WINDOW_MS', 60_000),
    searchCacheTtlMs: integer(env, 'SEARCH_CACHE_TTL_MS', 300_000),
  };
  if (config.maxTokens + 256 >= config.contextTokens) throw new Error('LLM_MAX_TOKENS must leave room for input.');
  if (config.searchLlmMaxTokens + 256 >= config.searchLlmContextTokens) {
    throw new Error('SEARCH_LLM_MAX_TOKENS must leave room for input.');
  }
  if (config.searxngUrl && !config.searchLlmModel) {
    throw new Error('SEARXNG_URL is set, so SEARCH_LLM_MODEL must be set too (search needs a model to extract the query).');
  }
  return config;
}

export type Config = ReturnType<typeof loadConfig>;
