# Headless Agent Runner

## 1. Common execution contract

Agent Manager supports the local `codex` and `claude` CLIs. Every invocation follows these rules:

- `cwd` is always the directory where Agent Manager started;
- `shell: false`; commands are never assembled through a shell;
- RD and Reviewer task prompts are supplied through stdin so they do not appear in process arguments;
- the child inherits the current environment, and each CLI loads its own authentication, configuration, repository instructions, and Skills;
- Agent Manager does not pass `--cd` or `--add-dir`; both CLIs run without interactive approval or CLI sandbox restrictions;
- stdout is parsed as JSONL, while stderr is retained as an error summary;
- RD Runs time out after 60 minutes by default and Reviewer Runs after at most 30 minutes; a timeout terminates the CLI and its complete tool-process tree;
- on POSIX systems, a human interrupt sends `SIGTERM` to the isolated process group and follows with `SIGKILL` after two seconds if descendants remain; Windows uses `taskkill /T /F`. The Run becomes `cancelled` only after the process tree exits;
- one RD AgentSession may have only one active Run, while Sessions for different Requirements may run concurrently;
- Human or Reviewer messages received during an RD Run are appended to the Requirement conversation without interrupting it. Only an explicit human interrupt stops the current Run, after which queued messages continue in the same native Session;
- Agent Manager puts a private `code-factory-cli` launcher on the RD process's `PATH` and injects its connection context through the environment; project instructions and Skills are still loaded natively from the working directory.
- Before changing code, RD Agents are instructed to create or reuse a Git worktree dedicated to the Requirement and leave pre-existing shared-workspace changes untouched. This is a behavioral instruction: every child process still starts in the Agent Manager workspace, and Agent Manager does not provision or enforce the worktree.
- each invocation may include an explicit model and reasoning effort (`low | medium | high | xhigh | max`); omitted values continue to use the CLI configuration.

### RD control-plane CLI

RD Agents use two self-describing commands instead of constructing Agent API requests in their prompts:

```bash
code-factory-cli pr register --help
code-factory-cli requirement propose --help
```

`pr register` registers a newly created PR or refreshes metadata changed by the RD Agent. `requirement propose` records separate follow-up work as a linked TODO Requirement. Both commands print the Agent API JSON response and return nonzero exit codes for invalid input, missing context, network failures, or HTTP errors.

Agent Manager injects `CODE_FACTORY_API_URL`, `CODE_FACTORY_REQUIREMENT_ID`, and `CODE_FACTORY_SESSION_ID` for each RD Run. The CLI supplies those context fields to the HTTP API, so the model does not copy IDs or endpoint paths from its prompt. A workspace-private launcher is created next to the workspace database and prepended to `PATH`, which also supports the documented `node .../dist/cli.js start` development workflow.

## 2. Codex

Start a native RD session:

```bash
codex exec --json --color never --dangerously-bypass-approvals-and-sandbox \
  --model <model> -c 'model_reasoning_effort="high"' \
  -c 'developer_instructions="...code-factory-cli behavior..."' -
```

Resume a native RD session:

```bash
codex exec --json --color never --dangerously-bypass-approvals-and-sandbox \
  --model <model> -c 'model_reasoning_effort="high"' \
  resume <thread-id> -
```

Run a short-lived Reviewer:

```bash
codex exec --json --color never --ephemeral \
  --dangerously-bypass-approvals-and-sandbox \
  --model <model> -c 'model_reasoning_effort="high"' \
  -c 'developer_instructions="...GitHub review contract..."' -
```

The `thread_id` from a `thread.started` event is stored on the AgentSession and reused by later RD Runs. Reviewers use `--ephemeral` and do not create resumable business Sessions.

Code Factory instructions are appended through Codex's supported `developer_instructions` override and do not replace repository `AGENTS.md` files. A Reviewer does not use the local-working-tree-oriented `codex exec review --base` command. It runs as an ordinary headless Agent and receives `Review GitHub PR <url>` through stdin.

## 3. Claude Code

Start a native RD session:

```bash
claude --print --output-format stream-json --verbose \
  --dangerously-skip-permissions --session-id <uuid> \
  --model <model> --effort high \
  --append-system-prompt "...code-factory-cli behavior..."
```

Resume a native RD session:

```bash
claude --print --output-format stream-json --verbose \
  --dangerously-skip-permissions --model <model> --effort high \
  --resume <session-id>
```

Run a short-lived Reviewer:

```bash
claude --print --output-format stream-json --verbose \
  --no-session-persistence --dangerously-skip-permissions \
  --model <model> --effort high
```

Claude Reviewers also run as ordinary headless Agents instead of invoking `/review`. They receive `Review GitHub PR <url>` through stdin. `--no-session-persistence` prevents them from becoming long-lived Sessions.

The model and reasoning flags shown above are optional. RD choices are stored on the Requirement and applied again when its native Session resumes. Reviewer choices are stored on both the ReviewRequest and AgentRun so each review can use a different configuration.

