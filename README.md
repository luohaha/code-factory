# Code Factory

Code Factory is a local, TypeScript-based development workspace for running and supervising coding agents. Start an **Agent Manager** inside a repository, create Jira-like requirements, collaborate with long-lived RD Agent sessions, track pull requests, and request on-demand reviews from a Web dashboard.

The current implementation supports headless **Codex** and **Claude Code**.

## How It Works

Code Factory is built around three first-class domain entities:

- **Requirement** — a Jira-like work item containing its business state and complete Human/RD/Reviewer conversation.
- **AgentSession** — the long-lived RD session created and permanently bound to one Requirement.
- **PullRequest** — a GitHub PR associated with a Requirement, with `draft`, `open`, `closed`, or `merged` state.

The main runtime rules are:

- One Agent Manager manages the workspace directory from which it was started.
- A Requirement receives its RD AgentSession immediately when it is created. There is no agent pool or scheduling queue.
- One AgentSession may produce multiple AgentRuns while preserving context through the native Codex thread ID or Claude Code session ID.
- Different RD sessions may run concurrently, while a single session may have only one active RD Run.
- The Requirement conversation is the RD message stream. Human and Reviewer messages arriving during a Run are processed automatically after that Run finishes.
- RD Agent output is visible in the conversation but is never sent back to the same agent as new input.
- A human can request a review for an Open PR and explicitly choose Codex or Claude Code as the Reviewer.
- Reviewer is a short-lived Run with no persistent AgentSession. Its result is added to the Requirement conversation and wakes the corresponding RD session.
- An RD Agent can call the local Agent API to register or update a PR and propose a separate TODO Requirement.
- Child-process cwd is always the Agent Manager startup directory. Project instructions, Skills, and configuration are loaded according to the native Codex or Claude Code directory rules.
- Requirements follow `TODO → DOING → WAITING_CONFIRMATION → DONE`.
- SQLite is the initial persistence layer, behind a business-level Store interface that can later be implemented with PostgreSQL.

## Web Dashboard

The bundled dashboard provides three views:

- Requirement board: `TODO / DOING / Waiting for confirmation / DONE`
- Pull Request board: `DRAFT / OPEN / CLOSED / MERGED`
- RD Session board: `Idle / Running / Waiting for human / Failed / Completed`

Opening a Requirement displays its description, linked PRs, Run information, and unified conversation. The input remains available while RD is running; new messages wait in the conversation and are automatically delivered during the next Run.

## Quick Start

Requirements:

- Node.js 22.13 or newer
- At least one installed and authenticated Agent CLI: `codex` or `claude`

Build from this repository:

~~~bash
cd packages/agent-manager
npm install
npm run build

cd ~/starrocks
node /path/to/code-factory/packages/agent-manager/dist/cli.js start
~~~

After the npm package is published, the intended command is:

~~~bash
cd ~/starrocks
npx @code-factory/agent-manager start
~~~

Agent Manager prints a local dashboard URL:

~~~text
Dashboard: http://127.0.0.1:4310/
API:       http://127.0.0.1:4310/api
~~~

Open the Dashboard URL to use Code Factory. Pass `--open` to open it automatically:

~~~bash
npx @code-factory/agent-manager start --open
~~~

The Web dashboard, HTTP API, and SSE event stream use the same process and port. No separate Web deployment is required.

Workspace data is stored outside the managed repository:

~~~text
~/.code-factory/workspaces/<workspace-hash>/factory.sqlite
~~~

## Verification

~~~bash
cd packages/agent-manager
npm test
npm run typecheck
npm run build

cd ../../apps/web
npm run lint
npx tsc --noEmit
npm run build
~~~

## Design Documentation

- [Final architecture and domain model — English](docs/architecture.en.md)
- [最终架构与领域模型 — 中文](docs/architecture.md)
- [Headless Agent Runner](docs/agent-runners.md)
- [HTTP and event protocol](docs/protocol.md)
- [Development roadmap](docs/roadmap.md)

## Current Boundaries

The current implementation includes the Agent Manager core, SQLite Store, HTTP/SSE API, Codex and Claude Code adapters, conversation-driven RD continuation, PR tracking, manually triggered Reviewer Runs, and the bundled Web dashboard.

Reviewer agents are instructed to publish inline comments through the GitHub CLI/API, but Code Factory does not yet verify those comments structurally. GitHub webhook synchronization, stale-review indicators after a head-SHA change, local access tokens, detailed tool-execution logs, and optional worktree isolation remain future work.
