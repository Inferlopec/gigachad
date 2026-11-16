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
  const defaults = loadConfig(env);
  assert.equal(defaults.searchEnabled, false);
  assert.equal(defaults.searchLlmBaseUrl, defaults.baseUrl);
  assert.equal(defaults.searchLlmApiKey, defaults.apiKey);
  assert.equal(defaults.searchLlmModel, defaults.model);
  assert.equal(Object.hasOwn(defaults, 'searxngUrl'), false);
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

test('optional search validates its LLM API overrides and inherits main settings', () => {
  assert.throws(() => loadConfig({ ...env, SEARCH_ENABLED: 'yes' }), /SEARCH_ENABLED must be true or false/);

  const inherited = loadConfig({ ...env, SEARCH_ENABLED: 'true' });
  assert.equal(inherited.searchEnabled, true);
  assert.equal(inherited.searchLlmBaseUrl, inherited.baseUrl);
  assert.equal(inherited.searchLlmApiKey, inherited.apiKey);
  assert.equal(inherited.searchLlmModel, inherited.model);

  const overridden = loadConfig({
    ...env,
    SEARCH_ENABLED: 'true',
    SEARCH_LLM_BASE_URL: 'https://query-llm.example/v1///',
    SEARCH_LLM_API_KEY: 'query-secret',
    SEARCH_LLM_MODEL: 'query-model',
  });
  assert.equal(overridden.searchLlmBaseUrl, 'https://query-llm.example/v1');
  assert.equal(overridden.searchLlmApiKey, 'query-secret');
  assert.equal(overridden.searchLlmModel, 'query-model');

  for (const value of ['not a url', 'ftp://query-secret.example', 'https://user:secret@example.com',
    'https://example.com?key=secret', 'https://example.com#secret']) {
    assert.throws(() => loadConfig({ ...env, SEARCH_ENABLED: 'true', SEARCH_LLM_BASE_URL: value }), (error: Error) => {
      assert.match(error.message, /SEARCH_LLM_BASE_URL/);
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
  assert.throws(
    () => loadConfig({ ...env, SEARCH_ENABLED: 'true', SEARCH_LLM_API_KEY: 'query-secret\nheader' }),
    (error: Error) => {
      assert.match(error.message, /SEARCH_LLM_API_KEY/);
      assert.doesNotMatch(error.message, /query-secret/);
      return true;
    },
  );
  assert.throws(() => loadConfig({ ...env, SEARCH_ENABLED: 'true', SEARCH_LLM_MODEL: 'model\nname' }), /SEARCH_LLM_MODEL/);

  // Dormant search settings do not prevent the default LLM-only runtime from starting.
  const disabled = loadConfig({ ...env, SEARCH_LLM_BASE_URL: 'not a url', SEARCH_LLM_MAX_TOKENS: 'bad' });
  assert.equal(disabled.searchEnabled, false);
  assert.equal(disabled.searchLlmBaseUrl, disabled.baseUrl);
  assert.throws(() => loadConfig({ ...env, SEARCH_ENABLED: 'true', SEARCH_LLM_MAX_TOKENS: 'bad' }), /SEARCH_LLM_MAX_TOKENS/);
});
