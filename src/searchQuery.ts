import type { ChatMessage, SearchLlmConfig } from './llm.ts';
import { completeSearchQuery, describeLlmFailure } from './llm.ts';

// System prompt for the extraction model. It is intentionally strict:
//  - one query, not a list (SearXNG ranks a single focused query better);
//  - keywords only, no question words or greetings;
//  - the model may answer NOSEARCH when a web lookup is not warranted, which
//    is how we keep the expensive SearXNG round-trip "only when needed";
//  - it is allowed to resolve vague references against the recent history so
//    a short follow-up like "а что нового?" becomes a concrete query;
//  - the sender's nickname (the "Name:" prefix in chat messages) is the person
//    ASKING, not the topic — the model must not fold it into the query. (A
//    deterministic stripSenderNicknames pass in code backstops this.)
export const EXTRACT_SYSTEM = `Ты — модуль извлечения поискового запроса.
Из диалога (последние сообщения + текущий вопрос) составь ОДНУ поисковую фразу для веб-поиска.

Правила:
- Ответь ровно одной строкой. Без кавычек, без «запрос:», без объяснений.
- Только ключевые слова и имена; без вопросительных слов, обращений и вежливости.
- Если вопрос неоднозначен или ссылается на что-то из диалога («а что с этим?», «сколько он весит?») — подставь конкретное имя/тему из последних сообщений.
- Ник отправителя — это ЧАСТЬ сообщения до «:» (например «Inferlo: глянь ...»). Это тот, КТО спрашивает, а НЕ тема. Не включай его в запрос, если вопрос не задан явно О этом человеке (например «во сколько стрим у Inferlo?» — тогда Inferlo в запрос).
- Для технических тем (IT, наука, продукты) ищи на английском; для локальных новостей, людей и событий — на языке вопроса.
- Если веб-поиск НЕ нужен — ответь ровно: NOSEARCH. Это: приветствия и благодарности, уточнения к предыдущему ответу, тривиальные факты, вопросы о том, что уже обсуждалось, и любые просьбы без фактологического вопроса.

Примеры:
«сколько весит iPhone 16?» → iphone 16 weight specs
«что нового по Rust в этом году?» → rust 2026 release changelog
«спасибо, помогло» → NOSEARCH
«а что с этим, который ты упоминал?» (контекст: квантовые компьютеры) → quantum computers latest research
«Inferlo: глянь во сколько сегодня dev-стрим по Path of Exile 2?» → path of exile 2 dev stream schedule today`;

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

// The extraction model sees the whole recent conversation, where every
// user message is prefixed with the sender's nickname ("Inferlo: ...").
// It can fold that nickname into the query even when the person is the
// asker, not the topic. This deterministic pass removes exact nickname
// matches from the query so the result does not depend on the model
// honouring the prompt rule.
//
// Matching is word-boundary based (case-insensitive): "inferlo" is removed
// from "inferlo poe2 stream" but "inferlopec" is left alone (it is a
// different token, not the nickname as a substring).
export function stripSenderNicknames(query: string, nicknames: string[]): string {
  if (!nicknames.length) return query;
  let result = query;
  for (const nickname of nicknames) {
    const trimmed = nickname.trim();
    if (!trimmed) continue;
    // Escape regex metacharacters so a nickname like "bob.c" is literal.
    const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Word boundaries on both sides; case-insensitive; global.
    const pattern = new RegExp(`\\b${escaped}\\b`, 'gi');
    result = result.replace(pattern, ' ');
  }
  // Collapse the spaces left behind and trim.
  return result.replace(/\s+/g, ' ').trim();
}

// Collect the set of sender nicknames present in the recent conversation.
// User messages are stored as "Nickname: text" by the handler; assistant
// messages have no such prefix and are ignored. The result is deduped and
// order-stable (first-seen order) so it is cheap to diff in tests.
export function collectNicknames(conversation: ChatMessage[]): string[] {
  const seen = new Set<string>();
  const nicknames: string[] = [];
  for (const message of conversation) {
    if (message.role !== 'user') continue;
    const colonIndex = message.content.indexOf(':');
    if (colonIndex <= 0) continue;
    const nickname = message.content.slice(0, colonIndex).trim();
    if (!nickname) continue;
    const key = nickname.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    nicknames.push(nickname);
  }
  return nicknames;
}

// Extract a web-search query from the recent conversation.
// Returns null when no search should run (short message, NOSEARCH, garbage
// output, or any LLM error). Failures are logged, never propagated — the
// final answer must not depend on the search succeeding.
//
// `conversation` is the recent messages (last 4 + current), all nick-prefixed
// by the handler. The current message is the last element. Sender nicknames
// are stripped from the extracted query deterministically so the asker's name
// never leaks into the SearXNG lookup.
export async function extractSearchQuery(
  conversation: ChatMessage[],
  deps: ExtractDeps,
): Promise<string | null> {
  // The current message is the last element; check its length to skip
  // short greetings/thanks without an LLM round-trip.
  const current = conversation[conversation.length - 1];
  if (!current || current.role !== 'user') return null;
  // Strip the "Nickname: " prefix to get the raw text length.
  const colonIndex = current.content.indexOf(':');
  const rawText = colonIndex >= 0 ? current.content.slice(colonIndex + 1).trim() : current.content.trim();
  if (rawText.length < MIN_QUERY_LENGTH) return null;
  try {
    const raw = await completeSearchQuery(
      deps.config,
      EXTRACT_SYSTEM,
      conversation,
      deps.shutdown,
    );
    let query = parseQuery(raw);
    if (query) {
      query = stripSenderNicknames(query, collectNicknames(conversation));
      if (!query) {
        deps.log('Search skipped: query contained only the sender nickname.');
        query = null;
      }
    }
    if (!query) deps.log('Search skipped: extraction returned no usable query.');
    return query;
  } catch (error) {
    deps.log(`Search query extraction failed: ${describeLlmFailure(error)}.`);
    return null;
  }
}
