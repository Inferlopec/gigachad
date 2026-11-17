import { loadLlmConfig, loadLlmEndpoint, validateLlmPrompt } from './config.ts';
import { describeLlmFailure, testLlmConnection } from './llm.ts';
import { readLlmSetupStore } from './llmSetupStore.ts';

export type LlmCheckResult =
  | { status: 'success' }
  | { status: 'cancelled' }
  | { status: 'failed'; code: string; message: string };

export type LlmProgress = { phase: 'checking' | 'complete' };

export async function checkLlmDraft(options: {
  env: NodeJS.ProcessEnv;
  prompt: string;
  signal: AbortSignal;
  onProgress?: (event: LlmProgress) => void;
}): Promise<LlmCheckResult> {
  try {
    const config = loadLlmConfig(options.env);
    const prompt = options.prompt;
    try { validateLlmPrompt(config, prompt); }
    catch (error) {
      const message = (error as Error).message;
      const code = !prompt.trim() ? 'empty_prompt' : message.includes('context budget') ? 'context_budget' : 'invalid_prompt';
      return { status: 'failed', code, message };
    }
    options.signal.throwIfAborted();
    options.onProgress?.({ phase: 'checking' });
    await testLlmConnection(config, prompt, options.signal);
    options.onProgress?.({ phase: 'complete' });
    return { status: 'success' };
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return { status: 'cancelled' };
    const validation = error instanceof Error && /^(?:Set LLM_(?:BASE_URL|MODEL|API_KEY|CONTEXT_TOKENS|MAX_TOKENS|TIMEOUT_MS) in \.env\.|LLM_(?:BASE_URL|MODEL|API_KEY|CONTEXT_TOKENS|MAX_TOKENS|TIMEOUT_MS) must )/.test(error.message)
      ? error.message : undefined;
    const message = validation ?? describeLlmFailure(error);
    const match = /^LLM HTTP (\d{3})$/.exec(message);
    const status = match ? Number(match[1]) : undefined;
    const code = status === 401 || status === 403 ? 'authorization'
      : status === 404 || status === 400 ? 'endpoint_or_model'
      : status === 429 ? 'rate_limited'
      : status && status >= 500 ? 'server'
      : message.includes('timed out') ? 'timeout'
      : message.includes('network or TLS') ? 'network'
      : 'invalid_response';
    const guidance = code === 'authorization' ? 'Check the API key and endpoint permissions.'
      : code === 'endpoint_or_model' ? 'Check the API base URL and model name.'
      : code === 'rate_limited' ? 'Check provider limits, then retry.'
      : code === 'server' ? 'The LLM service returned an error; retry later.'
      : code === 'timeout' ? 'Check service availability or increase the timeout.'
      : code === 'network' ? 'Check the endpoint, network and TLS configuration.'
      : 'Check the endpoint response and OpenAI-compatible Chat Completions support.';
    return { status: 'failed', code, message: `${message}. ${guidance}` };
  }
}

export type LlmSetupTerminal = {
  ask: (label: string, initial?: string, secret?: boolean) => Promise<string>;
  askMultiline: (label: string) => Promise<string>;
  write: (message: string) => void;
};

const cancelled = (): { status: 'cancelled' } => ({ status: 'cancelled' });

