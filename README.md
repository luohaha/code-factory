<p align="center">
  <img src="docs/assets/brand/code-factory-logo.png" alt="Code Factory logo" width="180" />
</p>

<h1 align="center">Code Factory</h1>

<p align="center"><strong>From requirement to reviewed pull request, keep every coding-agent loop visible and under human control.</strong></p>

<p align="center">
  <img src="docs/assets/brand/code-factory-overview.png" alt="Code Factory connects requirements, persistent RD agents, a local workspace, pull requests, AI review, scheduled wake-ups, and human control. Agent Triggers route timed and GitHub PR events into existing Requirements and are designed to support more sources and new Requirement creation in the future." />
</p>

Code Factory is a **local control plane for agent-driven software delivery**. It turns each requirement into a persistent development loop that connects a human, an RD coding agent, the local workspace, GitHub pull requests, on-demand AI reviewers, and external events routed through Agent Triggers in one Web dashboard.

It is designed for developers and engineering teams that already use **Codex** or **Claude Code**, but need more than isolated terminal sessions: durable context, visible progress, human intervention, PR feedback, and an auditable conversation around the work.

## Product Positioning

Code Factory sits between an issue tracker, an agent session manager, and a pull-request control center:

- **Requirement-driven:** work starts from a concrete requirement instead of an ad-hoc prompt.
- **Persistent:** every requirement owns a long-lived RD session that can be resumed across multiple runs.
- **Human-controlled:** people can add context, queue corrections, interrupt a run, and decide when work is done.
- **Trigger-connected:** Agent Triggers connect external events and persistent scheduled wake-ups to the delivery loop. Built-in triggers handle configurable one-time or recurring wake-ups plus GitHub PR status, reviews/comments, CI failures, and merge conflicts, while the source-neutral boundary is designed to support systems such as Slack and Jira.
- **Local-first:** agents run in your existing repository with your installed CLI tools, project instructions, and credentials.

Code Factory is not a hosted IDE or a generic agent pool. It coordinates the delivery workflow around coding agents while leaving code execution, Git, and GitHub access in the developer's own environment.

The current implementation supports headless **Codex** and **Claude Code** agents.

## Quick Start

~~~bash
cd /path/to/the/repository/to-manage
npx --package @luoyixin/code-factory code-factory-agent-manager start --daemon
~~~

