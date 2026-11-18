import type { readConfigSetupStore } from './configSetupStore.ts';

type ConfigStore = Awaited<ReturnType<typeof readConfigSetupStore>>;
export type ConfigSaveResult =
  | { status: 'saved'; promptPath: string }
  | { status: 'cancelled' }
  | { status: 'failed'; code: 'invalid-config' | 'concurrent-edit' | 'storage'; message: string };

// Terminal-independent commit action shared by setup/config presentations.
// Storage errors are deliberately reduced to safe diagnostics.
export async function saveConfigDraft(options: {
  store: ConfigStore; draft: NodeJS.ProcessEnv; prompt: string; signal: AbortSignal;
}): Promise<ConfigSaveResult> {
  try {
    const saved = await options.store.save(options.draft, options.prompt, options.signal);
    return { status: 'saved', promptPath: saved.promptPath };
  } catch (error) {
    if (options.signal.aborted || (error instanceof Error && error.name === 'AbortError')) return { status: 'cancelled' };
    const message = error instanceof Error ? error.message : '';
    if (/changed during setup|prompt (?:or )?template changed/i.test(message)) {
      return { status: 'failed', code: 'concurrent-edit', message: 'Configuration or prompt changed while the wizard was open. Run config again.' };
    }
    if (/^(?:Set |(?:GRYT|LLM|SEARCH|SYSTEM_PROMPT_PATH)|System prompt|Prompt and connection|A setting|Settings cannot)/.test(message)) {
      return { status: 'failed', code: 'invalid-config', message };
    }
    return { status: 'failed', code: 'storage', message: 'Could not save configuration or prompt. Check storage permissions and available disk space.' };
  }
}
