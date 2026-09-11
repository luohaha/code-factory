# Agent Manager HTTP API Reference

本文档描述当前 Agent Manager 对外提供的 HTTP API。它适用于 Web Dashboard、自动化脚本，以及由 Agent Manager 启动的 RD Agent。

若需要了解对话投递、Run 恢复和 Review 闭环等设计语义，请参阅 [HTTP 与事件协议](protocol.md)；领域模型和状态机见 [最终架构与领域模型](architecture.md)。

## 1. 开始使用

Agent Manager 默认监听 `127.0.0.1:4310`，API base URL 为：

~~~text
http://127.0.0.1:4310/api
~~~

Agent Manager 默认每 30 秒通过本机已认证的 `gh` CLI 同步 Draft/Open PR 的状态、评论、Review、行级 review comment 和 CI 失败。使用 `--pr-reconcile-interval SECONDS` 修改轮询间隔，设为 `0` 可关闭。同步产生的消息仍通过本文档中的 Requirement conversation 与 SSE 接口展示和投递。

可以先用健康检查确认服务和当前 workspace：

~~~bash
curl http://127.0.0.1:4310/api/health
~~~

~~~json
{
  "ok": true,
  "workspaceRoot": "/path/to/workspace"
}
~~~

除附件上传端点和 SSE 端点外，响应与请求均为 JSON。JSON POST 请求体不能超过 1 MB；附件上传使用原始二进制 body，单个不能超过 20 MB。当前 API 没有版本前缀。

服务默认只监听本机地址，尚不提供身份认证。通过 `--host` 暴露到其他网络前，应先评估访问风险。CLI 可用 `--allow-origin <origin>` 配置单个 CORS origin。

## 2. 接口一览

| Method | Path | 用途 |
| --- | --- | --- |
| `GET` | `/api/health` | 健康检查 |
| `GET` | `/api/workspace` | 查询当前 workspace 和数据库路径 |
| `GET` | `/api/requirements` | 列出需求及其 RD Session |
| `POST` | `/api/requirements` | 创建需求及其 RD Session |
| `POST` | `/api/requirements/:id/start` | 启动或重试需求 |
| `POST` | `/api/requirements/:id/reply` | 向需求对话发送人工消息 |
| `POST` | `/api/requirements/:id/confirm` | 确认已完成的需求 |
| `GET` | `/api/requirements/:id/messages` | 查询需求的完整对话 |
| `POST` | `/api/requirements/:id/attachments` | 上传一个待发送的对话附件 |
| `GET` | `/api/attachments/:id` | 读取或下载已上传附件 |
| `GET` | `/api/sessions` | 列出 RD Session |
| `GET` | `/api/runs` | 列出 RD 和 Reviewer Run |
| `GET` | `/api/pull-requests` | 列出已登记的 PR |
| `POST` | `/api/pull-requests/:id/review-requests` | 发起 PR Review |
| `GET` | `/api/review-requests` | 列出 Review Request |
| `GET` | `/api/events` | 订阅可恢复的 SSE 事件流 |
| `POST` | `/api/agent/pull-requests` | RD Agent 登记或更新 PR |
| `POST` | `/api/agent/requirements` | RD Agent 提议后续需求 |

路径参数中的 ID 应进行 URL 编码。Requirement、Session、Run、PR 和 Review Request 列表按最近更新时间或创建时间优先返回；消息和事件按序号升序返回。列表响应格式为：

~~~json
{
  "items": []
}
~~~

列表接口目前不支持分页；`GET /api/events` 首次连接时最多补发 200 个历史事件。

## 3. 数据模型

所有时间字段都是 ISO 8601 字符串。尚未产生的值以 `null` 返回，不会省略。

### 3.1 Requirement

~~~ts
interface Requirement {
  id: string;                         // req_<uuid>
  title: string;
  description: string;
  status: 'todo' | 'doing' | 'waiting_confirmation' | 'done' | 'cancelled';
  provider: 'codex' | 'claude-code';
  createdBy: 'human' | 'rd_agent';
  parentRequirementId: string | null;
  sourceSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  session: AgentSession;
}
~~~

