# Running Code Factory

This guide covers prerequisites, npm-based startup, daemon operation, configuration, CLI options, and workspace data. For source installation and local development workflows, see the [Development guide](development.md).

## Prerequisites

- Node.js 22.13 or newer;
- at least one installed and authenticated Agent CLI: `codex` or `claude`;
- GitHub CLI (`gh`) installed and authenticated for pull-request reconciliation and review workflows.

## Start from npm

Run Code Factory from the repository that its agents should manage:

~~~bash
cd /path/to/the/repository/to-manage
npx --package @luoyixin/code-factory code-factory-agent-manager start --daemon
~~~

The startup directory becomes the managed workspace and the initial working directory for every RD and Reviewer agent. The dashboard listens on [http://127.0.0.1:4310](http://127.0.0.1:4310) by default.

Code Factory allows only one Agent Manager process for the same canonical workspace. A second foreground start, or a foreground/daemon mixed start, fails with an `already running for workspace` error even if it uses a different port, configuration file, or database path. Repeating `start --daemon` is idempotent: it reports the existing daemon instead of launching another one. The workspace lock is released automatically when the owning process exits, including after a crash.

On first start, Agent Manager creates a workspace-scoped configuration file at `~/.code-factory/workspaces/<workspace-hash>/config.json`. The dashboard settings dialog can edit it. PR reconciliation intervals, terminal Requirement retention periods, and log levels are applied immediately; network, storage, browser, and log-rotation changes are saved for the next restart.

## Network and port

Use `--port` followed by an integer from `1` to `65535`:

~~~bash
npx --yes --package @luoyixin/code-factory code-factory-agent-manager start --port 8080
~~~

To listen on every network interface, specify the host as well:

~~~bash
npx --yes --package @luoyixin/code-factory code-factory-agent-manager start \
  --host 0.0.0.0 \
  --port 8080
~~~

Listening on `0.0.0.0` makes the dashboard reachable from other machines. Only do this on a trusted network: headless agents run with the permissions of the user who started Agent Manager.

## Supervised daemon

Add `--daemon` to detach Agent Manager from the terminal and keep it running under a lightweight supervisor:

~~~bash
cd /path/to/your-project
npx --yes --package @luoyixin/code-factory code-factory-agent-manager start --daemon --open
~~~

The start command returns only after the HTTP service is ready. Errors encountered before readiness, such as an occupied port or invalid configuration, are returned directly to the starting command and do not enter a restart loop. If a running Agent Manager process exits unexpectedly, the supervisor restarts it automatically with exponential backoff from 1 to 30 seconds. Run lifecycle commands from the same managed workspace:

~~~bash
npx --yes --package @luoyixin/code-factory code-factory-agent-manager status
npx --yes --package @luoyixin/code-factory code-factory-agent-manager restart
npx --yes --package @luoyixin/code-factory code-factory-agent-manager stop
~~~

When the daemon is running, `restart` reuses its start options unless new options are supplied. `status` exits with code `0` while the supervisor is live and `3` otherwise. The equivalent `daemon start|status|restart|stop` command form is also supported. This supervisor provides background execution and process recovery; it does not install an operating-system service or start automatically after a machine reboot.

## Common examples

~~~bash
# Reconcile tracked pull requests every 10 seconds
npx --yes --package @luoyixin/code-factory code-factory-agent-manager start \
  --pr-reconcile-interval 10

# Disable pull-request polling
npx --yes --package @luoyixin/code-factory code-factory-agent-manager start \
  --pr-reconcile-interval 0

# Use a custom database and debug logging
npx --yes --package @luoyixin/code-factory code-factory-agent-manager start \
  --db /path/to/factory.sqlite \
  --log-level debug
~~~

## CLI options

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
| `-v`, `--version` | — | Print the installed Code Factory version and exit. |

Configuration-file values are used by default. Logging environment variables take precedence over the file, and command-line options take precedence over both. Launch-only overrides are never copied into the writable file by later dashboard changes. Relative database and log paths are resolved from the managed workspace.

~~~json
{
  "host": "127.0.0.1",
  "port": 4310,
  "allowedOrigin": "http://localhost:3000",
  "openDashboard": false,
  "databasePath": null,
  "pullRequestReconcileIntervalSeconds": 30,
  "cancelledRequirementRetentionDays": 7,
  "doneRequirementRetentionDays": 365,
  "logLevel": "info",
  "logFilePath": null,
  "logMaxSize": "20m",
  "logMaxFiles": "14d"
}
~~~

`databasePath` and `logFilePath` use workspace defaults when set to `null`; `allowedOrigin: null` disables CORS headers. Set `pullRequestReconcileIntervalSeconds` to `0` to disable GitHub polling. Its largest accepted value is `2147483` seconds, matching Node.js timer limits. `cancelledRequirementRetentionDays` and `doneRequirementRetentionDays` accept whole numbers from `0` to `36500`; `0` deletes matching Requirements as they become terminal. Agent Manager also scans at startup, after either setting changes, and daily thereafter. Requirements with a running RD or Reviewer Run are deferred; a zero-day purge is retried as soon as that Run finishes. Expiry removes the Requirement and all related domain records in one SQLite transaction while recording attachment-file deletion tombstones; unsuccessful file deletions are retried on later scans.

## Workspace data and logs

Workspace data is stored outside the managed repository by default:

~~~text
~/.code-factory/workspaces/<workspace-hash>/config.json
~/.code-factory/workspaces/<workspace-hash>/factory.sqlite
~/.code-factory/workspaces/<workspace-hash>/attachments/
~/.code-factory/workspaces/<workspace-hash>/logs/agent-manager.log
~/.code-factory/workspaces/<workspace-hash>/logs/daemon.log
~/.code-factory/workspaces/<workspace-hash>/daemon.json
~/.code-factory/workspaces/<workspace-hash>/agent-manager.lock
~/.code-factory/workspaces/<workspace-hash>/daemon.guard.sqlite
~~~

The foreground CLI prints a startup banner containing the workspace, configuration, database, log path, dashboard URL, API URL, and PR reconciliation interval. Daemon commands print supervisor and manager PIDs plus the daemon log path. Operational logs are structured JSONL and omit prompts, conversation bodies, and raw Agent output. Daemon state and log files use mode `0600`.

The daemon log is append-only diagnostic history: its presence does not mean that a daemon is running and never blocks a later start. `daemon.lock` is also only PID metadata, so a stale copy does not block startup. Live-process detection uses `daemon.json` together with the recorded supervisor PID; an operating-system-released SQLite lock in `daemon.guard.sqlite` serializes supervisor ownership and is safe to leave on disk.

Follow the active logs with:

~~~bash
tail -f ~/.code-factory/workspaces/<workspace-hash>/logs/agent-manager.log
tail -f ~/.code-factory/workspaces/<workspace-hash>/logs/daemon.log
~~~

Logging can also be configured with `CODE_FACTORY_LOG_LEVEL`, `CODE_FACTORY_LOG_FILE`, `CODE_FACTORY_LOG_MAX_SIZE`, and `CODE_FACTORY_LOG_MAX_FILES`. Command-line options take precedence over their environment-variable equivalents, which take precedence over configuration-file values.
