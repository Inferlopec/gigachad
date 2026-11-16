import { runProcess } from './process.ts';

void runProcess().catch(() => { process.exitCode = 1; });
