# Headless Agent Runner

## 1. Common execution contract

Agent Manager supports the local `codex` and `claude` CLIs. Every invocation follows these rules:

- `cwd` is always the directory where Agent Manager started;
- `shell: false`; commands are never assembled through a shell;
- RD and Reviewer task prompts are supplied through stdin so they do not appear in process arguments;
- the child inherits Agent Manager's environment, and each CLI loads its own authentication, configuration, repository instructions, Skills, plugins, and enabled local memory features according to its native rules;
- Agent Manager does not pass `--cd` or `--add-dir`; both CLIs run without interactive approval or CLI sandbox restrictions;
- stdout is parsed as JSONL, while stderr is retained as an error summary;
- RD Runs time out after 60 minutes without stdout or stderr activity by default, so an actively progressing Run may continue for longer than one hour. Reviewer Runs retain a total elapsed-time limit of at most 30 minutes. A timeout terminates the CLI and its complete tool-process tree;
- on POSIX systems, a human interrupt sends `SIGTERM` to the isolated process group and follows with `SIGKILL` after two seconds if descendants remain; Windows uses `taskkill /T /F`. The Run becomes `cancelled` only after the process tree exits;
- one RD AgentSession may have only one active Run, while Sessions for different Requirements may run concurrently;
- Human or Reviewer messages received during an RD Run are appended to the Requirement conversation without interrupting it. Only an explicit human interrupt stops the current Run, after which queued messages continue in the same native Session;
- Agent Manager puts a private `code-factory-cli` launcher on the RD process's `PATH` and injects its connection context through the environment; project instructions and Skills are still loaded natively from the working directory.
- Before changing code, RD Agents are instructed to create or reuse a Git worktree dedicated to the Requirement and leave pre-existing shared-workspace changes untouched. This is a behavioral instruction: every child process still starts in the Agent Manager workspace, and Agent Manager does not provision or enforce the worktree.
- each invocation may include an explicit model and reasoning effort (`low | medium | high | xhigh | max`); omitted values continue to use the CLI configuration.

### Context and memory boundaries

“Memory” has three distinct meanings in this architecture:

- **Requirement session context:** the first RD Run starts a new native Codex thread or Claude Code session. Agent Manager persists that native ID and resumes it for later Runs of the same Requirement, so the provider's conversation context carries forward.
- **CLI-discovered context:** every child starts in the managed workspace with the inherited environment. Codex can therefore discover its `AGENTS.md` chain, configured Skills, and enabled local memories; Claude Code can discover its `CLAUDE.md` hierarchy, Skills/plugins, and auto-memory. Exact discovery and injection remain controlled by the installed CLI and its configuration. Code Factory only appends its own behavioral instructions.
- **Launching-agent context:** a new RD session does not receive the live transcript, context window, or in-progress reasoning of an interactive agent that happened to start Agent Manager. Sessions belonging to other Requirements are also never merged into it. Provider-managed local memories may make selected information available when enabled, but that is not a copy of every previous conversation.

Reviewers always start as independent, short-lived invocations. They use the same native configuration discovery but do not resume the Requirement's RD session.

### Model discovery

Agent Manager maintains a provider-specific model catalog for the dashboard. It refreshes once at startup and every 24 hours thereafter. Codex models come from the authenticated local CLI's app-server `model/list` method, so the list reflects the launching user's available picker models. Claude models come from `GET /v1/models?limit=1000` for direct API-key access or when gateway discovery is enabled for a custom `ANTHROPIC_BASE_URL`. Gateway discovery mirrors Claude Code's request contract: `ANTHROPIC_AUTH_TOKEN` takes precedence as Bearer authentication, `ANTHROPIC_API_KEY` is the fallback `x-api-key`, and `ANTHROPIC_CUSTOM_HEADERS` entries are forwarded. Claude Code's rolling `best`, `sonnet`, `opus`, and `haiku` families, extended-context variants, `opusplan`, and environment-configured model IDs are used as safe fallbacks.

Discovery results are cached in memory. Provider failures retain the previous list and mark it stale instead of affecting Agent execution. The HTTP catalog continues to include the CLI-default choice separately, and the execution API remains compatible with explicit custom model strings supplied by non-dashboard clients.

### RD control-plane CLI

RD Agents use self-describing commands instead of constructing Agent API requests in their prompts:

```bash
code-factory-cli pr register --help
code-factory-cli requirement propose --help
code-factory-cli timer register --help
code-factory-cli timer show --help
code-factory-cli timer cancel --help
```

