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

function parseEndpoint(value: string, name: string): string {
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

function endpoint(env: NodeJS.ProcessEnv, name: string): string {
  return parseEndpoint(required(env, name), name);
}

function optionalEndpoint(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = env[name]?.trim();
  return value ? parseEndpoint(value, name) : fallback;
}

function optionalValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return env[name]?.trim() || undefined;
}

function optionalSingleLine(env: NodeJS.ProcessEnv, name: string, fallback: string): string {
  const value = optionalValue(env, name) ?? fallback;
  if (/[\r\n]/.test(value)) throw new Error(`${name} must be a single line.`);
  return value;
}

function boolean(env: NodeJS.ProcessEnv, name: string, fallback: boolean): boolean {
  const value = optionalValue(env, name)?.toLowerCase();
  if (value === undefined) return fallback;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function singleLine(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be a single line without control characters.`);
  return value;
}

export type GrytConfig = { host: string; nickname: string; identityPath: string; botToken?: string };

export function loadGrytHost(value: string): string {
  return endpoint({ GRYT_HOST: value }, 'GRYT_HOST');
}

// Setup validates the same Gryt fields as runtime without requiring an LLM yet.
export function loadGrytConfig(env: NodeJS.ProcessEnv): GrytConfig {
  const botToken = env.GRYT_BOT_TOKEN?.trim() || undefined;
  if (botToken && /[\x00-\x1f\x7f]/.test(botToken)) throw new Error('GRYT_BOT_TOKEN must be a single line without control characters.');
  return {
    host: loadGrytHost(required(env, 'GRYT_HOST')),
    nickname: singleLine(env, 'GRYT_NICKNAME'),
    identityPath: singleLine(env, 'GRYT_IDENTITY_PATH'),
    botToken,
  };
}

export function loadChannelId(value: string): string {
  return singleLine({ GRYT_ALLOWED_CHANNEL_ID: value }, 'GRYT_ALLOWED_CHANNEL_ID');
}

export type LlmConfig = {
  baseUrl: string;
  model: string;
  apiKey: string;
  contextTokens: number;
  maxTokens: number;
  timeoutMs: number;
};

export function loadLlmEndpoint(value: string): string {
  return endpoint({ LLM_BASE_URL: value }, 'LLM_BASE_URL');
}

// Match the runtime's conservative byte budget, reserving the full configured
// output even though the setup probe requests only a short answer.
export function validateLlmPrompt(config: LlmConfig, prompt: string): void {
  if (!prompt.trim()) throw new Error('System prompt must not be empty.');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(prompt)) throw new Error('System prompt contains unsupported control characters.');
  const inputBytes = Buffer.byteLength(prompt, 'utf8') + Buffer.byteLength('Reply with OK.', 'utf8') + 32;
  if (inputBytes + config.maxTokens + 256 > config.contextTokens) {
    throw new Error('Prompt and connection check exceed the configured context budget.');
  }
}

export function loadLlmConfig(env: NodeJS.ProcessEnv): LlmConfig {
  const config = {
    baseUrl: loadLlmEndpoint(required(env, 'LLM_BASE_URL')),
    model: singleLine(env, 'LLM_MODEL'),
    apiKey: singleLine(env, 'LLM_API_KEY'),
    contextTokens: integer(env, 'LLM_CONTEXT_TOKENS'),
    maxTokens: integer(env, 'LLM_MAX_TOKENS'),
    timeoutMs: integer(env, 'LLM_TIMEOUT_MS', 120_000),
  };
  if (config.maxTokens + 256 >= config.contextTokens) throw new Error('LLM_MAX_TOKENS must leave room for input.');
  return config;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const llm = loadLlmConfig(env);
  const { baseUrl, model, apiKey } = llm;
  const searchEnabled = boolean(env, 'SEARCH_ENABLED', false);
  const config = {
    ...loadGrytConfig(env),
    channelId: loadChannelId(required(env, 'GRYT_ALLOWED_CHANNEL_ID')),
    promptPath: env.SYSTEM_PROMPT_PATH === undefined ? 'prompts/system.md' : required(env, 'SYSTEM_PROMPT_PATH'),
    baseUrl,
    model,
    apiKey,
    contextTokens: llm.contextTokens,
    maxTokens: llm.maxTokens,
    timeoutMs: llm.timeoutMs,
    searchEnabled,
    // Search query extraction inherits the main API settings unless explicitly
    // overridden. These separate fields let the future CLI configure a search
    // model independently without requiring a second API configuration today.
    searchLlmBaseUrl: searchEnabled ? optionalEndpoint(env, 'SEARCH_LLM_BASE_URL', baseUrl) : baseUrl,
    searchLlmApiKey: searchEnabled ? optionalSingleLine(env, 'SEARCH_LLM_API_KEY', apiKey) : apiKey,
    searchLlmModel: searchEnabled ? optionalSingleLine(env, 'SEARCH_LLM_MODEL', model) : model,
    // Extraction is a tiny single-line task: short output budget and a short
    // timeout so a stalled extraction degrades to "no search" quickly.
    searchLlmTimeoutMs: searchEnabled ? integer(env, 'SEARCH_LLM_TIMEOUT_MS', 8_000) : 8_000,
    searchLlmMaxTokens: searchEnabled ? integer(env, 'SEARCH_LLM_MAX_TOKENS', 100) : 100,
    searchLlmContextTokens: searchEnabled ? integer(env, 'SEARCH_LLM_CONTEXT_TOKENS', 8_192) : 8_192,
    searchTimeoutMs: searchEnabled ? integer(env, 'SEARCH_TIMEOUT_MS', 10_000) : 10_000,
    searchMaxResults: searchEnabled ? integer(env, 'SEARCH_MAX_RESULTS', 5) : 5,
    searchRateLimit: searchEnabled ? integer(env, 'SEARCH_RATE_LIMIT', 5) : 5,
    searchRateWindowMs: searchEnabled ? integer(env, 'SEARCH_RATE_WINDOW_MS', 60_000) : 60_000,
    searchCacheTtlMs: searchEnabled ? integer(env, 'SEARCH_CACHE_TTL_MS', 300_000) : 300_000,
  };
  if (/[\r\n]/.test(config.nickname)) throw new Error('GRYT_NICKNAME must be a single line.');
  if (searchEnabled && config.searchLlmMaxTokens + 256 >= config.searchLlmContextTokens) {
    throw new Error('SEARCH_LLM_MAX_TOKENS must leave room for input.');
  }
  return config;
}

export type Config = ReturnType<typeof loadConfig>;
