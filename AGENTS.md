# Repository Guidelines

## Project Structure & Module Organization

Runnable processes live in `apps/`: `web`, `control-api`, `napcat-gateway`, and `agent-worker`. Reusable code belongs in `packages/`: `agent-core`, `db`, `im`, `config`, `llm`, and `shared`. Tests live with their workspace. PostgreSQL schemas and migrations are owned only by `packages/db/`; no second application database is allowed. Root `scripts/` and `Makefile` orchestrate workspaces. Treat `docs/requirements-and-development.md` as the core product and architecture reference; review it before changes.

## Build, Test, and Development Commands

- `make install`: install locked npm dependencies.
- `make dev`: run Web, gateway, control API, and inbound worker.
- `make frontend` / `make backend`: run either side independently.
- `make worker`: process one batch of newly persisted QQ messages.
- `make db-generate`: generate a migration for review; never change tables manually.
- `make db-migrate`: apply reviewed PostgreSQL migrations from `.env`.
- `make check`: run lint, typecheck, boundary checks, and unit tests.
- `make test`: build and run the complete test suite.
- `make build`: create and validate the production artifact.

## Coding Style & Naming Conventions

Use TypeScript/ES modules, two-space indentation, semicolons, and existing ESLint rules. Use `camelCase` for values/functions, `PascalCase` for components/types, and descriptive kebab-case filenames. Keep credentials in ignored `.env` files; document variables in `.env.example`.

Import another workspace only through its `@asuka-agent/*` public exports; never traverse package boundaries with relative paths.

## Testing Guidelines

Tests use Node's built-in runner and follow `<workspace>/tests/*.test.mjs`. Add regression tests for behavioral changes, especially ingestion idempotency and agent decisions. `make check` includes lint, typecheck, workspace-boundary validation, and unit tests. Run it before every PR and `make test` before merge. No numeric coverage threshold exists; cover success and important failure paths.

## Standard Development Workflow

Create the issue and milestone first with `gh issue create` and `gh api`. When creating an issue, add the most relevant existing labels; if none fit, confirm before creating a new label. Start standalone `feature/<issue>-<slug>` or `milestone/<slug>` branches from an updated `dev`. For milestone work, branch features from the milestone branch and open PRs back to that branch; standalone features target `dev`. After implementation, push and open a PR. Wait for all CI checks, then wait for the repository owner's explicit confirmation before merging.

Run GitHub-facing `gh` operations outside the sandbox with elevated network access, including authentication checks, API calls, issue/PR operations, and CI checks. A sandboxed `gh auth status` may incorrectly report an invalid token; do not treat that result as the real authentication state.

## Commits & Pull Requests

History is currently minimal, so use Conventional Commit subjects: `feat:`, `fix:`, `docs:`, `test:`, or `chore:`. Keep commits scoped and never include `Co-authored-by` trailers. PRs must include: linked issue/milestone, scope, implementation decisions and alternatives, verification commands/results, risks or rollback notes, and a reusable **Know-how** section. Include screenshots for UI changes. Do not merge your own PR without owner approval.