`pr register` registers a newly created PR or refreshes metadata changed by the RD Agent. `requirement propose` records separate follow-up work as a linked TODO Requirement. `requirement related` lists direct parent and child Requirements; `requirement message` coordinates with their RD Agents. `timer register` registers a one-time wake-up by default or a recurring one with `--repeat`; `timer show` recovers timer IDs and statuses for the current Requirement; `timer cancel` stops an active timer. The commands print the Agent API JSON response on stdout. Exit code `0` means success, `2` means invalid input or missing context, and `1` means an execution, network, HTTP, or response-format failure. Errors go to stderr. API requests and GitHub lookups time out after 30 seconds; writes are never automatically retried. A timeout or invalid response can occur after the server commits a write: inspect the Requirement before retrying, especially when proposing follow-up work.

Prefer registration from an explicit PR URL, using the authenticated local `gh` CLI:

```bash
code-factory-cli pr register --from-github https://github.com/OWNER/REPO/pull/123
code-factory-cli requirement propose --title 'Follow-up task' --description-file ./follow-up.md
```

`--from-github` reads the PR number, title, URL, branches, head SHA, and state from GitHub and validates the returned identity before registration. The repository key comes from the returned URL and is normalized to lowercase, matching Manager and Store identity checks. GitHub Enterprise URLs are supported and retain the hostname in the repository identifier. It cannot be mixed with manual metadata flags. The existing full manual registration form remains supported for callers that already have a snapshot; an existing PR's lifecycle is still owned by the reconciler, even when `--status` is supplied. The CLI does not create or edit GitHub PRs.

`--description-file` reads a UTF-8 file relative to the CLI's working directory and is mutually exclusive with `--description`. This avoids shell quoting problems for multiline descriptions. Proposed Requirements remain TODO until a human starts them.

The RD behavioral prompt is supplied on both initial and resumed invocations. It describes CLI capabilities and behavioral constraints, leaving command names and arguments to `code-factory-cli --help`. It covers Requirement scope, worktree isolation, recovery without duplicate actions, control-plane commands, lifecycle ownership, evaluating external feedback, and evidence-based handoff. Task-specific content stays in the stdin prompt; every invocation includes the current Requirement ID, title, and description, with only new external conversation messages on resume. Questions and investigations do not inherently require code changes, and the RD Agent must not substitute follow-up proposals for work required by the current Requirement. A successful GitHub PR creation and a successful Code Factory registration are separate outcomes; a failed registration must be reported without recreating the PR. Human confirmation owns Requirement completion.

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
  -c 'developer_instructions="...code-factory-cli behavior..."' \
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
  --append-system-prompt "...code-factory-cli behavior..." \
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

### Built-in Timer Trigger

The `timer` Agent Trigger executes Requirement-scoped one-time and recurring `AgentTimer` resources persisted in SQLite. A timer's first occurrence is `intervalSeconds` after creation; recurring timers continue at the same interval. Each occurrence appends one System message containing the timer ID, schedule, and required follow-up description. Recurring messages also tell the RD Agent how to cancel the timer when it is no longer needed. An idle or waiting RD Session resumes immediately, while an active Run leaves the message queued for the next Run.

Timers survive Agent Manager restarts. If the Manager was stopped across several recurring intervals, startup delivers only one due wake-up and advances directly to the next future occurrence instead of replaying a backlog. The occurrence's scheduled timestamp is part of its trigger-scoped idempotency key, so a crash between message persistence and timer advancement cannot duplicate the conversation message. Completing or cancelling a Requirement cancels its remaining active timers.

Humans manage timers from the clock control beside the Requirement chat composer or through the HTTP API. An RD Agent must track every long-running process or task it starts—including builds, tests, deployments, data jobs, and other background work—to completion. While the current Run remains active, it uses the provider's normal wait, task-output, or monitor mechanism. It registers a Code Factory timer before ending the Run only when the task is guaranteed to continue independently after the Run ends and the Session needs to wake later to inspect it. The Agent can use `code-factory-cli timer register --description DESCRIPTION --after-seconds SECONDS [--repeat]`, recover the timer ID and description later with `code-factory-cli timer show`, then cancel a recurring timer with `code-factory-cli timer cancel --id TIMER_ID` once it is no longer needed. Descriptions must contain 1 through 500 characters after trimming. Intervals must be whole seconds from 60 through 31536000.

### Built-in PR Triggers

By default, Agent Manager polls registered PRs whose last stored state is Draft or Open every 30 seconds through the authenticated local `gh` CLI. A poll can capture and persist a Draft-to-Open transition as well as transitions to Draft, Closed, or Merged; terminal PRs are then skipped on later polls. One fetched snapshot is shared by four independently registered triggers, so the split does not multiply GitHub requests:

