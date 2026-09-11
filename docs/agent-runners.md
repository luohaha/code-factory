# Headless Agent Runner

## 1. 通用执行契约

Agent Manager 只支持 `codex` 和 `claude` 两个本机 CLI。每次调用都遵循以下约束：

- `cwd` 固定为 Agent Manager 启动目录；
- `shell: false`，不拼接 shell 命令；
- RD 与 Claude Reviewer 的 prompt 通过 stdin 传入，避免出现在进程参数和进程列表；Codex Reviewer 受 CLI 参数约束，Review 指令通过 `developer_instructions` 注入；
- 继承当前进程环境，由 CLI 自己读取登录状态、配置、项目指令和 Skills；
- 不传 `--cd` 或 `--add-dir`；Codex 和 Claude Code 均以无交互审批、无 CLI 沙箱限制的模式运行；
- stdout 按 JSONL 解析，stderr 保留为错误摘要；
- RD 默认超时 60 分钟，Reviewer 最长 30 分钟；超时会终止 CLI 及其启动的整棵工具进程树；
- 人类打断 RD Run 时，POSIX 平台先向独立进程组发送 `SIGTERM`，2 秒后仍有后代存活则发送 `SIGKILL`；Windows 使用 `taskkill /T /F`。进程树停止后 Run 才记录为 `cancelled`；
- 同一个 RD AgentSession 只允许一个活跃 Run；不同需求的 Session 不经调度即可并行运行。
- 人类或 Reviewer 在 RD 运行期间发送的消息只写入需求对话，不触发打断；只有人类显式点击“打断”才会停止当前 Run，随后用同一原生 Session 处理排队消息；
- Agent Manager 为 RD 注入本地 Agent API 协议，项目指令和 Skills 仍由 CLI 根据 cwd 原生加载。

## 2. Codex

新建 RD 原生会话：

```bash
codex exec --json --color never --dangerously-bypass-approvals-and-sandbox \
  -c 'developer_instructions="...Code Factory API contract..."' -
```

恢复原生会话：

```bash
codex exec --json --color never --dangerously-bypass-approvals-and-sandbox \
  resume <thread-id> -
```

短程 Reviewer：

```bash
codex exec review --json --ephemeral \
  --dangerously-bypass-approvals-and-sandbox \
  -c 'developer_instructions="...PR URL, head SHA, review contract..."' \
  --base <base-branch>
```

`thread.started` 事件中的 `thread_id` 写入 AgentSession，后续 RD Run 复用它。Reviewer 使用 `--ephemeral`，不会形成可恢复的业务 Session。
Codex 的 Code Factory 运行协议通过官方支持的 `developer_instructions` 配置覆盖项追加，不替换仓库中的 `AGENTS.md`。`codex exec review` 不允许同时使用 `--base` 和位置参数 `[PROMPT]`，因此 Reviewer 不传 stdin 占位符 `-`，而是把指定 PR、不可变 head SHA 和 Review 约束一并注入 `developer_instructions`。

## 3. Claude Code

新建 RD 原生会话：

```bash
claude --print --output-format stream-json --verbose \
  --dangerously-skip-permissions --session-id <uuid> \
  --append-system-prompt "...Code Factory API contract..."
```

恢复原生会话：

```bash
claude --print --output-format stream-json --verbose \
  --dangerously-skip-permissions --resume <session-id>
```

短程 Reviewer：

```bash
claude --print --output-format stream-json --verbose \
  --no-session-persistence --dangerously-skip-permissions
```

Reviewer 的 stdin 以 `/review` 开头，让 Claude Code 直接使用当前目录可用的原生 review skill。`--no-session-persistence` 只负责保证它不会变成长生命周期会话。Reviewer 在权限层面不受限制，但 prompt 仍要求它只使用 GitHub CLI/API 读取指定 PR/head SHA、发布评论且不修改共享工作区。

## 4. 事件归一化

Adapter 把两种 CLI 的 JSONL 映射为：

- `session_started`：捕获原生 session id；
- `message`：Agent 文本输出；
- `completed`：模型回合结束；
- `error`：结构化错误；
- `other`：保留未知事件以便兼容 CLI 升级。

