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
  const value = required(env, name);
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('Invalid endpoint');
    }
    return url.href.replace(/\/+$/, '');
  } catch {
    // URL errors can include supplied values and embedded secrets.
    throw new Error(`${name} must be an HTTP(S) URL without credentials, query or fragment.`);
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const config = {
    host: endpoint(env, 'GRYT_HOST'),
    nickname: required(env, 'GRYT_NICKNAME'),
    channelId: required(env, 'GRYT_ALLOWED_CHANNEL_ID'),
    identityPath: required(env, 'GRYT_IDENTITY_PATH'),
    promptPath: env.SYSTEM_PROMPT_PATH === undefined ? 'prompts/system.md' : required(env, 'SYSTEM_PROMPT_PATH'),
    botToken: env.GRYT_BOT_TOKEN?.trim() || undefined,
    baseUrl: endpoint(env, 'LLM_BASE_URL'),
    model: required(env, 'LLM_MODEL'),
    apiKey: required(env, 'LLM_API_KEY'),
    contextTokens: integer(env, 'LLM_CONTEXT_TOKENS'),
    maxTokens: integer(env, 'LLM_MAX_TOKENS'),
    timeoutMs: integer(env, 'LLM_TIMEOUT_MS', 120_000),
    searxngUrl: env.SEARXNG_URL?.trim() || undefined,
    // Independently configurable extraction model at the same endpoint.
    // It may be the same model as LLM_MODEL.
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
  if (/[\r\n]/.test(config.nickname)) throw new Error('GRYT_NICKNAME must be a single line.');
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
