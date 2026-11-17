import { chmod, link, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { loadLlmConfig, validateLlmPrompt } from './config.ts';

async function optionalRead(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolve(path);
    throw error;
  }
}

function encode(value: string): string {
  for (const quote of ['"', "'", '`']) {
    if (!value.includes(quote)) return `${quote}${value}${quote}`;
  }
  throw new Error('A setting contains an unsupported combination of quote characters. No settings were saved.');
}

export async function readLlmSetupStore(envFile: string, cwd = process.cwd()) {
  const envPath = resolve(cwd, envFile);
  const originalEnv = await optionalRead(envPath);
  const env = parseEnv(originalEnv ?? '');
  const promptPath = env.SYSTEM_PROMPT_PATH?.trim() || 'prompts/system.md';
  if (/[\x00-\x1f\x7f]/.test(promptPath)) throw new Error('SYSTEM_PROMPT_PATH must not contain control characters.');
  const absolutePromptPath = resolve(cwd, promptPath);
  const identityPath = resolve(cwd, env.GRYT_IDENTITY_PATH ?? './data/gryt-bot-identity.json');
  const [canonicalPrompt, canonicalEnv, canonicalIdentity] = await Promise.all([
    canonicalPath(absolutePromptPath), canonicalPath(envPath), canonicalPath(identityPath),
  ]);
  if (canonicalPrompt === canonicalEnv || canonicalPrompt === canonicalIdentity) {
    throw new Error('SYSTEM_PROMPT_PATH conflicts with another data file.');
  }
  const originalPrompt = await optionalRead(absolutePromptPath);
  const templatePath = promptPath === 'prompts/system.md' && originalPrompt === null
    ? resolve(cwd, 'prompts/system.md.example') : undefined;
  const template = templatePath ? await optionalRead(templatePath) : null;

  return {
    env,
    promptPath,
    prompt: originalPrompt ?? template ?? '',
    save: async (draft: {
      baseUrl: string; model: string; apiKey: string; contextTokens: number; maxTokens: number;
      timeoutMs: number; prompt: string;
    }, signal?: AbortSignal) => {
      const check = () => signal?.throwIfAborted();
      check();
      const config = loadLlmConfig({ LLM_BASE_URL: draft.baseUrl, LLM_MODEL: draft.model,
        LLM_API_KEY: draft.apiKey, LLM_CONTEXT_TOKENS: String(draft.contextTokens),
        LLM_MAX_TOKENS: String(draft.maxTokens), LLM_TIMEOUT_MS: String(draft.timeoutMs) });
      validateLlmPrompt(config, draft.prompt);
      if (await optionalRead(envPath) !== originalEnv) throw new Error('Configuration changed during setup. Run setup-llm again.');
      if (await optionalRead(absolutePromptPath) !== originalPrompt) throw new Error('System prompt changed during setup-llm. Run setup-llm again.');
      if (templatePath && await optionalRead(templatePath) !== template) throw new Error('Prompt template changed during setup-llm. Run setup-llm again.');

      const next: Record<string, string> = { ...env, LLM_BASE_URL: config.baseUrl, LLM_MODEL: config.model,
        LLM_API_KEY: config.apiKey, LLM_CONTEXT_TOKENS: String(config.contextTokens),
        LLM_MAX_TOKENS: String(config.maxTokens), LLM_TIMEOUT_MS: String(config.timeoutMs) };
      let savedPromptPath = promptPath;
      let versionPath: string | undefined;
      let promptTemporary: string | undefined;
      let envTemporary: string | undefined;
      let committed = false;
      try {
        check();
        const promptNeedsSave = originalPrompt === null || draft.prompt !== originalPrompt;
        if (promptNeedsSave) {
          const directory = dirname(absolutePromptPath);
          const relativeDirectory = dirname(promptPath);
          const relative = !isAbsolute(promptPath);
          const forbidden = new Set([envPath, resolve(cwd, env.GRYT_IDENTITY_PATH ?? './data/gryt-bot-identity.json')]);
          for (let attempt = 0; attempt < 3; attempt++) {
            const fileName = `system.${randomUUID()}.md`;
            const candidate = join(directory, fileName);
            if (forbidden.has(candidate) || candidate === absolutePromptPath) continue;
            const temporary = `${candidate}.${randomUUID()}.tmp`;
            promptTemporary = temporary;
            try {
              check();
              await writeFile(temporary, draft.prompt, { flag: 'wx', mode: 0o600 });
              check();
              await chmod(temporary, 0o600);
              check();
              await link(temporary, candidate);
              versionPath = candidate;
              check();
              await unlink(temporary);
              promptTemporary = undefined;
              savedPromptPath = relative ? join(relativeDirectory === '.' ? '' : relativeDirectory, fileName) : candidate;
              break;
            } catch (error) {
              await unlink(temporary).catch(() => {});
              if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            }
          }
          if (!versionPath) throw new Error('Could not create a new prompt version.');
        }
        next.SYSTEM_PROMPT_PATH = savedPromptPath;

        const content = Object.entries(next).map(([key, value]) => `${key}=${encode(value)}`).join('\n') + '\n';
        const decoded = parseEnv(content);
        if (Object.entries(next).some(([key, value]) => decoded[key] !== value)) {
          throw new Error('Settings cannot be safely encoded. No settings were saved.');
        }
        envTemporary = `${envPath}.${randomUUID()}.tmp`;
        check();
        await writeFile(envTemporary, content, { flag: 'wx', mode: 0o600 });
        check();
        await chmod(envTemporary, 0o600);
        if (await optionalRead(envPath) !== originalEnv || await optionalRead(absolutePromptPath) !== originalPrompt ||
            (templatePath !== undefined && await optionalRead(templatePath) !== template)) {
          throw new Error('Configuration changed during setup-llm. Run setup-llm again.');
        }
        check();
        // The rename is the commit point. Once it succeeds, a late signal
        // cannot turn a committed save into cancellation or delete its prompt.
        await rename(envTemporary, envPath);
        committed = true;
        return { promptPath: savedPromptPath };
      } finally {
        if (!committed && versionPath) await unlink(versionPath).catch(() => {});
        if (promptTemporary) await unlink(promptTemporary).catch(() => {});
        if (envTemporary) await unlink(envTemporary).catch(() => {});
      }
    },
  };
}
