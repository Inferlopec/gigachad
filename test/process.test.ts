import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { runProcess } from '../src/process.ts';
import { env } from './support/fixtures.ts';

for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`process handles ${signal} while approval is pending and removes both signal listeners`, async () => {
    const signals = new EventEmitter();
    const logs: string[] = [];
    let finish!: () => void;
    let stops = 0;
    const running = runProcess({
      env, signals, log: (m) => logs.push(m), logError: (m) => logs.push(m),
      createRuntime: () => ({
        start: () => new Promise<void>((resolve) => { finish = resolve; }),
        stop: async () => { stops++; finish(); },
      }),
    });
    assert.equal(signals.listenerCount(signal), 1);
    signals.emit(signal);
    await running;
    assert.equal(stops, 1);
    assert.equal(signals.listenerCount('SIGINT'), 0);
    assert.equal(signals.listenerCount('SIGTERM'), 0);
    assert.match(logs.join('\n'), new RegExp(signal));
  });
}

test('process reports safe startup failures and removes signal listeners', async () => {
  const signals = new EventEmitter();
  const logs: string[] = [];
  await assert.rejects(runProcess({
    env, signals, log: () => {}, logError: (m) => logs.push(m),
    createRuntime: () => ({ start: async () => { throw new Error('secret SDK body'); }, stop: async () => {} }),
  }), /Startup failed/);
  assert.doesNotMatch(logs.join('\n'), /secret/);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});

test('invalid configuration cannot create a runtime or register signal handlers', async () => {
  const signals = new EventEmitter();
  const logs: string[] = [];
  await assert.rejects(runProcess({
    env: { ...env, LLM_BASE_URL: 'secret bad url' }, signals,
    logError: (m) => logs.push(m), createRuntime: () => { assert.fail('runtime must not be created'); },
  }), /Invalid configuration/);
  assert.match(logs.join('\n'), /LLM_BASE_URL/);
  assert.doesNotMatch(logs.join('\n'), /secret/);
  assert.equal(signals.listenerCount('SIGTERM'), 0);
});