查询和创建 Requirement 时，响应总是内嵌它唯一绑定的 `session`。

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

`nativeSessionId` 是 Codex 或 Claude Code 的原生会话 ID。`pendingMessageCount` 表示尚未成功投递给 RD 的外部消息数量。

### 3.3 AgentRun

~~~ts
interface AgentRun {
  id: string;                         // run_<uuid>
  requirementId: string;
  sessionId: string | null;           // Reviewer Run 为 null
  role: 'rd' | 'reviewer';
  provider: 'codex' | 'claude-code';
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

`inputFromSequence` 和 `inputToSequence` 记录本次 RD Run 捕获的需求消息范围；Reviewer Run 的这两个字段为 `null`。

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

`sequence` 在单个 Requirement 内单调递增。`deliverToRd=true` 表示该消息需要由 RD 消费；RD 自己的输出不会再次投递给自身。

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

`repository + number` 是 PR 的幂等键。

### 3.6 ReviewRequest

~~~ts
interface ReviewRequest {
  id: string;                         // rev_<uuid>
  pullRequestId: string;
  runId: string;
  provider: 'codex' | 'claude-code';
  targetHeadSha: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled';
  requestedBy: 'human';
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
}
~~~

Review 开始时会固定 `targetHeadSha`，因此结果只代表该版本。

Reviewer Run 超时时，对应 `AgentRun.status` 为 `timed_out`，而 `ReviewRequest.status` 归一为 `failed`。

## 4. 系统查询接口

### `GET /api/health`

返回服务状态和 Agent Manager 启动时绑定的 workspace。

成功响应：`200 OK`

~~~json
{
  "ok": true,
  "workspaceRoot": "/path/to/workspace"
}
~~~

### `GET /api/workspace`

成功响应：`200 OK`

~~~json
{
  "root": "/path/to/workspace",
  "databasePath": "/home/user/.code-factory/workspaces/7a60b5f8c3d94945/factory.sqlite",
  "logFilePath": "/home/user/.code-factory/workspaces/7a60b5f8c3d94945/logs/agent-manager.log"
}
~~~

`logFilePath` 指向当前活跃日志的稳定符号链接；实际日志文件按日期和大小滚动。

### `GET /api/requirements`

返回所有未取消的 Requirement，每项包含对应的 `AgentSession`。

成功响应：`200 OK`，body 为 `{ "items": Requirement[] }`。

### `GET /api/sessions`

返回全部 RD Session。

成功响应：`200 OK`，body 为 `{ "items": AgentSession[] }`。

### `GET /api/runs`

可选 query 参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `requirementId` | string | 仅返回指定 Requirement 的 Run |

成功响应：`200 OK`，body 为 `{ "items": AgentRun[] }`。不存在的 `requirementId` 返回空数组。

### `GET /api/requirements/:id/messages`

按 `sequence` 升序返回指定 Requirement 的完整对话。

成功响应：`200 OK`，body 为 `{ "items": RequirementMessage[] }`。

指定 Requirement 不存在时返回 `404 Not Found`。

### `POST /api/requirements/:id/attachments`

上传一个附件并返回 Attachment。请求 body 是文件原始字节，不是 JSON；`X-File-Name` 使用 URI 编码后的原始文件名。单个文件最大 20 MB。PNG、JPEG、GIF 和 WebP 会按文件签名识别为 `kind=image`，其他内容为 `kind=file`。

~~~bash
curl -X POST http://127.0.0.1:4310/api/requirements/req_.../attachments \
  -H 'Content-Type: text/plain' \
  -H 'X-File-Name: debug.log' \
  --data-binary @debug.log
~~~

成功响应为 `201 Created`。上传后，将返回的 `id` 放入 `start` 或 `reply` 的 `attachmentIds`；每条消息最多包含 6 个附件。附件和关联消息都持久化，Agent Manager 重启后仍可读取。

### `GET /api/attachments/:id`

返回附件内容。安全的栅格图片使用 `Content-Disposition: inline`，其他文件强制使用 `attachment` 下载，并统一返回 `X-Content-Type-Options: nosniff`。Attachment 不存在时返回 `404 Not Found`。

### `GET /api/pull-requests`

可选 query 参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `requirementId` | string | 仅返回指定 Requirement 登记的 PR |

成功响应：`200 OK`，body 为 `{ "items": PullRequest[] }`。不存在的 `requirementId` 返回空数组。

### `GET /api/review-requests`

可选 query 参数：

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `pullRequestId` | string | 仅返回指定 PR 的 Review Request |

成功响应：`200 OK`，body 为 `{ "items": ReviewRequest[] }`。不存在的 `pullRequestId` 返回空数组。

## 5. Requirement 操作

### `POST /api/requirements`

创建一个由人类提出的 Requirement，并同时创建它唯一绑定的 RD Session。创建后不会自动启动 Agent。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `title` | string | 是 | 去除首尾空白后不能为空 |
| `description` | string | 是 | 去除首尾空白后不能为空 |
| `provider` | string | 是 | `codex` 或 `claude-code` |

~~~bash
curl -X POST http://127.0.0.1:4310/api/requirements \
  -H 'Content-Type: application/json' \
  -d '{
    "title": "为导出任务增加超时",
    "description": "超时后停止子进程并记录失败原因",
    "provider": "codex"
  }'
