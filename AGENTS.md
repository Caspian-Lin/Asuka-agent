# Repository Guidelines

## Project Structure & Module Organization

`app/` contains the Vinext/React UI and routes. Shared logic lives in `lib/`; server orchestration belongs in `lib/server/`. NapCat processes are under `services/`, and the Cloudflare entry point is `worker/`. Schemas live in `db/`; D1 and PostgreSQL migrations are in `drizzle/` and `drizzle-pg/`. Tests use `tests/`, assets `public/`, and scripts `scripts/`. Treat `docs/requirements-and-development.md` as the core product and architecture reference; review it before changes and keep it current.

## Build, Test, and Development Commands

- `make install`: install locked npm dependencies.
- `make dev`: run Web, gateway, control API, and inbound worker.
- `make frontend` / `make backend`: run either side independently.
- `make worker`: process one batch of newly persisted QQ messages.
- `make db-generate`: generate a migration for review; never change tables manually.
- `make db-migrate`: apply reviewed PostgreSQL migrations from `.env`.
- `make check`: run ESLint and fast unit tests.
- `make test`: build and run the complete test suite.
- `make build`: create and validate the production artifact.

## Coding Style & Naming Conventions

Use TypeScript/ES modules, two-space indentation, semicolons, and existing ESLint rules. Use `camelCase` for values/functions, `PascalCase` for components/types, and descriptive kebab-case filenames. Keep credentials in ignored `.env` files; document variables in `.env.example`.

## Testing Guidelines

Tests use Node's built-in runner and follow `tests/*.test.mjs`. Add regression tests for behavioral changes, especially ingestion idempotency and agent decisions. Run `make check` before every PR and `make test` before merge. No numeric coverage threshold exists; cover success and important failure paths.

## Standard Development Workflow

Create the issue and milestone first with `gh issue create` and `gh api`. Start standalone `feature/<issue>-<slug>` or `milestone/<slug>` branches from an updated `dev`. For milestone work, branch features from the milestone branch and open PRs back to that branch; standalone features target `dev`. After implementation, push and open a PR. Wait for all CI checks, then wait for the repository owner's explicit confirmation before merging.

## Commits & Pull Requests

History is currently minimal, so use Conventional Commit subjects: `feat:`, `fix:`, `docs:`, `test:`, or `chore:`. Keep commits scoped and never include `Co-authored-by` trailers. PRs must include: linked issue/milestone, scope, implementation decisions and alternatives, verification commands/results, risks or rollback notes, and a reusable **Know-how** section. Include screenshots for UI changes. Do not merge your own PR without owner approval.
