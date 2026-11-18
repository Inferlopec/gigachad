# gigachad

A minimal mention-only AI bot for Gryt servers. Built with `@gryt/bot` and an OpenAI-compatible Chat Completions endpoint.

- Responds only to direct ID-based mentions in `GRYT_ALLOWED_CHANNEL_ID`
- Each request includes the 5 most recent messages from the configured channel (including the trigger)
- One LLM request at a time; concurrent mentions are silently dropped (typing indicator shows the bot is busy)
- Transient LLM failures (5xx, timeout, network) are retried once after 1s before failing
- Optional web search via the managed SearXNG service (`SEARCH_ENABLED=true`)

## User Guide

### Install a prebuilt version (M3.1)

Target: Linux amd64 with Docker Engine and **Docker Compose v2** already
installed and accessible. The installer needs Bash, GNU coreutils, tar and curl;
it does not install Docker. Node.js and Git are not needed on the target host.

**Release publication is implemented in M4.** Until a versioned release/image
exists, use the local package workflow in [deployment notes](docs/DEPLOYMENT.md).
The following is the release installation contract, not a claim that the example
version has been published:

```sh
version=v1.0.0-rc.1 # replace with an available release tag
curl --fail --location --proto '=https' --proto-redir '=https' \
  "https://github.com/Inferlopec/gigachad/releases/download/$version/install.sh" \
  -o install.sh
# Inspect the downloaded script before running it as root.
sudo bash install.sh --version "$version"
```

The installer downloads and checks the versioned assets, pulls the matching
`ghcr.io/inferlopec/gigachad:<version>` image and validates Compose. It installs
into `/opt/gigachad` and creates `/usr/local/bin/gigachad`; both paths can be
changed with `--install-dir` and `--bin-dir`. An existing installation or launcher
is refused without overwriting it. Installation never starts setup or services.

`gigachad --help` and `gigachad --version` are available. Lifecycle commands and
setup/config forwarding belong to M3.2; use these direct commands meanwhile:

```sh
cd /opt/gigachad
sudo docker compose --env-file release.env run --rm --no-deps gigachad \
  node /app/dist/cli.js setup --env-file /data/.env
# After explicitly saving valid configuration:
sudo docker compose --env-file release.env up -d gigachad
sudo docker compose --env-file release.env logs -f --tail=100 gigachad
```

Setup registers the identity, waits for administrator approval if required,
selects a channel and configures the LLM, prompt and optional search. Setup
never starts the runtime. Cancelled edits preserve previously saved settings;
a newly created identity remains durable even when later steps are cancelled.
For approval, a Gryt administrator with `manage_bots` opens **Server settings →
Bots** and grants `read_messages` and `send_messages` plus access to the selected
channel. An administrator-created single-use registration token can instead be
entered in setup; it is removed from the saved dotenv.

### Edit configuration and enable optional search

Stop the runtime before opening a wizard that may register with Gryt:

```sh
cd /opt/gigachad
sudo docker compose --env-file release.env stop gigachad
sudo docker compose --env-file release.env run --rm --no-deps gigachad \
  node /app/dist/cli.js config --env-file /data/.env
sudo docker compose --env-file release.env up -d gigachad
```

If search was explicitly enabled and saved, start the managed backend with
`sudo docker compose --env-file release.env --profile search up -d`.
With search disabled, only `gigachad` starts. There are no incoming bot ports,
no mounted Docker socket, and no mandatory SearXNG dependency.

### Persistent data and identity

`/opt/gigachad/data` is mounted as `/data` for runtime and setup. It contains
private `.env`, `identity/gryt-bot-identity.json`, and `prompts/` with the active
prompt and its saved versions. Directories are `0700`, dotenv and prompts are
`0600`, owned by the image's `node` user (UID/GID 1000). Root can manage them on
the host. The image runs without root. Keep container paths inside `/data`.

The runtime reads dotenv when it starts. After changing settings, restart it
with `sudo docker compose --env-file release.env restart gigachad`. Prompt edits
are read on each request. `release.env` contains only the selected image;
credentials remain in `data/.env` and are never interpolated by Compose.

Back up the entire data directory securely while runtime and setup are stopped.
Possession of the identity permits impersonating the bot. Never delete it or
its lock to resolve a running owner's conflict. Lock recovery requires stopping
all owners and removing only the adjacent empty `.lock` directory.

