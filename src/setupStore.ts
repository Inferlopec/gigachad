import { chmod, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { loadChannelId, loadGrytConfig, type GrytConfig } from './config.ts';

async function readOptional(path: string): Promise<string | null> {
  try { return await readFile(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function encode(value: string): string {
  // Node's dotenv parser does not interpret JSON-style quote escaping.
  for (const quote of ['"', "'", '`']) {
    if (!value.includes(quote)) return `${quote}${value}${quote}`;
  }
  throw new Error('A setting contains an unsupported combination of quote characters. No settings were saved.');
}

export async function readSetupStore(path: string) {
  const absolute = resolve(path);
  const original = await readOptional(absolute);
  const env = parseEnv(original ?? '');
  return {
    env,
    save: async (input: GrytConfig, channel: string) => {
      const config = loadGrytConfig({ GRYT_HOST: input.host, GRYT_NICKNAME: input.nickname,
        GRYT_IDENTITY_PATH: input.identityPath });
      const next = { ...env, GRYT_HOST: config.host, GRYT_NICKNAME: config.nickname,
        GRYT_IDENTITY_PATH: config.identityPath, GRYT_ALLOWED_CHANNEL_ID: loadChannelId(channel) };
      // Registration tokens are single-use, supplied only to this connection.
      delete (next as Record<string, string>).GRYT_BOT_TOKEN;
      const content = Object.entries(next).map(([key, value]) => `${key}=${encode(value)}`).join('\n') + '\n';
      const decoded = parseEnv(content);
      if (Object.entries(next).some(([key, value]) => decoded[key] !== value)) {
        throw new Error('Settings cannot be safely encoded. No settings were saved.');
      }
      // Refuse overwriting edits made while the wizard was open.
      if (await readOptional(absolute) !== original) throw new Error('Configuration changed during setup. Run setup again.');
      const temporary = `${absolute}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        await chmod(temporary, 0o600);
        if (await readOptional(absolute) !== original) throw new Error('Configuration changed during setup. Run setup again.');
        await rename(temporary, absolute);
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      }
    },
  };
}
