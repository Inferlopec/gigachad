# M1.1 — Audit and baseline

Audit date: 2026-11-16. Source baseline: `36b574acd7bce8b4b951347089253d43c396ea49`
on `next`. Tracking: [#1](https://github.com/Inferlopec/gigachad/issues/1).
GitHub issues, rather than this snapshot, own current task status.

## Baseline follow-up — 2026-11-16

After maintainer approval to perform preparation, `test/searchQuery.ts` was
renamed to `test/searchQuery.test.ts` without changing test contents. The standard
`npm test` now runs all 61 tests. A clean `npm ci --no-audit --no-fund` on Node
24.22.2 / npm 11.19.1 succeeded, followed by passing `npm run typecheck`,
`npm test` (61/61) and `npm run build`. No application behavior changed.
AGENTS.md now explicitly requires standard test discovery and integration of
audit evidence before issue closure. The original audit below records the
earlier observations; its discovery and fresh-install gaps are resolved by
this follow-up. Deployment and live-integration verification remain outstanding
in their owning roadmap tasks.

## Environment and checks

- GitHub CLI authenticated as `Inferlopec`; repository permission `ADMIN`.
- Local and remote `next` matched the source baseline. Local and remote `main`
  were `79bd864e792628f5fceb8dca4738f363a3266df0`; neither was changed.
- Linux x86_64; Node 24.22.2 from `.tools/node/bin`, npm 11.19.1.
  Node was initially absent from PATH. Commands used
  `export PATH="$PWD/.tools/node/bin:$PATH"` first.
- Existing installed dependencies: `@gryt/bot@0.3.1`, TypeScript 5.9.3,
  `@types/node@24.19.2`. The lockfile pins the SDK tarball/integrity.
  A fresh `npm ci` was not performed; these checks used the existing installation.
- `npm run typecheck`: passed. Its tsconfig includes only `src/**/*.ts`,
  so this does not type-check the test files.
- `npm test`: passed, 46 tests across four files, with localhost access.
  The initial restricted sandbox run failed in the HTTP-based test files;
  the unrestricted rerun passed without source changes.
- `node --test --test-isolation=none --test-reporter=tap test/*.ts`:
  passed, 61 tests across all five intended files.
- `npm run build`: passed; generated only ignored `dist/` output.
- `docker compose --env-file /dev/null config --no-env-resolution --quiet`:
  passed using Compose v5.7.0 without displaying resolved secrets.
  This does not establish compatibility with the target Compose v2.
- Image build/smoke, real Gryt registration/reconnect, live LLM/SearXNG and
  clean-VM checks were not run. Deployment was unchanged. Docker daemon access
  was denied in the sandbox; no daemon escalation or production operation was attempted.

The implementation passes the executed tests, but the standard test command
omits `test/searchQuery.ts` (15 tests). M1.1 must not claim complete standard
test discovery until that file follows the test naming convention or the
test command includes it. No test/package/application changes were made in this audit.

## Existing boundaries to retain

| Component | Reusable implementation and observed coverage |
| --- | --- |
| `src/handler.ts` | Injected dependencies; complete-ID mention parsing, code/link/escape exclusions, one-channel and self/system/readiness guards, deduplication, bounded history, last-four-plus-current context, busy-request dropping, typing refresh and UTF-16-safe reply truncation. Tests cover these paths and search fallback. |
| `src/llm.ts` | Shared OpenAI-compatible Chat Completions transport; configured endpoint/model/key, conservative byte budget, oldest-history trimming, bounded body, timeout/abort, one transient retry and safe fixed diagnostics. HTTP mocks cover payload, errors, budgets, abort and retries. |
| `src/search.ts` | Optional SearXNG client, cache, rate limiter, circuit breaker and result formatting. Tests cover normal responses, throttling/cache/breaker and failures. |
| `src/searchQuery.ts` | Dedicated query extraction, NOSEARCH handling, short-message skip and deterministic nickname removal. Fifteen dedicated tests are outside standard discovery; handler/LLM tests also exercise parts of this path. |
| `src/config.ts` | Existing single env parser validates required fields, HTTP(S) Gryt/LLM endpoints, positive integers and token budgets. Config tests currently live in `llm.test.ts`. Extend this source for runtime/CLI rather than adding a second parser. |
| SDK identity | Existing test proves new identity survives reload with the same subject and mode 0600. Keep SDK key storage and persistent Compose volume. |

`src/index.ts` combines process entry, configuration, storage preparation, SDK
construction, raw token extraction, lifecycle and dependency wiring. Extract
these boundaries around the existing modules; a rewrite is unnecessary.
Retain env-based configuration: the audit found no concrete reason for a new format.

## Pinned SDK findings

Evidence comes from installed `@gryt/bot@0.3.1` declarations and implementation
(`dist/client.d.ts`, `dist/client.js`, `dist/identity.js`), not an assumption about
the latest upstream release.

- `socket` is public, nullable before start; `serverUserId` is private and has no
  public getter. The current workaround reads the `serverUserId` access-token
  claim on `server:joined`. Keep it entirely inside a Gryt integration adapter;
  parsing identifies the bot, it does not authorize actions or verify a token.
- Supplying a preloaded identity avoids the awaited identity-loading branch,
  so the socket exists synchronously after calling `start()` in this version.
  The current non-null assertion depends on this implementation detail.
- `start()` waits for initial `ready`; first registration can remain pending
  while administrator approval is required. Approval emits `waiting` rather
  than a fatal error. `stop()` disconnects and stops refresh/reconnect but does
  not itself settle the pending start promise. Test shutdown while waiting.
- Socket.IO reconnects; the SDK rejoins on connect. `ready` is emitted only
  for the first server details payload, not every reconnect. The adapter must
  clear availability/self-ID on disconnect and establish it again on join,
  while consulting current permissions/channels.
- The SDK exposes channels, permissions, message events, send and typing APIs
  needed by the target architecture. No SDK replacement/server modification is needed.
- `loadIdentity` creates a key on ENOENT, reuses an existing key, and throws on
  malformed existing data. It does not provide an application-level process
  lock; M2 must prevent setup and runtime sharing an identity concurrently.
  Missing-key creation is not an atomic exclusive write, so do not run competing
  first-time loaders. Do not add silent recovery that replaces damaged keys.

## M1 gaps and implementation plan

Finish the discovery correction and rerun all checks under #1 before starting
implementation of #2. This audit intentionally leaves that correction for a
follow-up change because the assigned task excludes application code changes.

### M1.2 — Runtime and configuration (#2)

1. Extract an explicit runtime factory/start-stop API and thin process entry.
   Inject the Gryt client and external dependencies so tests never connect to a server.
2. Add a Gryt integration adapter around SDK creation, self-ID parsing,
   availability and listener cleanup. Cover missing socket, invalid/missing claim,
   join/disconnect/rejoin, permission changes, startup failure and shutdown while
   waiting for approval. Preserve handler semantics and existing request abort behavior.
3. Extend `loadConfig` as the one runtime/CLI-ready source. Make nickname and
   prompt path configurable; preserve identity paths and separate prompt storage.
   Retain required explicit LLM endpoint/model/key and generic numeric defaults.
4. Remove personal hosts, model/replica requirements and name examples from
   distributed config, README and extraction prompt/test fixtures. Keep generic
   prompt templates and the existing extraction behavior. Do not publish local prompts.
5. Resolve the unconditional `chat_template_kwargs.enable_thinking=false`
   Qwen/vLLM extension: omit it from the generic request, or explicitly configure
   an optional setting if agreed. The portable default must work without a
   provider-specific parameter. Update payload expectations deliberately.
6. Add focused config and lifecycle tests; expand identity tests to cover
   malformed identity without replacement and reuse through the runtime boundary.
   Run typecheck, every intended test and build. Keep CLI UI and installer work in M2/M3.

### M1.3 — Optional search (#3)

1. Default search to disabled with `SEARCH_ENABLED=false`. Keep SearXNG at the
   fixed internal Compose address `http://searxng:8080`; do not expose a user URL.
2. Let search-query extraction inherit the main LLM API endpoint, key and model.
   Support optional `SEARCH_LLM_BASE_URL`, `SEARCH_LLM_API_KEY` and
   `SEARCH_LLM_MODEL` overrides for future CLI configuration, and validate them
   only when search is enabled.
3. Put managed SearXNG behind an opt-in Compose profile and remove the bot's
   unconditional `depends_on: service_healthy`.
4. Preserve query extraction, rate limits, cache, breaker and LLM-only fallback.
   Test disabled wiring, the fixed internal endpoint, inherited/overridden LLM
   settings, and extraction/search failures.
5. Update development/deployment instructions for actual disabled/enabled modes.
   Validate both Compose configurations with v2 and build/smoke-test the image;
   then run typecheck, all tests and build. Installer lifecycle remains in M3.3.

M1 exit additionally requires generic config to work and existing mention,
single-channel, conversation and LLM behavior to remain covered. None of the
M2–M5 backlog has been started by this audit.

## Coverage limits and deferred observations

No coverage percentage was measured. Tests demonstrate the named paths, not
full line/branch coverage. Lifecycle, SDK event order/reconnect, signal handling,
corrupt identity preservation, CLI interaction and real image operation lack
direct coverage today. HTTP tests use local mocks; identity tests use disposable
temporary files, not the installed bot identity.

Some search edge cases deserve future triage rather than incidental changes:
`parseQuery` collapses whitespace before splitting on newlines; nickname removal
also removes a sender name when it is the explicit topic; SearXNG response shape
and size are less constrained than LLM responses; cache cleanup is expiry-based,
not a hard entry cap. These are code-review observations, not newly reproduced
production defects or authorization to expand M1. SDK/raw search-dependency
error logging also needs review before claiming all logs are secret-safe.

Docker currently builds from source and mounts an ignored local prompt directory.
There is no release workflow, host CLI or installer yet; these remain M2–M4.
The SDK declares AGPL-3.0-or-later and the repository has no tracked root LICENSE;
confirm project licensing and dependency notice obligations before public release
under M5.3. This is a release-readiness question, not a licensing conclusion.

## Organization recommendations

- Keep standard test naming/discovery in M1.1's acceptance and require the normal
  command to run all intended files before closure. Do not treat the manual
  61-test run as a permanent workaround.
- Clarify in AGENTS.md that audit/documentation issues can be completed by
  integrating evidence into `next`, and that changes limited to tests/tooling
  should still run the checks they affect.
- M4.1 currently arrives after substantial development. Consider adding a minimal
  non-publishing CI check earlier, while retaining release automation in M4.
  This changes milestone scope/order and needs agreement; it was not implemented.
- Keep early verification notes beside the affected issue, with version/commands
  and outstanding manual checks. Add target Compose v2 verification explicitly;
  a newer local Compose version alone is not acceptance evidence.
- Separate final maintainer approval for merging/releasing from pre-release
  pipeline validation; agree the non-stable validation mechanism before M4.3.
  Do not let M5.3's combined documentation/release scope obscure that gate.