- `github.pull-request.status` turns PR lifecycle changes into System messages;
- `github.pull-request.comment` turns general comments, reviews, and inline review comments into Reviewer messages that explicitly mark their bodies as untrusted external feedback;
- `github.pull-request.ci-failure` turns checks that newly enter a failed conclusion into System messages;
- `github.pull-request.conflict` turns a `CONFLICTING` GitHub mergeability result into a System message for each new head revision;
- messages for active Requirements use `deliverToRd=true`, reusing the existing conversation cursor to trigger or queue the next RD Run;
- SQLite observation state tracks previous CI state, while trigger-scoped receipts deduplicate comments, state changes, CI failures, and conflicts across restarts;
- the first observation of an existing PR establishes a baseline without replaying old comments or CI results, while still correcting stale PR state.

Set `pullRequestReconcileIntervalSeconds` in the workspace configuration or dashboard to change the interval dynamically; `0` disables polling. The compatible `--pr-reconcile-interval SECONDS` launch override is also available. Reconciliation requires the launching user to be authenticated with `gh auth login`.

## 6. Recovery and failure

- A native session ID is stored as soon as the CLI reports it.
- After a successful Run, Agent Manager advances only the input message boundary captured by that Run. If external messages remain, it starts another Run; otherwise the Requirement enters `waiting_confirmation` and the Session enters `waiting_human`.
- A failed Run, including an RD Run that produces no output for 60 minutes, leaves the Requirement in `doing` and moves the Session to `failed`.
- A human-interrupted Run leaves the Requirement in `doing` and returns the Session to `waiting_human`. If corrective messages arrived after the Run started, Agent Manager immediately resumes the same Session.
- A human retry or reply continues the same AgentSession. Agent Manager resumes an existing native session ID or creates a new native session if none exists.
- On restart, Agent Manager never treats an old PID as a live process. Startup reconciliation marks orphaned RD Runs as failed and separately cleans up orphaned ReviewRequests without changing RD Session state.
- With `start --daemon`, a detached workspace-scoped supervisor restarts an unexpectedly exited Agent Manager. Repeated early failures use exponential backoff from 1 to 30 seconds to avoid a busy crash loop. `stop` is intentional and does not trigger another restart.
- Every Agent Manager holds one exclusive lock for its canonical workspace. Foreground and daemon starts therefore reject a second Manager for that workspace regardless of its port, configuration file, or database path; process exit automatically releases the operating-system-backed lock.

## 7. Security boundary

Run Agent Manager only inside trusted workspaces. Every headless RD and Reviewer skips CLI approvals and sandbox checks, inheriting the launching user's filesystem, network, and command-execution permissions. The startup banner and log record this warning. Reviewer read-only behavior is enforced by instructions, not by an operating-system boundary.

HTTP listens on `127.0.0.1` by default and permits the local dashboard origin `http://localhost:3000`. Change `host` or `allowedOrigin` in the workspace configuration (or use the compatible CLI overrides) and restart to apply it. API clients cannot choose the child process working directory. Production hardening still requires a local access token, webhook signature validation, sensitive-field redaction, and a log-retention policy.

## 8. Runtime logs

Agent Manager appends JSONL lifecycle logs for the manager, Requirements, Runs, PR reconciliation, and HTTP requests to `~/.code-factory/workspaces/<workspace-hash>/logs/agent-manager.log`. In foreground mode, the CLI prints one startup banner containing the Workspace, configuration, Database, log path, Dashboard URL, API URL, and Reconciler interval; it otherwise emits no runtime logs to stdout or stderr. The default level is `info`. Configure it in `config.json`, with the logging environment variables, or with CLI flags; later sources in that list take precedence. Log-level updates through the API apply immediately. Log destination and rotation changes apply after restart. Log files use mode `0600`.

Daemon mode redirects the Manager startup banner and process-level errors to `logs/daemon.log`, alongside supervisor start, exit, and restart events. `daemon.json` contains the current supervisor/Manager PIDs, readiness state, restart count, and start options used by `restart`; both files use mode `0600`. Run `status` from the same workspace to inspect the live state.

Logging uses `winston` and `winston-daily-rotate-file`. Files rotate by local date and after reaching 20 MB, with 14 days retained by default. `agent-manager.log` is a stable symlink to the current file. Set `logMaxSize` and `logMaxFiles` in the workspace configuration; the existing environment variables and CLI flags remain launch-time overrides.

Logs contain only IDs, states, durations, and errors needed for diagnostics. They do not contain prompts, conversation bodies, or raw Agent stdout. Library users may inject a custom `Logger` to own the destination and policy.
