# Target architecture

Gigachad is a standalone AI bot for supported Gryt servers. It needs no Gryt server modifications or inbound host ports.

## Components

- **Bot runtime:** connect/approve/reconnect via `@gryt/bot`; respond to direct mentions in one configured channel. Keep message handling, context, LLM and search modules independent.
- **Configuration:** shared schema/validation for runtime and CLI; retain an env-based format unless M1 identifies a concrete reason to change it. Separate editable prompt file and identity.
- **CLI:** TypeScript setup/config commands inside the application image; a small host-side wrapper manages Docker Compose and forwards interactive commands. No Docker socket inside the bot container.
- **Search:** opt-in SearXNG integration at the fixed internal Compose address `http://searxng:8080`; no user-configurable search endpoint. Query extraction inherits the primary OpenAI-compatible LLM API settings, with optional search-specific endpoint/key/model overrides for future CLI configuration. Search failure must not prevent an LLM-only reply.

Runtime code boundaries:

- `src/index.ts` invokes `runProcess`; `src/process.ts` loads validated configuration and owns process signal handlers.
- `src/runtime.ts` connects the existing handler, LLM and optional search modules through injected dependencies. Its stop operation aborts requests and drains message handlers.
- `src/gryt.ts` owns identity loading, SDK construction and lifecycle, including the pinned SDK's raw-socket self-ID workaround. Disconnect clears identity availability; each join restores it independently of the one-time `ready` event. Stop settles startup even while approval is pending.
- `src/config.ts` is the shared env validation source for runtime and future CLI. `GRYT_NICKNAME` is required; `SYSTEM_PROMPT_PATH` defaults to `prompts/system.md`. Identity and prompt remain separate files. Endpoint and SDK errors are logged without raw supplied values or server payloads.

Gryt, LLM and search boundaries can be mocked without connecting to live services.
The generic LLM transport sends no provider-specific chat-template parameters.

## Deployment

- Linux amd64, Docker Compose v2, prebuilt runtime image from `ghcr.io/inferlopec/gigachad`.
- Persistent installation directory (default `/opt/gigachad`), with restricted config/secrets, prompt files and bot identity. Host CLI in `/usr/local/bin/gigachad`.
- Installer/release assets provide Compose and CLI files; install/update select a version rather than building source on the host.
- Updates replace application artifacts, not user data. Uninstall preserves data by default; explicit confirmation is required to delete it.

## Setup flow

1. Enter Gryt host and bot nickname; connect with existing/new identity or optional single-use registration token.
2. Wait for administrator approval, then select an accessible text channel (manual ID fallback).
3. Configure and test the LLM API; set context limits and system prompt.
4. Optionally enable search; save validated settings and start the service.

The setup process must be repeatable and must not start a second runtime using the same identity. Keep the existing single-channel model; multi-server/multi-bot orchestration, web UI, databases and new LLM provider adapters are out of scope for v1.0.0.