Update/uninstall tooling and external search support arrive in M3.3. Do not
rerun the fresh installer as an update or remove data to make it accept an
existing installation.

## Developer Guide

### CLI: setup and configuration (M2)

With Node.js 24 and installed dependencies, use the complete setup wizard or
edit selected sections of an existing configuration:

```sh
npm run setup
npm run config
# Either command can target another dotenv file:
npm run config -- --env-file /path/to/bot.env
```

`setup` guides you through Gryt registration and channel selection, the
OpenAI-compatible LLM and system prompt, and optional web search. Registration
can use a hidden single-use token or wait for administrator approval. Accessible
text channels are listed, with manual channel ID entry as a fallback. `config`
offers Gryt/channel, LLM/prompt and search sections. Changes stay in memory
until the final save confirmation; Ctrl+C or declining the save leaves saved
configuration and prompt files unchanged. Any identity created during Gryt
registration is retained and should be reused on later setup runs. Setup never
starts the bot.

The LLM section tests the draft with one short Chat Completions request. If the
test fails, you can retry, change settings, explicitly save without a successful
test, or cancel. Prompt edits use multiline input; finish with `.end` on a line
by itself, or enter `..end` for a literal `.end` line. Search is disabled by
default. When enabled, query extraction can inherit the main LLM settings or
use separate credentials and model, and the existing search limits are
configurable. Start the SearXNG backend separately with the Compose `search`
profile.

Saving writes the selected dotenv with mode `0600`, preserves unrelated setting
values, removes the single-use `GRYT_BOT_TOKEN`, and replaces comments and
formatting. Prompt changes create a new private `system.<id>.md` version beside
the active prompt and atomically switch `SYSTEM_PROMPT_PATH`; older versions
remain. Relative paths use the working directory. Restart or recreate the
container to apply dotenv changes. Existing environment variables are not
imported by the wizard.

