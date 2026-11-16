# Roadmap — v1.0.0

Development: `next`. Release: merge into `main`, then tag `v1.0.0` after maintainer approval.

Track work in [GitHub Milestones](https://github.com/Inferlopec/gigachad/milestones) and [Issues](https://github.com/Inferlopec/gigachad/issues). The list below defines the initial backlog and milestone order, not live progress.

## M1 — Core refactoring

- **M1.1 — Audit and baseline:** inspect architecture, SDK compatibility and test discovery; establish a passing baseline.
- **M1.4 — Baseline CI:** after M1.1 and before M1.2, run locked installation, typecheck, all tests and application build on pushes to `next` and PRs targeting `next`/`main`; no publishing. Numbering preserves existing issue identifiers.
- **M1.2 — Runtime and configuration:** separate the Gryt lifecycle/entry point, isolate the self-ID workaround, centralize validation and remove personal defaults.
- **M1.3 — Optional search:** decouple SearXNG from mandatory runtime and Compose dependencies.

Exit: existing bot behavior preserved, generic config works, tests and build pass.

## M2 — Interactive CLI

Provide interactive setup/configuration for v1.0.0. Separate actions from terminal dialogs, return structured results and progress, support cancellation, and save validated configuration/prompt drafts only on explicit confirmation. Preserve identity independently of cancelled configuration edits. Follow the CLI boundaries in `docs/ARCHITECTURE.md`; a full-screen TUI is deferred until after v1.0.

- **M2.1 — Setup and registration:** configure host/nickname, persist identity, handle approval/token, select channel or enter ID.
- **M2.2 — LLM and prompts:** configure endpoint/key/model/context, test connectivity, edit the system prompt.
- **M2.3 — Configuration management:** implement repeatable `setup` and `config`, validation/cancellation and opt-in search.

Exit: configure and edit a fresh installation without manual file changes; actions are testable without a terminal, and mocked tests verify progress/cancellation and safe save/cancel behavior.

## M3 — Deployment

Keep direct lifecycle commands and host Compose operations separate from terminal presentation. Expose reusable operations and structured status/diagnostic results, including a small machine-readable command contract where data crosses the host/container boundary. Setup/config runs inside the image; Docker control stays on the host, without an in-container socket or an API service.

- **M3.1 — Installer and release assets:** Linux amd64, Docker Compose v2, no host Node.js or source checkout.
- **M3.2 — Host CLI:** lifecycle commands, logs, status and doctor; forward interactive setup/config.
- **M3.3 — Updates and data:** versioned images, persistent restricted config/secrets/prompts/identity, safe update/uninstall, optional managed or external SearXNG.

Exit: installation and lifecycle management work on a clean VM; lifecycle/status/diagnostics can be consumed independently of interactive rendering, with host-wrapper verification.

## M4 — Release pipeline

- **M4.1 — Image CI and final validation:** extend the M1.4 baseline workflow with Linux amd64 image builds on push/PR and validate the complete check suite against deployment assets; retain locked dependencies, typecheck, all tests and application build.
- **M4.2 — Release automation:** tag-triggered linux/amd64 GHCR image and GitHub Release assets; built-in GITHUB_TOKEN with minimal permissions.
- **M4.3 — Pipeline validation:** validate publish flow and version tags without prematurely releasing a stable image.

Exit: CI passes and release flow is verified.

## M5 — Release readiness

- **M5.1 — End-to-end validation:** clean install, Gryt registration, mention replies and optional search.
- **M5.2 — Operational validation:** restart/update identity preservation, failure diagnostics and uninstall.
- **M5.3 — Documentation and release:** installation, configuration, troubleshooting and supported versions; maintainer approval for merge/release.

Exit: release candidate passes end-to-end checks; no legacy migration.

## After v1.0 — Simple full-screen TUI

Future direction, outside M1–M5 and v1.0.0 acceptance: a main menu with configuration screens, bot status and basic service controls, reusing the M2/M3 actions. Preserve direct CLI commands. Live log dashboards and multiple auto-updating panels are not part of this simple TUI concept. Agree detailed scope and create a separate milestone/issues after v1.0; no TUI dependency or screen framework is needed now.

## Issue format

Title: `M<stage>.<task> — <action>`

Assign the matching milestone. Each issue contains:

- **Goal:** intended outcome.
- **Scope:** necessary changes and exclusions.
- **Acceptance criteria:** observable behavior and required checks.
- **Dependencies:** blocking issues, if any.

Keep issues independently verifiable; update status in GitHub rather than duplicating checklists in this file.
