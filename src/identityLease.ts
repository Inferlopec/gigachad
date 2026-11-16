import { mkdir, realpath, rmdir } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export class IdentityBusyError extends Error {
  constructor() {
    super('Identity is locked. Stop the running bot or setup first. After a crash, remove only the adjacent .lock directory once all bot/setup processes are stopped; keep the identity file.');
  }
}

// Atomic filesystem ownership shared by setup and runtime, including containers
// sharing the identity directory. Never guess that an existing lock is stale.
export async function acquireIdentityLease(path: string) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true, mode: 0o700 });
  let canonical: string;
  try { canonical = await realpath(absolute); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    canonical = join(await realpath(dirname(absolute)), basename(absolute));
  }
  const lockPath = `${canonical}.lock`;
  try { await mkdir(lockPath, { mode: 0o700 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new IdentityBusyError();
    throw error;
  }
  let released = false;
  return {
    path: canonical,
    release: async () => {
      if (released) return;
      await rmdir(lockPath);
      released = true;
    },
  };
}
