# Agent Manager HTTP API Reference

This document describes the HTTP API exposed by Agent Manager. It is intended for the Web dashboard, automation scripts, and RD Agents started by Agent Manager.

For message delivery, Run recovery, and review-loop semantics, see [HTTP and Event Protocol](protocol.md). For the domain model and state machines, see [Architecture and Domain Model](architecture.en.md).

## 1. Getting started

Agent Manager listens on 127.0.0.1:4310 by default. Its API base URL is:

~~~text
http://127.0.0.1:4310/api
~~~

By default, Agent Manager uses the authenticated local GitHub CLI every 30 seconds to synchronize state, comments, reviews, inline review comments, CI failures, and merge conflicts for Draft and Open PRs. Change `pullRequestReconcileIntervalSeconds` through the configuration API or dashboard; use `0` to disable polling. The compatible `--pr-reconcile-interval SECONDS` option overrides the file for the launched process only. Reconciliation messages are exposed and delivered through the Requirement conversation and SSE endpoints documented here.

Check the service and bound workspace first:

~~~bash
curl http://127.0.0.1:4310/api/health
~~~

~~~json
{
  "ok": true,
  "workspaceRoot": "/path/to/workspace"
}
~~~

Requests and responses use JSON except for attachment uploads and SSE. JSON request bodies are limited to 1 MB. Attachment uploads use a raw binary body and are limited to 20 MB per file. The API currently has no version prefix.

The service listens only on the loopback interface by default and currently has no authentication. Assess the risk before exposing it. Changes to `host`, `port`, and `allowedOrigin` are persisted through the configuration API and require a restart.

## 2. Endpoint summary

| Method | Path | Purpose |
| --- | --- | --- |
| GET | /api/health | Check service health |
| GET | /api/workspace | Read the bound workspace and data paths |
| GET | /api/configuration | Read desired Agent Manager configuration and restart status |
| PATCH | /api/configuration | Validate, persist, and apply configuration changes |
| GET | /api/requirements | List Requirements with their RD Sessions |
| POST | /api/requirements | Create a Requirement and RD Session |
| POST | /api/requirements/:id/start | Start or retry a Requirement |
| POST | /api/requirements/:id/reply | Send a human conversation message |
| POST | /api/requirements/:id/interrupt | Interrupt the current RD Run |
| POST | /api/requirements/:id/confirm | Confirm Requirement completion |
| GET | /api/requirements/:id/messages | Read the complete Requirement conversation |
| POST | /api/requirements/:id/attachments | Upload a conversation attachment |
| GET | /api/attachments/:id | Read or download an attachment |
| GET | /api/sessions | List RD Sessions |
| GET | /api/runs | List RD and Reviewer Runs |
| GET | /api/pull-requests | List registered Pull Requests |
| POST | /api/pull-requests/:id/review-requests | Request a PR review |
| GET | /api/review-requests | List Review Requests |
| GET | /api/events | Subscribe to the resumable SSE stream |
| POST | /api/agent/pull-requests | Register or update a PR from an RD Agent |
| POST | /api/agent/requirements | Propose a follow-up Requirement from an RD Agent |

URL-encode IDs used in path parameters. Requirement, Session, Run, PR, and ReviewRequest lists are ordered with the most recently updated or created items first. Messages and events are ordered by ascending sequence number. List responses use:

~~~json
{
  "items": []
}
~~~

List endpoints do not currently support pagination. A new GET /api/events connection replays at most 200 historical events.

## 3. Data models

All timestamps are ISO 8601 strings. Values that do not yet exist are returned as null rather than omitted.

### 3.1 Requirement

~~~ts
interface Requirement {
  id: string;                         // req_<uuid>
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'waiting_confirmation' | 'done' | 'cancelled';
  provider: 'codex' | 'claude-code';
  model: string | null;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  createdBy: 'human' | 'rd_agent';
  parentRequirementId: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  session: AgentSession;
}
~~~

Requirement query and creation responses always embed the uniquely bound session.

### 3.2 AgentSession