For LLM-only edits, the standalone `npm run setup-llm` command remains available.
All three commands accept `-- --env-file PATH`; compiled entries are
`node dist/cli.js setup|config|setup-llm [--env-file PATH]`. An interactive
terminal is required. Registration and configuration actions return structured
results and progress independently of terminal rendering. Host lifecycle
commands remain M3.2 work; a full-screen TUI is outside v1.0. See
[ROADMAP.md](ROADMAP.md) and the
[CLI boundaries](docs/ARCHITECTURE.md#cli-boundaries-m2m3).

Runtime and setup share an atomic lock beside the identity file
(`<identity-path>.lock`). A second process fails before loading the identity or
connecting. Paths resolving to the same identity share the lock. Normal shutdown
releases it; a crash can leave it behind. To recover, first stop **all** bot and
setup processes using that identity, then remove only the empty `.lock`
directory with `rmdir`. Keep the identity file. Lock recovery is deliberately
manual to avoid replacing a bot's identity or interrupting an active owner.

### Source development setup

The root `compose.yaml` remains a source-build development deployment;
prebuilt installations use the separate packaged Compose described above.

Requires Node.js 24 and npm. The repository includes `.nvmrc` for version managers.

```sh
npm ci
npm run setup
```

The wizard saves `.env` and a prompt after explicit confirmation. For manual
development configuration, copy `.env.example` to `.env` with mode `0600` and
`prompts/system.md.example` to `prompts/system.md`, then fill the required Gryt
and LLM settings. The source Compose still builds with `docker compose up -d
--build`; its identity lives in the existing named volume, independently of
the local Node.js identity. No migration into the prebuilt installation is
performed by M3.1.

### Commands

CI runs the locked dependency installation, typecheck, all tests and application
build on pushes to `next` and pull requests targeting `next` or `main`. It uses
the Node.js version in `.nvmrc`; no live Gryt, LLM or search services are needed.

```sh
npm run typecheck   # type-check without emitting
npm test            # run tests (synthetic messages + local HTTP server)
npm run build       # compile to dist/
npm run dev         # run TypeScript directly on Node 24
npm start           # run compiled output
```

Stop with Ctrl+C.

### Web search (optional, source development Compose)

The bot can search the web via a self-hosted [SearXNG](https://docs.searxng.org/) instance.
Search is **disabled by default**. Set `SEARCH_ENABLED=true` to enable it and
start the optional Compose service with `docker compose --profile search up -d`.
The bot always calls SearXNG at the fixed internal address
`http://searxng:8080`; no search URL needs to be supplied. Search failure never
blocks an LLM-only answer.

When enabled, the search flow is:

1. **Query extraction** — an LLM reads the user's message plus the last 4
   messages of context and produces a single focused search query (keywords,
   no question words). If the
   message does not warrant a web lookup (greetings, thanks, clarifications,
   trivial facts) the model answers `NOSEARCH` and the search is skipped entirely.
   This is what makes search "only when needed" — the expensive SearXNG
   round-trip only happens when the extraction model says so.
2. **SearXNG lookup** — the extracted query is sent to SearXNG's JSON API.
   Up to `SEARCH_MAX_RESULTS` results (default 5) are returned.
3. **System prompt enrichment** — the results are appended to the system prompt
   so the main LLM (`LLM_MODEL`) can cite sources. The main LLM is instructed
   to rely on the results when present and to say so when they are irrelevant.

The extraction call is **blocking**: the main LLM waits for it before being
called. This is a deliberate trade-off — the answer always sees the search
results (higher quality), at the cost of up to `SEARCH_LLM_TIMEOUT_MS`
(default 8 s) + `SEARCH_TIMEOUT_MS` (default 10 s) of added latency before
the LLM starts. In practice the extraction takes 2–3 s and SearXNG 1–3 s, so
the typical added latency is 3–6 s.

#### Choosing the extraction model

Query extraction inherits `LLM_BASE_URL`, `LLM_API_KEY` and `LLM_MODEL` by
default. To use a separate OpenAI-compatible API, optionally set
`SEARCH_LLM_BASE_URL`, `SEARCH_LLM_API_KEY` and `SEARCH_LLM_MODEL`; empty values
inherit the main LLM settings. This also gives the future CLI fields for
configuring the search model independently. Query extraction uses its own
context, output and timeout budgets, and does not retry on failure.

#### Throttling

The bot protects the SearXNG instance (and upstream search engines) from
being overwhelmed:

- **Rate limit:** at most `SEARCH_RATE_LIMIT` (default 5) SearXNG requests
  per `SEARCH_RATE_WINDOW_MS` (default 60 000 ms) window.
- **Circuit breaker:** 3 consecutive failures open the breaker for 60 s;
  during that time the bot answers without search. After the cooldown the
  failure count resets, so a single transient failure does not re-open the
  breaker.
- **Cache:** identical (case-insensitive) queries are served from an
  in-memory cache for `SEARCH_CACHE_TTL_MS` (default 300 000 ms). Empty
  results are not cached.
- **Minimum length:** messages shorter than 15 characters skip the extraction
  call entirely (no LLM round-trip).
- **Graceful degradation:** if the extraction model or SearXNG is unreachable,
  the bot simply answers without web context.

#### Enable search

1. Set `SEARCH_ENABLED=true` in `.env`.
2. Run `docker compose --profile search up -d --build`.

The Compose profile starts SearXNG alongside the bot. Verify it is healthy:

```sh
docker compose ps
# searxng should show "healthy"
docker compose logs --tail=20 searxng
```

#### Disable search

1. Set `SEARCH_ENABLED=false` in `.env`.
2. Run `docker compose --profile search stop searxng`.
3. Run `docker compose up -d --build gigachad`.

#### Update SearXNG

The SearXNG image is pinned to `latest` in `compose.yaml`. To update:

```sh
docker compose --profile search pull searxng
docker compose --profile search up -d searxng
docker compose ps   # wait for "healthy"
```

The SearXNG cache volume (`searxng-cache`) survives the update. If a SearXNG
upgrade changes the JSON API (rare, but possible), the bot will log search
failures and fall back to no-search answers; check `docker compose logs
--tail=50 searxng` for the cause.

To pin a specific SearXNG version instead of `latest`, edit the `image:`
line in `compose.yaml` (e.g. `docker.io/searxng/searxng:2026.11.5`).

### Project layout

```
src/
  config.ts      # env loading and validation
  cli.ts         # interactive terminal entry (setup)
  setup.ts       # setup dialog orchestration
  setupStore.ts  # explicit private dotenv saves
  registration.ts # terminal-independent Gryt registration action
  identityLease.ts # shared runtime/setup filesystem ownership
  handler.ts     # mention matching, dedup, reply routing
  llm.ts         # OpenAI-compatible API client (complete + completeSearchQuery)
  search.ts      # SearXNG client with rate limiting, circuit breaker, cache
  searchQuery.ts # query extraction via dedicated LLM model
  gryt.ts        # SDK lifecycle and self-ID adapter
  runtime.ts     # handler, LLM and optional search wiring
  process.ts     # configuration and process signal lifecycle
  index.ts       # executable entry point
prompts/
  system.md.example # template for the system prompt (committed)
  system.md         # active system prompt (local only, git-ignored, hot-reloaded)
searxng-settings/
  settings.yml   # SearXNG configuration (JSON format enabled)
test/
  config.test.ts
  gryt.test.ts
  process.test.ts
  runtime.test.ts
  handler.test.ts
  identity.test.ts
  llm.test.ts
  search.test.ts
  searchQuery.test.ts
```

### Notes

- **Typing indicator:** Refreshed every five seconds while a request and its reply send are pending, then cleared when the operation finishes or fails.
- **Portable LLM requests:** Requests use OpenAI-compatible Chat Completions fields without model-specific template parameters. Configure model reasoning behavior at your endpoint if needed.
- **Local LLM timeout:** `LLM_TIMEOUT_MS` defaults to `120000` (two minutes) when omitted. The example configuration uses the same value. Existing `.env` values still take precedence; set this to `120000` if an older installation uses `60000`, then run `docker compose up -d --force-recreate`. Increase it further if your model needs more time with conversation history. One request runs at a time; concurrent mentions are silently dropped (the typing indicator shows the bot is working).
- **Context window:** Set `LLM_CONTEXT_TOKENS` to your model’s supported input-plus-output budget. `LLM_MAX_TOKENS` is the separate output budget. Input is bounded conservatively using UTF-8 byte length plus framing/output reserves, not a model-specific tokenizer.
- **Conversation history:** The bot keeps the latest 20 messages in memory (including replies it successfully sends) and sends only the 5 most recent to the model. History resets on restart; it does not fetch older channel messages.
- **Mention matching:** Links of the form `[@label](mention:<server-user-id>)`. Labels alone, code examples, escaped links, images, role mentions, `@everyone`, and `@here` do not trigger.
- **Reliability:** LLM calls have a total timeout, reject HTTP errors and invalid/empty answers, cap response bodies at 1 MiB. Transient failures (HTTP 5xx, timeout, network errors) are retried once after a 1s backoff before failing. Permanent failures (HTTP 4xx, invalid JSON, budget errors) are not retried. Replies fit Gryt's 4,000 UTF-16-unit limit. SDK reconnection is automatic. Logs omit tokens, API keys, and message bodies.
- **Local vs Docker identity:** Local development uses `./data/`, so it registers a separate bot unless you intentionally migrate the identity.

### SDK compatibility

Pinned: `@gryt/bot@0.3.1` (commit `05800d0d`). Verified APIs: `GrytBot`, `loadIdentity`, message events, `send`, `permissions`, `channels`, `socket`.

The SDK exposes no public bot server-ID getter. With a preloaded identity its socket is created synchronously; the adapter checks this assumption. Its `ready` event fires only once, so the adapter clears self-ID on disconnect and restores it on each join. Shutdown also settles startup while approval is pending. The adapter in `src/gryt.ts` listens to `server:joined` and reads the `serverUserId` claim from its access token. Review this adapter when upgrading the SDK.

References:

- [Bot registration and identity persistence](https://docs.gryt.chat/docs/build/bots)
- [SDK source for the pinned release](https://github.com/Gryt-chat/bot/blob/05800d0d118afd9056792f7502cb71b92b007e25/src/client.ts)
- [Documented mention format](https://docs.gryt.chat/docs/build/webhooks#mentions)
- [Server message-length limit](https://github.com/Gryt-chat/server/blob/3078393f1b80d3748637e330d4324a6567090634/src/utils/messageLimits.ts)