~~~

成功响应：`201 Created`，body 为新建的 `Requirement`。其初始状态为 `todo`，Session 初始状态为 `idle`。

### `POST /api/requirements/:id/start`

启动尚未运行的 Requirement，或重试一个失败的 RD Session。可选的 `message` 和 `attachmentIds` 会先写入需求对话，再随本次或下一次 Run 投递。

请求体可为空，或为：

~~~json
{
  "message": "先看截图复现问题，再补回归测试。",
  "attachmentIds": ["att_..."]
}
~~~

成功响应：`202 Accepted`

~~~json
{
  "accepted": true,
  "requirementId": "req_...",
  "action": "start"
}
~~~

接口只表示任务已接受，Run 在后台执行。如果 Session 已在运行，接口仍返回 `202`；可选消息会排队供后续 Run 消费，但不会启动第二个并发 RD Run。通过 SSE 或查询 Run、Session 来跟踪结果。

Requirement 不存在时返回 `404`；已经 `done` 或 `cancelled` 时返回 `409 Conflict`。

### `POST /api/requirements/:id/reply`

向 Requirement 对话追加一条人工消息。Session 空闲时会自动启动 RD Run；正在运行时只排队，不中断当前 Run。

请求体：

~~~json
{
  "message": "请根据截图调整布局。",
  "attachmentIds": ["att_..."]
}
~~~

成功响应：`202 Accepted`

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
    "body": "请再覆盖超时后的重试路径。",
    "sequence": 3,
    "deliverToRd": true,
    "createdAt": "2026-09-11T02:30:00.000Z"
  }
}
~~~

`message` 可在包含 `attachmentIds` 时为空。`queued` 表示收到消息时 RD Session 是否正在运行。文字和附件都为空时返回 `400`；Requirement 不存在时返回 `404`；已经 `done` 或 `cancelled` 时返回 `409`。

### `POST /api/requirements/:id/confirm`

将处于 `waiting_confirmation` 的 Requirement 确认为 `done`，并将对应 Session 设为 `completed`。请求体可省略或使用空对象。

~~~bash
curl -X POST http://127.0.0.1:4310/api/requirements/req_.../confirm \
  -H 'Content-Type: application/json' \
  -d '{}'
~~~

成功响应：`200 OK`，body 为更新后的 `Requirement`。Requirement 不存在时返回 `404`；状态不是 `waiting_confirmation` 时返回 `409`。

## 6. Pull Request Review

### `POST /api/pull-requests/:id/review-requests`