~~~ts
interface AgentSession {
  id: string;                         // ses_<uuid>
  requirementId: string;
  provider: 'codex' | 'claude-code';
  nativeSessionId: string | null;
  state: 'idle' | 'running' | 'waiting_human' | 'failed' | 'completed';
  lastError: string | null;
  lastConsumedMessageSequence: number;
  pendingMessageCount: number;
  createdAt: string;
  updatedAt: string;
}
~~~

nativeSessionId is the native Codex or Claude Code session ID. pendingMessageCount is the number of external messages that RD has not successfully consumed.

### 3.3 AgentRun

~~~ts
interface AgentRun {
  id: string;                         // run_<uuid>
  requirementId: string;
  sessionId: string | null;           // null for Reviewer Runs
  role: 'rd' | 'reviewer';
  provider: 'codex' | 'claude-code';
  model: string | null;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  status: 'running' | 'succeeded' | 'failed' | 'timed_out' | 'cancelled';
  taskSummary: string;
  nativeSessionId: string | null;
  exitCode: number | null;
  error: string | null;
  inputFromSequence: number | null;
  inputToSequence: number | null;
  startedAt: string;
  finishedAt: string | null;
}
~~~

inputFromSequence and inputToSequence record the Requirement-message range captured by an RD Run. Both are null for Reviewer Runs.

### 3.4 RequirementMessage

~~~ts
interface RequirementMessage {
  id: string;                         // msg_<uuid>
  requirementId: string;
  sessionId: string;
  runId: string | null;
  author: 'human' | 'rd_agent' | 'reviewer' | 'system';
  body: string;
  attachments: MessageAttachment[];
  sequence: number;
  deliverToRd: boolean;
  createdAt: string;
}

interface MessageAttachment {
  id: string;                         // att_<uuid>
  requirementId: string;
  messageId: string | null;
  fileName: string;
  kind: 'image' | 'file';
  mediaType: string;
  byteSize: number;
  createdAt: string;
}
~~~

sequence increases monotonically within a Requirement. deliverToRd=true means RD must consume the message. RD output is never delivered back to itself.

### 3.5 PullRequest

~~~ts
interface PullRequest {
  id: string;                         // pr_<uuid>
  requirementId: string;
  repository: string;                 // owner/repository
  number: number;
  url: string;
  title: string;
  baseBranch: string;
  headBranch: string;
  headSha: string;
  status: 'draft' | 'open' | 'closed' | 'merged';
  createdAt: string;
  updatedAt: string;
}
~~~

repository + number is the idempotency key for a PR.

### 3.6 ReviewRequest

