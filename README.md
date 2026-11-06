# gigachad

A minimal mention-only AI bot for `https://chat.inferlo.xyz`. Built with `@gryt/bot` and an OpenAI-compatible Chat Completions endpoint.

- Responds only to direct ID-based mentions in `GRYT_ALLOWED_CHANNEL_ID`
- Each request includes the 5 most recent messages from the configured channel (including the trigger)
- One LLM request at a time; concurrent mentions are silently dropped (typing indicator shows the bot is busy)
- Transient LLM failures (5xx, timeout, network) are retried once after 1s before failing
- Optional web search via self-hosted SearXNG (enabled by setting `SEARXNG_URL`)

## User Guide

### Install (Docker)

Requires Git and Docker Engine with Compose.

On the remote server, log in as the account that will install and update the bot. Prepare a directory owned by that account, then clone without `sudo`:

```sh
sudo mkdir -p /opt/gryt-gigachad
sudo chown "$(id -u):$(id -g)" /opt/gryt-gigachad
git clone https://github.com/Inferlopec/gigachad /opt/gryt-gigachad
cd /opt/gryt-gigachad
cp .env.example .env
chmod 600 .env
```

Edit `.env` and `prompts/system.md` before starting:

- `GRYT_ALLOWED_CHANNEL_ID` — the channel where the bot responds (see below)
- `LLM_API_KEY` — your API key
- Review the supplied endpoint, model, and limits

**Finding the channel ID:** In Gryt, right-click the target channel → **Copy channel mention**. Paste it into a text editor: `[#channel](channel:chat.inferlo.xyz/CHANNEL_ID)`. Use only `CHANNEL_ID` (the part after the final `/`, without the closing `)`). If the link has no server host (`channel:CHANNEL_ID`), use the part after `channel:`.

Start the bot:

```sh
docker compose up -d --build
docker compose logs -f --tail=100 gigachad
```

This starts two containers: **gigachad** (the bot) and **searxng** (web search
backend). The bot waits for SearXNG to become healthy before starting
(`depends_on: service_healthy`), so a fresh install takes ~30–60 s longer on
first run while the SearXNG image is pulled and initialized.

