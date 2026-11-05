import { readFile } from 'node:fs/promises';
import type { Message } from '@gryt/bot';

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
  complete: (system: string, user: string) => Promise<string>;
  send: (channelId: string, text: string) => Promise<unknown>;
  typing: (channelId: string) => void;
  stopTyping: (channelId: string) => void;
  log: (event: string) => void;
};

export function createHandler(deps: Dependencies) {
  const seen = new Set<string>();
  let busy = false;
  return async (message: Message): Promise<void> => {
    const id = deps.selfId();
    if (!id || !deps.available() || message.conversationId !== deps.channelId || message.isOwn ||
        message.senderServerUserId === id || message.isSystem || !message.text) return;
    const user = stripOwnMention(message.text, id);
    if (user === null || seen.has(message.messageId)) return;
    seen.add(message.messageId);
    if (seen.size > 1000) seen.delete(seen.values().next().value!);

    const send = async (text: string) => {
      if (!deps.available()) return;
      try { await deps.send(message.conversationId, limitReply(text)); }
      catch { deps.log('Gryt response send failed; not retrying.'); }
    };
    if (busy) return send('I’m busy with another request. Please try again shortly.');
    busy = true;
    deps.typing(message.conversationId);
    let stage = 'System prompt';
    try {
      const system = await readFile(deps.promptPath, 'utf8');
      if (!system.trim()) throw new Error('Empty system prompt');
      stage = 'LLM request';
      const answer = await deps.complete(system, user || 'Hello!');
      await send(answer);
    } catch {
      deps.log(`${stage} failed. Check configuration, request limits, or service availability.`);
      await send('I couldn’t complete that request. Please try again later.');
    } finally {
      deps.stopTyping(message.conversationId);
      busy = false;
    }
  };
}
