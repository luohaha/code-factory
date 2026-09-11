# Agent Manager HTTP 与事件协议

默认地址为 `http://127.0.0.1:4310`。API、SSE 和 Web 页面使用同一端口，只操作 Agent Manager 启动时绑定的 workspace。

逐接口的请求字段、响应模型、状态码和 `curl` 示例见 [Agent Manager HTTP API Reference](agent-manager-api.md)。本文档重点说明消息投递与事件协议。

## 1. 查询接口

~~~text
GET /api/health
GET /api/workspace
GET /api/requirements
GET /api/sessions
GET /api/runs?requirementId=<id>
GET /api/requirements/:id/messages
GET /api/attachments/:id
GET /api/pull-requests?requirementId=<id>
GET /api/review-requests?pullRequestId=<id>
GET /api/events?after=<event-id>
~~~

`GET /api/events` 是可通过事件 id 恢复的 SSE 流。

## 2. 人类接口

创建需求：

~~~http
POST /api/requirements
Content-Type: application/json

{
  "title": "Compaction Profile 增加分层耗时",
  "description": "补齐 segment merge、encode 与 flush 的统计",
  "provider": "codex"
}
~~~

驱动需求：

~~~text
POST /api/requirements/:id/start
POST /api/requirements/:id/reply
POST /api/requirements/:id/interrupt
POST /api/requirements/:id/confirm
POST /api/requirements/:id/attachments
~~~

文件先以原始二进制 body 上传到 `attachments` 端点，再把返回的 ID 作为 `attachmentIds` 随 `start` 或 `reply` 发送。每条消息最多 6 个附件、单个最大 20 MB；PNG、JPEG、GIF、WebP 会作为图片预览，其他文件作为普通附件下载。`reply` 的 JSON body 为 `{"message":"...","attachmentIds":["att_..."]}`；包含附件时文字可为空。RD 正在运行时，回复始终只追加到对话并排队，不会打断当前 Run。只有显式调用 `interrupt` 端点（Web 看板中的“打断”按钮）才会停止当前 RD Run。

人工发起 PR Review：

~~~http
POST /api/pull-requests/:id/review-requests
Content-Type: application/json

{
  "provider": "claude-code",
  "prompt": "可选的额外 Review 关注点"
}
~~~

只有 `open` PR 可以发起。每次请求捕获当前 head SHA，同一 PR 同时只允许一个活跃 Review。

## 3. RD Agent 接口

RD Agent 的 developer/system 指令中会收到 API base URL、Requirement ID 和 Session ID。

登记或更新 PR：

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

`status` 必须是 `draft | open | closed | merged`，仅用于首次登记。`repository + number` 幂等更新同一 PR 的元数据，但后续请求不能改变 lifecycle 状态；状态由 PR Reconciler 根据 GitHub 自动同步。

提议新的独立需求：

~~~http
POST /api/agent/requirements
Content-Type: application/json

{
  "sourceSessionId": "ses_...",
  "parentRequirementId": "req_...",
  "title": "补充性能基准",
  "description": "主线任务中发现的独立跟进项",
  "provider": "codex"
}
~~~

Provider 可省略并继承来源 Session。新需求以 `createdBy=rd_agent` 和 `TODO` 创建，不自动启动。

## 4. 消息投递

`GET /api/requirements/:id/messages` 返回统一对话。每条消息包含：

- `sequence`：需求内单调递增序号；
- `author`：`human | rd_agent | reviewer | system`；
- `deliverToRd`：是否需要投递给 RD；
- 可选的 `runId`；
- `attachments`：持久化附件列表；Codex 图片使用原生图片参数，其他文件通过本地绝对路径读取；Claude Code 通过消息中的本地绝对路径读取全部附件。

RD Run 记录 `inputFromSequence` 和 `inputToSequence`。成功后只推进到该输入边界；Run 执行期间到达的消息留给下一轮。RD Agent 自己的输出始终 `deliverToRd=false`。

## 5. SSE 事件

~~~text
id: 42
event: review_request.started
data: {"id":42,"type":"review_request.started",...}
~~~

当前事件包括：

- `requirement.created` / `requirement.completed`；
- `message.created`；
- `pull_request.created` / `pull_request.updated`；
- `review_request.started`；
- `run.started` / `run.succeeded` / `run.failed` / `run.timed_out` / `run.cancelled`；
- `manager.reconciled`。

PR Reconciler 通过 `pull_request.updated` 推送 GitHub 状态/head SHA 变化。新的 PR 评论、Review、行级 review comment 和 CI 失败会先写入需求对话，再通过 `message.created` 推送；事件 payload 带有 `source: "github"` 和 `pullRequestId`。外部事件使用 SQLite receipt 持久去重，Agent Manager 重启后不会重复投递。

## 6. 错误语义

- `400`：字段、JSON 或 body 大小错误；
- `404`：实体不存在；
- `409`：非法状态转换、同一 PR 已有活跃 Review，或显式重复启动同一 Session；
- `500`：未分类内部错误。

人类向运行中的 RD 发送消息是正常行为，不属于冲突。

## 7. 当前安全边界

服务默认只监听 `127.0.0.1`，Agent API 依赖本机进程边界，尚未增加访问令牌。生产化前需要本地令牌、Webhook 签名校验和权限审计。
