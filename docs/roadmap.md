# 开发路线图

## M0：v2 架构收敛（已完成）

- Agent Manager 命名与 workspace-scoped 边界；
- Requirement 与 RD AgentSession 严格一对一，PullRequest 是第三类领域实体；
- 移除 QA Agent、Agent Pool、Scheduler 和独立消息队列，对话本身作为 RD 消息流；
- Requirement 与 Session 两套状态机；
- Reviewer 定义为无持久 Session 的短程 Run。

## M1：本地可运行内核（本次已实现）

- TypeScript Agent Manager 包与 CLI；
- SQLite schema、业务级 Store 和 workspace 隔离的数据路径；
- Requirement/Session/Run/Event 持久化；
- RequirementMessage 消费边界、PullRequest 与 ReviewRequest 持久化；
- 单 AgentSession 活跃 Run 互斥约束，不同需求可并行；
- Codex、Claude Code 新建/恢复 RD 会话；
- 两种 CLI 的临时 Reviewer；
- 子进程超时、JSONL 归一化和原生 session id 捕获；
- HTTP 查询/操作接口和 SSE；
- 需求看板与 Agent Session 看板 Web 原型。

## M2：Web 接入与恢复能力（核心交互已实现）

- [x] Web 从 Agent Manager HTTP/SSE 读取真实数据；
- [x] Jira 式需求详情、持久化 Agent 输出与人工回复；
- [x] Agent Manager 启动时 reconciliation：清理遗留 `running` 状态；
- [x] RD 运行期间接收 Human/Reviewer 消息，并在当前 Run 后自动续跑；
- [x] RD 输出只展示，不回灌为下一轮输入；
- [ ] 完整 Run 时间线和工具执行日志；
- Run 主动取消与优雅终止；
- 本地访问令牌、Origin 白名单和诊断日志脱敏；
- CLI 可用性、登录状态与版本预检。

## M3：Git / PR 闭环（基础流程已实现）

- [ ] GitHub App 或 Provider 抽象与 Webhook 签名校验；
- [x] PR/head SHA 与 Requirement 关联，PR 独立看板；
- [x] 人类在 Open PR 上选择 Reviewer Agent；
- [x] Reviewer 摘要写入需求对话并自动唤醒 RD Session；
- [x] RD Agent API：登记 PR、提议新的 TODO 需求；
- PR 创建/更新/评论/合并 webhook；
- [x] Reviewer 结果绑定发起时的 head SHA；
- [ ] 在 UI 显式标识 head SHA 更新后的旧 Review 为 stale；
- [ ] 结构化校验 Reviewer 已成功发布 GitHub 行级评论；
- 合并后进入人工完成确认。

## M4：可靠性与可扩展存储

- PostgreSQL Store 实现与迁移工具；
- 进程 lease、崩溃恢复和事件幂等强化；
- 指标、Tracing、保留策略和审计日志；
- 显式 worktree 隔离模式，支持同 workspace 多需求并行；
- 权限策略模板和可配置资源限制。

## 验收原则

每个里程碑都必须维持以下不变量：

1. Requirement 创建时已有唯一 RD AgentSession；
2. 人类回复继续的是同一个逻辑 Session；
3. Reviewer 不成为长期 Session；
4. cwd 和 Skills 来源只由 Agent Manager 启动目录及 Agent CLI 原生规则决定；
5. 没有“等待调度”状态；不同需求可以并行，同一 Session 不允许重入。
6. Human/Reviewer 的对话消息可靠投递，RD 自己的输出不重复投递。
