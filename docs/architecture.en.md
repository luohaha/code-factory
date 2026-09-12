# Code Factory — Final Architecture

Additional references: [HTTP and event protocol](protocol.md) · [Agent Manager HTTP API](agent-manager-api.md)

## 1. Domain Model

The system has three first-class domain entities:

- `Requirement`: a Jira-like issue that owns business state and the complete conversation;
- `AgentSession`: the long-lived RD session uniquely bound to a Requirement;
- `PullRequest`: a GitHub pull request produced by a Requirement. One Requirement may have multiple PRs.

`AgentRun`, `RequirementMessage`, and `ReviewRequest` are execution and interaction records. They are not long-lived agents that require scheduling.

~~~mermaid
erDiagram
  Requirement ||--|| AgentSession : owns
  Requirement ||--o{ RequirementMessage : contains
  Requirement ||--o{ PullRequest : produces
  AgentSession ||--o{ AgentRun : resumes
  PullRequest ||--o{ ReviewRequest : receives
  ReviewRequest ||--|| AgentRun : executes
~~~

Agent Manager is not a scheduler. There is no agent pool and no “waiting for scheduling” state. An RD AgentSession is created and permanently bound when its Requirement is created.

## 2. Runtime Boundary

~~~mermaid
flowchart LR
  H[Human] -->|Create requirement / Send message / Request review| M[Agent Manager]
  W[Web dashboard] <-->|HTTP + SSE| M
  S[Optional daemon supervisor] -->|Start / restart| M
  M <--> DB[(SQLite)]
  M -->|Same cwd, long-lived resume| RD[Codex / Claude Code RD]
  M -->|Short-lived, no persistent session| RV[Codex / Claude Code Reviewer]
  RD -->|Register PR / Propose requirement| CLI[code-factory-cli]
  CLI --> API[Agent API]
  API --> M
  RV -->|GitHub inline comments| GH[GitHub PR]
  GH -->|Poll status, comments, reviews, CI, conflicts| T[PR Agent Triggers]
  T -->|Normalized messages| M
  RV -->|Reviewer message| M
~~~

At startup, Agent Manager fixes the workspace to `realpath(process.cwd())`. Every RD and Reviewer child process uses that directory. Codex and Claude Code discover AGENTS.md, CLAUDE.md, Skills, and configuration according to their native directory rules.

Agent Manager's own settings are workspace-scoped in `~/.code-factory/workspaces/<workspace-hash>/config.json` by default. The CLI loads this file before constructing storage, logging, HTTP, and trigger services. Existing command-line flags remain process-local overrides, and `--config PATH` selects another file. File-backed desired values and effective startup values are kept separate so a later API update cannot persist unrelated CLI arguments, environment values, or resolved paths. The API and dashboard can atomically update the file. PR reconciliation intervals and log levels are reconfigured in the running process; HTTP binding, CORS, storage paths, startup browser behavior, and log rotation are marked as requiring a restart.

Agent Manager also owns an in-memory provider model catalog. It refreshes at startup and every 24 hours, using Codex's local app-server `model/list` method and Claude's `/v1/models` endpoint when API or gateway credentials are available. Claude Code rolling aliases and environment-configured model overrides remain available when remote discovery cannot run. A failed refresh retains the last successful provider list and marks it stale; model discovery never prevents the Manager from starting or running existing Sessions.

Agent Manager adds only Code Factory behavioral instructions that identify the relevant `code-factory-cli` commands. It places a private CLI launcher on the RD process's `PATH` and injects `CODE_FACTORY_API_URL`, `CODE_FACTORY_REQUIREMENT_ID`, and `CODE_FACTORY_SESSION_ID`; HTTP paths and payload schemas remain in CLI help instead of the model prompt. It does not copy or replace the project’s own instructions or Skills.

For example:

~~~bash
cd ~/starrocks
npx @code-factory/agent-manager start
~~~

All agents launched by that process initially use `~/starrocks` as their working directory. Before changing code, an RD Agent is instructed to create or reuse a Git worktree dedicated to its Requirement and perform the work there. Agent Manager does not currently provision or enforce that isolation.

Agent Manager may run in the foreground or beneath its workspace-scoped daemon supervisor. `start --daemon` detaches the supervisor, which starts Agent Manager with the original CLI options and waits for a readiness message emitted only after the HTTP listener is active. An unexpected Manager exit is restarted indefinitely with capped exponential backoff. `stop` terminates the supervisor and Manager intentionally, while `restart` reuses a running daemon's stored options unless replacements are supplied. `daemon.json`, `daemon.lock`, and `logs/daemon.log` live beside the workspace database under `~/.code-factory/workspaces/<workspace-hash>/`. This is application-level process supervision, not operating-system service installation or boot-time activation.

Every headless RD and Reviewer invocation skips interactive approval and CLI sandbox checks. It therefore inherits the launching user's full filesystem, network, and command-execution permissions. Agent Manager must only be started in a trusted workspace. Reviewers remain behaviorally read-only through their task instructions; this is not an operating-system security boundary.

## 3. Entities

### Requirement

- `status`: `todo | doing | waiting_confirmation | done | cancelled`;
- `provider`: `codex | claude-code`;
- optional `model` and `reasoningEffort` pin the CLI configuration for every RD Run in the Session;
- `createdBy`: `human | rd_agent`;
- an agent-proposed Requirement records `parentRequirementId` and `sourceSessionId`;
- an agent proposal is created as TODO and does not start automatically, preventing uncontrolled recursive work.

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

## 4. The Requirement Conversation Is the RD Message Stream

The system does not maintain a separate RD message-queue table. `requirement_messages` is the single source of truth for both display and delivery:

| Author | Visible in the Requirement conversation | Delivered to RD |
| --- | --- | --- |
| Human | Yes | Yes |
| Reviewer | Yes | Yes |
| RD Agent | Yes | No |
| System | Yes | Depends on the event |

Each message has a monotonically increasing `sequence` and a `deliverToRd` flag. When an RD Run starts, it captures the pending external-message range as `inputFromSequence..inputToSequence`:

1. If the Session is already running, new messages are only appended and never interrupt it; a human may then explicitly click **Interrupt**.
2. After a successful Run, the consumption cursor advances only to the `inputToSequence` captured when that Run started.
3. If external messages remain, Agent Manager automatically resumes the same RD Session.
4. Multiple messages are delivered together in order during the next Run.
5. A failed or interrupted Run does not advance the cursor, so retrying or corrective resumption cannot lose messages. Only messages arriving after the interrupted Run started trigger its automatic replacement.
6. RD output is never delivered back to the RD Agent as normal next-turn input.

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

### PR Reconciliation Triggers

Agent Manager polls each tracked Draft/Open PR through the authenticated local `gh` CLI every 30 seconds by default. The reconciler fetches one snapshot per PR and shares it with four independently registered triggers:

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
TODO → DOING → WAITING_CONFIRMATION → DONE
          ↑              │
          └─ New input ──┘
~~~

RD AgentSession:

~~~text
IDLE → RUNNING → WAITING_HUMAN → RUNNING
          └────────→ FAILED → RUNNING
WAITING_HUMAN → COMPLETED
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
- One-to-one relationships, message ordering, and active-Run constraints are enforced by SQLite.
- The application depends on the business-level `AgentManagerStore` interface, allowing a later PostgreSQL implementation without changing domain workflows.
- Configuration is validated before use and replaced atomically with file mode `0600`; it is operational state rather than a domain entity stored in SQLite.

## 9. Web Dashboard

The Web application contains three boards:

- Requirement: `TODO / DOING / Waiting for confirmation / DONE`;
- Pull Request: `DRAFT / OPEN / CLOSED / MERGED`;
- RD Session: `Idle / Running / Waiting for human / Failed / Completed`.

Requirement details form a Jira-like work surface containing the description, linked PRs, Run information, and a unified Human/RD/Reviewer/System conversation. The input remains available while RD is running, and pending external-message counts appear on Requirement and Session cards.

The dashboard supports English and Simplified Chinese. The header language switcher applies the locale immediately and persists the choice in browser storage; a visitor without a saved preference defaults to the browser language. Requirement and Reviewer forms select models from the current provider catalog and retain the CLI-default option. The configuration dialog updates the workspace configuration and distinguishes immediately applied settings from restart-required settings.

Requirement, Pull Request, and RD Session boards share a creation-time filter. It defaults to the last 7 days and also offers the last 24 hours, 30 days, 90 days, and all time.

Running `npx @code-factory/agent-manager start` serves the API, SSE stream, and bundled Web dashboard from the same port and writes the local URL to the log file in the workspace data directory. No separate Web deployment is required.

## 10. Current Boundary

The Reviewer is instructed to use the GitHub CLI/API to publish inline comments, but structured verification that every expected comment was posted is not implemented yet. The Agent Trigger extension API is code-level; dynamic trigger discovery/configuration and a Slack trigger are not implemented. Reconciliation currently uses local `gh` polling; GitHub webhook synchronization, stale-review indicators after head-SHA changes, access tokens, and Manager-enforced worktree isolation remain future work. The daemon supervisor recovers an exited Agent Manager process, but it does not register itself with systemd, launchd, or Windows Service Control Manager and therefore does not provide machine-reboot recovery.
