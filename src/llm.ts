import type { Config } from './config.ts';

type LlmConfig = Pick<Config, 'baseUrl' | 'apiKey' | 'model' | 'timeoutMs' | 'maxTokens' | 'contextTokens'>;
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export async function complete(config: LlmConfig, system: string, conversation: ChatMessage[], shutdown?: AbortSignal): Promise<string> {
  // Byte count is a conservative input budget, not a model-specific token count.
  // Reserve room for chat framing and the requested output without a tokenizer dependency.
  const messages = conversation.slice();
  const inputBytes = () => Buffer.byteLength(system, 'utf8') +
    messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + 32, 0);
  while (messages.length > 1 && inputBytes() + config.maxTokens + 256 > config.contextTokens) messages.shift();
  if (!messages.length || inputBytes() + config.maxTokens + 256 > config.contextTokens) {
    throw new Error('Input exceeds conservative context budget');
  }
  const timeout = AbortSignal.timeout(config.timeoutMs);
  const signal = shutdown ? AbortSignal.any([timeout, shutdown]) : timeout;
  const response = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      stream: false,
      max_tokens: config.maxTokens,
      messages: [{ role: 'system', content: system }, ...messages],
    }),
    signal,
    redirect: 'error',
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`LLM HTTP ${response.status}`);
  }
  if (!response.body) throw new Error('Empty LLM body');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024 * 1024) {
        await reader.cancel();
        throw new Error('LLM response exceeds 1 MiB');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  const answer: unknown = data?.choices?.[0]?.message?.content;
  if (typeof answer !== 'string' || !answer.trim()) throw new Error('Invalid LLM answer');
  return answer.trim();
}
