import type { ChatMessage, SearchLlmConfig } from './llm.ts';
import { completeSearchQuery, describeLlmFailure } from './llm.ts';

// System prompt for the extraction model. It is intentionally strict:
//  - one query, not a list (SearXNG ranks a single focused query better);
//  - keywords only, no question words or greetings;
//  - the model may answer NOSEARCH when a web lookup is not warranted, which
//    is how we keep the expensive SearXNG round-trip "only when needed";
//  - it is allowed to resolve vague references against the recent history so
//    a short follow-up like "а что нового?" becomes a concrete query.
export const EXTRACT_SYSTEM = `Ты — модуль извлечения поискового запроса.
Из диалога (последние сообщения + текущий вопрос) составь ОДНУ поисковую фразу для веб-поиска.

Правила:
- Ответь ровно одной строкой. Без кавычек, без «запрос:», без объяснений.
- Только ключевые слова и имена; без вопросительных слов, обращений и вежливости.
- Если вопрос неоднозначен или ссылается на что-то из диалога («а что с этим?», «сколько он весит?») — подставь конкретное имя/тему из последних сообщений.
- Для технических тем (IT, наука, продукты) ищи на английском; для локальных новостей, людей и событий — на языке вопроса.
- Если веб-поиск НЕ нужен — ответь ровно: NOSEARCH. Это: приветствия и благодарности, уточнения к предыдущему ответу, тривиальные факты, вопросы о том, что уже обсуждалось, и любые просьбы без фактологического вопроса.

Примеры:
«сколько весит iPhone 16?» → iphone 16 weight specs
«что нового по Rust в этом году?» → rust 2026 release changelog
«спасибо, помогло» → NOSEARCH
«а что с этим, который ты упоминал?» (контекст: квантовые компьютеры) → quantum computers latest research`;

export type ExtractDeps = {
  config: SearchLlmConfig;
  log: (message: string) => void;
  shutdown?: AbortSignal;
};

// Minimum message length worth an extraction call. Short greetings and
// thanks never need the web, so skip the (cheap but nonzero) LLM call.
const MIN_QUERY_LENGTH = 15;
// A "query" longer than this is the model rambling, not searching — drop it.
const MAX_QUERY_LENGTH = 200;
const NO_SEARCH = 'NOSEARCH';

function parseQuery(raw: string): string | null {
  let query = raw.trim()
    .replace(/["'`]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!query) return null;
  if (query.toUpperCase() === NO_SEARCH) return null;
  // If the model ignored the "one line" rule and emitted several, keep the
  // first — a single focused query ranks better than a merged bag of terms.
  query = query.split(/\n|;|(?<!\w)\|(?!\w)/)[0]!.trim();
  if (!query || query.toUpperCase() === NO_SEARCH) return null;
  if (query.length > MAX_QUERY_LENGTH) return null;
  return query;
}

// Extract a web-search query from the current message and recent context.
// Returns null when no search should run (short message, NOSEARCH, garbage
// output, or any LLM error). Failures are logged, never propagated — the
// final answer must not depend on the search succeeding.
export async function extractSearchQuery(
  userText: string,
  history: ChatMessage[],
  deps: ExtractDeps,
): Promise<string | null> {
  if (userText.trim().length < MIN_QUERY_LENGTH) return null;
  try {
    const raw = await completeSearchQuery(
      deps.config,
      EXTRACT_SYSTEM,
      [...history, { role: 'user', content: userText }],
      deps.shutdown,
    );
    const query = parseQuery(raw);
    if (!query) deps.log('Search skipped: extraction returned no usable query.');
    return query;
  } catch (error) {
    deps.log(`Search query extraction failed: ${describeLlmFailure(error)}.`);
    return null;
  }
}
