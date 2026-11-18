import { loadChannelId, loadConfig, loadGrytConfig, loadGrytHost, loadLlmConfig, loadLlmEndpoint, validateLlmPrompt } from './config.ts';
import { checkLlmDraft, type LlmCheckResult } from './llmSetup.ts';
import { saveConfigDraft } from './configSetup.ts';
import { readConfigSetupStore } from './configSetupStore.ts';
import { registerGryt } from './registration.ts';

type Terminal = {
  ask: (label: string, initial?: string, secret?: boolean) => Promise<string>;
  askMultiline: (label: string) => Promise<string>;
  write: (message: string) => void;
};
type Draft = Record<string, string | undefined>;
const yes = (value: string) => ['y', 'yes'].includes(value.trim().toLowerCase());
const safeText = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

function check(signal: AbortSignal) { signal.throwIfAborted(); }

export async function runConfigManagement(options: {
  command: 'setup' | 'config'; envPath: string; signal: AbortSignal; terminal: Terminal; cwd?: string;
  register?: typeof registerGryt;
  checkLlm?: typeof checkLlmDraft;
}): Promise<{ status: 'saved' | 'cancelled' | 'failed' }> {
  const { terminal, signal } = options;
  const cancelled = () => ({ status: 'cancelled' as const });
  try {
    check(signal);
    const store = await readConfigSetupStore(options.envPath, options.cwd);
    const original = { ...store.env };
    const draft: Draft = { ...store.env, SYSTEM_PROMPT_PATH: store.promptPath };
    let prompt = store.prompt;
    let connectionWasTested = false;
    let saveAfterFailedTest = false;

    const editGryt = async () => {
      let hostDefault: string | undefined;
      try { if (draft.GRYT_HOST) hostDefault = loadGrytHost(draft.GRYT_HOST); } catch { /* ask afresh */ }
      while (true) {
        draft.GRYT_HOST = await terminal.ask('Gryt host (HTTP(S) URL)', hostDefault);
        draft.GRYT_NICKNAME = await terminal.ask('Bot nickname', draft.GRYT_NICKNAME);
        if (!draft.GRYT_IDENTITY_PATH) {
          draft.GRYT_IDENTITY_PATH = await terminal.ask('Identity path (reuse this path on later setup)', draft.GRYT_IDENTITY_PATH ?? './data/gryt-bot-identity.json');
        }
        try {
          loadGrytConfig({ GRYT_HOST: draft.GRYT_HOST, GRYT_NICKNAME: draft.GRYT_NICKNAME,
            GRYT_IDENTITY_PATH: draft.GRYT_IDENTITY_PATH });
          break;
        } catch (error) {
          terminal.write(`Gryt settings are invalid: ${(error as Error).message}`);
          if (!yes(await terminal.ask('Edit Gryt settings again? [Y/n]', 'y'))) throw new DOMException('Cancelled', 'AbortError');
        }
      }
      const connect = yes(await terminal.ask('Connect to Gryt and select an accessible text channel? [Y/n]', options.command === 'setup' ? 'y' : 'n'));
      if (connect) {
        const token = await terminal.ask('Optional single-use registration token (hidden; blank waits for approval)', undefined, true);
        const config = loadGrytConfig({ GRYT_HOST: draft.GRYT_HOST, GRYT_NICKNAME: draft.GRYT_NICKNAME,
          GRYT_IDENTITY_PATH: draft.GRYT_IDENTITY_PATH, GRYT_BOT_TOKEN: token });
        terminal.write('Connecting to Gryt for channel selection. Ctrl+C cancels; any created identity is retained.');
        const result = await (options.register ?? registerGryt)(config, { signal, onProgress: (event) => {
          const messages = { 'identity-loaded': 'Persistent identity loaded; it will be kept if setup is cancelled.',
            connecting: 'Connecting to Gryt…', waiting: 'Waiting for administrator approval. Ctrl+C cancels.', ready: 'Gryt connection ready.' };
          terminal.write(messages[event]);
        } });
        if (result.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
        if (result.status === 'failed') terminal.write(`Gryt connection failed: ${result.message}`);
        else {
          try {
            result.channels.forEach((channel, index) => terminal.write(`${index + 1}. ${safeText(channel.name)} [${safeText(channel.id)}]`));
            terminal.write('0. Enter channel ID manually');
            while (true) {
              const choice = await terminal.ask('Channel number', '0');
              check(signal);
              if (choice === '0') {
                draft.GRYT_ALLOWED_CHANNEL_ID = loadChannelId(await terminal.ask('Channel ID (verify bot access in Gryt)', draft.GRYT_ALLOWED_CHANNEL_ID));
                break;
              }
              const index = Number(choice) - 1;
              const channel = /^\d+$/.test(choice) && Number.isSafeInteger(index) ? result.channels[index] : undefined;
              if (channel) { draft.GRYT_ALLOWED_CHANNEL_ID = loadChannelId(channel.id); break; }
              terminal.write('Select a listed number, or 0 for a manual ID.');
            }
          } finally {
            try { await result.close(); }
            catch {
              terminal.write('Could not close the Gryt connection. Stop this process before retrying; the identity lock is retained.');
              throw new Error('Gryt connection could not be closed.');
            }
          }
        }
      }
      if (!draft.GRYT_ALLOWED_CHANNEL_ID) {
        draft.GRYT_ALLOWED_CHANNEL_ID = loadChannelId(await terminal.ask('Channel ID (verify bot access in Gryt)'));
      } else if (!connect && options.command === 'config') {
        const change = yes(await terminal.ask('Change the allowed channel ID? [y/N]', 'n'));
        if (change) draft.GRYT_ALLOWED_CHANNEL_ID = loadChannelId(await terminal.ask('Channel ID', draft.GRYT_ALLOWED_CHANNEL_ID));
      }
    };

    const editLlm = async () => {
      while (true) {
        let endpoint: string | undefined;
        try { if (draft.LLM_BASE_URL) endpoint = loadLlmEndpoint(draft.LLM_BASE_URL); } catch { /* ask afresh */ }
        const values = {
          baseUrl: await terminal.ask('OpenAI-compatible API base URL', endpoint),
          model: await terminal.ask('Model', draft.LLM_MODEL),
          apiKey: await terminal.ask('API key (hidden)', draft.LLM_API_KEY, true),
          contextTokens: await terminal.ask('Context limit (positive integer)', draft.LLM_CONTEXT_TOKENS ?? '8192'),
          maxTokens: await terminal.ask('Maximum output tokens', draft.LLM_MAX_TOKENS ?? '2048'),
          timeoutMs: await terminal.ask('Request timeout in milliseconds', draft.LLM_TIMEOUT_MS ?? '120000'),
        };
        check(signal);
        draft.LLM_BASE_URL = values.baseUrl; draft.LLM_MODEL = values.model; draft.LLM_API_KEY = values.apiKey;
        draft.LLM_CONTEXT_TOKENS = values.contextTokens; draft.LLM_MAX_TOKENS = values.maxTokens; draft.LLM_TIMEOUT_MS = values.timeoutMs;
        const editPrompt = yes(await terminal.ask('Edit system prompt? [y/N]', 'n'));
        if (editPrompt) prompt = await terminal.askMultiline('Enter prompt lines. Finish with .end; type ..end for a literal .end line:');
        try {
          const llm = loadLlmConfig(draft);
          validateLlmPrompt(llm, prompt);
        } catch (error) {
          terminal.write(`LLM draft is invalid: ${(error as Error).message}`);
          if (yes(await terminal.ask('Edit LLM settings and prompt again? [Y/n]', 'y'))) continue;
          throw new DOMException('Cancelled', 'AbortError');
        }

        while (true) {
          const checkLlm = options.checkLlm ?? checkLlmDraft;
          const result: LlmCheckResult = await checkLlm({ env: draft, prompt, signal,
            onProgress: ({ phase }) => terminal.write(phase === 'checking' ? 'Testing LLM connection…' : 'LLM connection succeeded.') });
          if (result.status === 'cancelled') throw new DOMException('Cancelled', 'AbortError');
          if (result.status === 'success') { connectionWasTested = true; saveAfterFailedTest = false; return; }
          terminal.write(`LLM check failed: ${result.message}`);
          if (result.code === 'context_budget' || result.code === 'empty_prompt' || result.code === 'invalid_prompt') {
            if (yes(await terminal.ask('Edit LLM settings and prompt again? [Y/n]', 'y'))) break;
            throw new DOMException('Cancelled', 'AbortError');
          }
          const choice = (await terminal.ask('Choose: [r]etry, [c]hange settings/prompt, [s]ave anyway, Enter to cancel', '')).toLowerCase();
          check(signal);
          if (choice === 'r') continue;
          if (choice === 'c') break;
          if (choice === 's' && yes(await terminal.ask('Save without a successful connection test? [y/N]', 'n'))) {
            saveAfterFailedTest = true; return;
          }
          throw new DOMException('Cancelled', 'AbortError');
        }
      }
    };

    const editSearch = async () => {
      while (true) {
        const enabled = yes(await terminal.ask('Enable optional web search? [y/N]', draft.SEARCH_ENABLED === 'true' ? 'y' : 'n'));
        draft.SEARCH_ENABLED = String(enabled);
        if (!enabled) return;
        const hasOverride = Boolean(draft.SEARCH_LLM_BASE_URL || draft.SEARCH_LLM_API_KEY || draft.SEARCH_LLM_MODEL);
        const override = yes(await terminal.ask('Use a separate OpenAI-compatible LLM for search query extraction? [y/N]', hasOverride ? 'y' : 'n'));
        if (override) {
          let endpoint: string | undefined;
          try {
            const stored = draft.SEARCH_LLM_BASE_URL?.trim() || draft.LLM_BASE_URL;
            if (stored) endpoint = loadLlmEndpoint(stored);
          } catch { /* Unsafe URLs must never be displayed as defaults. */ }
          draft.SEARCH_LLM_BASE_URL = await terminal.ask('Search LLM API base URL', endpoint);
          draft.SEARCH_LLM_API_KEY = await terminal.ask('Search LLM API key (hidden)', draft.SEARCH_LLM_API_KEY ?? draft.LLM_API_KEY, true);
          draft.SEARCH_LLM_MODEL = await terminal.ask('Search LLM model', draft.SEARCH_LLM_MODEL ?? draft.LLM_MODEL);
        } else {
          delete draft.SEARCH_LLM_BASE_URL; delete draft.SEARCH_LLM_API_KEY; delete draft.SEARCH_LLM_MODEL;
        }
        draft.SEARCH_LLM_TIMEOUT_MS = await terminal.ask('Search LLM timeout (ms)', draft.SEARCH_LLM_TIMEOUT_MS ?? '8000');
        draft.SEARCH_LLM_MAX_TOKENS = await terminal.ask('Search LLM output tokens', draft.SEARCH_LLM_MAX_TOKENS ?? '100');
        draft.SEARCH_LLM_CONTEXT_TOKENS = await terminal.ask('Search LLM context tokens', draft.SEARCH_LLM_CONTEXT_TOKENS ?? '8192');
        draft.SEARCH_TIMEOUT_MS = await terminal.ask('Search request timeout (ms)', draft.SEARCH_TIMEOUT_MS ?? '10000');
        draft.SEARCH_MAX_RESULTS = await terminal.ask('Maximum search results', draft.SEARCH_MAX_RESULTS ?? '5');
        draft.SEARCH_RATE_LIMIT = await terminal.ask('Search requests per rate window', draft.SEARCH_RATE_LIMIT ?? '5');
        draft.SEARCH_RATE_WINDOW_MS = await terminal.ask('Rate window (ms)', draft.SEARCH_RATE_WINDOW_MS ?? '60000');
        draft.SEARCH_CACHE_TTL_MS = await terminal.ask('Search cache TTL (ms)', draft.SEARCH_CACHE_TTL_MS ?? '300000');
        try { loadConfig(draft); return; }
        catch (error) {
          terminal.write(`Search settings are invalid: ${(error as Error).message}`);
          if (!yes(await terminal.ask('Edit search settings again? [Y/n]', 'y'))) throw new DOMException('Cancelled', 'AbortError');
        }
      }
    };

    terminal.write(`${options.command === 'setup' ? 'Setup' : 'Configuration'} wizard. Ctrl+C cancels; saved files stay unchanged until final confirmation.`);
    if (options.command === 'setup') {
      await editGryt();
      await editLlm();
      await editSearch();
    } else {
      while (true) {
        terminal.write('1. Gryt and channel   2. LLM and prompt   3. Search   4. Save   5. Cancel');
        const choice = await terminal.ask('Select a section', '4');
        check(signal);
        try {
          if (choice === '1') await editGryt();
          else if (choice === '2') await editLlm();
          else if (choice === '3') await editSearch();
          else if (choice === '5') {
            terminal.write('Cancelled; saved settings and prompt are unchanged.');
            return cancelled();
          }
          else if (choice === '4') break;
          else terminal.write('Choose 1–5.');
        } catch (error) {
          if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) return cancelled();
          terminal.write(`Section could not be applied: ${(error as Error).message}`);
        }
      }
    }

    while (true) {
      try {
        const config = loadConfig(draft);
        validateLlmPrompt(config, prompt);
        const llmChanged = ['LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'LLM_CONTEXT_TOKENS', 'LLM_MAX_TOKENS', 'LLM_TIMEOUT_MS']
          .some((key) => draft[key] !== original[key]);
        if ((options.command === 'setup' || llmChanged) && !connectionWasTested && !saveAfterFailedTest) {
          await editLlm();
          continue;
        }
        terminal.write('Saving validated configuration and prompt. Existing dotenv comments and formatting will be rewritten.');
        if (!yes(await terminal.ask('Save these configuration and prompt changes? [y/N]', 'n'))) {
          terminal.write(`Cancelled; saved settings and prompt are unchanged.${options.command === 'setup' ? ' Any created identity is retained.' : ''}`);
          return cancelled();
        }
        check(signal);
        const saved = await saveConfigDraft({ store, draft, prompt, signal });
        if (saved.status === 'cancelled') {
          terminal.write('Cancelled; saved settings and prompt are unchanged.');
          return cancelled();
        }
        if (saved.status === 'failed') {
          terminal.write(saved.message);
          if (saved.code !== 'invalid-config') return { status: 'failed' };
          throw new Error(saved.message);
        }
        terminal.write(`Configuration saved.${options.command === 'setup' ? ' Any created identity is retained.' : ''} Restart or recreate the running container to apply dotenv changes.`);
        return { status: 'saved' };
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          terminal.write(`Cancelled; saved settings and prompt are unchanged.${options.command === 'setup' ? ' Any created identity is retained.' : ''}`);
          return cancelled();
        }
        terminal.write(`Configuration validation or save failed: ${(error as Error).message}`);
        if (options.command === 'setup') {
          const section = (await terminal.ask('Edit [g]ryt, [l]lm, [s]earch, or Enter to cancel', '')).toLowerCase();
          check(signal);
          try {
            if (section === 'g') await editGryt();
            else if (section === 'l') await editLlm();
            else if (section === 's') await editSearch();
            else return cancelled();
          } catch (editError) {
            if (signal.aborted || (editError instanceof Error && editError.name === 'AbortError')) return cancelled();
            terminal.write(`Section could not be applied: ${(editError as Error).message}`);
          }
          continue;
        }
        const section = (await terminal.ask('Return to [g]ryt, [l]lm, [s]earch settings, or Enter to cancel', '')).toLowerCase();
        check(signal);
        try {
          if (section === 'g') await editGryt();
          else if (section === 'l') await editLlm();
          else if (section === 's') await editSearch();
          else return { status: 'failed' };
        } catch (editError) {
          if (signal.aborted || (editError instanceof Error && editError.name === 'AbortError')) return cancelled();
          terminal.write(`Section could not be applied: ${(editError as Error).message}`);
        }
      }
    }
  } catch (error) {
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      terminal.write(`Cancelled; saved settings and prompt are unchanged.${options.command === 'setup' ? ' Any created identity is retained.' : ''}`);
      return cancelled();
    }
    terminal.write(`Configuration wizard failed. Check inputs, configuration permissions and whether files changed during setup.${options.command === 'setup' ? ' Any created identity is retained.' : ''}`);
    return { status: 'failed' };
  }
}
