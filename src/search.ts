import type { Config } from './config.ts';

export type SearchResult = {
  title: string;
  url: string;
  content: string;
  engine: string;
  score: number;
};

export type SearchConfig = Pick<
  Config,
  | 'searxngUrl'
  | 'searchTimeoutMs'
  | 'searchMaxResults'
  | 'searchRateLimit'
  | 'searchRateWindowMs'
  | 'searchCacheTtlMs'
>;

export type SearchState = {
  limiter: RateLimiter;
  breaker: CircuitBreaker;
  cache: Map<string, { results: SearchResult[]; at: number }>;
};

export function createSearchState(config: SearchConfig): SearchState {
  return {
    limiter: new RateLimiter(config.searchRateLimit, config.searchRateWindowMs),
    breaker: new CircuitBreaker(3, 60_000),
    cache: new Map(),
  };
}

export function describeSearchFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'Unexpected search failure';
  if (error.name === 'TimeoutError') return 'Search request timed out';
  if (error.name === 'AbortError') return 'Search request aborted';
  if (error instanceof SyntaxError) return 'Search returned invalid JSON';
  if (/^Search HTTP \d{3}$/.test(error.message)) return error.message;
  if (error instanceof TypeError && error.message === 'fetch failed') return 'Search network or TLS connection failed';
  return 'Unexpected search failure';
}

type SearxngResult = {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  engine?: unknown;
  score?: unknown;
};

type SearxngResponse = {
  results?: SearxngResult[];
};

export class RateLimiter {
  private readonly max: number;
  private readonly windowMs: number;
  private timestamps: number[] = [];

  constructor(max: number, windowMs: number) {
    this.max = max;
    this.windowMs = windowMs;
  }

  tryAcquire(now: number = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((ts) => ts > cutoff);
    if (this.timestamps.length >= this.max) return false;
    this.timestamps.push(now);
    return true;
  }
}

export class CircuitBreaker {
  private readonly threshold: number;
  private readonly cooldownMs: number;
  private failures = 0;
  private openUntil = 0;

  constructor(threshold: number, cooldownMs: number) {
    this.threshold = threshold;
    this.cooldownMs = cooldownMs;
  }

  // When the breaker is open (failures >= threshold) but the cooldown has
  // expired, reset the failure count so the next attempt starts from a clean
  // slate. This prevents a single failure during the half-open window from
  // immediately re-opening the breaker for another full cooldown.
  isClosed(now: number = Date.now()): boolean {
    if (this.failures < this.threshold) return true;
    if (now < this.openUntil) return false;
    this.failures = 0;
    this.openUntil = 0;
    return true;
  }

  recordSuccess(): void {
    this.failures = 0;
    this.openUntil = 0;
  }

  recordFailure(now: number = Date.now()): void {
    this.failures++;
    if (this.failures >= this.threshold) {
      this.openUntil = now + this.cooldownMs;
    }
  }
}

export function normalizeQuery(query: string): string {
  return query.toLowerCase().trim().replace(/\s+/g, ' ');
}

const CONTENT_LIMIT = 300;

function toSearchResult(raw: SearxngResult, index: number): SearchResult {
  const title = typeof raw.title === 'string' ? raw.title.slice(0, 200) : '';
  const url = typeof raw.url === 'string' ? raw.url : '';
  let content = typeof raw.content === 'string' ? raw.content : '';
  if (content.length > CONTENT_LIMIT) {
    content = content.slice(0, CONTENT_LIMIT);
    const lastSpace = content.lastIndexOf(' ');
    if (lastSpace > CONTENT_LIMIT - 50) content = content.slice(0, lastSpace);
    content += '…';
  }
  return {
    title,
    url,
    content,
    engine: typeof raw.engine === 'string' ? raw.engine : '',
    score: typeof raw.score === 'number' ? raw.score : index + 1,
  };
}

export async function searchWeb(
  query: string,
  config: SearchConfig,
  state: SearchState,
  shutdown?: AbortSignal,
): Promise<SearchResult[]> {
  const url = config.searxngUrl;
  if (!url) return [];
  if (shutdown?.aborted) return [];
  if (!state.breaker.isClosed()) return [];

  const key = normalizeQuery(query);
  if (!key) return [];

  const now = Date.now();
  const cached = state.cache.get(key);
  if (cached && now - cached.at < config.searchCacheTtlMs) {
    return cached.results;
  }

  if (!state.limiter.tryAcquire(now)) {
    return cached?.results ?? [];
  }

  const endpoint = new URL('/search', url);
  endpoint.searchParams.set('q', query);
  endpoint.searchParams.set('format', 'json');

  const timeout = AbortSignal.timeout(config.searchTimeoutMs);
  const signal = shutdown ? AbortSignal.any([timeout, shutdown]) : timeout;

  let response: Response;
  try {
    response = await fetch(endpoint.href, { signal, redirect: 'error' });
  } catch {
    state.breaker.recordFailure(now);
    return cached?.results ?? [];
  }

  if (!response.ok) {
    await response.body?.cancel();
    state.breaker.recordFailure(now);
    return cached?.results ?? [];
  }

  let data: SearxngResponse;
  try {
    const body = await response.text();
    data = JSON.parse(body);
  } catch {
    state.breaker.recordFailure(now);
    return cached?.results ?? [];
  }

  const results = (data.results ?? []).slice(0, config.searchMaxResults).map(toSearchResult);
  state.breaker.recordSuccess();
  // Only cache non-empty results. Caching an empty list would suppress a
  // follow-up request for the same query for the full TTL, even if SearXNG
  // later has something to return (e.g. after a transient engine failure).
  if (results.length) state.cache.set(key, { results, at: now });

  if (state.cache.size > 200) {
    const cutoff = now - config.searchCacheTtlMs;
    for (const [k, entry] of state.cache) {
      if (entry.at <= cutoff) state.cache.delete(k);
    }
  }

  return results;
}

export function formatSearchResults(query: string, results: SearchResult[]): string {
  if (!results.length) return '';
  const lines = results.map((r, i) => {
    const title = r.title || r.url || 'Источник';
    const content = r.content ? ` — ${r.content}` : '';
    return `${i + 1}. ${title}${content}\n   Источник: ${r.url}`;
  });
  return [
    `Веб-поиск по запросу «${query}»`,
    ...lines,
    '',
    'Используй эти результаты при ответе. Указывай источники. Если результаты нерелевантны — ответь по своим знаниям.',
  ].join('\n');
}