~~~ts
interface ReviewRequest {
  id: string;                         // rev_<uuid>
  pullRequestId: string;
  runId: string;
  provider: 'codex' | 'claude-code';
  model: string | null;
  reasoningEffort: 'low' | 'medium' | 'high' | 'xhigh' | 'max' | null;
  targetHeadSha: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  requestedBy: 'human';
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
~~~

Agent Manager captures targetHeadSha when a review starts, so the ReviewRequest records the revision it represents. A timed-out Reviewer has AgentRun.status=timed_out and normalized ReviewRequest.status=failed.

## 4. Query endpoints

### GET /api/health

Returns service status, the installed Code Factory version, and the workspace bound at Agent Manager startup.

Success: 200 OK

~~~json
{
  "ok": true,
  "version": "0.1.0",
  "workspaceRoot": "/path/to/workspace"
}
~~~

### GET /api/workspace

Success: 200 OK

~~~json
{
  "root": "/path/to/workspace",
  "databasePath": "/home/user/.code-factory/workspaces/7a60b5f8c3d94945/factory.sqlite",
  "logFilePath": "/home/user/.code-factory/workspaces/7a60b5f8c3d94945/logs/agent-manager.log"
}
~~~

logFilePath is a stable symlink to the active log; physical files rotate by date and size.

### GET /api/configuration

Returns the configuration file path, file-backed desired values, and any fields saved for the next restart. Process-local CLI and environment overrides are effective for the current launch but do not replace these values.

~~~json
{
  "path": "/home/user/.code-factory/workspaces/7a60b5f8c3d94945/config.json",
  "values": {
    "host": "127.0.0.1",
    "port": 4310,
    "allowedOrigin": "http://localhost:3000",
    "openDashboard": false,
    "databasePath": null,
    "pullRequestReconcileIntervalSeconds": 30,
    "logLevel": "info",
    "logFilePath": null,
    "logMaxSize": "20m",
    "logMaxFiles": "14d"
  },
  "restartRequired": false,
  "restartRequiredFields": []
}
~~~

### PATCH /api/configuration

Accepts any subset of `values`. The patch is merged into the file-backed desired values and the complete validated document is atomically written; unrelated launch-only overrides are never persisted. `pullRequestReconcileIntervalSeconds` and `logLevel` apply immediately. All other fields are persisted, returned in `restartRequiredFields`, and apply on restart.

~~~bash
curl -X PATCH http://127.0.0.1:4310/api/configuration \
  -H 'Content-Type: application/json' \
  -d '{"pullRequestReconcileIntervalSeconds":10,"logLevel":"debug"}'
~~~

`port` must be an integer from 1 to 65535. The reconcile interval must be an integer from 0 to 2147483 seconds, the largest whole-second delay supported by Node.js timers. `logLevel` accepts `debug`, `info`, `warn`, `error`, or `silent`. Paths and origins accept a non-empty string or `null`; a null database or log path selects its workspace default, while a null origin disables CORS. Unknown fields return 400 Bad Request.

### GET /api/requirements

Returns every non-cancelled Requirement, including its AgentSession.

Success: 200 OK with {"items": Requirement[]}.

### GET /api/sessions

Returns all RD Sessions.

Success: 200 OK with {"items": AgentSession[]}.

### GET /api/runs

Optional query parameters:

| Parameter | Type | Meaning |
| --- | --- | --- |
| requirementId | string | Return only Runs for this Requirement |

Success: 200 OK with {"items": AgentRun[]}. An unknown requirementId returns an empty array.

### GET /api/requirements/:id/messages

Returns the complete Requirement conversation ordered by ascending sequence.

Success: 200 OK with {"items": RequirementMessage[]}. Returns 404 Not Found for an unknown Requirement.

### POST /api/requirements/:id/attachments

Uploads one attachment and returns MessageAttachment. The body is raw file bytes rather than JSON. X-File-Name contains the URI-encoded original filename. Files are limited to 20 MB. PNG, JPEG, GIF, and WebP are detected by signature as kind=image; all other content uses kind=file.

~~~bash
curl -X POST http://127.0.0.1:4310/api/requirements/req_.../attachments \
  -H 'Content-Type: text/plain' \
  -H 'X-File-Name: debug.log' \
  --data-binary @debug.log
~~~

Success: 201 Created. Include the returned ID in attachmentIds on a later start or reply request. A message supports up to six attachments. Attachments and their messages persist across Agent Manager restarts.

### GET /api/attachments/:id

Returns attachment content. Safe raster images use Content-Disposition: inline. Other files are forced to download with attachment. Every response includes X-Content-Type-Options: nosniff. Returns 404 Not Found for an unknown attachment.

### GET /api/pull-requests

Optional query parameters:

| Parameter | Type | Meaning |
| --- | --- | --- |
| requirementId | string | Return only PRs registered for this Requirement |

Success: 200 OK with {"items": PullRequest[]}. An unknown requirementId returns an empty array.

### GET /api/review-requests

Optional query parameters:

| Parameter | Type | Meaning |
| --- | --- | --- |
| pullRequestId | string | Return only ReviewRequests for this PR |

Success: 200 OK with {"items": ReviewRequest[]}. An unknown pullRequestId returns an empty array.

## 5. Requirement actions

### POST /api/requirements

Creates a human-authored Requirement and its uniquely bound RD Session. The Agent does not start automatically.

Request body:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| title | string | yes | Must be non-empty after trimming |
| description | string | yes | Must be non-empty after trimming |
| provider | string | yes | codex or claude-code |
| model | string | no | Model identifier passed to the selected CLI; defaults to CLI configuration |
| reasoningEffort | string | no | low, medium, high, xhigh, or max; defaults to CLI configuration |

~~~bash
curl -X POST http://127.0.0.1:4310/api/requirements \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "Add an export timeout",
    "description": "Stop the child process and record the failure when the timeout expires",
    "provider": "codex",
    "model": "gpt-5.6",
    "reasoningEffort": "high"
  }'
