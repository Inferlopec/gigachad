import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from '../src/config.ts';
import { env } from './support/fixtures.ts';

test('shared configuration requires explicit Gryt name and LLM settings with configurable prompt path', () => {
  const c = loadConfig({ ...env, GRYT_NICKNAME: ' Other Bot ', SYSTEM_PROMPT_PATH: './custom/prompt.md' });
  assert.equal(c.nickname, 'Other Bot');
  assert.equal(c.promptPath, './custom/prompt.md');
  assert.equal(c.model, env.LLM_MODEL);
  assert.equal(loadConfig(env).promptPath, 'prompts/system.md');
  for (const key of ['GRYT_NICKNAME', 'GRYT_HOST', 'LLM_MODEL', 'LLM_BASE_URL', 'LLM_API_KEY', 'GRYT_IDENTITY_PATH']) {
    assert.throws(() => loadConfig({ ...env, [key]: '' }), new RegExp(key));
  }
  assert.throws(() => loadConfig({ ...env, SYSTEM_PROMPT_PATH: ' ' }), /SYSTEM_PROMPT_PATH/);
  assert.throws(() => loadConfig({ ...env, GRYT_NICKNAME: 'first\nsecond' }), /single line/);
  assert.equal(loadConfig({ ...env, SEARXNG_URL: 'https://search.example.com',
    SEARCH_LLM_MODEL: env.LLM_MODEL }).searchLlmModel, env.LLM_MODEL);
});

test('endpoint validation errors name the setting without exposing URL input or secrets', () => {
  for (const key of ['GRYT_HOST', 'LLM_BASE_URL']) {
    for (const input of ['secret invalid url', 'ftp://secret.example', 'https://user:secret@example.com',
      'https://example.com?key=secret', 'https://example.com#secret']) {
      assert.throws(() => loadConfig({ ...env, [key]: input }), (error: Error) => {
        assert.match(error.message, new RegExp(key));
        assert.doesNotMatch(error.message, /secret/);
        return true;
      });
    }
  }
  const c = loadConfig({ ...env, LLM_BASE_URL: 'http://localhost:8080/v1///' });
  assert.equal(c.baseUrl, 'http://localhost:8080/v1');
});
