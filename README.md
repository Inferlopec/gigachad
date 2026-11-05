# gigachad

A minimal mention-only AI bot for `https://chat.inferlo.xyz`. Built with `@gryt/bot` and an OpenAI-compatible Chat Completions endpoint.

- Responds only to direct ID-based mentions in `GRYT_ALLOWED_CHANNEL_ID`
- Each request includes up to 10 recent messages from the configured channel, plus the triggering message
- One LLM request at a time; duplicates and self-messages are filtered

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

The `.env` file and identity volume survive updates. In-memory conversation history resets when the container restarts. Save any custom prompt edits before pulling and check `.env.example` for new settings. To apply only `.env` changes: `docker compose up -d --force-recreate`.

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

### Project layout

```
src/
  config.ts    # env loading and validation
  handler.ts   # mention matching, dedup, reply routing
  llm.ts       # OpenAI-compatible API client
  index.ts     # entry point, SDK wiring
prompts/
  system.md    # system prompt (hot-reloaded)
test/
  handler.test.ts
  identity.test.ts
  llm.test.ts
```

### Notes

- **Thinking disabled:** Each LLM request sends `chat_template_kwargs: { "enable_thinking": false }`, the [Qwen/vLLM setting](https://qwen.readthedocs.io/en/stable/deployment/vllm.html) for disabling thinking. The inference server and model chat template must support this setting.
- **Local LLM timeout:** `LLM_TIMEOUT_MS` defaults to `120000` (two minutes) when omitted. The example configuration uses the same value. Existing `.env` values still take precedence; set this to `120000` if an older installation uses `60000`, then run `docker compose up -d --force-recreate`. Increase it further if your model needs more time with conversation history. One request runs at a time, so a slower request also makes the bot busy for longer.
- **Context window:** 131,000 tokens (input + output). `LLM_MAX_TOKENS` is the separate output budget. Input is bounded conservatively using UTF-8 byte length plus framing/output reserves, not a model-specific tokenizer.
- **Conversation history:** The bot remembers messages it sees in the configured channel while running, including replies it successfully sends. It keeps the latest 10 messages in memory and drops the oldest context when needed to fit the model budget. History resets on restart; it does not fetch older channel messages.
- **Mention matching:** Links of the form `[@label](mention:<server-user-id>)`. Labels alone, code examples, escaped links, images, role mentions, `@everyone`, and `@here` do not trigger.
- **Reliability:** LLM calls have a total timeout, reject HTTP errors and invalid/empty answers, cap response bodies at 1 MiB. Replies fit Gryt's 4,000 UTF-16-unit limit. SDK reconnection is automatic. Logs omit tokens, API keys, and message bodies.
- **Local vs Docker identity:** Local development uses `./data/`, so it registers a separate bot unless you intentionally migrate the identity.

### SDK compatibility

Pinned: `@gryt/bot@0.3.1` (commit `05800d0d`). Verified APIs: `GrytBot`, `loadIdentity`, message events, `send`, `permissions`, `channels`, `socket`.

The SDK exposes no public bot server-ID getter. A small adapter listens to `server:joined` and reads the `serverUserId` claim from its access token. Review this adapter when upgrading the SDK.

References:

- [Bot registration and identity persistence](https://docs.gryt.chat/docs/build/bots)
- [SDK source for the pinned release](https://github.com/Gryt-chat/bot/blob/05800d0d118afd9056792f7502cb71b92b007e25/src/client.ts)
- [Documented mention format](https://docs.gryt.chat/docs/build/webhooks#mentions)
- [Server message-length limit](https://github.com/Gryt-chat/server/blob/3078393f1b80d3748637e330d4324a6567090634/src/utils/messageLimits.ts)
