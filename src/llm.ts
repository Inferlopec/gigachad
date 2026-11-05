import type { Config } from './config.ts';

type LlmConfig = Pick<Config, 'baseUrl' | 'apiKey' | 'model' | 'timeoutMs' | 'maxTokens' | 'contextTokens'>;
export type ChatMessage = { role: 'user' | 'assistant'; content: string };

// Only expose fixed diagnostics; upstream bodies and arbitrary error messages can contain private data.
export function describeLlmFailure(error: unknown): string {
  if (!(error instanceof Error)) return 'Unexpected LLM failure';
  if (error.name === 'TimeoutError') return 'LLM request timed out';
  if (error.name === 'AbortError') return 'LLM request aborted';
  if (error instanceof SyntaxError) return 'LLM returned invalid JSON';
  if (/^LLM HTTP \d{3}$/.test(error.message) || [
    'Input exceeds conservative context budget', 'Empty LLM body',
    'LLM response exceeds 1 MiB', 'Invalid LLM answer',
  ].includes(error.message)) return error.message;
  if (error instanceof TypeError && error.message === 'fetch failed') return 'LLM network or TLS connection failed';
  return 'Unexpected LLM failure';
}

// A retry is only useful when the failure is transient. HTTP 5xx and
// network/timeout errors may succeed on the second attempt; anything else
// (4xx, invalid JSON, budget errors, shutdown) is permanent for this request.
function isRetryable(error: unknown): boolean {
  if (error instanceof SyntaxError) return false;
  if (typeof error === 'string' || !(error instanceof Error)) return false;
  if (error.name === 'AbortError') return false; // shutdown aborts must never be retried
  if (error.name === 'TimeoutError') return true;
  if (error instanceof TypeError && error.message === 'fetch failed') return true;
  if (/^LLM HTTP (\d{3})$/.test(error.message)) {
    const status = Number(error.message.match(/^LLM HTTP (\d{3})$/)?.[1]);
    return status >= 500;
  }
  return false;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function complete(
  config: LlmConfig,
  system: string,
  conversation: ChatMessage[],
  shutdown?: AbortSignal,
  retries = 1,
): Promise<string> {
  // Byte count is a conservative input budget, not a model-specific token count.
  // Reserve room for chat framing and the requested output without a tokenizer dependency.
  const messages = conversation.slice();
  const inputBytes = () => Buffer.byteLength(system, 'utf8') +
    messages.reduce((sum, message) => sum + Buffer.byteLength(message.content, 'utf8') + 32, 0);
  while (messages.length > 1 && inputBytes() + config.maxTokens + 256 > config.contextTokens) messages.shift();
  if (!messages.length || inputBytes() + config.maxTokens + 256 > config.contextTokens) {
    throw new Error('Input exceeds conservative context budget');
  }
  const attempts = retries + 1;
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(1000 * 2 ** (attempt - 1));
    if (shutdown?.aborted) throw new DOMException('LLM request aborted', 'AbortError');
    const timeout = AbortSignal.timeout(config.timeoutMs);
    const signal = shutdown ? AbortSignal.any([timeout, shutdown]) : timeout;
    try {
      const response = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: config.model,
          stream: false,
          chat_template_kwargs: { enable_thinking: false },
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
    } catch (error) {
      lastError = error;
      if (attempt + 1 >= attempts || !isRetryable(error)) throw error;
    }
  }
  throw lastError;
}
