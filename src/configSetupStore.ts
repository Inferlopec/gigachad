import { chmod, link, mkdir, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { loadConfig, validateLlmPrompt } from './config.ts';

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
  for (const quote of ['"', "'", '`']) if (!value.includes(quote)) return `${quote}${value}${quote}`;
  throw new Error('A setting contains an unsupported combination of quote characters. No settings were saved.');
}

export async function readConfigSetupStore(envFile: string, cwd = process.cwd()) {
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
  const activePromptPath = promptPath;

  return {
    env,
    promptPath,
    prompt: originalPrompt ?? template ?? '',
    save: async (draft: NodeJS.ProcessEnv, prompt: string, signal?: AbortSignal) => {
      const check = () => signal?.throwIfAborted();
      check();
      const config = loadConfig(draft);
      validateLlmPrompt(config, prompt);
      if (await optionalRead(envPath) !== originalEnv) throw new Error('Configuration changed during setup. Run config again.');
      if (await optionalRead(absolutePromptPath) !== originalPrompt) throw new Error('System prompt changed during setup. Run config again.');
      if (templatePath && await optionalRead(templatePath) !== template) throw new Error('Prompt template changed during setup. Run config again.');

      const next: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) if (value !== undefined) next[key] = value;
      const fields = [
        'GRYT_HOST', 'GRYT_NICKNAME', 'GRYT_IDENTITY_PATH', 'GRYT_ALLOWED_CHANNEL_ID',
        'LLM_BASE_URL', 'LLM_MODEL', 'LLM_API_KEY', 'LLM_CONTEXT_TOKENS', 'LLM_MAX_TOKENS', 'LLM_TIMEOUT_MS',
        'SEARCH_ENABLED', 'SEARCH_LLM_BASE_URL', 'SEARCH_LLM_API_KEY', 'SEARCH_LLM_MODEL',
        'SEARCH_LLM_TIMEOUT_MS', 'SEARCH_LLM_MAX_TOKENS', 'SEARCH_LLM_CONTEXT_TOKENS',
        'SEARCH_TIMEOUT_MS', 'SEARCH_MAX_RESULTS', 'SEARCH_RATE_LIMIT', 'SEARCH_RATE_WINDOW_MS', 'SEARCH_CACHE_TTL_MS',
      ];
      for (const field of fields) {
        const value = draft[field];
        if (value === undefined || value === '') delete next[field];
        else next[field] = value;
      }
      // Persist normalized required values and never retain one-time registration material.
      next.GRYT_HOST = config.host;
      next.GRYT_NICKNAME = config.nickname;
      next.GRYT_IDENTITY_PATH = config.identityPath;
      next.GRYT_ALLOWED_CHANNEL_ID = config.channelId;
      next.LLM_BASE_URL = config.baseUrl;
      next.LLM_MODEL = config.model;
      next.LLM_API_KEY = config.apiKey;
      next.LLM_CONTEXT_TOKENS = String(config.contextTokens);
      next.LLM_MAX_TOKENS = String(config.maxTokens);
      next.LLM_TIMEOUT_MS = String(config.timeoutMs);
      next.SEARCH_ENABLED = String(config.searchEnabled);
      delete next.GRYT_BOT_TOKEN;
      let savedPromptPath = activePromptPath;
      let versionPath: string | undefined;
      let promptTemporary: string | undefined;
      let envTemporary: string | undefined;
      let committed = false;
      try {
        check();
        if (originalPrompt === null || prompt !== originalPrompt) {
          const directory = dirname(absolutePromptPath);
          await mkdir(directory, { recursive: true, mode: 0o700 });
          const relativeDirectory = dirname(activePromptPath);
          const relative = !isAbsolute(activePromptPath);
          const forbidden = new Set([envPath, identityPath]);
          for (let attempt = 0; attempt < 3; attempt++) {
            const fileName = `system.${randomUUID()}.md`;
            const candidate = join(directory, fileName);
            if (forbidden.has(candidate) || candidate === absolutePromptPath) continue;
            const temporary = `${candidate}.${randomUUID()}.tmp`;
            promptTemporary = temporary;
            try {
              check();
              await writeFile(temporary, prompt, { flag: 'wx', mode: 0o600 });
              await chmod(temporary, 0o600);
              check();
              await link(temporary, candidate);
              versionPath = candidate;
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
        await mkdir(dirname(envPath), { recursive: true, mode: 0o700 });
        check();
        await writeFile(envTemporary, content, { flag: 'wx', mode: 0o600 });
        await chmod(envTemporary, 0o600);
        if (await optionalRead(envPath) !== originalEnv || await optionalRead(absolutePromptPath) !== originalPrompt ||
            (templatePath !== undefined && await optionalRead(templatePath) !== template)) {
          throw new Error('Configuration changed during setup. Run config again.');
        }
        check();
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
