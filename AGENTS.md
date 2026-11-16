# Gigachad — Agent instructions

## Scope

- Build the first public release (v1.0.0) from the existing experimental bot. Refactor, do not rewrite.
- Work on `next`; keep `main` unchanged until release approval. Complete one roadmap milestone at a time.
- Target Linux amd64 with Docker Compose v2. No ARM64, legacy config compatibility or migration tooling.
- See `ROADMAP.md` for milestone order and issue structure; `docs/ARCHITECTURE.md` defines design boundaries.

## Work tracking

- GitHub Milestones (M1–M5) define release stages; Issues define scoped work and acceptance criteria. GitHub is the source of truth for task status.
- Work on one issue at a time within the active milestone; reference its number in commits/PRs. Do not expand scope without agreement.
- Close an issue only after its acceptance criteria are verified and the change is integrated into `next`. Advance to the next milestone only when the current one is complete.
- If GitHub access is unavailable, follow the issue scope in `ROADMAP.md` or the assigned prompt; report status rather than assuming an issue is closed.

## Architecture and behavior

- Keep TypeScript/Node.js and the official `@gryt/bot` SDK. Isolate SDK-specific workarounds in the Gryt integration.
- Preserve tested mention detection, single-channel scope, conversation handling, LLM behavior, and optional search unless a milestone explicitly changes them.
- Use an OpenAI-compatible LLM endpoint; never assume a specific provider or model.
- No hardcoded personal hosts, models, names, credentials, or private prompts.
- Use one validated configuration source shared by runtime and CLI. Never print secrets or commit runtime data.
- Persist bot identity across restarts and upgrades. Never regenerate or remove it implicitly.
- Search is opt-in; the bot must operate without SearXNG.

## Validation

- Run `npm run typecheck`, `npm test`, and `npm run build` after code changes. Ensure all intended test files are discovered.
- Add focused tests for changed behavior; use mocks for Gryt/LLM/search in CI.
- For deployment changes, validate Compose and build/smoke-test the image.
- Keep PRs milestone-scoped. Report any checks not run, blockers, and remaining milestone criteria.
- Do not publish releases or modify production settings without maintainer approval.