Agent Manager 自己只依赖归一化字段，原始事件可作为诊断流输出。人类回复和归一化后的 Agent/Reviewer 文本消息会持久化到需求对话，并通过 `message.created` 实时推送；原始 JSONL 和工具噪声不写入数据库，避免无限增长。

## 5. PR Reconciler

Agent Manager 启动后默认每 30 秒通过本机 `gh` CLI 轮询 Draft/Open PR。轮询读取 PR 状态、head SHA、普通 PR 评论、Review、行级 review comment 和 CI check：

- PR 状态变化与 CI 失败作为 System 消息；
- PR/Review 评论作为 Reviewer 消息，并用明显边界标记为不可信外部反馈；
- 活跃 Requirement 的消息设置 `deliverToRd=true`，复用既有对话游标触发或排队下一轮 RD Run；
- SQLite observation 保存 CI 前态，external event receipt 对评论、状态和 CI 事件持久去重；
- 首次接管旧 PR 时不回放已有评论和 CI，只修正落后的 PR 状态。

`--pr-reconcile-interval SECONDS` 可修改轮询间隔，`0` 关闭轮询。轮询需要启动用户已经通过 `gh auth login` 完成认证。

## 6. 恢复与失败

- CLI 启动后只要观测到原生 session id，就立即写入 AgentSession；
- Run 成功后先推进本次输入消息边界；有新外部消息时立即启动下一轮，否则 Requirement 进入 `waiting_confirmation`，Session 进入 `waiting_human`；
- Run 失败或超时后，Requirement 保持 `doing`，Session 进入 `failed`；
- Run 被人类打断后，Requirement 保持 `doing`，Session 回到 `waiting_human`；若打断时已有新纠偏消息，则立即恢复同一 Session；
- 人类重试或回复时仍使用同一个 AgentSession；已有原生 id 就 resume，没有则重新创建原生会话；
- Agent Manager 重启后不会把旧 PID 当成存活进程；启动 reconciliation 会把遗留 RD Run 标记为失败，并独立清理遗留 ReviewRequest，不污染 RD Session 状态。

## 7. 安全边界

Agent Manager 应只在用户信任的代码目录中启动。所有 headless RD 和 Reviewer 都会跳过 CLI 审批与沙箱检查，继承启动用户的完整文件系统、网络和命令执行权限；Agent Manager 启动时会在日志中明确记录此警告。Reviewer 的“只读”是 prompt 约束，不是操作系统级隔离。

HTTP 默认只监听 `127.0.0.1`，并只允许 `http://localhost:3000` 的本地 Web 看板跨域访问；可用 `--allow-origin` 覆盖。API 不接受客户端指定 cwd。生产化前还需要增加本地访问令牌、Webhook 签名验证、敏感字段脱敏和运行日志清理策略。

## 8. 运行日志

Agent Manager 默认把自身、Requirement、Run、PR reconciliation 和 HTTP 请求生命周期日志以 JSONL 追加到 `~/.code-factory/workspaces/<workspace-hash>/logs/agent-manager.log`，不向 stdout 或 stderr 打印运行日志。默认级别为 `info`，可通过 `--log-level debug|info|warn|error|silent` 或 `CODE_FACTORY_LOG_LEVEL` 调整；可通过 `--log-file PATH` 或 `CODE_FACTORY_LOG_FILE` 修改文件位置，命令行参数优先于环境变量。日志文件创建权限为 `0600`。

底层使用 `winston` 和 `winston-daily-rotate-file`。默认按本地日期写入 `agent-manager-YYYY-MM-DD.log`，单个文件达到 20 MB 后继续按大小切分，保留 14 天；`agent-manager.log` 是指向当前文件的稳定符号链接。`--log-max-size SIZE` / `CODE_FACTORY_LOG_MAX_SIZE` 可修改单文件上限，`--log-max-files COUNT_OR_DAYS` / `CODE_FACTORY_LOG_MAX_FILES` 可修改保留文件数或天数。

日志只包含关联排障所需的 ID、状态、耗时和错误，不记录 prompt、对话正文或 Agent 原始 stdout。直接通过库构造 `AgentManager` 时也默认写文件；宿主仍可注入自定义 `Logger`，显式接管日志目标与策略。
