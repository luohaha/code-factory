<p align="center">
  <img src="docs/assets/brand/code-factory-logo.svg" alt="Code Factory logo" width="180" />
</p>

<h1 align="center">Code Factory</h1>

<p align="center"><strong>From requirement to reviewed pull request, keep every coding-agent loop visible and under human control.</strong></p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-Apache%202.0-blue" alt="License: Apache 2.0" /></a>
  <a href="https://www.npmjs.com/package/@luoyixin/code-factory"><img src="https://img.shields.io/npm/v/%40luoyixin%2Fcode-factory?label=npm&amp;color=CB3837" alt="npm version" /></a>
  <a href="packages/agent-manager/package.json"><img src="https://img.shields.io/badge/node-%3E%3D22.13.0-brightgreen" alt="Node.js: >=22.13.0" /></a>
  <a href="packages/agent-manager/tsconfig.json"><img src="https://img.shields.io/badge/TypeScript-strict-3178C6" alt="TypeScript: strict" /></a>
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

<p align="center">
  <img src="docs/assets/brand/code-factory-overview.png" alt="Code Factory coordinates multiple related Requirements, each with its own persistent RD session. RD agents can create and manage child Requirements, exchange durable messages, work in the local workspace, and deliver GitHub pull requests. Timer and GitHub triggers are available today; Slack and Jira triggers are planned." />
</p>

Each Requirement owns one long-lived RD session. Sessions for different Requirements can run in parallel, but a session has at most one active RD run. Directly related Requirements coordinate through explicit, durable RD-to-RD messages while keeping their native agent contexts isolated.

1. **Create.** A human creates a Requirement in the dashboard and selects Codex or Claude Code, with optional model and reasoning settings. Agent Manager creates the Requirement and its RD session atomically.
2. **Build and delegate.** Agent Manager starts or resumes that session in the managed workspace. The RD edits and tests the repository, then uses `code-factory-cli` to register pull requests, create directly related child Requirements, manage their permitted lifecycle transitions, message their RD agents, or schedule a later wake-up.
3. **Continue.** The durable Requirement conversation is also the RD delivery stream: Human and Reviewer messages, selected System events, and explicit related-Agent messages are delivered to RD; the RD's own output is displayed but not fed back as new input. New input stays queued in order, and a running session processes it after the current run unless a human explicitly interrupts.
4. **React.** Today's Timer and GitHub triggers add deduplicated messages for due wake-ups, PR state changes, reviews and comments, CI failures, and merge conflicts. The source-neutral trigger boundary is designed for future Slack and Jira sources, which are not implemented yet. GitHub and the reconciler—not the RD—own PR lifecycle state.
5. **Review.** On request, a separate short-lived Reviewer reads the open PR, can publish inline comments, and appends a summary to the Requirement conversation, waking the RD to continue the loop.

SQLite persists Requirements, relationships, conversations, runs, sessions, PR metadata, timers, and trigger receipts across restarts. Related-agent communication becomes new input in the target Requirement; it does not merge the agents' native session contexts.

Stopping or restarting Agent Manager first cancels active Agent process trees and waits for them to exit before releasing the workspace. Under the daemon supervisor, active Agent process groups are also tracked across a forced Manager exit and terminated before recovery starts, preventing a resumed Codex thread from overlapping its previous writer.

For the complete domain model, state machines, concurrency rules, and delivery semantics, see [Final architecture and domain model](docs/architecture.en.md).

## Web Dashboard

The bundled dashboard provides four views:

- Requirement board: `TODO / DOING / Waiting for confirmation / DONE`
- Pull Request board: `DRAFT / OPEN / CLOSED / MERGED`
- RD Session board: `Idle / Running / Waiting for human / Failed / Completed`
- Timer board: `Active / Completed / Cancelled`, with each timer linked to its Requirement

Opening a Requirement shows its description, linked PRs, run information, per-Run Agent trace, and unified Human/RD/Reviewer conversation. Requirement descriptions and conversation messages render GitHub Flavored Markdown, including tables, lists, links, and code blocks. The Session board cards open this work surface directly; the latest Run trace is selected by default and shows Provider-emitted reasoning summaries, tool calls, command/tool results, messages, and errors in real time. Starting a TODO card opens that conversation first, so optional instructions and attachments can be included in the initial Run; it also offers an explicit start-without-instructions action. Before execution starts, a human can change the TODO Requirement's model and reasoning effort or restore the CLI defaults from this work surface. TODO cards can be deleted before execution; the action requires confirmation and removes the Requirement from active lists. Messages support images and file attachments. The chat composer can create and cancel one-time or recurring scheduled wake-ups in minutes, hours, or days, while the Timer board shows timers across the workspace and opens their associated Requirements. New input can be queued while RD is running, or the current run can be interrupted so the same session handles the correction immediately. Replying to a completed Requirement reactivates it and resumes its original RD Session in a new Run. Requirement and Reviewer forms provide provider-specific model dropdowns populated by an Agent Manager catalog that refreshes every 24 hours.

The dashboard supports light and dark modes from the top-right theme control, remembers the selected theme, and follows the operating-system preference until one is selected. It also supports English and Simplified Chinese, remembers the selected locale, and initially follows the browser language. Its settings dialog persists workspace configuration, applies Requirement retention periods at runtime, identifies changes that require a restart, and updates browser-local notification preferences immediately.

Browser notifications default to enabled and can be changed immediately in the settings dialog or from the header bell. A browser still requires an explicit permission grant before it can display notifications. In a Windows browser reached through port forwarding, open the dashboard at `http://localhost:<forwarded-port>`, use either notification control, and allow notifications for that site. Successful, failed, timed-out, and cancelled RD Runs show their Requirement title and outcome; clicking a notification opens the Requirement. The browser stores the preference locally. Keep the dashboard tab open to receive notifications; browsers require a secure context such as localhost or HTTPS, and the site's notification permission must remain granted.

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