~~~

Success: 201 Created with the new Requirement. Its initial status is todo and its Session state is idle.

### POST /api/requirements/:id/start

Starts a Requirement that has not run, or retries a failed RD Session. Optional message and attachmentIds values are appended to the conversation before delivery in this or the next Run.

The request body may be empty or contain:

~~~json
{
  "message": "Reproduce the issue from the screenshot, then add a regression test.",
  "attachmentIds": ["att_..."]
}
~~~

Success: 202 Accepted

~~~json
{
  "accepted": true,
  "requirementId": "req_...",
  "action": "start"
}
~~~

Acceptance does not mean the background Run has completed. If the Session is already running, the endpoint still returns 202; optional input is queued for the next Run and no second concurrent RD Run is started. Track completion through SSE or the Run and Session query endpoints.

Returns 404 for an unknown Requirement and 409 Conflict for a done or cancelled Requirement.

### POST /api/requirements/:id/reply

Appends a human message to the Requirement conversation. An idle Session automatically starts an RD Run. A running Session always queues the message without interruption. Call the interrupt endpoint separately to stop the current Run.

Request body:

~~~json
{
  "message": "Adjust the layout based on the screenshot.",
  "attachmentIds": ["att_..."]
}
~~~

Success: 202 Accepted

~~~json
{
  "accepted": true,
  "requirementId": "req_...",
  "action": "reply",
  "queued": true,
  "message": {
    "id": "msg_...",
    "requirementId": "req_...",
    "sessionId": "ses_...",
    "runId": null,
    "author": "human",
    "body": "Also cover retry after a timeout.",
    "sequence": 3,
    "deliverToRd": true,
    "createdAt": "2026-09-11T02:30:00.000Z"
  }
}
~~~

message may be empty when attachmentIds is non-empty. queued reports whether the RD Session was running when the message arrived. The reply endpoint never interrupts a Run. Empty text and attachments return 400. An unknown Requirement returns 404. A done or cancelled Requirement returns 409.

### POST /api/requirements/:id/interrupt

Interrupts the current Requirement's RD Run without appending a message. The request body may be omitted or be an empty object. Agent Manager terminates the CLI and its complete tool-process tree. POSIX platforms send `SIGTERM` first and then `SIGKILL` to the process group if descendants remain after two seconds. Windows uses `taskkill /T /F`. The Run becomes `cancelled` only after the process tree exits, and the Session returns to `waiting_human`.

~~~json
{
  "accepted": true,
  "requirementId": "req_...",
  "action": "interrupt",
  "runId": "run_..."
}
~~~

Success: `202 Accepted`. Repeated calls are idempotent while the Run is still exiting. Returns `409 Conflict` when no RD Run is active. If pending messages arrived after the interrupted Run started, Agent Manager automatically resumes the same Session after exit; otherwise it waits for the next human or external message.

### POST /api/requirements/:id/confirm

Moves a Requirement from waiting_confirmation to done and its Session to completed. The request body may be omitted or be an empty object.

~~~bash
curl -X POST http://127.0.0.1:4310/api/requirements/req_.../confirm \
  -H 'Content-Type: application/json' \
  -d '{}'
~~~

Success: 200 OK with the updated Requirement. Returns 404 for an unknown Requirement or 409 when its status is not waiting_confirmation.

## 6. Pull Request review

### POST /api/pull-requests/:id/review-requests

Starts a short-lived Reviewer Run for a registered Open PR. The id is Code Factory's pr_<uuid>, not the GitHub PR number.

Request body:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| provider | string | yes | codex or claude-code |
| model | string | no | Model identifier passed to the selected CLI; defaults to CLI configuration |
| reasoningEffort | string | no | low, medium, high, xhigh, or max; defaults to CLI configuration |
| prompt | string | no | Additional focus appended to Reviewer system/developer instructions; the task prompt remains Review GitHub PR <url> |

