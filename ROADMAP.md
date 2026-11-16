# Roadmap — v1.0.0

Development: `next`. Release: merge into `main`, then tag `v1.0.0` after maintainer approval.

## M1 — Core refactoring

- Audit existing code and tests; establish a passing baseline.
- Separate Gryt connection lifecycle and bot runtime from the entry point.
- Centralize validated settings, including nickname, channel, prompt path, LLM and context limits.
- Remove personal defaults; keep search optional in runtime and Compose.
- Isolate the current self-ID/socket workaround; verify SDK compatibility before replacing it.

Done: existing core behavior is preserved, generic config works, and tests/build pass.

## M2 — Interactive CLI

- Implement `setup` and `config` using the runtime configuration schema.
- Register against a supplied Gryt host (admin approval or optional registration token), persist identity, then select a channel or enter its ID.
- Configure nickname, system prompt, LLM endpoint/key/model and context limits; validate credentials/connectivity without logging secrets.
- Offer optional web search in advanced settings. Provide useful validation and cancellation.

Done: a fresh configuration can be created and edited interactively without manual file changes.

## M3 — Deployment

- Provide a one-command Linux amd64 installer using Docker Compose v2 and release artifacts; no source checkout or host Node.js.
- Add the host CLI: `setup`, `config`, `start`, `stop`, `restart`, `status`, `logs`, `doctor`, `update`, `uninstall`.
- Persist configuration, secrets, prompts and identity; protect data on update and uninstall.
- Make managed SearXNG opt-in; allow an external SearXNG URL.

Done: install, configure, start, restart and uninstall work on a clean Linux VM.

## M4 — Release pipeline

- CI on pushes/PRs: install locked dependencies, check types, run tests, build image.
- Release workflow on approved version tags: build linux/amd64, publish versioned GHCR image and GitHub Release with installer assets.
- Use built-in GITHUB_TOKEN and minimal workflow permissions; stable image tag follows the latest stable release.

Done: CI passes and the release flow is validated without prematurely publishing a stable release.

## M5 — Release readiness

- Test clean installation and registration against a supported Gryt server; verify mention replies and optional search.
- Test restart/update identity preservation and useful failure diagnostics.
- Document installation, configuration, troubleshooting, versions and supported platforms.
- Maintainer approves merge and initial stable release.

Done: release candidate passes end-to-end checks; no migration from the experimental version required.
