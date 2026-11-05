# gigachad

A minimal mention-only AI bot for `https://chat.inferlo.xyz`, using `@gryt/bot` and an OpenAI-compatible Chat Completions endpoint. It answers only direct ID-based mentions in `GRYT_ALLOWED_CHANNEL_ID`. Each request contains the current system prompt and the triggering message. There is no conversation history.

## Local development

Install Node.js 24 and npm. The repository contains `.nvmrc` for version managers.

This workspace has a local Node runtime in the ignored `.tools/node/` directory. New VS Code Linux terminals add it to `PATH`. To use it from an existing shell, run `export PATH="$PWD/.tools/node/bin:$PATH"` in the repository root. Other checkouts can use a normal Node 24 installation.

```sh
npm ci
cp .env.example .env
chmod 600 .env
```

Edit `.env` in VS Code. Set `GRYT_ALLOWED_CHANNEL_ID` and `LLM_API_KEY`; review the supplied endpoint, model, and limits. In Gryt, right-click the target channel and use Copy ID. Configuration is loaded from `.env` for local runs; Compose injects the same file into the container. Configuration changes require a restart.

```sh
npm run typecheck
npm test
npm run build
npm run dev
```

`npm run dev` runs TypeScript directly on Node 24. `npm start` runs the compiled output. Stop either with Ctrl+C.

The configured model context window is 131,000 tokens, including input and output. `LLM_MAX_TOKENS` is the separate output budget. To keep dependencies small, input is bounded conservatively using UTF-8 byte length plus framing/output reserves, not a model-specific tokenizer. This can reject a large prompt before the model's actual token limit. No history is accumulated.

## Registration

1. Start the bot with valid configuration. It creates its identity and waits for approval.
2. A Gryt administrator with `manage_bots` opens **Server settings → Bots**, enables bot requests if needed, and approves **gigachad** with only `read_messages` and `send_messages`.
3. Ensure the bot can access the configured channel. Approval takes effect while the process runs.
4. In that channel, select gigachad from mention autocomplete and send a question.

Alternatively, an administrator can create a registration named gigachad in advance and supply its single-use token in `GRYT_BOT_TOKEN`. Remove the token from `.env` after the first successful claim. The persistent identity handles later starts. The original registration fixes the nickname and requested permissions; changing declarations later does not expand the registration.

The bot matches links of the form `[@label](mention:<actual-server-user-id>)`. A label alone does not trigger it. Code examples, escaped links, images, role mentions, `@everyone`, and `@here` do not trigger it. The SDK also filters its own messages; the application checks the sender again.

## System prompt

Edit `prompts/system.md` directly in VS Code, including through Remote SSH on the deployment host. The bot reads it for every accepted request; no restart is needed. Compose mounts the entire directory read-only into the container so editor saves that replace the file remain visible. Missing or empty prompts fail the request with a brief error response.

## Docker deployment

Requires Git and Docker Engine with Compose. From an account allowed to create `/opt/gryt-gigachad`, clone this repository there:

```sh
git clone <repository-url> /opt/gryt-gigachad
cd /opt/gryt-gigachad
cp .env.example .env
chmod 600 .env
# Edit .env and prompts/system.md before starting.
docker compose up -d --build
docker compose logs -f --tail=100 gigachad
```

The Compose project is `gryt-gigachad`. It publishes no ports, runs as the image's unprivileged `node` user, and uses outbound HTTPS/WebSocket connections. It runs independently of Gryt CLI, Caddy, and SFU.

The identity is stored in the Compose volume `gryt-gigachad_identity` at `/data/gryt-bot-identity.json`. Compose overrides the local identity path from `.env` for the container. The SDK creates the key file with mode `0600`. Keep this volume across rebuilds and back it up securely: possession of the identity allows impersonating the bot, and losing it requires registering a new identity. Do not run `docker compose down -v` unless deliberately deleting that identity. Local development uses `./data/` instead, so it registers a separate bot unless you intentionally migrate the identity.

To back up the container identity using the existing image:

```sh
docker compose stop gigachad
docker compose run --rm --no-deps --entrypoint tar gigachad -C /data -czf - . > identity-backup.tar.gz
chmod 600 identity-backup.tar.gz
docker compose start gigachad
```

Store backups outside the repository. To restore into an initialized volume, stop the bot and run:

```sh
docker compose run --rm --no-deps -T --entrypoint tar gigachad -C /data -xzf - < identity-backup.tar.gz
docker compose up -d
```

## Updates

Preserve local prompt edits before pulling, for example with a local commit or `git stash push -- prompts/system.md`, then restore them and resolve any conflicts before restarting.

```sh
cd /opt/gryt-gigachad
git pull --ff-only
docker compose up -d --build
docker compose logs --tail=100 gigachad
```

The ignored `.env` and the identity volume survive this update. Inspect `.env.example` for new configuration keys. To apply only `.env` changes, recreate the service with `docker compose up -d --force-recreate`.

## Reliability and verification

- One LLM request runs at a time. Additional accepted mentions receive a short busy response. The last 1,000 accepted message IDs are remembered in memory to suppress duplicate deliveries within a process.
- LLM calls have a total timeout, reject HTTP errors and invalid/empty answers, and cap response bodies at 1 MiB. No automatic LLM or send retries are made.
- Replies fit Gryt's 4,000 UTF-16-unit limit; longer answers receive a truncation notice without splitting an emoji surrogate pair.
- SDK reconnection is automatic. Messages are ignored until a server ID and the required permissions are available. Shutdown aborts the active LLM request and stops the Gryt connection.
- Logs omit tokens, API keys, and message bodies. User-facing errors are brief; logs identify the failing stage without upstream response bodies.

Tests use synthetic Gryt messages and a local HTTP server. They cover exact mention IDs, literal/code exclusions, channel/self/system restrictions, prompt reloads, duplicates, concurrency, reply routing, HTTP request shape, timeouts, API errors, malformed responses, body limits, and context/configuration guards.

After registration, smoke-test a real autocomplete mention, a plain name, a mention in another channel, a prompt edit, and container recreation. Confirm the identity remains approved. The real LLM credentials and deployed endpoint must be checked during this smoke test.

## SDK facts and compatibility

Pinned SDK: `@gryt/bot@0.3.1`, published from commit `05800d0d118afd9056792f7502cb71b92b007e25`. Verified APIs include `GrytBot`, `loadIdentity`, message events, `send`, `permissions`, `channels`, and the public `socket` getter.

This SDK exposes no public bot server-ID getter. A small adapter listens to `server:joined` and reads the `serverUserId` claim from its access token, matching the SDK's own self-message detection. It does not use that decoded claim for authorization. The adapter assumes this event/claim shape remains compatible; malformed claims fail closed. Review this adapter when upgrading the SDK.

References:

- [Bot registration and identity persistence](https://docs.gryt.chat/docs/build/bots)
- [SDK source for the pinned release](https://github.com/Gryt-chat/bot/blob/05800d0d118afd9056792f7502cb71b92b007e25/src/client.ts)
- [Documented mention format](https://docs.gryt.chat/docs/build/webhooks#mentions)
- [Server message-length limit](https://github.com/Gryt-chat/server/blob/3078393f1b80d3748637e330d4324a6567090634/src/utils/messageLimits.ts)

The configured provider is assumed to support Bearer authentication, `max_tokens`, and string `choices[0].message.content` responses at `/v1/chat/completions`. Automated tests verify this protocol against a mock, not the private provider.