~~~bash
curl -X POST http://127.0.0.1:4310/api/pull-requests/pr_.../review-requests \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "claude-code",
    "model": "claude-opus-4-6",
    "reasoningEffort": "high",
    "prompt": "Focus on concurrent state transitions and failure recovery."
  }'
~~~

Success: 202 Accepted

~~~json
{
  "accepted": true,
  "pullRequestId": "pr_...",
  "provider": "claude-code",
  "model": "claude-opus-4-6",
  "reasoningEffort": "high"
}
~~~

The Reviewer runs in the background. The request does not wait for completion. Returns 404 for an unknown PR and 409 when the PR is not Open or already has an active review.

## 7. RD Agent endpoints

These endpoints are the transport used by `code-factory-cli` and other trusted local integrations. RD Agents launched by Agent Manager should use the CLI rather than construct HTTP requests: their instructions name the relevant commands, while Agent Manager injects the API URL, current Requirement ID, and Session ID through the environment.

~~~bash
code-factory-cli pr register --help
code-factory-cli requirement propose --help
~~~

### POST /api/agent/pull-requests

Registers or updates GitHub PR metadata. Later requests for the same repository + number update the same entity but cannot advance lifecycle state. The PR Reconciler owns draft/open/closed/merged state.

Every request field is required:

| Field | Type | Meaning |
| --- | --- | --- |
| requirementId | string | Requirement that owns the PR |
| repository | string | GitHub owner/repository |
| number | positive integer | GitHub PR number |
| url | string | PR URL |
| title | string | PR title |
| baseBranch | string | Target branch |
| headBranch | string | Source branch |
| headSha | string | Current head commit SHA |
| status | string | draft, open, closed, or merged |

~~~bash
curl -X POST http://127.0.0.1:4310/api/agent/pull-requests \
  -H 'Content-Type: application/json' \
  -d '{
    "requirementId": "req_...",
    "repository": "acme/widgets",
    "number": 184,
    "url": "https://github.com/acme/widgets/pull/184",
    "title": "Add export timeout",
    "baseBranch": "main",
    "headBranch": "feature/export-timeout",
    "headSha": "6f1e56b177a84a9f15fcd5e92b6f4f27c1c0810d",
    "status": "open"
  }'
~~~

Success: 200 OK with the created or updated PullRequest. Returns 404 for an unknown Requirement and 400 for invalid fields.

An Agent should register a PR after creating it and call this endpoint again only when its own push or edit changes metadata such as title, branch, or head SHA. After initial registration, the requested status is ignored and the stored state is preserved. The PR Reconciler synchronizes GitHub state events; an Agent receiving the corresponding System message must not call this endpoint merely to repeat that state transition.

### POST /api/agent/requirements

Proposes a follow-up Requirement that should be tracked separately from the current work. The new Requirement is created in todo and does not start automatically.

Request body:

| Field | Type | Required | Meaning |
| --- | --- | --- | --- |
| sourceSessionId | string | yes | RD Session that discovered the follow-up |
| parentRequirementId | string | no | Defaults to the source Session Requirement and must match it if supplied |
| title | string | yes | Follow-up title |
| description | string | yes | Follow-up description |
| provider | string | no | codex or claude-code; defaults to the source Session provider |
| model | string | no | Model identifier passed to the selected CLI; defaults to CLI configuration |
| reasoningEffort | string | no | low, medium, high, xhigh, or max; defaults to CLI configuration |

~~~bash
curl -X POST http://127.0.0.1:4310/api/agent/requirements \
  -H 'Content-Type: application/json' \
  -d '{
    "sourceSessionId": "ses_...",
    "parentRequirementId": "req_...",
    "title": "Add an export performance benchmark",
    "description": "Track throughput and peak memory for large datasets separately",
    "provider": "codex"
  }'
~~~

Success: 201 Created with the new Requirement and createdBy=rd_agent. Returns 404 for an unknown source Session and 400 when parentRequirementId does not match or another field is invalid.