Codex and Claude Code share the same Reviewer system/developer instructions: inspect the target PR through the GitHub CLI/API, record the head SHA at the start and verify it again before publishing, publish GitHub review comments, and do not modify the shared workspace. Agent Manager still captures `ReviewRequest.targetHeadSha` internally when the review is requested; it does not need to appear in the task prompt.

## 4. Event normalization

Adapters map each CLI's JSONL output into:

- `session_started`: captures the native session ID;
- `message`: Agent text output;
- `completed`: the model turn completed;
- `error`: a structured error;
- `other`: retains an unknown event for forward compatibility.

Agent Manager depends only on normalized fields. Raw events may be exposed as a diagnostic stream. Human messages and normalized Agent or Reviewer messages are persisted in the Requirement conversation and broadcast through `message.created`. Raw JSONL and tool noise are not stored in the database.

## 5. Agent Triggers

`AgentTrigger` is the extension boundary for external systems that should continue an RD session. A trigger owns source-specific polling or listening and emits an `AgentTriggerMessage` containing a target Requirement, an idempotency key, an author, a body, and optional event metadata. Register it with `AgentManager.startAgentTrigger()` and release it with `stopAgentTrigger()`.

Agent Manager deliberately owns the rest of the delivery path: it scopes durable receipts by trigger ID, appends each accepted message to the Requirement conversation, publishes `message.created`, and starts or queues the target RD session. A stopped trigger's delivery context no longer accepts messages. This keeps future integrations such as a Slack-thread listener out of session and persistence internals.

### Built-in PR Trigger

By default, Agent Manager polls Draft and Open PRs every 30 seconds through the authenticated local `gh` CLI. Each poll reads PR state, head SHA, general comments, reviews, inline review comments, and CI checks:

- PR state changes and CI failures become System messages;
- PR and review comments become Reviewer messages and are explicitly marked as untrusted external feedback;
- messages for active Requirements use `deliverToRd=true`, reusing the existing conversation cursor to trigger or queue the next RD Run;
- SQLite observation state tracks previous CI state, while Agent Trigger receipts deduplicate comments, state changes, and CI events across restarts;
- the first observation of an existing PR establishes a baseline without replaying old comments or CI results, while still correcting stale PR state.

Use `--pr-reconcile-interval SECONDS` to change the interval or `0` to disable polling. Reconciliation requires the launching user to be authenticated with `gh auth login`.

## 6. Recovery and failure

- A native session ID is stored as soon as the CLI reports it.
- After a successful Run, Agent Manager advances only the input message boundary captured by that Run. If external messages remain, it starts another Run; otherwise the Requirement enters `waiting_confirmation` and the Session enters `waiting_human`.
- A failed or timed-out Run leaves the Requirement in `doing` and moves the Session to `failed`.
- A human-interrupted Run leaves the Requirement in `doing` and returns the Session to `waiting_human`. If corrective messages arrived after the Run started, Agent Manager immediately resumes the same Session.
- A human retry or reply continues the same AgentSession. Agent Manager resumes an existing native session ID or creates a new native session if none exists.
- On restart, Agent Manager never treats an old PID as a live process. Startup reconciliation marks orphaned RD Runs as failed and separately cleans up orphaned ReviewRequests without changing RD Session state.

## 7. Security boundary

Run Agent Manager only inside trusted workspaces. Every headless RD and Reviewer skips CLI approvals and sandbox checks, inheriting the launching user's filesystem, network, and command-execution permissions. The startup banner and log record this warning. Reviewer read-only behavior is enforced by instructions, not by an operating-system boundary.

HTTP listens on `127.0.0.1` by default and permits the local dashboard origin `http://localhost:3000`. Use `--allow-origin` to override it. API clients cannot choose the child process working directory. Production hardening still requires a local access token, webhook signature validation, sensitive-field redaction, and a log-retention policy.

## 8. Runtime logs

Agent Manager appends JSONL lifecycle logs for the manager, Requirements, Runs, PR reconciliation, and HTTP requests to `~/.code-factory/workspaces/<workspace-hash>/logs/agent-manager.log`. The CLI always prints one startup banner containing the Workspace, Database, log path, Dashboard URL, API URL, and Reconciler interval; it otherwise emits no runtime logs to stdout or stderr. The default level is `info`. Configure it with `--log-level debug|info|warn|error|silent` or `CODE_FACTORY_LOG_LEVEL`, and configure the destination with `--log-file PATH` or `CODE_FACTORY_LOG_FILE`. Command-line values take precedence. Log files use mode `0600`.

Logging uses `winston` and `winston-daily-rotate-file`. Files rotate by local date and after reaching 20 MB, with 14 days retained by default. `agent-manager.log` is a stable symlink to the current file. Use `--log-max-size SIZE` or `CODE_FACTORY_LOG_MAX_SIZE` to change the per-file limit, and `--log-max-files COUNT_OR_DAYS` or `CODE_FACTORY_LOG_MAX_FILES` to change retention.

Logs contain only IDs, states, durations, and errors needed for diagnostics. They do not contain prompts, conversation bodies, or raw Agent stdout. Library users may inject a custom `Logger` to own the destination and policy.
