# Agent Manager HTTP and Event Protocol

The default address is `http://127.0.0.1:4310`. The API, SSE stream, and Web dashboard share one port and operate only on the workspace bound when Agent Manager starts.

See the [Agent Manager HTTP API Reference](agent-manager-api.md) for request fields, response models, status codes, and `curl` examples. This document focuses on message delivery and event semantics.

## 1. Query endpoints

~~~text
GET /api/health
GET /api/workspace
GET /api/configuration
GET /api/requirements
GET /api/requirements/:id
GET /api/sessions
GET /api/runs?requirementId=<id>
GET /api/requirements/:id/messages
GET /api/attachments/:id
GET /api/pull-requests?requirementId=<id>
GET /api/review-requests?pullRequestId=<id>
GET /api/events?after=<event-id>
~~~

`GET /api/events` is an SSE stream. A connection without a cursor receives only new events. Pass `after=<event-id>` to replay events after a known ID; browser reconnections may instead send the standard `Last-Event-ID` header.

## 2. Human endpoints

Update workspace configuration:

~~~text
PATCH /api/configuration
~~~

PR reconciliation interval, terminal Requirement retention, and log-level changes apply immediately; other settings are persisted for restart. See the API reference for validation and the restart-required response fields.

Create a Requirement:

~~~http
POST /api/requirements
Content-Type: application/json

{
  "title": "Add tiered timings to the compaction profile",
  "description": "Report segment merge, encode, and flush durations",
  "provider": "codex"
}
~~~

Delete a Requirement that has not started, or drive a Requirement:

~~~text
DELETE /api/requirements/:id
POST /api/requirements/:id/start
POST /api/requirements/:id/reply
POST /api/requirements/:id/interrupt
POST /api/requirements/:id/confirm
POST /api/requirements/:id/attachments
~~~

Upload a file as the raw binary request body to the `attachments` endpoint, then include the returned ID in `attachmentIds` on `start` or `reply`. A message supports up to six attachments of at most 20 MB each. PNG, JPEG, GIF, and WebP files are previewed as images; other files are downloaded as regular attachments. A reply body has the form `{"message":"...","attachmentIds":["att_..."]}` and may omit text when attachments are present. While RD is running, replies are appended and queued without interrupting the current Run. Replying to a DONE Requirement reactivates it as DOING and starts a new Run in the original RD Session. Only an explicit call to `interrupt`—the Web dashboard's Interrupt button—stops the current RD Run.

If RD is running, `reply` still returns `202`. `queued=true` means the message was appended to the Requirement conversation and will be handled after the current Run; an active Session is not a conflict. The response includes the persisted message and the latest Requirement with its RD Session so clients can update the affected conversation and card without a workspace-wide refresh.

Request a PR review:

~~~http
POST /api/pull-requests/:id/review-requests
Content-Type: application/json

{
  "provider": "claude-code",
  "prompt": "Optional additional review focus"
}
~~~

Only Open PRs can be reviewed. Each request captures the current head SHA, and a PR may have only one active ReviewRequest.

## 3. RD Agent endpoints

RD developer/system instructions name the relevant `code-factory-cli` commands rather than embedding this HTTP schema. Agent Manager injects the API base URL, Requirement ID, and Session ID as CLI environment context. The commands below remain the canonical transport protocol used by the CLI and other integrations.

Register or update a PR:

~~~http
POST /api/agent/pull-requests
Content-Type: application/json

{
  "requirementId": "req_...",
  "repository": "org/repo",
  "number": 184,
  "url": "https://github.com/org/repo/pull/184",
  "title": "Improve compaction",
  "baseBranch": "main",
  "headBranch": "feature/compaction",
  "headSha": "abc123...",
  "status": "open"
}
~~~

`status` must be `draft | open | closed | merged` and is used only on initial registration. `repository + number` idempotently updates PR metadata. Later Agent requests cannot change lifecycle state; the PR Reconciler synchronizes it from GitHub.

Propose a separate Requirement:

~~~http
POST /api/agent/requirements
Content-Type: application/json

{
  "sourceSessionId": "ses_...",
  "parentRequirementId": "req_...",
  "title": "Add a performance benchmark",
  "description": "Track throughput and peak memory as a separate follow-up",
  "provider": "codex"
}
~~~

`provider` is optional and defaults to the source Session provider. The proposed Requirement is created as `createdBy=rd_agent` in TODO and does not start automatically.

Inspect and message directly related Requirements:

~~~bash
code-factory-cli requirement related
code-factory-cli requirement message --requirement-id req_... --message "Use contract version 2."
~~~