## 8. SSE event stream

### GET /api/events

Opens a text/event-stream connection and continues receiving Manager events. Use the optional after query parameter to replay events with a larger ID:

~~~bash
curl -N 'http://127.0.0.1:4310/api/events?after=41'
~~~

~~~text
id: 42
event: message.created
data: {"id":42,"type":"message.created","requirementId":"req_...","sessionId":"ses_...","runId":null,"payload":{"message":{"id":"msg_..."}},"createdAt":"2026-09-11T02:30:00.000Z"}

~~~

Every data value is a complete ManagerEvent:

~~~ts
interface ManagerEvent {
  id: number;
  type: string;
  requirementId: string | null;
  sessionId: string | null;
  runId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}
~~~

Current event types and primary payloads:

| Event | Payload |
| --- | --- |
| requirement.created | provider, createdBy |
| requirement.completed | empty object |
| message.created | message |
| pull_request.created | pullRequest |
| pull_request.updated | pullRequest |
| review_request.started | reviewRequestId, pullRequestId, provider, targetHeadSha |
| run.started | RD role, provider, resumed, and input message range |
| run.succeeded | role, exitCode, nativeSessionId, finalMessage, error |
| run.failed | same as run.succeeded |
| run.timed_out | same as run.succeeded |
| run.cancelled | same as run.succeeded |
| manager.reconciled | runIds and requirementIds repaired at startup |
| manager.configuration.updated | changedFields, appliedFields, restartRequired, restartRequiredFields |

Clients should store the last successfully processed event ID and pass it as after when reconnecting. A missing or non-finite after value starts replay at 0. Each connection replays at most 200 existing events before continuing with live events.

## 9. Typical workflow

This example creates, starts, and confirms a Requirement from the command line. It uses jq to extract the ID.

~~~bash
API=http://127.0.0.1:4310/api

requirement=$(
  curl -sS -X POST "$API/requirements" \
    -H 'Content-Type: application/json' \
    -d '{
      "title": "Add export timeout handling",
      "description": "Implement the timeout and cover failure recovery",
      "provider": "codex"
    }'
)
requirement_id=$(printf '%s' "$requirement" | jq -r '.id')

curl -sS -X POST "$API/requirements/$requirement_id/start" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Run the existing tests first."}'
~~~

Subscribe to events in another terminal. Production clients should persist the latest event ID and supply it through after when reconnecting:

~~~bash
API=http://127.0.0.1:4310/api
curl -N "$API/events?after=0"
~~~

Messages may be appended while execution is in progress. queued reports whether the message is waiting for the next Run or triggered a new one:

~~~bash
curl -sS -X POST "$API/requirements/$requirement_id/reply" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Also verify that the child process exits after a timeout."}'
~~~

When a message requires immediate course correction, append it normally and then explicitly interrupt the current Run:

~~~bash
curl -sS -X POST "$API/requirements/$requirement_id/reply" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Stop here. Do not change the API; add only the regression test."}'

curl -sS -X POST "$API/requirements/$requirement_id/interrupt" \
  -H 'Content-Type: application/json' \
  -d '{}'
~~~

When /api/requirements reports waiting_confirmation, inspect the result and confirm completion:

~~~bash
curl -sS -X POST "$API/requirements/$requirement_id/confirm" \
  -H 'Content-Type: application/json' \
  -d '{}'
~~~

A 202 Accepted response from start, reply, or review means only that the background task was accepted. Automation must use SSE or query final state.

## 10. Error responses

Errors use a consistent JSON shape:

~~~json
{
  "error": "provider must be codex or claude-code"
}
~~~

| HTTP status | Meaning |
| --- | --- |
| 400 Bad Request | Invalid JSON syntax, body type or size, or request fields |
| 404 Not Found | Requirement, Session, attachment, or PR does not exist |
| 409 Conflict | Illegal state transition or an incompatible active Run/Review already exists |
| 500 Internal Server Error | Unclassified server error |

A background Agent Run failure cannot change an already returned 202 Accepted response. Read final state through /api/runs, /api/sessions, /api/review-requests, or SSE.
