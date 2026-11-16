import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { runSetup } from './setup.ts';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] !== 'setup' || (args.length !== 1 && !(args.length === 3 && args[1] === '--env-file' && args[2]))) {
    console.error('Usage: node dist/cli.js setup [--env-file PATH]');
    return 1;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Setup requires an interactive terminal (stdin and stdout TTY).');
    return 1;
  }
  const controller = new AbortController();
  let hidden = false;
  let closing = false;
  // readline writes input echo through this stream. Suppress it entirely for
  // tokens, and disable history so earlier secret answers cannot be recalled.
  const output = new Writable({ write(chunk, _encoding, done) {
    if (!hidden) process.stdout.write(chunk);
    done();
  } });
  const terminal = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
  const cancel = () => controller.abort();
  terminal.on('SIGINT', cancel);
  terminal.on('close', () => { if (!closing) cancel(); });
  process.once('SIGINT', cancel);
  process.once('SIGTERM', cancel);
  try {
    const result = await runSetup({ envPath: args[2] ?? '.env', signal: controller.signal, terminal: {
      write: (message) => console.log(message),
      ask: async (label, initial, secret = false) => {
        controller.signal.throwIfAborted();
        const safe = initial?.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
        process.stdout.write(`${label}${safe && !secret ? ` [${safe}]` : ''}: `);
        hidden = secret;
        try {
          const answer = await terminal.question('', { signal: controller.signal });
          return answer.trim() || initial || '';
        } finally {
          hidden = false;
          if (secret) process.stdout.write('\n');
        }
      },
    } });
    return result.status === 'failed' ? 1 : result.status === 'cancelled' ? 130 : 0;
  } finally {
    closing = true;
    terminal.close();
    output.end();
    process.off('SIGINT', cancel);
    process.off('SIGTERM', cancel);
  }
}

main().then((code) => { process.exitCode = code; }).catch(() => {
  console.error('Setup failed. Check terminal, configuration and identity storage.');
  process.exitCode = 1;
});