为一个已登记且状态为 `open` 的 PR 发起短生命周期 Reviewer Run。这里的 `:id` 是 Code Factory 的 `pr_<uuid>`，不是 GitHub PR number。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `provider` | string | 是 | `codex` 或 `claude-code` |
| `prompt` | string | 否 | 追加到 Reviewer system/developer 指令的 Review 关注点；Reviewer 的任务 prompt 始终只是 `Review GitHub PR <url>` |

~~~bash
curl -X POST http://127.0.0.1:4310/api/pull-requests/pr_.../review-requests \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "claude-code",
    "prompt": "重点检查并发状态转换和失败恢复。"
  }'
~~~

成功响应：`202 Accepted`

~~~json
{
  "accepted": true,
  "pullRequestId": "pr_...",
  "provider": "claude-code"
}
~~~

Reviewer 在后台运行，接口不会等待 Review 完成。PR 不存在时返回 `404`；PR 不是 `open` 或同一 PR 已有活跃 Review 时返回 `409`。

## 7. RD Agent 接口

这两个接口供 Agent Manager 启动的 RD Agent 使用。Agent 会在 developer/system 指令中收到 API base URL、当前 Requirement ID 和 Session ID。

### `POST /api/agent/pull-requests`

登记或更新 GitHub PR 元数据。相同 `repository + number` 的后续请求更新同一条记录，但不能推进已登记 PR 的 lifecycle 状态；`draft/open/closed/merged` 由 PR Reconciler 根据 GitHub 推进。

请求体的所有字段均为必填：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `requirementId` | string | PR 所属 Requirement ID |
| `repository` | string | GitHub `owner/repository` |
| `number` | positive integer | GitHub PR number |
| `url` | string | PR URL |
| `title` | string | PR 标题 |
| `baseBranch` | string | 目标分支 |
| `headBranch` | string | 来源分支 |
| `headSha` | string | 当前 head commit SHA |
| `status` | string | `draft`、`open`、`closed` 或 `merged` |

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

成功响应：`200 OK`，body 为创建或更新后的 `PullRequest`。Requirement 不存在时返回 `404`；字段无效时返回 `400`。

Agent 应在 PR 创建后登记，并且只在自己的 push 或编辑改变标题、分支或 head SHA 等元数据时再次调用。首次登记后，请求中的 `status` 字段会被忽略并保留 Agent Manager 已记录的状态；GitHub 状态事件由 PR Reconciler 自动同步，Agent 收到相应 System 消息时不得重复调用该接口。

### `POST /api/agent/requirements`

提议一个与当前工作分开跟踪的后续 Requirement。新 Requirement 只以 `todo` 创建，不会自动运行。

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `sourceSessionId` | string | 是 | 发现后续工作的 RD Session |
| `parentRequirementId` | string | 否 | 默认使用来源 Session 的 Requirement；若提供，必须与其一致 |
| `title` | string | 是 | 后续需求标题 |
| `description` | string | 是 | 后续需求描述 |
| `provider` | string | 否 | `codex` 或 `claude-code`；默认继承来源 Session |

~~~bash
curl -X POST http://127.0.0.1:4310/api/agent/requirements \
  -H 'Content-Type: application/json' \
  -d '{
    "sourceSessionId": "ses_...",
    "parentRequirementId": "req_...",
    "title": "增加导出任务性能基准",
    "description": "单独记录大数据集下的吞吐量和内存峰值",
    "provider": "codex"
  }'
~~~

成功响应：`201 Created`，body 为新建的 `Requirement`，其中 `createdBy` 为 `rd_agent`。来源 Session 不存在时返回 `404`；`parentRequirementId` 与来源 Session 不匹配或字段无效时返回 `400`。

## 8. SSE 事件流

### `GET /api/events`

建立 `text/event-stream` 连接并持续接收 Manager 事件。使用可选的 `after` query 参数补发 ID 大于指定值的历史事件：

