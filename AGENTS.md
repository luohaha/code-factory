# Repository Instructions

## Project Overview

Code Factory is a local control plane for agent-driven software delivery. It connects requirement management, persistent RD coding-agent sessions, GitHub pull requests, on-demand AI review, and human intervention in one workspace-scoped application.

The repository has two independently installed Node.js packages and no root package scripts:

- `packages/agent-manager/` — Node.js/TypeScript Agent Manager, SQLite persistence, HTTP/SSE API, GitHub reconciliation, and Codex/Claude Code adapters.
- `apps/web/` — React 19 dashboard built with Vinext, Vite, Tailwind CSS, and Base UI.
- `docs/` — architecture, protocol, runner, API, and roadmap documentation.

Read `README.md` for the product and operator-facing overview. Treat `docs/architecture.en.md` as the canonical detailed architecture document and `docs/agent-manager-api.md` as the canonical HTTP API reference.

## Core Architecture Invariants

Preserve these rules unless the task explicitly changes the product architecture:

- One Agent Manager owns the directory from which it was started. Every child agent uses that directory as its working directory.
- Each Requirement has exactly one long-lived RD `AgentSession`, created when the Requirement is created. There is no shared agent pool or scheduling queue.
- A session may have many `AgentRun` records but at most one active RD run. Sessions for different Requirements may run concurrently.
- Native Codex thread IDs and Claude Code session IDs preserve agent context across runs.
- `requirement_messages` is both the visible conversation and the RD delivery stream. Human, Reviewer, and selected System messages are delivered in sequence; RD output is displayed but is never sent back as new RD input.
- Messages arriving during a run are queued without implicitly interrupting it. Failed or interrupted runs must not advance the message-consumption cursor.
- A Reviewer is a short-lived run, not a persistent `AgentSession`. Review output returns to the Requirement conversation and can wake its RD session.
- GitHub and the PR reconciler own `draft`, `open`, `closed`, and `merged` lifecycle state. RD endpoints may register a PR or refresh metadata, but must not mirror reconciler-observed lifecycle changes.
- SQLite is behind the business-level Store interface. Keep business rules out of HTTP handlers and storage-specific code where possible.
- Headless agents run with the launching user's filesystem, network, and command permissions. Do not describe behavioral instructions as an operating-system security boundary.

## Development Workflow

Develop every new feature in a dedicated Git worktree and feature branch. Create the worktree before making feature changes so concurrent work remains isolated. If the current checkout is already a dedicated worktree for the requested feature, continue there instead of creating a nested or duplicate worktree. Never move, discard, or copy uncommitted changes into a new worktree without explicit user approval.

Before editing:

1. Inspect the relevant implementation, tests, and design documentation.
2. Check `git status` and preserve all unrelated or pre-existing changes.
3. Prefer focused changes; do not reformat unrelated files or modify generated output.

When changing a cross-layer contract, update every affected layer in the same change:

- Domain or persistence changes usually touch `types.ts`, `store.ts`, `sqlite-store.ts`, `schema.ts`, manager logic, and tests.
- HTTP changes usually touch `server.ts`, `apps/web/lib/agent-manager-client.ts`, and `docs/agent-manager-api.md` or `docs/protocol.md`.
- Agent execution changes usually touch `adapters/types.ts`, one or both adapters, `process-runner.ts`, tests, and `docs/agent-runners.md`.
- Architecture or lifecycle changes must also update `docs/architecture.en.md` and the concise README explanation when user-visible.
- Dashboard copy must remain available in English and Simplified Chinese. English source strings used with `t(...)` need matching entries in `apps/web/locales/zh-CN.ts`.

Do not edit or commit generated directories such as `dist/`, `.next/`, or `packages/agent-manager/dashboard/`. Only update lockfiles when dependencies actually change.

## Code Conventions

### Agent Manager

- Use TypeScript ESM and keep explicit `.js` suffixes in relative imports, as required by `NodeNext` resolution.
- Maintain compatibility with the strict options in `packages/agent-manager/tsconfig.json`, including `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes`.
- Prefer typed domain inputs and explicit validation over casts or `any`.
- Keep provider-specific CLI construction and event parsing inside adapters.
- Keep HTTP handlers thin: validate transport input, delegate behavior to `AgentManager`, and map known errors to stable HTTP responses.
- Preserve structured logging without prompts, conversation bodies, raw agent output, credentials, or attachment contents.

### Web Dashboard

- Keep components typed and use the `@/` path alias for app-local imports.
- Reuse existing UI primitives and visual patterns before adding new dependencies or parallel component systems.
- Preserve responsive behavior and both supported locales.
- Keep API types and request behavior centralized in `apps/web/lib/agent-manager-client.ts`.

### Tests

- Backend tests use `node:test` and `node:assert/strict` through `tsx`.
- Add regression coverage for behavioral fixes and state transitions.
- Prefer in-memory SQLite and deterministic fake runners or GitHub clients over network access.
- Assert public outcomes and durable state; avoid tests that depend unnecessarily on private implementation details.

## Commands

Install dependencies separately in each package:

~~~bash
cd packages/agent-manager && npm install
cd ../../apps/web && npm install
~~~

Run Agent Manager checks:

~~~bash
cd packages/agent-manager
npm test
npm run typecheck
npm run build
~~~

Run one backend test file while iterating:

~~~bash
cd packages/agent-manager
npx tsx --test test/agent-manager.test.ts
~~~

Run dashboard checks:

~~~bash
cd apps/web
npm run lint
npx tsc --noEmit
npm run build
~~~

Start the built application from the repository it should manage:

~~~bash
cd /path/to/managed-repository
node /path/to/code-factory/packages/agent-manager/dist/cli.js start --port 4310 --open
~~~

Choose checks in proportion to the change. Run the full relevant package checks before handing off a substantial implementation; documentation-only changes do not require application builds.

## Documentation and Handoff

- Keep README instructions copy-pasteable and ensure CLI options match `packages/agent-manager/src/cli.ts`.
- Use Mermaid for architecture diagrams that contain exact labels or are expected to evolve with the code.
- Report what changed, which checks ran, and any known limitation or unverified area.
- Never claim tests passed unless they were actually executed successfully.