To enable web search, set `SEARXNG_URL=http://searxng:8080` in `.env`
(see [Web search](#web-search-optional)). Leave it empty to run without search.

### Register the bot

1. Start the bot with valid configuration. It creates its identity and waits for approval.
2. A Gryt administrator with `manage_bots` opens **Server settings → Bots**, enables bot requests if needed, and approves **gigachad** with only `read_messages` and `send_messages`.
3. Ensure the bot can access the configured channel. Approval takes effect while the process runs.
4. In that channel, select gigachad from mention autocomplete and send a question.

> **Alternative:** An administrator can pre-create a registration named gigachad and supply its single-use token in `GRYT_BOT_TOKEN`. Remove the token from `.env` after the first successful claim.

### Update

Run these commands on the remote server using the same account that installed the bot:

```sh
cd /opt/gryt-gigachad
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 gigachad
```

This rebuilds the **gigachad** image and restarts the bot. The **searxng**
container is only recreated if `compose.yaml` or the SearXNG image changed;
otherwise Docker reuses the running container. To force-pull the latest
SearXNG image:

```sh
docker compose pull searxng
docker compose up -d searxng
```

The `.env` file, identity volume, and SearXNG cache volume survive updates.
In-memory conversation history and the search cache reset when the gigachad
container restarts. Save any custom prompt edits before pulling and check
`.env.example` for new settings. To apply only `.env` changes:
`docker compose up -d --force-recreate gigachad`.

If Git reports **dubious ownership** after an earlier installation under another account, run this once as the account that will manage the bot, then retry the update:

```sh
sudo chown -R "$(id -u):$(id -g)" /opt/gryt-gigachad
```

Run Git commands without `sudo`. If Docker requires elevated permissions, use `sudo` for the `docker compose` commands only.

### Back up the identity

The identity is stored in the Compose volume `gryt-gigachad_identity` at `/data/gryt-bot-identity.json`. **Back it up securely** — possession allows impersonating the bot, and losing it requires re-registration. Do not run `docker compose down -v` unless you intend to delete it.

```sh
docker compose stop gigachad
docker compose run --rm --no-deps --entrypoint tar gigachad -C /data -czf - . > identity-backup.tar.gz
chmod 600 identity-backup.tar.gz
docker compose start gigachad
```

Restore into an initialized volume:

```sh
docker compose run --rm --no-deps -T --entrypoint tar gigachad -C /data -xzf - < identity-backup.tar.gz
docker compose up -d
```

Store backups outside the repository.

### System prompt

Edit `prompts/system.md` directly. The bot reads it for every request — no restart needed. Compose mounts the directory read-only so editor saves remain visible. Missing or empty prompts fail the request with a brief error.

## Developer Guide

### Setup

Requires Node.js 24 and npm. The repository includes `.nvmrc` for version managers.

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` as described in the user guide above.

### Commands

```sh
npm run typecheck   # type-check without emitting
npm test            # run tests (synthetic messages + local HTTP server)
npm run build       # compile to dist/
npm run dev         # run TypeScript directly on Node 24
npm start           # run compiled output
```

Stop with Ctrl+C.

### Web search (optional)

The bot can search the web via a self-hosted [SearXNG](https://docs.searxng.org/) instance.
Search is **disabled** unless both `SEARXNG_URL` **and** `SEARCH_LLM_MODEL` are set in `.env`.
The SearXNG container is started by `docker compose` regardless; the bot simply does not
call it when either variable is empty.

When enabled, the search flow is:

1. **Query extraction** — a dedicated LLM model (`SEARCH_LLM_MODEL`, separate from
   `LLM_MODEL`) reads the user's message plus the last 4 messages of context and
   produces a single focused search query (keywords, no question words). If the
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

#### Why a separate model?

The extraction task is tiny (one line of output, ≤ 100 tokens) and fast
(≤ 8 s timeout). Giving it a dedicated model replica means:

- It does **not** compete for the same inference slot as the final answer
  (which can take up to 120 s).
- It can use a much smaller context budget (8 192 tokens vs 131 000).
- A failed or slow extraction degrades to "no search" without retrying,
  keeping the total latency bounded.

Set `SEARCH_LLM_MODEL` to one of your three `qwen3.8-27b-unleashed-{1,2,3}`
replicas, and `LLM_MODEL` to a different one.

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

1. Set `SEARXNG_URL=http://searxng:8080` in `.env`.
2. Set `SEARCH_LLM_MODEL=qwen3.8-27b-unleashed-2` (or another replica,
   different from `LLM_MODEL`).
3. `docker compose up -d --force-recreate gigachad`

That's it — the SearXNG container is already defined in `compose.yaml` and
started alongside the bot. Verify it is healthy:

```sh
docker compose ps
# searxng should show "healthy"
docker compose logs --tail=20 searxng
```

#### Disable search

1. Set `SEARXNG_URL=` (empty) in `.env`.
2. `docker compose up -d --force-recreate gigachad`

The SearXNG container keeps running (it is cheap to keep up and can be
re-enabled instantly), but the bot no longer calls it. To stop the container
entirely: `docker compose stop searxng`.

#### Update SearXNG

The SearXNG image is pinned to `latest` in `compose.yaml`. To update:

```sh
docker compose pull searxng
docker compose up -d searxng
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
  handler.ts     # mention matching, dedup, reply routing
  llm.ts         # OpenAI-compatible API client (complete + completeSearchQuery)
  search.ts      # SearXNG client with rate limiting, circuit breaker, cache
  searchQuery.ts # query extraction via dedicated LLM model
  index.ts       # entry point, SDK wiring
prompts/
  system.md      # system prompt (hot-reloaded)
searxng-settings/
  settings.yml   # SearXNG configuration (JSON format enabled)
test/
  handler.test.ts
  identity.test.ts
  llm.test.ts
  search.test.ts
  searchQuery.ts
```

### Notes

- **Typing indicator:** Refreshed every five seconds while a request and its reply send are pending, then cleared when the operation finishes or fails.
- **Thinking disabled:** Each LLM request sends `chat_template_kwargs: { "enable_thinking": false }`, the [Qwen/vLLM setting](https://qwen.readthedocs.io/en/stable/deployment/vllm.html) for disabling thinking. The inference server and model chat template must support this setting.
- **Local LLM timeout:** `LLM_TIMEOUT_MS` defaults to `120000` (two minutes) when omitted. The example configuration uses the same value. Existing `.env` values still take precedence; set this to `120000` if an older installation uses `60000`, then run `docker compose up -d --force-recreate`. Increase it further if your model needs more time with conversation history. One request runs at a time; concurrent mentions are silently dropped (the typing indicator shows the bot is working).
- **Context window:** 131,000 tokens (input + output). `LLM_MAX_TOKENS` is the separate output budget. Input is bounded conservatively using UTF-8 byte length plus framing/output reserves, not a model-specific tokenizer.
- **Conversation history:** The bot keeps the latest 20 messages in memory (including replies it successfully sends) and sends only the 5 most recent to the model. History resets on restart; it does not fetch older channel messages.
- **Mention matching:** Links of the form `[@label](mention:<server-user-id>)`. Labels alone, code examples, escaped links, images, role mentions, `@everyone`, and `@here` do not trigger.
- **Reliability:** LLM calls have a total timeout, reject HTTP errors and invalid/empty answers, cap response bodies at 1 MiB. Transient failures (HTTP 5xx, timeout, network errors) are retried once after a 1s backoff before failing. Permanent failures (HTTP 4xx, invalid JSON, budget errors) are not retried. Replies fit Gryt's 4,000 UTF-16-unit limit. SDK reconnection is automatic. Logs omit tokens, API keys, and message bodies.
- **Local vs Docker identity:** Local development uses `./data/`, so it registers a separate bot unless you intentionally migrate the identity.

### SDK compatibility

Pinned: `@gryt/bot@0.3.1` (commit `05800d0d`). Verified APIs: `GrytBot`, `loadIdentity`, message events, `send`, `permissions`, `channels`, `socket`.

The SDK exposes no public bot server-ID getter. A small adapter listens to `server:joined` and reads the `serverUserId` claim from its access token. Review this adapter when upgrading the SDK.

References:

- [Bot registration and identity persistence](https://docs.gryt.chat/docs/build/bots)
- [SDK source for the pinned release](https://github.com/Gryt-chat/bot/blob/05800d0d118afd9056792f7502cb71b92b007e25/src/client.ts)
- [Documented mention format](https://docs.gryt.chat/docs/build/webhooks#mentions)
- [Server message-length limit](https://github.com/Gryt-chat/server/blob/3078393f1b80d3748637e330d4324a6567090634/src/utils/messageLimits.ts)
