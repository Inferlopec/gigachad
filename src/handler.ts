import { readFile } from 'node:fs/promises';
import type { Message } from '@gryt/bot';
import type { ChatMessage } from './llm.ts';
import { describeLlmFailure } from './llm.ts';
import type { SearchResult } from './search.ts';
import { formatSearchResults } from './search.ts';

// Skip fenced/inline code, escapes, images and ordinary links before looking for a mention.
const TOKENS = /(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\1[^\n]*(?:\n|$)|$)|(`+)[^\n]*?\2|\\[\s\S]|https?:\/\/\S+|!?\[([^\]\n]*)\]\(([^)\s]*)\)/g;

export function stripOwnMention(text: string, selfId: string): string | null {
  let mentioned = false;
  const cleaned = text.replace(TOKENS, (whole: string, fence, inline, label, href) => {
    if (!fence && !inline && !whole.startsWith('!') && href === `mention:${selfId}`) {
      mentioned = true;
      return '';
    }
    return whole;
  });
  return mentioned ? cleaned.trim() : null;
}

export function limitReply(text: string): string {
  const suffix = '\n\n[Response truncated]';
  if (text.length <= 4000) return text;
  let cut = 4000 - suffix.length;
  if (/[\uD800-\uDBFF]/.test(text[cut - 1]!)) cut--;
  return text.slice(0, cut) + suffix;
}

type Dependencies = {
  channelId: string;
  selfId: () => string | null;
  available: () => boolean;
  promptPath: string;
  complete: (system: string, messages: ChatMessage[]) => Promise<string>;
  send: (channelId: string, text: string) => Promise<unknown>;
  typing: (channelId: string) => void;
  stopTyping: (channelId: string) => void;
  log: (event: string) => void;
  search?: (query: string) => Promise<SearchResult[]>;
};

export function createHandler(deps: Dependencies) {
  const seen = new Set<string>();
  const history: ChatMessage[] = [];
  const remember = (entry: ChatMessage) => {
    history.push(entry);
    if (history.length > 20) history.shift();
  };
  let busy = false;
  return async (message: Message): Promise<void> => {
    const id = deps.selfId();
    if (!id || !deps.available() || message.conversationId !== deps.channelId || message.isOwn ||
        message.senderServerUserId === id || message.isSystem || !message.text) return;
    if (seen.has(message.messageId)) return;
    seen.add(message.messageId);
    if (seen.size > 1000) seen.delete(seen.values().next().value!);
    const user = stripOwnMention(message.text, id);
    const name = (message.senderNickname || message.senderServerUserId).replace(/[\r\n]/g, ' ').slice(0, 80);
    const current: ChatMessage = { role: 'user', content: `${name}: ${user === null ? message.text : user || 'Hello!'}` };
    // Send only the most recent 5 messages (including the trigger) to the model.
    // Older context is noise in a small channel and degrades answer quality.
    const conversation = [...history.slice(-4), current];
    remember(current);
    if (user === null) return;

    const send = async (text: string) => {
      if (!deps.available()) return;
      try {
        const reply = limitReply(text);
        await deps.send(message.conversationId, reply);
        remember({ role: 'assistant', content: reply });
      }
      catch { deps.log('Gryt response send failed; not retrying.'); }
    };
    if (busy) {
      // In a 2-3 person channel a "busy" reply is noise. The typing indicator
      // already shows the bot is working, so silently drop and log instead.
      deps.log('Request dropped: busy with another request.');
      return;
    }
    busy = true;
    const refreshTyping = () => {
      if (!deps.available()) return;
      try { deps.typing(message.conversationId); }
      catch { deps.log('Gryt typing indicator failed.'); }
    };
    refreshTyping();
    // The SDK's typing indicator expires after about eight seconds.
    const typingTimer = setInterval(refreshTyping, 5000);
    typingTimer.unref();
    let stage = 'System prompt';
    try {
      const system = await readFile(deps.promptPath, 'utf8');
      if (!system.trim()) throw new Error('Empty system prompt');

      const searchContext = await maybeSearch(user || '', deps);

      stage = 'LLM request';
      const fullSystem = searchContext ? system + '\n\n' + searchContext : system;
      const answer = await deps.complete(fullSystem, conversation);
      await send(answer);
    } catch (error) {
      deps.log(stage === 'LLM request'
        ? `LLM request failed: ${describeLlmFailure(error)}.`
        : 'System prompt failed. Check that prompts/system.md is readable and nonempty.');
      await send('I couldn’t complete that request. Please try again later.');
    } finally {
      clearInterval(typingTimer);
      busy = false;
      deps.stopTyping(message.conversationId);
    }
  };
}

// Search the web for long-enough questions. Short greetings and thanks are
// not worth a search round-trip. Failures are logged, never propagated.
async function maybeSearch(
  text: string,
  deps: Pick<Dependencies, 'search' | 'log'>,
): Promise<string> {
  if (!deps.search || text.length < 15) return '';
  try {
    const results = await deps.search(text);
    if (results.length) return formatSearchResults(text, results);
  } catch (error) {
    deps.log(`Search failed: ${error instanceof Error ? error.message : 'unknown error'}.`);
  }
  return '';
}