~~~bash
curl -N 'http://127.0.0.1:4310/api/events?after=41'
~~~

~~~text
id: 42
event: message.created
data: {"id":42,"type":"message.created","requirementId":"req_...","sessionId":"ses_...","runId":null,"payload":{"message":{"id":"msg_..."}},"createdAt":"2026-09-11T02:30:00.000Z"}

~~~

每个 `data` 都是完整的 `ManagerEvent`：

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

当前事件类型及主要 payload：

| 事件 | payload |
| --- | --- |
| `requirement.created` | `provider`、`createdBy` |
| `requirement.completed` | 空对象 |
| `message.created` | `message` |
| `pull_request.created` | `pullRequest` |
| `pull_request.updated` | `pullRequest` |
| `review_request.started` | `reviewRequestId`、`pullRequestId`、`provider`、`targetHeadSha` |
| `run.started` | RD Run 的 `role`、`provider`、`resumed` 和输入消息范围 |
| `run.succeeded` | `role`、`exitCode`、`nativeSessionId`、`finalMessage`、`error` |
| `run.failed` | 同上 |
| `run.timed_out` | 同上 |
| `run.cancelled` | 同上 |
| `manager.reconciled` | 重启时修复的 `runIds` 和 `requirementIds` |

客户端应保存最后成功处理的事件 ID，并在重连时作为 `after` 传入。若 `after` 缺失或不是有限数字，服务会从 `0` 开始补发；单次连接最多补发 200 个已有事件，之后继续推送实时事件。

## 9. 典型调用流程

下面的流程展示如何从命令行创建、启动并确认一个 Requirement。示例使用 `jq` 从响应中提取 ID。

~~~bash
API=http://127.0.0.1:4310/api

requirement=$(
  curl -sS -X POST "$API/requirements" \
    -H 'Content-Type: application/json' \
    -d '{
      "title": "补充导出超时处理",
      "description": "实现超时并覆盖失败恢复测试",
      "provider": "codex"
    }'
)
requirement_id=$(printf '%s' "$requirement" | jq -r '.id')

curl -sS -X POST "$API/requirements/$requirement_id/start" \
  -H 'Content-Type: application/json' \
  -d '{"message":"请先运行现有测试。"}'
~~~

另开一个终端订阅事件。生产客户端应记录收到的最后一个事件 ID，并在断线重连时传给 `after`：

~~~bash
API=http://127.0.0.1:4310/api
curl -N "$API/events?after=0"
~~~

执行期间可以继续追加消息。响应中的 `queued` 表明消息是等待下一个 Run，还是已经触发了新的 Run：

~~~bash
curl -sS -X POST "$API/requirements/$requirement_id/reply" \
  -H 'Content-Type: application/json' \
  -d '{"message":"同时检查超时后的子进程是否退出。"}'
~~~

当 `/api/requirements` 显示 Requirement 已进入 `waiting_confirmation`，检查结果后完成确认：

~~~bash
curl -sS -X POST "$API/requirements/$requirement_id/confirm" \
  -H 'Content-Type: application/json' \
  -d '{}'
~~~

`start`、`reply` 和 Review 接口的 `202 Accepted` 只代表后台任务已接受。自动化调用方应以 SSE 事件或查询接口中的最终状态为准。

## 10. 错误响应

错误统一返回 JSON：

~~~json
{
  "error": "provider must be codex or claude-code"
}
~~~

| HTTP 状态 | 含义 |
| --- | --- |
| `400 Bad Request` | JSON 语法、body 类型或大小错误，或请求字段无效 |
| `404 Not Found` | 指定的 Requirement、Session 或 PR 不存在 |
| `409 Conflict` | 非法状态转换，或已存在不兼容的活跃 Run/Review |
| `500 Internal Server Error` | 未分类的服务端错误 |

后台 Agent Run 的失败不会把已经返回的 `202 Accepted` 改为 HTTP 错误。请通过 `/api/runs`、`/api/sessions`、`/api/review-requests` 或 SSE 事件读取最终状态。
