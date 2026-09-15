# Changelog

All notable changes to Code Factory are documented here. The project follows
[Semantic Versioning](https://semver.org/), with minor releases allowed to contain
breaking changes while the major version is `0`.

## [Unreleased]

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
