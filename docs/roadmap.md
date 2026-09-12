# Development Roadmap

## M0: v2 architecture convergence (complete)

- Agent Manager naming and workspace-scoped boundary;
- strict one-to-one mapping between Requirement and RD AgentSession, with PullRequest as the third first-class domain entity;
- removal of the QA Agent, Agent Pool, Scheduler, and separate message queue; the conversation itself is the RD message stream;
- separate Requirement and Session state machines;
- Reviewer defined as a short-lived Run without a persistent Session.

## M1: locally runnable core (implemented)

- TypeScript Agent Manager package and CLI;
- SQLite schema, domain Store, and workspace-isolated data path;
- persistence for Requirements, Sessions, Runs, and Events;
- RequirementMessage consumption boundaries and PullRequest/ReviewRequest persistence;
- one-active-Run constraint per AgentSession, with concurrency across different Requirements;
- creation and resumption of Codex and Claude Code RD sessions;
- ephemeral Reviewers for both CLIs;
- child-process timeouts, JSONL normalization, and native session ID capture;
- HTTP query/action API and SSE;
- Requirement and Agent Session Web dashboards.

## M2: Web integration and recovery (core interaction implemented)

- [x] Web dashboard reads live state through Agent Manager HTTP/SSE;
- [x] Jira-like Requirement detail, persisted Agent output, and human replies;
- [x] startup reconciliation clears orphaned `running` state;
- [x] RD receives Human/Reviewer messages during a Run and automatically continues afterward;
- [x] RD output is displayed but never fed back as next-turn input;
- [ ] complete Run timeline and tool execution logs;
- [ ] explicit Run cancellation and graceful termination;
- [ ] local access token, Origin allowlist, and diagnostic-log redaction;
- [ ] CLI availability, authentication, and version preflight checks.

## M3: Git and PR loop (basic flow implemented)

- [ ] GitHub App or Provider abstraction and webhook signature validation;
- [x] PR/head SHA association with Requirements and a dedicated PR board;
- [x] human selection of a Reviewer Agent for an Open PR;
- [x] Reviewer summary appended to the Requirement conversation and automatic RD wake-up;
- [x] RD Agent API for registering PRs and proposing TODO Requirements;
- [ ] PR create/update/comment/merge webhooks;
- [x] Reviewer results associated with the head SHA captured when requested;
- [ ] explicit stale-review indication after a head SHA update;
- [ ] structured validation that the Reviewer published GitHub inline comments;
- [ ] human completion confirmation after merge.

## M4: reliability and extensible storage

- [x] workspace-scoped daemon supervisor with background start and automatic Manager restart;
- PostgreSQL Store implementation and migration tooling;
- process leases, crash recovery, and stronger event idempotency;
- metrics, tracing, retention policies, and audit logs;
- explicit worktree isolation mode for concurrent Requirements in one workspace;
- permission-policy templates and configurable resource limits.

## Acceptance invariants

Every milestone must preserve these invariants:

1. A Requirement owns exactly one RD AgentSession as soon as it is created.
2. A human reply continues the same logical Session.
3. A Reviewer never becomes a long-lived Session.
4. The Agent Manager launch directory and native CLI rules are the only sources of working directory and Skills.
5. There is no waiting-for-scheduling state. Different Requirements may run concurrently, while one Session cannot re-enter.
6. Human and Reviewer conversation messages are delivered reliably; RD output is never delivered back to itself.