The startup directory becomes the managed workspace. Only one Agent Manager may run for a canonical workspace at a time, even when another port or database path is supplied. The dashboard is available at [http://127.0.0.1:4310](http://127.0.0.1:4310) by default. Daemon startup failures, including an occupied port, are reported directly to the starting command.

Prerequisites, daemon operation, configuration, CLI options, and log locations are documented in [Running Code Factory](docs/running-code-factory.md). To install dependencies or run a source checkout manually, see the [Development guide](docs/development.md).

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
  RV -->|Reviewer summary| M
  GH -->|Current PR events| T[Agent Triggers]
  W -->|Configure timed wake-up| T
  EXT[Slack / Jira / more] -.->|Future sources| T
  T -->|Current: deliver to<br/>existing Requirement| M
  T -.->|Future: create<br/>Requirement| M
~~~

1. A human creates a Requirement and chooses Codex or Claude Code, optionally pinning a model and reasoning effort. Code Factory creates a dedicated, persistent RD session for it.
2. Agent Manager starts or resumes that agent in the managed workspace. Messages sent during a run are queued; the human may explicitly interrupt when an immediate correction is needed.
3. The RD agent edits and tests the repository, then uses the bundled `code-factory-cli` to register any pull request it creates, propose separate follow-up work, read complete or paginated conversations from other Requirements, inspect its direct parent and child Requirements, message their RD Agents, or schedule a wake-up while a long external build or command continues. Related-Agent messages are persisted in the target Requirement conversation and start or queue its long-lived RD session.
4. Agent Triggers route normalized, deduplicated messages into the Requirement conversation. The timer trigger executes configurable one-time or recurring timers and sends their ID and follow-up description when due. The GitHub triggers poll registered PRs whose last stored state is Draft or Open, observing state, comments and reviews, CI failures, and merge conflicts. This lets the reconciler discover when a Draft PR becomes Open. Once a PR transitions to Closed or Merged, it is excluded from later polls. An idle RD session resumes immediately; a running session consumes the new messages after its current run.
5. A human can request a short-lived AI review for an open PR with its own provider, model, and reasoning effort. Review results return to the same conversation and wake the original RD session to continue the loop.

The Agent Trigger boundary is intentionally source-neutral, but its current message contract targets an existing Requirement. Scheduled wake-ups are natively configurable; dynamic discovery and configuration of third-party trigger implementations, Slack and Jira sources, and triggers that create new Requirements are future extensions rather than implemented behavior.

Different Requirements can run concurrently, while each Requirement has at most one active RD run. Requirement state, conversations, runs, sessions, PR metadata, scheduled wake-ups, and Agent Trigger receipts are persisted in SQLite. Cancelled Requirements are retained for 7 days and completed Requirements for 365 days by default; both periods are runtime-configurable, and expiry atomically removes the Requirement and its related domain records while retaining retryable tombstones until attachment files are deleted.

Agent Manager places `code-factory-cli` on every RD process's `PATH` and injects its API URL, Requirement ID, and Session ID through the environment. The RD prompt names the relevant commands and leaves their arguments to `code-factory-cli --help`; raw HTTP details remain an internal transport contract.

Agent context is scoped to the Requirement rather than copied from whichever interactive agent or terminal started Agent Manager. A Requirement's first RD Run creates a new native Codex thread or Claude Code session; later Runs resume that same native session, preserving its conversation context. Because the child CLI inherits Agent Manager's environment and starts in the managed workspace, it also discovers the provider's configured project/user instructions, Skills, plugins, and local memory features according to the CLI's own rules. Code Factory does not automatically copy another agent's live transcript or merge context from other Requirements. An explicit related-Agent message is new, durable input to the target Requirement rather than shared session context. Code Factory does not guarantee that every provider-managed memory entry is injected.

For the complete domain model, state machines, concurrency rules, and delivery semantics, see [Final architecture and domain model](docs/architecture.en.md).

## Web Dashboard

The bundled dashboard provides four views:

- Requirement board: `TODO / DOING / Waiting for confirmation / DONE`
- Pull Request board: `DRAFT / OPEN / CLOSED / MERGED`
- RD Session board: `Idle / Running / Waiting for human / Failed / Completed`
- Timer board: `Active / Completed / Cancelled`, with each timer linked to its Requirement

Opening a Requirement shows its description, linked PRs, run information, and unified Human/RD/Reviewer conversation. Starting a TODO card opens that conversation first, so optional instructions and attachments can be included in the initial Run; it also offers an explicit start-without-instructions action. TODO cards can be deleted before execution; the action requires confirmation and removes the Requirement from active lists. Messages support images and file attachments. The chat composer can create and cancel one-time or recurring scheduled wake-ups in minutes, hours, or days, while the Timer board shows timers across the workspace and opens their associated Requirements. New input can be queued while RD is running, or the current run can be interrupted so the same session handles the correction immediately. Replying to a completed Requirement reactivates it and resumes its original RD Session in a new Run. Requirement and Reviewer forms provide provider-specific model dropdowns populated by an Agent Manager catalog that refreshes every 24 hours.

The dashboard supports light and dark modes from the top-right theme control, remembers the selected theme, and follows the operating-system preference until one is selected. It also supports English and Simplified Chinese, remembers the selected locale, and initially follows the browser language. Its Agent Manager settings dialog persists workspace configuration, applies Requirement retention periods at runtime, and identifies changes that require a restart.

All four boards share a time-range filter with options for the last 24 hours, 7 days, 30 days, 90 days, or all time. Requirement, PR, and Session boards filter by creation time. The Timer board always retains active timers by their upcoming wake-up and filters completed or cancelled history by its latest update. The default range is 7 days.

The shared search box uses a local hybrid index over Requirement titles and descriptions, complete conversation messages, and Pull Request titles and metadata. Persisted word and character n-gram vectors add similarity ranking to full-text matching, including useful partial and fuzzy matches; Agent Manager also uses SQLite FTS5 ranking when the installed Node.js SQLite build provides it. Search indexing and ranking stay inside the workspace's Agent Manager process and do not call an external embedding service.

The Web dashboard, HTTP API, and SSE event stream run in the same process and use the same port. No separate Web deployment is required.

## Security Model

Every headless RD and Reviewer invocation skips interactive CLI approval and sandbox checks. Agents therefore inherit the launching user's filesystem, network, and command-execution permissions. Start Agent Manager only inside a trusted workspace and expose its HTTP port only to trusted users and networks.

## Versioning and releases

Code Factory uses Semantic Versioning and is published as [`@luoyixin/code-factory`](https://www.npmjs.com/package/@luoyixin/code-factory). The installed version is available through `code-factory-agent-manager --version`, `code-factory-cli --version`, the startup banner, and `GET /api/health`. See the [release guide](docs/releasing.md) for version preparation, the tag workflow, verification, and recovery rules.

## License

Code Factory is licensed under the [Apache License 2.0](LICENSE).

## Design Documentation

- [Running Code Factory](docs/running-code-factory.md)
- [Development guide](docs/development.md)
- [Final architecture and domain model](docs/architecture.en.md)
- [Headless Agent Runner](docs/agent-runners.md)
- [Agent Manager HTTP API Reference](docs/agent-manager-api.md)
- [HTTP and event protocol](docs/protocol.md)
- [Dashboard perceived-latency audit](docs/dashboard-latency-audit.md)
- [Development roadmap](docs/roadmap.md)
- [Release guide](docs/releasing.md)

## Current Boundaries

The current implementation includes the Agent Manager core, a supervised daemon mode with automatic process restart, SQLite Store, HTTP/SSE API, Codex and Claude Code adapters, conversation-driven RD continuation, persistent scheduled wake-ups, PR tracking, manually triggered Reviewer runs, and the bundled Web dashboard.

The `AgentTrigger` lifecycle and extension API are currently code-level, and every delivered trigger message must target an existing Requirement. The native Timer Agent Trigger has HTTP, dashboard, and RD CLI configuration, but dynamic third-party trigger discovery/configuration, Slack and Jira sources, and trigger-created Requirements remain future work. GitHub synchronization currently uses local `gh` polling rather than webhooks. Stale-review indicators after a head-SHA change, local access tokens, detailed tool-execution logs, and Manager-enforced worktree isolation also remain future work. RD Agents are instructed to create or reuse a Requirement-specific Git worktree before changing code, but Agent Manager does not provision or enforce that isolation; every child process still starts in the shared Manager workspace.
