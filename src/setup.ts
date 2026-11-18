import { loadChannelId, loadGrytConfig, loadGrytHost } from './config.ts';
import { registerGryt } from './registration.ts';
import { readSetupStore } from './setupStore.ts';

export type SetupTerminal = {
  ask: (label: string, initial?: string, secret?: boolean) => Promise<string>;
  write: (message: string) => void;
};
export type SetupResult = { status: 'saved' | 'cancelled' | 'failed' };
const retained = 'Any identity created or registration completed is retained. Reuse the same identity path on the next setup.';
const display = (value: string) => value.replace(/[\x00-\x1f\x7f-\x9f]/g, '');

export async function runSetup(options: {
  envPath: string;
  signal: AbortSignal;
  terminal: SetupTerminal;
  register?: typeof registerGryt;
}): Promise<SetupResult> {
  const { terminal, signal } = options;
  let close: (() => Promise<void>) | undefined;
  const check = () => signal.throwIfAborted();
  try {
    check();
    const store = await readSetupStore(options.envPath);
    terminal.write('Gryt setup. Ctrl+C cancels. Stop the running bot before registration.');
    let defaultHost: string | undefined;
    // An invalid stored URL can contain embedded credentials or query tokens.
    try { defaultHost = loadGrytHost(store.env.GRYT_HOST ?? ''); } catch { /* ask afresh */ }
    const host = await terminal.ask('Gryt host (HTTP(S) URL)', defaultHost);
    const nickname = await terminal.ask('Bot nickname', store.env.GRYT_NICKNAME);
    const identityPath = await terminal.ask('Identity path (reuse the existing path)', store.env.GRYT_IDENTITY_PATH ?? './data/gryt-bot-identity.json');
    const botToken = await terminal.ask('Optional single-use registration token (hidden; blank waits for approval)', undefined, true);
    check();
    const config = loadGrytConfig({ GRYT_HOST: host, GRYT_NICKNAME: nickname,
      GRYT_IDENTITY_PATH: identityPath, GRYT_BOT_TOKEN: botToken });
    const result = await (options.register ?? registerGryt)(config, { signal, onProgress: (event) => {
      const messages = {
        'identity-loaded': 'Persistent identity loaded; it will be kept if setup is cancelled.',
        connecting: 'Connecting to Gryt…', waiting: 'Waiting for administrator approval. Approve read_messages and send_messages in Gryt. Ctrl+C cancels.',
        ready: 'Gryt connection ready.',
      };
      terminal.write(messages[event]);
    } });
    if (result.status === 'failed') {
      terminal.write(result.message);
      terminal.write(retained);
      return { status: 'failed' };
    }
    if (result.status === 'cancelled') {
      terminal.write(`Setup cancelled; saved settings unchanged. ${retained}`);
      return { status: 'cancelled' };
    }
    close = result.close;
    check();
    result.channels.forEach((channel, i) => terminal.write(`${i + 1}. ${display(channel.name)} [${display(channel.id)}]`));
    terminal.write('0. Enter channel ID manually');
    let channelId: string;
    while (true) {
      const choice = await terminal.ask('Channel number', '0');
      check();
      if (choice === '0') {
        channelId = loadChannelId(await terminal.ask('Channel ID (verify bot access in Gryt)', store.env.GRYT_ALLOWED_CHANNEL_ID));
        break;
      }
      const index = Number(choice) - 1;
      const channel = /^\d+$/.test(choice) && Number.isSafeInteger(index) ? result.channels[index] : undefined;
      if (channel) { channelId = loadChannelId(channel.id); break; }
      terminal.write('Select a listed number, or 0 for a manual ID.');
    }
    check();
    const save = await terminal.ask('Save Gryt settings? This replaces dotenv formatting/comments, preserves other setting values and removes the single-use token. [y/N]', 'n');
    check();
    if (!['y', 'yes'].includes(save.toLowerCase())) {
      terminal.write(`Setup cancelled; saved settings unchanged. ${retained}`);
      return { status: 'cancelled' };
    }
    await store.save(config, channelId);
    terminal.write('Gryt settings saved. Bot is not started. The complete setup wizard can configure the LLM and prompt.');
    return { status: 'saved' };
  } catch {
    if (signal.aborted) {
      terminal.write(`Setup cancelled; saved settings unchanged. ${retained}`);
      return { status: 'cancelled' };
    }
    // Filesystem/SDK errors may include credentials, paths or server payloads.
    terminal.write(`Setup failed. Check inputs, configuration permissions and whether the configuration changed during setup. ${retained}`);
    return { status: 'failed' };
  } finally {
    if (close) {
      try { await close(); }
      catch {
        terminal.write('Could not close the Gryt connection. Stop this process before retrying; the identity lock is retained.');
        return { status: 'failed' };
      }
    }
  }
}
