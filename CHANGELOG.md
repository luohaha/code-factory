# Changelog

All notable changes to Code Factory are documented here. The project follows
[Semantic Versioning](https://semver.org/), with minor releases allowed to contain
breaking changes while the major version is `0`.

## [Unreleased]

## [0.1.11] - 2026-09-24

### Added

- Allowed humans to edit a TODO Requirement's model and reasoning effort before its first run.
- Added configurable browser notifications for completed RD runs, including permission controls and direct links back to the Requirement.
- Added configurable Code Factory bot co-author attribution to RD-created commits.

### Changed

- Refreshed the README workflow overview to cover related Requirements, persistent RD sessions, durable agent messaging, and trigger sources.

### Fixed

- Preserved explicit browser-notification opt-outs while keeping notifications enabled by default.

## [0.1.10] - 2026-09-23

### Added

- Allowed RD Agents to start proposed follow-up Requirements immediately and manage their lifecycle with start, stop, delete, and done actions guarded by proposal ownership and state.
- Added a confirmed delete action to TODO Requirement details in the dashboard.

### Changed

- Kept RD prompt guidance focused on control-plane capabilities while leaving command names and arguments to the self-describing `code-factory-cli` help.

### Fixed

- Bounded GitHub CLI calls during pull-request reconciliation, isolated failures per PR, retried eligible failures, and recorded structured diagnostics without sensitive response content.

## [0.1.9] - 2026-09-19

### Added

- Rendered Requirement descriptions as GitHub Flavored Markdown, including tables, lists, links, and code blocks.

### Changed

- Combined every RD Run into one chronological, live-updating Session trace, while keeping Session board details trace-focused and other Requirement entry points conversation-focused.
- Opened Session traces at the latest event, kept following live updates while the viewport remains near the bottom, and added controls for jumping to the beginning or latest event.

## [0.1.8] - 2026-09-19

### Changed

- Added README badges for the license, published npm version, supported Node.js version, and strict TypeScript configuration.

### Fixed

- Opened Session board cards directly at the Agent trace while preserving conversation-focused behavior for other Requirement entry points.
- Rendered the complete Code Factory logo on GitHub and other SVG consumers that do not support its previous masking approach.

## [0.1.7] - 2026-09-19

### Added

- Added persistent, live-updating execution traces for Codex and Claude Code runs, with API, SSE, and dashboard access across historical Runs.
- Added GitHub-backed pull request registration and file-backed Requirement proposal descriptions to the Code Factory CLI.

### Changed

- Preserved Requirement context across resumed RD runs and clarified recovery, control-plane, and human-ownership guidance.
- Distinguished messages from related Requirements' RD agents with a separate dashboard avatar color.
- Removed Requirement composer input lag by isolating draft state and avoiding unnecessary conversation rendering.
- Normalized GitHub repository identities across casing variants and consolidated execution traces into ManagerEvent storage.
- Redesigned the Code Factory logo, dashboard header mark, favicon, and README branding.
- Added validation and timeouts to GitHub and Agent Manager calls made by the Code Factory CLI.

## [0.1.6] - 2026-09-18

### Added

- Added parent-child Requirement relationships, cross-Requirement agent messaging through the API and CLI, and a dashboard relationship tree.
- Added a conversation control for returning directly to the latest message.

### Changed

- Reduced dashboard synchronization latency with scoped reads and updates, and indexed Requirement parent lookups.

### Fixed

- Displayed persisted RD replies promptly and refreshed reply state without waiting for a full dashboard reload.
- Prevented new SSE connections from replaying stale event history.
- Preserved newer scoped dashboard and conversation updates when concurrent requests complete out of order.

## [0.1.5] - 2026-09-17

### Fixed

- Continued reconciling Draft pull requests so transitions to Open are persisted and delivered to their Requirements.
- Kept long timer descriptions and scheduling forms contained within timer dialogs without hiding cancellation controls.

## [0.1.4] - 2026-09-17

### Added

- Added configurable retention periods for cancelled and completed Requirements, with safe automatic cleanup of related records and retryable attachment deletion.
- Added timer detail views from both the Timer board and a Requirement's scheduled wake-up list.

### Changed

- Made Timer board cards and active scheduled wake-up rows more compact for faster scanning.

## [0.1.3] - 2026-09-16

### Added

- Added hybrid workspace search across requirements, conversation messages, and pull request metadata using SQLite full-text and vector indexes.
- Added persistent one-time and recurring Agent timers, with API, CLI, dashboard, restart recovery, and durable Requirement delivery support.

### Fixed

- Kept workspace search available when the local SQLite build does not include FTS5.

## [0.1.2] - 2026-09-15

### Added

- Allowed human replies to reactivate completed requirements in their original RD sessions.

### Changed

- Treated RD run timeouts as inactivity windows that renew while the agent produces output.
- Renamed the running RD action from Interrupt to Steering in the English and Simplified Chinese dashboard.
- Clarified how headless agents inherit their working directory, environment, instructions, skills, plugins, and provider-managed context.

### Fixed

- Made simultaneous daemon start commands safely replace stale supervisor metadata and converge on one owner instead of intermittently reporting an early-exit or workspace-conflict error.
- Reported daemon startup failures immediately instead of retrying deterministic failures until the startup command timed out.
- Collected optional instructions and attachments before starting a requirement's initial RD run.
- Preserved the reader's conversation position when new messages arrive, with shortcuts to new messages and requirement details.
- Limited GitHub reconciliation polling to registered pull requests whose persisted status is Open.

## [0.1.1] - 2026-09-15

### Added

- Added a persistent dashboard dark mode that follows the operating-system preference by default and includes an accessible theme toggle.
- Added confirmed deletion for TODO requirements through the dashboard and Agent Manager API.

### Changed

- Simplified the README quick start to the npm-based launch command and moved operation and local-development details into dedicated guides.
- Updated the dashboard header and favicon to use the latest Code Factory branding.
- Enforced a single Agent Manager instance per canonical workspace, including across foreground and daemon startup modes.
- Shortened the requirement completion action labels in English and Simplified Chinese.

### Fixed

- Kept dialog, sheet, requirement-detail, and composer actions reachable when content is long or the viewport is short.

## [0.1.0] - 2026-09-13

### Added

- Workspace-scoped Agent Manager with persistent RD sessions and durable SQLite state.
- Headless Codex and Claude Code runners, one-off AI review, and agent control-plane commands.
- GitHub pull-request reconciliation and independent status, comment, CI-failure, and conflict triggers.
- Bundled bilingual Web dashboard for requirements, pull requests, sessions, configuration, and conversations.
- Supervised daemon mode, structured rotating logs, attachments, and explicit run interruption.
- Semantic version synchronization, runtime version reporting, and tag-driven npm/GitHub release automation for `@luoyixin/code-factory`.
- Apache License 2.0 coverage for the repository and published npm package.

### Changed

- Updated the dashboard framework and Cloudflare toolchain to versions without known npm audit findings, and classified the Shadcn CLI as a development-only dependency.
