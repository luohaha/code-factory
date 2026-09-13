# Code Factory

> From requirement to reviewed pull request, keep every coding-agent loop visible and under human control.

Code Factory is a **local control plane for agent-driven software delivery**. It turns each requirement into a persistent development loop that connects a human, an RD coding agent, GitHub pull requests, and on-demand AI reviewers in one Web dashboard.

It is designed for developers and engineering teams that already use **Codex** or **Claude Code**, but need more than isolated terminal sessions: durable context, visible progress, human intervention, PR feedback, and an auditable conversation around the work.

## Product Positioning

Code Factory sits between an issue tracker, an agent session manager, and a pull-request control center:

- **Requirement-driven:** work starts from a concrete requirement instead of an ad-hoc prompt.
- **Persistent:** every requirement owns a long-lived RD session that can be resumed across multiple runs.
- **Human-controlled:** people can add context, queue corrections, interrupt a run, and decide when work is done.
- **Trigger-aware:** external signals flow into the same development loop; independent built-in GitHub PR Triggers handle status, reviews/comments, CI failures, and merge conflicts.
- **Local-first:** agents run in your existing repository with your installed CLI tools, project instructions, and credentials.

Code Factory is not a hosted IDE or a generic agent pool. It coordinates the delivery workflow around coding agents while leaving code execution, Git, and GitHub access in the developer's own environment.

The current implementation supports headless **Codex** and **Claude Code** agents.

## Quick Start

### Prerequisites

- Node.js 22.13 or newer
- At least one installed and authenticated Agent CLI: `codex` or `claude`
- GitHub CLI (`gh`) installed and authenticated for PR reconciliation and review workflows

### Build and start from this repository

Build Agent Manager once:

~~~bash
cd /path/to/code-factory/packages/agent-manager
npm install
npm run build
~~~

Then start it **from the repository you want the agents to work in**:

~~~bash
cd /path/to/your-project
node /path/to/code-factory/packages/agent-manager/dist/cli.js start --open
~~~

