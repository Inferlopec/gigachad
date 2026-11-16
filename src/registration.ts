import { loadGrytConfig, type GrytConfig } from './config.ts';
import { createGrytIntegration, type GrytIntegration, type GrytProgress } from './gryt.ts';
import { IdentityBusyError } from './identityLease.ts';

export type RegistrationResult =
  | { status: 'ready'; channels: { id: string; name: string }[]; close: () => Promise<void> }
  | { status: 'cancelled' }
  | { status: 'failed'; code: 'invalid-input' | 'identity-busy' | 'connection'; message: string };

type Options = {
  signal: AbortSignal;
  onProgress?: (event: GrytProgress) => void;
  createIntegration?: typeof createGrytIntegration;
};

// Own a registration connection until the caller closes it. No message handler,
// LLM or terminal is started here, and no settings or token are persisted.
export async function registerGryt(input: GrytConfig, options: Options): Promise<RegistrationResult> {
  if (options.signal.aborted) return { status: 'cancelled' };
  let gryt: GrytIntegration | undefined;
  const cancel = () => { void gryt?.stop().catch(() => {}); };
  try {
    let config: GrytConfig;
    try {
      config = loadGrytConfig({ GRYT_HOST: input.host, GRYT_NICKNAME: input.nickname,
        GRYT_IDENTITY_PATH: input.identityPath, GRYT_BOT_TOKEN: input.botToken });
    } catch {
      return { status: 'failed', code: 'invalid-input', message: 'Invalid Gryt settings. Check host URL, nickname and identity path.' };
    }
    gryt = (options.createIntegration ?? createGrytIntegration)(config, {
      onMessage: () => {}, log: () => {}, logError: () => {}, onProgress: options.onProgress,
    });
    options.signal.addEventListener('abort', cancel, { once: true });
    if (options.signal.aborted) cancel();
    await gryt.start();
    if (options.signal.aborted) {
      await gryt.stop();
      return { status: 'cancelled' };
    }
    if (!gryt.available()) throw new Error('Not ready');
    const connection = gryt;
    return { status: 'ready', channels: gryt.channels(), close: async () => {
      options.signal.removeEventListener('abort', cancel);
      try { await connection.stop(); }
      catch { throw new Error('Could not stop Gryt; identity lock retained.'); }
    } };
  } catch (error) {
    await gryt?.stop().catch(() => {});
    if (options.signal.aborted) return { status: 'cancelled' };
    return error instanceof IdentityBusyError
      ? { status: 'failed', code: 'identity-busy', message: error.message }
      : { status: 'failed', code: 'connection', message: 'Gryt setup failed. Check identity storage, registration, connectivity and read_messages/send_messages permissions.' };
  } finally {
    // A ready result retains its abort listener until close, including while the
    // caller is selecting a channel or confirming save.
    if (!gryt?.available() || options.signal.aborted) options.signal.removeEventListener('abort', cancel);
  }
}
