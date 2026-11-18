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
- `src/identityLease.ts` provides atomic filesystem ownership beside the canonical identity path, shared by runtime and setup before identity loading. Stop releases ownership after disconnect; an in-flight SDK identity write retains ownership until it settles. Failed shutdown retains the lock. Crash recovery requires stopping all owners and manually removing only the adjacent empty `.lock` directory; identity is never removed or regenerated for lock recovery.
- `src/registration.ts` exposes terminal-independent registration with structured progress, cancellation and text-channel results through the Gryt integration. The caller holds the registration session until channel selection/save finishes, then closes it; no message handling or LLM runtime is started.
- `src/configManagement.ts` composes the M2 setup/config flows from Gryt registration, LLM checks and search configuration actions. `setup` runs the sections in order; `config` lets the user choose sections. Both keep one draft until a single explicit save. `src/configSetup.ts` exposes that final commit as a terminal-independent action with structured success/cancel/failure results. `src/cli.ts` owns terminal input, hidden token/key entry, multiline prompt input and signals. Registration remains an independent action and closes its connection before configuration continues.
- `src/configSetupStore.ts` reads the selected dotenv and prompt snapshots, validates the complete draft, and commits it with one atomic dotenv rename. Changed prompts are written as private version files before that commit. It refuses detected concurrent edits, checks prompt paths against dotenv and identity data, preserves unrelated setting values, removes the single-use token, and rewrites formatting/comments. Relative paths use the process working directory. Cancellation before the rename cleans prepared files; a signal after the rename leaves the committed save intact.
- `src/setup.ts` and `src/setupStore.ts` retain the M2.1 Gryt-only terminal-independent action and store used by focused registration tests; the user-facing complete `setup` command is composed by `src/configManagement.ts`.
- `src/config.ts` is the shared env validation source for runtime and CLI, with a Gryt-independent `loadLlmConfig` for the M2.2 wizard. `GRYT_NICKNAME` is required at runtime; `SYSTEM_PROMPT_PATH` defaults to `prompts/system.md`. Identity and prompt remain separate files. Endpoint and SDK errors are logged without raw supplied values or server payloads.
- `src/llmSetup.ts` owns terminal-independent LLM connectivity checks with structured safe results, progress and cancellation. `src/llmSetupStore.ts` reads the selected dotenv and prompt, stages drafts, and saves only validated settings after explicit confirmation. Prompt edits create a new private version beside the active path; dotenv is atomically switched to it after the file is complete. Cancelled edits preserve prior files, concurrent edits are detected, and prompt versions are retained.
- `src/cli.ts` owns hidden key entry, multiline prompt entry and signal handling. For `setup-llm`, `.end` terminates prompt input and `..end` represents a literal `.end` line. LLM checks use the shared OpenAI-compatible transport, send no provider-specific fields, and do not retry.
- `config` can edit the existing search enable flag, inherited or separate extraction LLM credentials/model, and search budgets, timeouts, result count, rate limit and cache TTL. Search remains opt-in and its SearXNG URL stays fixed by the runtime.

LLM prompt validation reserves the full configured output budget before a probe
or save; only the probe's actual request uses the short output limit. During
save, cancellation before the final dotenv rename removes prepared files and
preserves the active configuration. A successful rename commits the save;
cancellation arriving afterwards does not undo it.

Gryt, LLM and search boundaries can be mocked without connecting to live services.
The generic LLM transport sends no provider-specific chat-template parameters.

## CLI boundaries (M2/M3)

v1.0.0 provides interactive setup/configuration and direct lifecycle commands. A simple full-screen TUI is a post-v1.0 direction, not a release requirement. Preserve these boundaries while implementing the existing M2/M3 work:

- Keep registration, channel lookup, LLM checks, configuration persistence and service operations separate from prompts, menus and terminal rendering. Actions accept explicit inputs and can be tested without a terminal.
- Return structured results and safe errors; expose progress for long operations such as approval waits and connectivity checks. The CLI owns human-readable formatting. Do not make another interface parse human-readable CLI output.
- Support cancellation of approval waits and network checks, with cleanup of connections/listeners and identity ownership. Cancellation must settle the operation without leaving a competing bot process.
- Edit settings and prompt content as a draft; validate and persist only after an explicit save. Cancelled or invalid edits leave previously saved configuration and prompt unchanged. Identity creation/registration is a separate persistent operation: retain a newly created identity even when later setup steps are cancelled, and explain that outcome to the user.
- Keep Docker Compose operations on the host behind reusable command functions or an adapter. Setup/configuration remains inside the application image. Where structured results cross this boundary, use a small machine-readable command contract; no daemon, HTTP API or Docker socket mount is needed. Direct commands remain available independently of any future menu.

Verify these boundaries with focused mocked action tests, including progress/cancellation and save/cancel behavior, under the standard `npm test` discovery. Host-wrapper checks belong to M3. No TUI library, screen framework, live dashboard or generalized plugin system is required for v1.0.0; choose terminal rendering and the TUI execution location after v1.0 when its scope is agreed.

## Deployment

- Linux amd64, Docker Compose v2, prebuilt runtime image from `ghcr.io/inferlopec/gigachad`.
- Persistent installation directory (default `/opt/gigachad`), with restricted config/secrets, prompt files and bot identity. Host CLI in `/usr/local/bin/gigachad`.
- Installer/release assets provide Compose and CLI files; install/update select a version rather than building source on the host.
- Updates replace application artifacts, not user data. Uninstall preserves data by default; explicit confirmation is required to delete it.

M3.1 deployment assets live separately from the source development Compose.
The installer packages a chosen image version, validates Docker/Compose v2 and
installs files without running setup or starting services. Installed Compose
mounts the private `data/` directory at `/data`, uses `/data` as the working
directory, and loads the runtime dotenv with Node's env-file reader. Setup/config
read and atomically save that same file; prompts and identity stay in the same
writable persistent mount. Compose image selection is in separate `release.env`
metadata and does not interpolate application secrets. The minimal launcher
reports help/version until M3.2 provides host operations. See
[`DEPLOYMENT.md`](DEPLOYMENT.md) for the asset contract and validation path.

## Setup flow

1. Enter Gryt host and bot nickname; connect with existing/new identity or optional single-use registration token.
2. Wait for administrator approval, then select an accessible text channel (manual ID fallback).
3. Configure and test the LLM API; set context limits and system prompt.
4. Optionally enable search; save validated settings and start the service.

The setup process must be repeatable and must not start a second runtime using the same identity. Keep the existing single-channel model; multi-server/multi-bot orchestration, web UI, databases and new LLM provider adapters are out of scope for v1.0.0.