`requirement related` calls `GET /api/agent/requirements/:sourceRequirementId/related?sourceSessionId=...` and returns `{parent, children}` for the direct parent and children, including terminal records that have not yet expired. `requirement message` calls `POST /api/agent/requirements/:sourceRequirementId/related/:targetRequirementId/messages` with the injected `sourceSessionId` and the message. Agent Manager verifies that the Session owns the source Requirement and that the target is its direct parent or child. Accepted messages are stored in the target conversation with `author=rd_agent`, `sourceRequirementId` set to the sender, and `deliverToRd=true`; they start an idle target RD Session or queue behind its active Run.

Schedule or cancel a wake-up for the current Requirement:

~~~bash
code-factory-cli timer register --description "Check compiler status" --after-seconds 3600
code-factory-cli timer register --description "Check compiler status" --after-seconds 900 --repeat
code-factory-cli timer show
code-factory-cli timer cancel --id tmr_...
~~~

The CLI uses the Requirement-scoped timer GET, POST, and DELETE endpoints with the injected Requirement ID. `timer show` returns every timer for the current Requirement, including its ID, description, and status, so an Agent can recover the ID needed by `timer cancel`. A due occurrence writes a System message containing `Timer fired.`, its timer ID, schedule, and description through the same durable delivery path as other Agent Triggers. Recurring messages also include the corresponding `timer cancel` command. One-time schedules complete after delivery; recurring schedules advance to their next future occurrence and skip replaying missed intervals after downtime.

## 4. Message delivery

`GET /api/requirements/:id/messages` returns the unified conversation. Each message contains:

- `sequence`: a monotonically increasing number within the Requirement;
- `author`: `human | rd_agent | reviewer | system`;
- `sourceRequirementId`: the sending Requirement for a related RD Agent message, otherwise null;
- `deliverToRd`: whether RD must consume the message;
- optional `runId`;
- `attachments`: persisted attachments; Codex receives images through native image arguments and reads other files by local absolute path, while Claude Code reads every attachment from the local absolute paths in the message.

An RD Run records `inputFromSequence` and `inputToSequence`. On success, only that captured input boundary is consumed. Messages arriving during the Run remain for the next Run. A Requirement's own RD output always uses `deliverToRd=false`; a message explicitly sent by a related Requirement's RD Agent uses `deliverToRd=true` for the target.

## 5. SSE events

~~~text
id: 42
event: review_request.started
data: {"id":42,"type":"review_request.started",...}
~~~

Current event types include:

- `requirement.created` / `requirement.deleted` / `requirement.completed` / `requirements.purged`;
- `message.created`;
- `pull_request.created` / `pull_request.updated`;
- `review_request.started`;
- `timer.created` / `timer.fired` / `timer.cancelled`;
- `run.started` / `run.succeeded` / `run.failed` / `run.timed_out` / `run.cancelled`;
- `manager.reconciled`.

The PR Reconciler publishes GitHub state and head-SHA changes through `pull_request.updated`. PR status changes, new comments/reviews, CI failures, and merge conflicts are first stored in the Requirement conversation and then published through `message.created`. Their payload includes `source: "github"`, `pullRequestId`, and the corresponding `triggerId`: `github.pull-request.status`, `github.pull-request.comment`, `github.pull-request.ci-failure`, or `github.pull-request.conflict`. SQLite Agent Trigger receipts deduplicate external events across Agent Manager restarts.

Timer messages publish `message.created` with `source: "timer"`, `triggerId: "timer"`, `timerId`, `description`, `schedule`, and `scheduledFor`. Their trigger receipt is keyed by timer ID plus occurrence time, while the separate `timer.*` events expose configuration and lifecycle changes to dashboard clients.

The initial dashboard state comes from the JSON query endpoints, so its cursorless SSE connection does not replay historical events. Reconnecting SSE clients resume after the `Last-Event-ID` value supplied by the browser. Other clients can request up to 200 persisted events after an explicit `after` cursor.

## 6. Error semantics

- `400`: invalid fields, JSON, or request-body size;
- `404`: entity not found;
- `409`: illegal state transition, an active review already exists for the PR, or an explicit duplicate start for the same Session;
- `500`: unclassified internal error.

Sending a human message to a running RD Session, or replying to reactivate a DONE Requirement, is normal and is not a conflict.

## 7. Current security boundary

The service listens only on `127.0.0.1` by default. The Agent API currently relies on the local process boundary and has no access token. Production use requires a local token, webhook signature validation, and permission auditing.
