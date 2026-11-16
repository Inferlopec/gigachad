# Gigachad — Agent instructions

## Scope

- Build the first public release (v1.0.0) from the existing experimental bot. Refactor, do not rewrite.
- Work on `next`; keep `main` unchanged until release approval. Complete one roadmap milestone at a time.
- Target Linux amd64 with Docker Compose v2. No ARM64, legacy config compatibility or migration tooling.
- See `ROADMAP.md` for milestone order and issue structure; `docs/ARCHITECTURE.md` defines design boundaries.

## Work tracking

- GitHub Milestones (M1–M5) define release stages; Issues define scoped work and acceptance criteria. GitHub is the source of truth for task status.
- Work on one issue at a time within the active milestone; reference its number in commits/PRs. Do not expand scope without agreement.
- Do not create commits or push changes without explicit user confirmation for that action. Prepare and verify the changes first; leave them uncommitted for review until confirmation is given. Starting an issue is not permission to commit or push, and past approval does not authorize later changes.
- Close an issue only after its acceptance criteria are verified and the change is integrated into `next`. Advance to the next milestone only when the current one is complete.
- For audit/documentation issues, integrate the findings and verification evidence into `next` before closing; resolve any acceptance blockers first.
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
- Name test files `test/*.test.ts` so the standard `npm test` command discovers them. Complete discovery is an acceptance requirement; explicit manual runs are not a substitute.
- Run the checks affected by test, tooling or workflow changes, including the standard typecheck/test/build checks when test discovery or CI changes.
- Add focused tests for changed behavior; use mocks for Gryt/LLM/search in CI.
- For deployment changes, validate Compose and build/smoke-test the image.
- Begin full end-to-end testing with live Gryt/LLM/search after M3.1. Keep automated checks and issue-specific deployment validation during development; final release acceptance remains in M5.
- Keep PRs milestone-scoped. Report any checks not run, blockers, and remaining milestone criteria.
- Do not publish releases or modify production settings without maintainer approval.