The startup directory becomes the managed workspace and the working directory for every RD and Reviewer agent. By default, the dashboard is available at [http://127.0.0.1:4310](http://127.0.0.1:4310).

On first start, Agent Manager creates a workspace-scoped configuration file at `~/.code-factory/workspaces/<workspace-hash>/config.json`. The dashboard settings dialog can edit it. PR reconciliation intervals and log levels are applied immediately; network, storage, browser, and log-rotation changes are saved for the next restart.

### Choose a port

Use `--port` followed by an integer from `1` to `65535`:

~~~bash
node /path/to/code-factory/packages/agent-manager/dist/cli.js start --port 8080
~~~

To listen on all network interfaces, specify the host as well:

~~~bash
node /path/to/code-factory/packages/agent-manager/dist/cli.js start \
  --host 0.0.0.0 \
  --port 8080
~~~

Listening on `0.0.0.0` makes the dashboard reachable from other machines. Only do this on a trusted network: headless agents run with the permissions of the user who started Agent Manager.

### Run as a supervised daemon

Add `--daemon` to detach Agent Manager from the terminal and keep it running under a lightweight supervisor:

~~~bash
cd /path/to/your-project
node /path/to/code-factory/packages/agent-manager/dist/cli.js start --daemon --open
~~~

The start command returns only after the HTTP service is ready. If the Agent Manager process exits unexpectedly, the supervisor restarts it automatically with exponential backoff from 1 to 30 seconds. Use the same managed workspace for lifecycle commands:

~~~bash
node /path/to/code-factory/packages/agent-manager/dist/cli.js status
node /path/to/code-factory/packages/agent-manager/dist/cli.js restart
node /path/to/code-factory/packages/agent-manager/dist/cli.js stop
~~~

When the daemon is running, `restart` reuses its start options unless new options are supplied. `status` exits with code `0` while the supervisor is live and `3` otherwise. The equivalent `daemon start|status|restart|stop` command form is also supported. This supervisor provides background execution and process recovery; it does not install an operating-system service or start automatically after a machine reboot.

### Common examples

~~~bash
# Open the dashboard after startup
node /path/to/code-factory/packages/agent-manager/dist/cli.js start --open

# Reconcile tracked pull requests every 10 seconds
node /path/to/code-factory/packages/agent-manager/dist/cli.js start \
  --pr-reconcile-interval 10

# Disable pull-request polling
node /path/to/code-factory/packages/agent-manager/dist/cli.js start \
  --pr-reconcile-interval 0

# Use a custom database and debug logging
node /path/to/code-factory/packages/agent-manager/dist/cli.js start \
  --db /path/to/factory.sqlite \
  --log-level debug
~~~

### CLI options

| Option | Default | Description |
| --- | --- | --- |
| `--config PATH` | Workspace data directory | JSON configuration file path. |
| `--host HOST` | `127.0.0.1` | HTTP listen address. |
| `--port PORT` | `4310` | Dashboard, HTTP API, and SSE port (`1`–`65535`). |
| `--open` | Off | Open the dashboard in the default browser after startup. |
| `--daemon` | Off | Run under the detached supervisor and restart after unexpected exits. |
| `--db PATH` | Workspace data directory | SQLite database path. |
| `--allow-origin ORIGIN` | `http://localhost:3000` | Allowed CORS origin. |
| `--pr-reconcile-interval SECONDS` | `30` | GitHub polling interval; use `0` to disable it. |
| `--log-level LEVEL` | `info` | `debug`, `info`, `warn`, `error`, or `silent`. |
| `--log-file PATH` | Workspace log directory | Structured JSONL log destination. |
| `--log-max-size SIZE` | `20m` | Rotate the active log after it reaches this size. |
| `--log-max-files COUNT_OR_DAYS` | `14d` | Number of rotated logs or retention period. |

Configuration file values are used by default. Command-line options remain available as one-process overrides for compatibility; logging environment variables take precedence over the file, and command-line options take precedence over both. These launch-only overrides are never copied into the writable file by later dashboard changes. Relative database and log paths are resolved from the managed workspace.

~~~json
{
  "host": "127.0.0.1",
  "port": 4310,
  "allowedOrigin": "http://localhost:3000",
  "openDashboard": false,
  "databasePath": null,
  "pullRequestReconcileIntervalSeconds": 30,
  "logLevel": "info",
  "logFilePath": null,
  "logMaxSize": "20m",
  "logMaxFiles": "14d"
}
~~~

`databasePath` and `logFilePath` use the workspace defaults when set to `null`; `allowedOrigin: null` disables CORS headers. Set `pullRequestReconcileIntervalSeconds` to `0` to disable GitHub polling. Its largest accepted value is `2147483` seconds, matching Node.js timer limits.

When the npm package is published, the equivalent command will be:

~~~bash
cd /path/to/your-project
npx @code-factory/agent-manager start --port 8080 --open
~~~

## How It Works

~~~mermaid
flowchart LR
  H[Human] <--> W[Web dashboard]
  W <-->|HTTP + SSE| M[Agent Manager]
  M <--> DB[(SQLite)]
  M -->|Create or resume| RD[Long-lived RD session<br/>Codex or Claude Code]
  M -->|Request review| RV[Short-lived Reviewer<br/>Codex or Claude Code]
  RD -->|Edit and test| WS[Local workspace]
  RD -->|Create or update PR| GH[GitHub]
  RD -->|code-factory-cli| M
  RV -->|Review comments| GH
  GH -->|PR state, comments,<br/>reviews, CI, and conflicts| T[PR Agent Triggers]
  T -->|Deduplicated messages| M
~~~

1. A human creates a Requirement and chooses Codex or Claude Code, optionally pinning a model and reasoning effort. Code Factory creates a dedicated, persistent RD session for it.
2. Agent Manager starts or resumes that agent in the managed workspace. Messages sent during a run are queued; the human may explicitly interrupt when an immediate correction is needed.
3. The RD agent edits and tests the repository, then uses the bundled `code-factory-cli` to register any pull request it creates or propose separate follow-up work. The built-in PR Agent Triggers continuously bring GitHub state, feedback, CI failures, and merge conflicts into the Requirement conversation.
4. A human can request a short-lived AI review for an open PR with its own provider, model, and reasoning effort. Review results return to the same conversation and wake the original RD session to continue the loop.

Different Requirements can run concurrently, while each Requirement has at most one active RD run. Requirement state, conversations, runs, sessions, PR metadata, and Agent Trigger receipts are persisted in SQLite.

Agent Manager places `code-factory-cli` on every RD process's `PATH` and injects its API URL, Requirement ID, and Session ID through the environment. The RD prompt names the relevant commands and leaves their arguments to `code-factory-cli --help`; raw HTTP details remain an internal transport contract.

For the complete domain model, state machines, concurrency rules, and delivery semantics, see [Final architecture and domain model](docs/architecture.en.md).

## Web Dashboard

The bundled dashboard provides three views:

- Requirement board: `TODO / DOING / Waiting for confirmation / DONE`
- Pull Request board: `DRAFT / OPEN / CLOSED / MERGED`
- RD Session board: `Idle / Running / Waiting for human / Failed / Completed`

Opening a Requirement shows its description, linked PRs, run information, and unified Human/RD/Reviewer conversation. Messages support images and file attachments. New input can be queued while RD is running, or the current run can be interrupted so the same session handles the correction immediately.

The dashboard supports English and Simplified Chinese, remembers the selected locale, and initially follows the browser language. Its Agent Manager settings dialog persists workspace configuration and identifies changes that require a restart.

All three boards share a creation-time filter with options for the last 24 hours, 7 days, 30 days, 90 days, or all time. The default view shows items created in the last 7 days.

The Web dashboard, HTTP API, and SSE event stream run in the same process and use the same port. No separate Web deployment is required.

## Data and Logs

Workspace data is stored outside the managed repository by default:

~~~text
~/.code-factory/workspaces/<workspace-hash>/config.json
~/.code-factory/workspaces/<workspace-hash>/factory.sqlite
~/.code-factory/workspaces/<workspace-hash>/attachments/
~/.code-factory/workspaces/<workspace-hash>/logs/agent-manager.log
~/.code-factory/workspaces/<workspace-hash>/logs/daemon.log
~/.code-factory/workspaces/<workspace-hash>/daemon.json
~~~

The foreground CLI prints a startup banner containing the workspace, configuration, database, log path, dashboard URL, API URL, and PR reconciliation interval. Daemon commands print supervisor and manager PIDs plus the daemon log path. Operational logs are written as structured JSONL and omit prompts, conversation bodies, and raw Agent output. Daemon state and log files use mode `0600`.

Follow the active log with:

~~~bash
tail -f ~/.code-factory/workspaces/<workspace-hash>/logs/agent-manager.log
~~~

In daemon mode, follow supervisor exits and restart attempts with:

~~~bash
tail -f ~/.code-factory/workspaces/<workspace-hash>/logs/daemon.log
~~~

Logging can also be configured with `CODE_FACTORY_LOG_LEVEL`, `CODE_FACTORY_LOG_FILE`, `CODE_FACTORY_LOG_MAX_SIZE`, and `CODE_FACTORY_LOG_MAX_FILES`. Command-line options take precedence over their environment-variable equivalents, which take precedence over configuration-file values.

## Security Model

Every headless RD and Reviewer invocation skips interactive CLI approval and sandbox checks. Agents therefore inherit the launching user's filesystem, network, and command-execution permissions. Start Agent Manager only inside a trusted workspace and expose its HTTP port only to trusted users and networks.

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

- [Final architecture and domain model](docs/architecture.en.md)
- [Headless Agent Runner](docs/agent-runners.md)
- [Agent Manager HTTP API Reference](docs/agent-manager-api.md)
- [HTTP and event protocol](docs/protocol.md)
- [Development roadmap](docs/roadmap.md)

## Current Boundaries

The current implementation includes the Agent Manager core, a supervised daemon mode with automatic process restart, SQLite Store, HTTP/SSE API, Codex and Claude Code adapters, conversation-driven RD continuation, PR tracking, manually triggered Reviewer runs, and the bundled Web dashboard.

The `AgentTrigger` extension API is currently code-level; dynamic trigger discovery/configuration and a Slack implementation remain future work. Webhook-based synchronization, stale-review indicators after a head-SHA change, local access tokens, detailed tool-execution logs, and Manager-enforced worktree isolation also remain future work. RD Agents are instructed to create or reuse a Requirement-specific Git worktree before changing code, but Agent Manager does not provision or enforce that isolation; every child process still starts in the shared Manager workspace.
