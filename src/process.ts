import { loadConfig } from './config.ts';
import { createRuntime, type Runtime } from './runtime.ts';

type Options = {
  env?: NodeJS.ProcessEnv;
  signals?: {
    once: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
    off: (signal: 'SIGINT' | 'SIGTERM', listener: () => void) => unknown;
  };
  log?: (message: string) => void;
  logError?: (message: string) => void;
  createRuntime?: typeof createRuntime;
};

export async function runProcess(options: Options = {}): Promise<Runtime> {
  const signals = options.signals ?? process;
  const log = options.log ?? ((message) => console.log(`[${new Date().toISOString()}] [gigachad] ${message}`));
  const logError = options.logError ?? ((message) => console.error(`[${new Date().toISOString()}] [gigachad] ${message}`));
  let config: ReturnType<typeof loadConfig>;
  try { config = loadConfig(options.env); }
  catch (error) {
    logError(error instanceof Error ? error.message : 'Invalid configuration.');
    throw new Error('Invalid configuration');
  }
  const runtime = (options.createRuntime ?? createRuntime)(config, { log, logError });
  const cleanup = () => {
    signals.off('SIGINT', onInterrupt);
    signals.off('SIGTERM', onTerminate);
  };
  const stop = async () => {
    cleanup();
    await runtime.stop();
  };
  const onSignal = (signal: string) => {
    log(`Received ${signal}; shutting down.`);
    void stop().catch(() => {
      logError('Shutdown failed.');
      process.exitCode = 1;
    });
  };
  const onInterrupt = () => onSignal('SIGINT');
  const onTerminate = () => onSignal('SIGTERM');
  signals.once('SIGINT', onInterrupt);
  signals.once('SIGTERM', onTerminate);
  try { await runtime.start(); }
  catch {
    cleanup();
    logError('Startup failed. Check configuration, identity storage, registration, and connectivity.');
    throw new Error('Startup failed');
  }
  return { start: runtime.start, stop };
}
