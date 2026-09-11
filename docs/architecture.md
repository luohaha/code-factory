# Code Factory 最终架构

English version: [architecture.en.md](architecture.en.md)

## 1. 领域模型

系统有三个一等领域实体：

- `Requirement`：类似 Jira Issue，承载业务状态和完整对话；
- `AgentSession`：每条 Requirement 唯一绑定的长期 RD 会话；
- `PullRequest`：Requirement 产生的 GitHub PR，一条 Requirement 可以关联多个 PR。

`AgentRun`、`RequirementMessage` 和 `ReviewRequest` 是执行与交互记录，不是需要调度的长期 Agent。

~~~mermaid
erDiagram
  Requirement ||--|| AgentSession : owns
  Requirement ||--o{ RequirementMessage : contains
  Requirement ||--o{ PullRequest : produces
  AgentSession ||--o{ AgentRun : resumes
  PullRequest ||--o{ ReviewRequest : receives
  ReviewRequest ||--|| AgentRun : executes
~~~

Agent Manager 不是 Scheduler：没有 Agent Pool，也没有“等待调度”。Requirement 创建时立即创建并绑定 RD AgentSession。

## 2. 运行边界

~~~mermaid
flowchart LR
  H[人类] -->|创建需求 / 发送消息 / Request review| M[Agent Manager]
  W[Web 看板] <-->|HTTP + SSE| M
  M <--> DB[(SQLite)]
  M -->|同一 cwd，长期 resume| RD[Codex / Claude Code RD]
  M -->|短程、无持久 Session| RV[Codex / Claude Code Reviewer]
  RD -->|登记 PR / 提议新需求| API[Agent API]
  API --> M
  RV -->|GitHub 行级评论| GH[GitHub PR]
  RV -->|Reviewer 消息| M
~~~

Agent Manager 启动时以 `realpath(process.cwd())` 固定 workspace。RD 和 Reviewer 子进程均使用该目录，Codex/Claude Code 按自己的原生目录规则加载 AGENTS.md、CLAUDE.md、Skills 和配置。

Agent Manager 只额外注入一段 Code Factory 协议指令，告诉 RD 当前 Requirement/Session ID 以及可调用的本地 Agent API；它不复制或替换项目自身的 Skills。

所有 headless RD 和 Reviewer 调用都会跳过交互审批与 CLI 沙箱检查，继承启动用户的完整文件系统、网络和命令执行权限。因此 Agent Manager 只能在可信 workspace 中启动。Reviewer 的“只读”由任务 prompt 约束，不是操作系统级安全边界。

## 3. 实体

### Requirement

- `status`：`todo | doing | waiting_confirmation | done | cancelled`；
- `provider`：`codex | claude-code`；
- `createdBy`：`human | rd_agent`；
- Agent 提议的新需求记录 `parentRequirementId` 和 `sourceSessionId`；
- Agent 提议只创建 TODO，不自动运行，避免递归失控。

### AgentSession

- 与 Requirement 严格一对一；
- 保存原生 Codex thread id 或 Claude session id；
- `state`：`idle | running | waiting_human | failed | completed`；
- `lastConsumedMessageSequence` 是 RD 已成功消费的对话边界；
- `pendingMessageCount` 是尚未投递的外部消息数量。

### PullRequest

- 与 Requirement 是 N:1；
- GitHub 身份为 `repository + number`；
- 保存 URL、标题、base/head branch、head SHA；
- 状态与 GitHub 对齐：`draft | open | closed | merged`。

### ReviewRequest

- 只允许人类在 Open PR 上发起；
- 人类明确选择 `codex` 或 `claude-code`；
- 每次请求捕获不可变的 `targetHeadSha`；
- 对应一个短程 Reviewer AgentRun，不创建 AgentSession；
- 同一个 PR 同时只允许一个活跃 ReviewRequest。

## 4. 对话即 RD 消息流

系统不维护独立 RD 消息队列表。`requirement_messages` 是展示和投递的唯一事实来源：

| 作者 | 展示在需求对话 | 投递给 RD |
| --- | --- | --- |
| Human | 是 | 是 |
| Reviewer | 是 | 是 |
| RD Agent | 是 | 否 |
| System | 是 | 按事件决定 |

每条消息有单调递增的 `sequence` 和 `deliverToRd`。RD Run 启动时捕获尚未消费的外部消息范围 `inputFromSequence..inputToSequence`：

1. 同一 Session 已运行时，新消息只追加到需求对话，不中断当前进程；
2. Run 成功后，消费游标只推进到该 Run 启动时捕获的 `inputToSequence`；
3. 若仍有未消费外部消息，Agent Manager 自动 resume 同一 RD Session；
4. 多条新消息在下一轮合并投递并保持顺序；
5. Run 失败不推进游标，重试不会丢消息；
6. RD 自己的输出永不作为正常的下一轮输入。

只有原生会话丢失且需要恢复时，才会从需求对话生成上下文摘要，而不是在正常流程中重放 RD 输出。

## 5. Review 闭环

~~~text
Open PR
  → 人类点击 Request review 并选择 Agent
  → Reviewer 对捕获的 head SHA 执行原生 review
  → Reviewer 通过 GitHub CLI/API 发布行级评论
  → Reviewer 摘要写入对应 Requirement 对话
  → 消息标记 deliverToRd=true
  → 空闲 RD 立即 resume；运行中 RD 在当前 Run 结束后 resume
~~~

Reviewer 不改变 Requirement 或 RD Session 状态，也不需要与 RD Run 串行。它必须通过 GitHub API 读取目标 PR/SHA，不能 checkout 或修改共享工作目录。PR head SHA 更新后，旧 Review 仅代表旧版本，需要人类再次发起 Review。

## 6. 状态机

Requirement：

~~~text
TODO → DOING → WAITING_CONFIRMATION → DONE
          ↑              │
          └──新外部消息──┘
~~~

RD AgentSession：

~~~text
IDLE → RUNNING → WAITING_HUMAN → RUNNING
          └────────→ FAILED → RUNNING
WAITING_HUMAN → COMPLETED
~~~

PR：

~~~text
DRAFT → OPEN → MERGED
          └──→ CLOSED
~~~

## 7. 并发

- 同一个 AgentSession 同时最多一个 RD Run；
- 不同 Requirement 的 RD Session 可以并行；
- Reviewer 是行为上只读的独立短任务，可以与 RD Run 并行；
- 同一个 PR 同时最多一个 ReviewRequest；
- 所有进程默认共享 Agent Manager 的 cwd，因此不同 RD 并行写入仍可能发生文件或 Git 状态冲突。MVP 不通过全局锁隐藏这个风险，后续提供可选 worktree 隔离。

## 8. Web

Web 有三个看板：

- Requirement：`TODO / DOING / 待确认 / DONE`；
- Pull Request：`DRAFT / OPEN / CLOSED / MERGED`；
- RD Session：`未运行 / 执行中 / 等待人类 / 异常 / 已结束`。

需求详情是 Jira 式工作面板：展示描述、关联 PR、运行信息以及 Human/RD/Reviewer/System 的统一对话。RD 运行时输入框仍可使用，未消费消息数会显示在需求卡和 Session 卡上。

运行 `npx @code-factory/agent-manager start` 后，Agent Manager 同一端口提供 API、SSE 和打包后的 Web 页面，并打印可点击 URL。
