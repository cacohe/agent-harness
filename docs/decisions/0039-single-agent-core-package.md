# ADR 0039：Core 只保留 Agent 核心循环

## 背景

ADR 0038 已将 Agent 循环使用的协议无关契约集中到 Kernel，但迁移后仍把 `agent`、`session` 和 `tools` 三个实现 package 放在 `packages/core/` 下。这等同于把 Core 当作“核心实现层”的分组名，与项目所有者给出的更严格含义不一致：Core 应当是 Agent 核心循环本身，而不是所有协议无关实现的容器。

会话日志、恢复分析和工具注册虽然不依赖外部系统，也只依赖 Kernel，但它们分别属于会话与工具能力域。继续放在 Core 下会模糊职责，并使目录结构暗示 Agent 循环拥有这些实现。

## 决策

`packages/core` 成为单一 package，包名为 `@agent-harness/core`。它只包含 Agent 状态机、Inbox、turn/step 执行与结算、上下文组装以及模型消息投影。上下文组装和消息投影直接参与每一步模型请求，属于核心循环行为。

其他协议无关实现返回所属能力域：

- `session/session-memory` 提供 `InMemorySessionLog`；
- `session/session-lifecycle` 提供恢复历史的生命周期分析；
- `tools/tool-runtime` 提供工具注册、组合、策略包装和 Sandbox 任务路由。

这些 package 与外部 adapter 一样，只能依赖 `@agent-harness/kernel`，彼此不得建立生产依赖。Runtime 依赖 Core、会话生命周期分析和工具运行时，并通过 Kernel 接口接收会话 repository、模型和工具。Host 负责选择持久化、模型、Skill、MCP 和 Sandbox adapter。

架构 gate 将 `core` 识别为唯一 Core package，并把 `session-memory`、`session-lifecycle` 与 `tool-runtime` 识别为能力域实现。旧包名 `@agent-harness/agent`、`@agent-harness/session` 和 `@agent-harness/tools` 不保留兼容转发层，所有调用方直接迁移到新名称。

## 后果

目录名称与架构词汇保持一致：Core 可以被直接理解为 Agent 循环，Session 和 Tools 的变化不会扩张 Core。每个实现 package 的修改原因更单一，Runtime 的组合依赖也能明确展示哪些能力参与执行与恢复。

Workspace package 数量增加一个，因为会话内存实现和生命周期分析具有不同消费者与变化原因。它们共享 Kernel 契约，不通过新的公共辅助 package 复用私有实现。

此次迁移改变内部 workspace 包名，但仓库所有包均为 private，不承诺外部 npm 兼容性。运行行为、事件协议和持久化格式保持不变。

## 放弃的方案

保留 `core/agent`、`core/session` 和 `core/tools`，并把 Core 解释为实现层。该方案改动最小，但违反 Core 只表示 Agent 循环的已确认语义。

把会话生命周期分析并入 Runtime。生命周期分析是可独立测试的会话规则，不负责组合和资源所有权；放入 Runtime 会混合恢复规则与应用生命周期。

把工具运行时并入 Core。Agent 只需要 `ToolCapability`，不应拥有工具注册、跨来源路由、权限包装或 Sandbox 派发实现。
