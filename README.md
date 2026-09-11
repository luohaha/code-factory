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
- A built-in PR reconciler polls GitHub for status changes, PR comments, review submissions, inline review comments, and newly failed CI checks. These events enter the same Requirement conversation and wake or queue for the RD session.
- An RD Agent can call the local Agent API to register a newly created PR, refresh metadata changed by its own work, and propose a separate TODO Requirement. GitHub lifecycle state is subsequently owned by the Agent Manager reconciler rather than the RD Agent.
- Child-process cwd is always the Agent Manager startup directory. Project instructions, Skills, and configuration are loaded according to the native Codex or Claude Code directory rules.
- Every headless RD and Reviewer skips CLI approval and sandbox checks, so it runs with the launching user's full filesystem, network, and command-execution permissions. Start Agent Manager only in a trusted workspace.
- Requirements follow `TODO → DOING → WAITING_CONFIRMATION → DONE`.
- SQLite is the initial persistence layer, behind a business-level Store interface that can later be implemented with PostgreSQL.

## Web Dashboard

The bundled dashboard provides three views:

- Requirement board: `TODO / DOING / Waiting for confirmation / DONE`
- Pull Request board: `DRAFT / OPEN / CLOSED / MERGED`
- RD Session board: `Idle / Running / Waiting for human / Failed / Completed`

Opening a Requirement displays its description, linked PRs, Run information, and unified conversation. Human messages can include pasted, dropped, or selected images and general file attachments. Images render inline; other files remain downloadable and are passed to the RD Agent by local path. The input remains available while RD is running, and new messages wait in the conversation for the next Run.

## Quick Start

Requirements:

- Node.js 22.13 or newer
- At least one installed and authenticated Agent CLI: `codex` or `claude`
- GitHub CLI (`gh`) installed and authenticated for PR reconciliation and review workflows

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

Agent Manager writes structured JSONL logs to the workspace data directory by default:

~~~bash
tail -f ~/.code-factory/workspaces/<workspace-hash>/logs/agent-manager.log
~~~

The CLI always prints a short startup banner with the Workspace, Database, log path,
Dashboard URL, API URL, and PR reconciler interval. Other operational logs are not
written to stdout or stderr. The default log level is `info`;
set `CODE_FACTORY_LOG_LEVEL` or pass `--log-level debug|info|warn|error|silent`
to change it. Override the destination with `CODE_FACTORY_LOG_FILE` or
`--log-file PATH`. Lifecycle logs include Requirement, Session, Run, PR, and HTTP
identifiers, but omit prompts, conversation bodies, and raw Agent output.

File rotation is provided by `winston` and `winston-daily-rotate-file`. Logs use
dated names such as `agent-manager-2026-09-11.log`, rotate again after 20 MB,
and are retained for 14 days by default. `agent-manager.log` is a stable symlink
to the active file. Use `--log-max-size SIZE` / `CODE_FACTORY_LOG_MAX_SIZE` and
`--log-max-files COUNT_OR_DAYS` / `CODE_FACTORY_LOG_MAX_FILES` to override the
size and retention limits.

Open the Dashboard URL to use Code Factory. Pass `--open` to open it automatically:

~~~bash
npx @code-factory/agent-manager start --open
~~~

The Web dashboard, HTTP API, and SSE event stream use the same process and port. No separate Web deployment is required.

By default, Agent Manager reconciles every tracked Draft/Open PR every 30 seconds. Change the interval or disable polling with:

~~~bash
npx @code-factory/agent-manager start --pr-reconcile-interval 10
npx @code-factory/agent-manager start --pr-reconcile-interval 0
~~~

Workspace data is stored outside the managed repository:

~~~text
~/.code-factory/workspaces/<workspace-hash>/factory.sqlite
~/.code-factory/workspaces/<workspace-hash>/attachments/
~/.code-factory/workspaces/<workspace-hash>/logs/agent-manager.log
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
- [Agent Manager HTTP API Reference](docs/agent-manager-api.md)
- [HTTP and event protocol](docs/protocol.md)
- [Development roadmap](docs/roadmap.md)

## Current Boundaries

The current implementation includes the Agent Manager core, SQLite Store, HTTP/SSE API, Codex and Claude Code adapters, conversation-driven RD continuation, PR tracking, manually triggered Reviewer Runs, and the bundled Web dashboard.

Reviewer agents are instructed to publish inline comments through the GitHub CLI/API. The polling reconciler observes GitHub state but does not yet structurally verify that a requested Reviewer posted every expected comment. Webhook-based synchronization, stale-review indicators after a head-SHA change, local access tokens, detailed tool-execution logs, and optional worktree isolation remain future work.