export async function runLlmSetup(options: {
  envPath: string;
  signal: AbortSignal;
  terminal: LlmSetupTerminal;
}): Promise<{ status: 'saved' | 'cancelled' | 'failed' }> {
  const { terminal, signal } = options;
  const check = () => signal.throwIfAborted();
  try {
    check();
    const store = await readLlmSetupStore(options.envPath);
    const baseDraft = {
      baseUrl: store.env.LLM_BASE_URL ?? '', model: store.env.LLM_MODEL ?? '',
      apiKey: store.env.LLM_API_KEY ?? '', contextTokens: store.env.LLM_CONTEXT_TOKENS ?? '8192',
      maxTokens: store.env.LLM_MAX_TOKENS ?? '2048', timeoutMs: store.env.LLM_TIMEOUT_MS ?? '120000',
    };
    let values = { ...baseDraft };
    let prompt = store.prompt;
    terminal.write('LLM setup. Ctrl+C cancels. Saved settings stay unchanged until confirmation.');

    const editSettings = async () => {
      let defaultEndpoint: string | undefined;
      // Stored or previously entered URLs can contain credentials/query tokens.
      // Only a validated endpoint may be offered as a visible default.
      try { defaultEndpoint = loadLlmEndpoint(values.baseUrl); } catch { /* ask afresh */ }
      values = {
        baseUrl: await terminal.ask('OpenAI-compatible API base URL', defaultEndpoint),
        model: await terminal.ask('Model', values.model),
        apiKey: await terminal.ask('API key (hidden)', values.apiKey, true),
        contextTokens: await terminal.ask('Context limit (positive integer)', values.contextTokens),
        maxTokens: await terminal.ask('Maximum output tokens', values.maxTokens),
        timeoutMs: await terminal.ask('Request timeout in milliseconds', values.timeoutMs),
      };
      check();
    };
    await editSettings();
    if (['y', 'yes'].includes((await terminal.ask('Edit system prompt? [y/N]', 'n')).toLowerCase())) {
      prompt = await terminal.askMultiline('Enter prompt lines. Finish with .end; type ..end for a literal .end line:');
    }
    check();
    if (!prompt.trim()) {
      terminal.write('The system prompt is empty.');
      return { status: 'failed' };
    }

    let checked = false;
    let saveWithoutCheck = false;
    while (!checked && !saveWithoutCheck) {
      const result = await checkLlmDraft({
        env: { LLM_BASE_URL: values.baseUrl, LLM_MODEL: values.model, LLM_API_KEY: values.apiKey,
          LLM_CONTEXT_TOKENS: values.contextTokens, LLM_MAX_TOKENS: values.maxTokens, LLM_TIMEOUT_MS: values.timeoutMs },
        prompt, signal, onProgress: ({ phase }) => terminal.write(phase === 'checking' ? 'Testing LLM connection…' : 'LLM connection succeeded.'),
      });
      if (result.status === 'cancelled') return cancelled();
      if (result.status === 'success') { checked = true; break; }
      terminal.write(`LLM check failed: ${result.message}`);
      const choice = (await terminal.ask('Choose: [r]etry, [c]hange settings/prompt, [s]ave anyway, Enter to cancel', '')).toLowerCase();
      check();
      if (choice === 'r') continue;
      if (choice === 'c') {
        await editSettings();
        if (['y', 'yes'].includes((await terminal.ask('Edit system prompt? [y/N]', 'n')).toLowerCase())) {
          prompt = await terminal.askMultiline('Enter prompt lines. Finish with .end; type ..end for a literal .end line:');
        }
        if (!prompt.trim()) { terminal.write('The system prompt is empty.'); return { status: 'failed' }; }
        continue;
      }
      if (choice === 's') {
        const confirm = (await terminal.ask('Save these settings without a successful connection test? [y/N]', 'n')).toLowerCase();
        check();
        saveWithoutCheck = ['y', 'yes'].includes(confirm);
        if (!saveWithoutCheck) return cancelled();
        break;
      }
      return cancelled();
    }

    check();
    terminal.write('Saving settings and a new prompt version. Existing dotenv comments and formatting will be rewritten.');
    const confirm = (await terminal.ask('Save validated LLM settings and prompt? [y/N]', 'n')).toLowerCase();
    check();
    if (!['y', 'yes'].includes(confirm)) {
      terminal.write('Cancelled; saved settings and prompt are unchanged.');
      return cancelled();
    }
    await store.save({ ...values, contextTokens: Number(values.contextTokens), maxTokens: Number(values.maxTokens),
      timeoutMs: Number(values.timeoutMs), prompt }, signal);
    terminal.write('LLM settings and prompt saved. Restart or recreate the running container to apply dotenv changes.');
    return { status: 'saved' };
  } catch {
    if (signal.aborted) {
      terminal.write('Cancelled; saved settings and prompt are unchanged.');
      return cancelled();
    }
    terminal.write('LLM setup failed. Check inputs, configuration permissions and whether the configuration changed during setup.');
    return { status: 'failed' };
  }
}
