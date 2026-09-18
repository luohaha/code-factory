# Code Factory — Final Architecture

Additional references: [HTTP and event protocol](protocol.md) · [Agent Manager HTTP API](agent-manager-api.md)

## 1. Domain Model

The system has three first-class domain entities:

- `Requirement`: a Jira-like issue that owns business state and the complete conversation;
- `AgentSession`: the long-lived RD session uniquely bound to a Requirement;
- `PullRequest`: a GitHub pull request produced by a Requirement. One Requirement may have multiple PRs.

`AgentRun`, `AgentTraceEvent`, `RequirementMessage`, `ReviewRequest`, and `AgentTimer` are execution and interaction records. They are not long-lived agents that require allocation from a pool.

~~~mermaid
erDiagram
  Requirement ||--|| AgentSession : owns
  Requirement ||--o{ RequirementMessage : contains
  Requirement ||--o{ PullRequest : produces
  Requirement ||--o{ AgentTimer : schedules
  AgentSession ||--o{ AgentRun : resumes
  PullRequest ||--o{ ReviewRequest : receives
  ReviewRequest ||--|| AgentRun : executes
~~~

Agent Manager is not an agent scheduler. There is no agent pool and no “waiting for scheduling” state. An RD AgentSession is created and permanently bound when its Requirement is created. Agent Timers are persisted configurations executed by the built-in `timer` Agent Trigger; they add a conversation message to an already bound Session and do not allocate Agents or queue execution capacity.

## 2. Runtime Boundary

~~~mermaid
flowchart LR
  H[Human] -->|Create requirement / Send message / Request review| M[Agent Manager]
  W[Web dashboard] <-->|HTTP + SSE| M
  S[Optional daemon supervisor] -->|Start / restart| M
  M <--> DB[(SQLite)]
  M -->|Same cwd, long-lived resume| RD[Codex / Claude Code RD]
  M -->|Short-lived, no persistent session| RV[Codex / Claude Code Reviewer]
  RD -->|Register PR / Propose requirement / Schedule wake-up| CLI[code-factory-cli]
  CLI --> API[Agent API]
  API --> M
  RV -->|GitHub inline comments| GH[GitHub PR]
  GH -->|Poll status, comments, reviews, CI, conflicts| T[PR Agent Triggers]
  DB -->|Due timers| ST[Timer Agent Trigger]
  ST -->|System message: timer ID + description| M
  T -->|Normalized messages| M
  RV -->|Reviewer message| M
~~~

At startup, Agent Manager fixes the workspace to `realpath(process.cwd())`. Every RD and Reviewer child process uses that directory and inherits Agent Manager's environment. Codex and Claude Code load their provider-specific project/user instructions, Skills, plugins, configuration, and enabled local memory features according to their native discovery rules.

Before opening its application database or HTTP listener, Agent Manager takes an exclusive process-lifetime lock under the canonical workspace's default data directory. Foreground and daemon-managed processes use the same lock, so a second Manager cannot bypass workspace ownership by selecting a different port, configuration file, or database. A live daemon supervisor also reserves the workspace between Manager restart attempts. The operating system releases the underlying SQLite lock if the Manager process crashes.

Agent Manager's own settings are workspace-scoped in `~/.code-factory/workspaces/<workspace-hash>/config.json` by default. The CLI loads this file before constructing storage, logging, HTTP, and trigger services. Existing command-line flags remain process-local overrides, and `--config PATH` selects another file. File-backed desired values and effective startup values are kept separate so a later API update cannot persist unrelated CLI arguments, environment values, or resolved paths. The API and dashboard can atomically update the file. PR reconciliation intervals, terminal Requirement retention periods, and log levels are reconfigured in the running process; HTTP binding, CORS, storage paths, startup browser behavior, and log rotation are marked as requiring a restart.

Agent Manager also owns an in-memory provider model catalog. It refreshes at startup and every 24 hours, using Codex's local app-server `model/list` method and Claude's `/v1/models` endpoint when API or gateway credentials are available. Claude Code rolling aliases and environment-configured model overrides remain available when remote discovery cannot run. A failed refresh retains the last successful provider list and marks it stale; model discovery never prevents the Manager from starting or running existing Sessions.

Agent Manager adds only Code Factory behavioral instructions that describe the available `code-factory-cli` capabilities. It places a private CLI launcher on the RD process's `PATH` and injects `CODE_FACTORY_API_URL`, `CODE_FACTORY_REQUIREMENT_ID`, and `CODE_FACTORY_SESSION_ID`; command names and arguments remain in CLI help and HTTP paths and payload schemas stay inside the CLI. The same behavioral instructions apply on initial and resumed runs; the stdin task prompt includes the current Requirement ID, title, description, and new external messages. Recovery guidance requires inspecting existing work before repeating actions. The CLI can read PR metadata from an explicit GitHub URL through `gh`, keeping the model from reconstructing a snapshot by hand; registration still cannot advance an existing PR lifecycle. Repository identity is case-insensitive and writes store lowercase keys. A legacy mixed-case key is normalized in place on update without replacing its PR ID; ambiguous pre-existing duplicates are rejected for explicit repair. API calls are bounded by a timeout and mutations are never automatically retried because a lost response can leave the write outcome unknown. It does not copy or replace provider-managed instructions, Skills, plugins, or local memories.

Context is isolated by Requirement. The first RD Run starts a new native Codex thread or Claude Code session, and later Runs resume only that Requirement's stored native ID. This preserves the Requirement's own native conversation across Runs without copying the live transcript, context window, or in-progress reasoning of the interactive agent or terminal that launched Agent Manager. It also never merges native conversation context from another Requirement. Any cross-session local memory remains an optional provider feature governed by the installed CLI and its configuration; Code Factory neither serializes it nor guarantees that every memory entry is injected.

For example:

~~~bash
cd ~/starrocks
npx --package @luoyixin/code-factory code-factory-agent-manager start
~~~

All agents launched by that process initially use `~/starrocks` as their working directory. Before changing code, an RD Agent is instructed to create or reuse a Git worktree dedicated to its Requirement and perform the work there. Agent Manager does not currently provision or enforce that isolation.

Agent Manager may run in the foreground or beneath its workspace-scoped daemon supervisor. `start --daemon` detaches the supervisor, which starts Agent Manager with the original CLI options and waits for a readiness message emitted only after the HTTP listener is active. A startup error emitted before readiness is persisted in daemon state and returned directly to the starting CLI instead of being retried. An unexpected exit after readiness is restarted indefinitely with capped exponential backoff. `stop` terminates the supervisor and Manager intentionally, while `restart` reuses a running daemon's stored options unless replacements are supplied. `daemon.json`, `daemon.lock`, `daemon.guard.sqlite`, and `logs/daemon.log` live beside the workspace database under `~/.code-factory/workspaces/<workspace-hash>/`. The persistent SQLite guard provides process-lifetime supervisor ownership; only its current owner may replace or remove the PID metadata and daemon state. This is application-level process supervision, not operating-system service installation or boot-time activation.

Every headless RD and Reviewer invocation skips interactive approval and CLI sandbox checks. It therefore inherits the launching user's full filesystem, network, and command-execution permissions. Agent Manager must only be started in a trusted workspace. Reviewers remain behaviorally read-only through their task instructions; this is not an operating-system security boundary.

## 3. Entities

### Requirement

- `status`: `todo | doing | waiting_confirmation | done | cancelled`;
- `provider`: `codex | claude-code`;
- optional `model` and `reasoningEffort` pin the CLI configuration for every RD Run in the Session;
- `createdBy`: `human | rd_agent`;
- an agent-proposed Requirement records `parentRequirementId` and `sourceSessionId`;
- an agent proposal is created as TODO and does not start automatically, preventing uncontrolled recursive work.
- the proposing Requirement and its direct child can discover each other and exchange explicit, durable RD messages without sharing native agent-session context.

### AgentSession

- Has a strict one-to-one relationship with Requirement;
- stores the native Codex thread ID or Claude session ID;
- `state`: `idle | running | waiting_human | failed | completed`;
- `lastConsumedMessageSequence` is the conversation boundary successfully consumed by the RD Agent;
- `pendingMessageCount` is the number of external messages not yet consumed.

### PullRequest

- Has an N:1 relationship with Requirement;
- uses `repository + number` as its GitHub identity;
- stores URL, title, base branch, head branch, and head SHA;
- follows GitHub-compatible states: `draft | open | closed | merged`.

### ReviewRequest

- Can only be created manually by a human for an Open PR;
- records the selected provider and optional model and reasoning effort for the one-off Reviewer Run;
- requires the human to select `codex` or `claude-code`;
- captures an immutable `targetHeadSha` when the request starts;
- owns one short-lived Reviewer AgentRun and never creates an AgentSession;
- allows at most one active ReviewRequest per PR.

### AgentTimer

- belongs to one Requirement, carries a required follow-up description, and uses `once | recurring` as its schedule pattern;
- stores a whole-second interval from 60 through 31536000, the next occurrence, and the last fired timestamp;
- follows `active | completed | cancelled`; a one-time occurrence completes automatically, while a recurring occurrence advances to its next future time;
- survives Agent Manager restarts and is cancelled automatically when its Requirement becomes DONE or CANCELLED.

## 4. The Requirement Conversation Is the RD Message Stream

The system does not maintain a separate RD message-queue table. `requirement_messages` is the single source of truth for both display and delivery:

| Author | Visible in the Requirement conversation | Delivered to RD |
| --- | --- | --- |
| Human | Yes | Yes |
| Reviewer | Yes | Yes |
| RD Agent | Yes | No for its own output; yes when explicitly sent from a directly related Requirement |
| System | Yes | Depends on the event |

Each message has a monotonically increasing `sequence` and a `deliverToRd` flag. When an RD Run starts, it captures the pending external-message range as `inputFromSequence..inputToSequence`:

1. If the Session is already running, new messages are only appended and never interrupt it; a human may then explicitly click **Interrupt**.
2. After a successful Run, the consumption cursor advances only to the `inputToSequence` captured when that Run started.
3. If external messages remain, Agent Manager automatically resumes the same RD Session.
4. Multiple messages are delivered together in order during the next Run.
5. A failed or interrupted Run does not advance the cursor, so retrying or corrective resumption cannot lose messages. Only messages arriving after the interrupted Run started trigger its automatic replacement.
6. A Requirement's own RD output is never delivered back to that RD Agent as normal next-turn input. An explicit message from a directly related Requirement is external input and is delivered to the target RD Agent.
7. A human reply or related-Agent message to a DONE Requirement reactivates it as DOING, clears its completion timestamp, and starts a new Run in the same long-lived RD Session. CANCELLED Requirements remain terminal.

Only when the native session is lost and must be recovered may Agent Manager rebuild context from a compact conversation summary. Normal execution never replays all previous RD output.

## 5. Review Loop

~~~text
Open PR
  → A human selects a Reviewer Agent and clicks Request review
  → Agent Manager sends `Review GitHub PR <url>` to the Reviewer
  → Reviewer inspects the target PR through the shared prompt contract
  → Reviewer publishes inline comments through the GitHub CLI/API
  → Reviewer summary is appended to the associated Requirement conversation
  → The message is marked deliverToRd=true
  → An idle RD resumes immediately; a running RD resumes after its current Run
~~~

Codex and Claude Code Reviewers both run as ordinary short-lived headless agents; neither invokes a native review command or skill that targets the local working tree. A Reviewer does not change Requirement or RD AgentSession state and does not need to run serially with RD. It must read the specified PR through the GitHub API without checking out or modifying the shared working directory. Agent Manager still records the trigger-time revision internally as `ReviewRequest.targetHeadSha`.

If the PR head SHA changes, previous reviews remain historical results for the old revision. A human must request another review for the new revision.

### Agent Triggers

`AgentTrigger` is the narrow integration boundary between external event sources and RD sessions. Each trigger owns source-specific polling or listening and emits normalized messages with a target Requirement and a trigger-scoped idempotency key. Agent Manager owns durable deduplication, conversation persistence, event publication, and the decision to start an idle RD session or queue input for a running one.

Trigger lifecycle is explicit through `startAgentTrigger()` and `stopAgentTrigger()`. Once stopped, a trigger's delivery context is invalidated. Receipts refer to Requirements rather than Pull Requests, so a future trigger such as a Slack-thread listener does not need GitHub-shaped persistence.

### Timer Trigger

`timer` is a built-in persistent Agent Trigger. Humans create `AgentTimer` resources from the Requirement chat composer or HTTP API. An RD Agent tracks every long-running process or task it starts to completion, using the provider's normal wait, task-output, or monitor mechanism while the current Run remains active. It uses `code-factory-cli timer register --description DESCRIPTION` before ending the Run only when the task is guaranteed to continue independently after the Run ends and the Session needs to wake later to inspect it. Every due occurrence delivers exactly one System message with the timer ID, schedule, and description through the normal Requirement message stream. Recurring messages also include the command needed to cancel the timer. The existing delivery rules then resume an idle Session or queue the message behind its active Run.

Each occurrence is deduplicated by the timer ID plus its scheduled timestamp. Delivery happens before the stored timer advances, so a process exit in between is retried safely after restart. A delayed recurring timer produces one wake-up and advances directly to its next future occurrence rather than replaying every missed interval. `timer show` lets the RD Agent recover the IDs, descriptions, and statuses of timers scoped to its Requirement. `timer cancel` and the dashboard stop an active timer; Requirement completion or cancellation stops all remaining timers automatically.

### PR Reconciliation Triggers

Agent Manager polls through the authenticated local `gh` CLI every 30 seconds by default. Poll eligibility comes from Code Factory's last persisted PR state: registered Draft and Open PRs are polled, while Closed and Merged PRs are skipped. This allows a snapshot to discover and persist a Draft-to-Open transition as well as transitions to Draft, Closed, or Merged. After a terminal transition, the PR is excluded from subsequent polls and later state, comment, review, or check changes are not observed.

For each eligible PR, the GitHub client runs `gh pr view` for lifecycle, metadata, comments, reviews, checks, and mergeability, plus a paginated `gh api` request for inline review comments. The reconciler combines those results into one snapshot and shares it with four independently registered triggers:

- `github.pull-request.status` observes Draft/Open/Closed/Merged lifecycle changes;
- `github.pull-request.comment` observes general PR comments, submitted reviews, and inline review comments;
- `github.pull-request.ci-failure` observes CI checks that newly enter a failed, errored, cancelled, timed-out, or action-required conclusion;
- `github.pull-request.conflict` observes GitHub mergeability and reports each conflicting head revision once.

New review activity is appended as a Reviewer message. PR status changes, CI failures, and merge conflicts are appended as System messages. All are marked for RD delivery while the Requirement is active: an idle RD session resumes immediately, while a running session consumes them in order after its current Run. DONE or CANCELLED Requirements retain the messages for visibility without being reopened.

Observation baselines and trigger-scoped receipts are persisted in SQLite. This prevents duplicate delivery across polling cycles and Agent Manager restarts. Legacy receipts from the former combined `github.pull-request` trigger are copied into the matching split trigger scope during migration. When an older PR is first adopted, existing comments and CI results form the baseline instead of being replayed, while a stale stored PR status is corrected immediately. A conflict is keyed by head SHA, so an unchanged conflict does not repeat while a newly pushed conflicting revision can wake RD again. `pullRequestReconcileIntervalSeconds` changes the interval dynamically; `0` disables polling. The compatible `--pr-reconcile-interval SECONDS` option overrides the file for the launched process only.

GitHub and the PR reconciler exclusively advance PR lifecycle state. The RD Agent uses `code-factory-cli pr register` after creating a PR and may run it again when its own push or edit changes the head SHA, title, or branches, but the underlying Agent API cannot change `draft/open/closed/merged` for an existing PR. Reconciler status messages explicitly say that the state is already persisted, so the RD Agent must not mirror the event.

## 6. State Machines

Requirement:

~~~text
TODO ─Start→ DOING ─success→ WAITING_CONFIRMATION ─confirm→ DONE
TODO ─Delete→ CANCELLED (hidden from active lists)
DONE ─Human reply→ DOING
~~~

RD AgentSession:

~~~text
IDLE → RUNNING → WAITING_HUMAN → RUNNING
          └────────→ FAILED → RUNNING
WAITING_HUMAN → COMPLETED
COMPLETED ─Human reply→ RUNNING
~~~

Pull Request:

~~~text
DRAFT → OPEN → MERGED
          └──→ CLOSED
~~~

## 7. Concurrency

- One AgentSession may have at most one active RD Run.
- RD Sessions belonging to different Requirements may run concurrently.
- Reviewer is an independent, behaviorally read-only, short-lived task and may run concurrently with RD.
- One PR may have at most one active ReviewRequest.
- All processes start in the Agent Manager working directory. RD developer instructions require code-changing work to create or reuse a Requirement-specific Git worktree, but Agent Manager does not provision or enforce that isolation. Concurrent RD Sessions can still conflict on files or Git state if the instruction is not followed.

## 8. Persistence

The first implementation uses Node.js `node:sqlite`:

~~~text
~/.code-factory/workspaces/<sha256(workspaceRoot)[0:16]>/config.json
~/.code-factory/workspaces/<sha256(workspaceRoot)[0:16]>/factory.sqlite
~~~

- Foreign keys, WAL mode, and a busy timeout are enabled.
- Requirement and AgentSession are created atomically.
- A daily retention sweep deletes expired CANCELLED and DONE Requirements. Defaults are 7 and 365 days respectively, measured from the terminal transition's `updatedAt`; configuration updates apply immediately and trigger a sweep, and a zero-day policy also sweeps when a Requirement enters the matching terminal state. A Requirement with any running Run is deferred so an in-flight Reviewer can persist and deliver its result; completing that Run immediately retries a zero-day purge.
- Expiry deletes the Requirement inside one SQLite transaction. Before foreign-key cascades remove its AgentSession, Runs, messages, attachment metadata, PRs, PR observations, ReviewRequests, trigger receipts, and related ManagerEvents, the transaction records attachment paths as pending-deletion tombstones; surviving child Requirements have parent and source-Session references cleared. Attachment files are removed after commit, and failed or interrupted file deletions remain discoverable for retry on the next sweep.
- One-to-one relationships, message ordering, and active-Run constraints are enforced by SQLite.
- Requirement text, conversation messages, and Pull Request metadata are copied into a unified search-document table as part of their owning Store writes. Full-text scores and persisted local word/character n-gram embeddings are combined at query time; an FTS5 trigram index accelerates and refines full-text ranking when the Node.js SQLite build includes FTS5, with deterministic in-process matching as the portable fallback. Existing records are backfilled idempotently when the Store opens.
- The application depends on the business-level `AgentManagerStore` interface, allowing a later PostgreSQL implementation without changing domain workflows.
- Configuration is validated before use and replaced atomically with file mode `0600`; it is operational state rather than a domain entity stored in SQLite.

## 9. Web Dashboard

The Web application contains four boards:

- Requirement: `TODO / DOING / Waiting for confirmation / DONE`;
- Pull Request: `DRAFT / OPEN / CLOSED / MERGED`;
- RD Session: `Idle / Running / Waiting for human / Failed / Completed`;
- Timer: `Active / Completed / Cancelled`.

Requirement details form a Jira-like work surface containing the description, linked PRs, Run information, and a unified Human/RD/Reviewer/System conversation. A TODO card's Start action opens this work surface and focuses the message composer, allowing optional instructions and attachments to be captured as input to the initial Run; the work surface also offers an explicit start-without-instructions action. TODO cards offer an adjacent Delete action; deletion requires confirmation and is no longer available after execution starts. The input remains available while RD is running, and pending external-message counts appear on Requirement and Session cards. A clock control beside the chat attachment button creates and cancels one-time or recurring scheduled wake-ups using minute, hour, or day intervals.

The Session board card opens the same work surface with its latest Run selected in an Agent trace panel. Provider JSON events are normalized inside the Codex and Claude Code adapters, persisted in per-Run sequence order, and streamed through SSE as they arrive. The trace includes lifecycle events, reasoning summaries emitted by the Provider, Agent messages, tool calls, command/tool results, and errors. Clients lazily load historical traces by Run; individual detail values are capped at 64 KiB so a large command result cannot dominate SQLite or the dashboard.

The dashboard supports English and Simplified Chinese. The header language switcher applies the locale immediately and persists the choice in browser storage; a visitor without a saved preference defaults to the browser language. Requirement and Reviewer forms select models from the current provider catalog and retain the CLI-default option. The configuration dialog updates the workspace configuration and distinguishes immediately applied settings from restart-required settings.

Dashboard synchronization is resource-scoped after initial load. Mutation responses and persisted SSE payloads are merged by resource ID and update time; Messages are additionally ordered and deduplicated by their Requirement-local sequence. Compatibility refreshes for incomplete events are routed only to the affected Requirement, Runs, PRs, ReviewRequests, or Timers and coalesced by that scope. A full workspace snapshot is reserved for initial connection and explicit manual refresh. SSE replay and newer local state win over an older in-flight snapshot, and ownership checks prevent a payload from entering another Requirement's conversation.

All four boards share a time-range filter. It defaults to the last 7 days and also offers the last 24 hours, 30 days, 90 days, and all time. Requirement, Pull Request, and RD Session boards filter by creation time; the Timer board retains active timers by their upcoming occurrence and filters history by its latest update.

Their shared search box calls the Agent Manager hybrid-search endpoint. A match in a Requirement or any of its conversation messages exposes that Requirement and RD Session; a matching Pull Request title or metadata exposes the PR and its Requirement. Requirement cards show the highest-ranked match source and excerpt so conversation-only matches are explainable.

Running `npx --package @luoyixin/code-factory code-factory-agent-manager start` serves the API, SSE stream, and bundled Web dashboard from the same port and writes the local URL to the log file in the workspace data directory. No separate Web deployment is required.

## 10. Current Boundary

The Reviewer is instructed to use the GitHub CLI/API to publish inline comments, but structured verification that every expected comment was posted is not implemented yet. The native Timer Agent Trigger is configurable, while the general Agent Trigger extension API remains code-level; dynamic third-party trigger discovery/configuration and a Slack trigger are not implemented. Reconciliation currently uses local `gh` polling; GitHub webhook synchronization, stale-review indicators after head-SHA changes, access tokens, and Manager-enforced worktree isolation remain future work. The daemon supervisor recovers an exited Agent Manager process, but it does not register itself with systemd, launchd, or Windows Service Control Manager and therefore does not provide machine-reboot recovery.
