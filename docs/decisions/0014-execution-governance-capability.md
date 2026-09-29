# ADR 0014：执行上下文与工具执行策略

## 状态

已接受。

## 背景

Runtime 需要在不依赖 Platform SDK、HTTP 协议或身份提供方的前提下，让一次 turn 携带被冻结的执行身份与授权版本，并在每次工具调用前执行可替换的许可判断。未来的 Platform、审批和 Sandbox 都需要复用该边界。

## 决策

`core/tools` 拥有 `ExecutionContext`、`ToolExecutionPolicy` 与 `PolicyControlledTools`。

- `Agent.run` 可接收一次性的执行上下文；开始 turn 时将其最小审计快照写入 `turn.started`。上下文不进入模型消息。
- Agent 在工具调用时将同一个已冻结上下文交给支持上下文的工具 capability。
- `PolicyControlledTools` 在委派真实工具前调用 `ToolExecutionPolicy`。策略只返回允许或拒绝；拒绝转换为持久化的 `ToolAuthorizationError` 结果，真实工具不执行。
- 审批、远程 Platform 授权与 Sandbox 是策略或工具 capability 的 adapter，不属于 Agent、domain 或 session 的依赖。
- 没有传入执行上下文的既有调用保持可用；只有组合 `PolicyControlledTools` 的部署要求该上下文存在。

## 后果

工具结果继续是模型可见且可恢复的事实；turn 的执行标识、主体和授权版本可审计但不会暴露给模型。后续接入 Platform 时，adapter 应将一次性 permit 绑定到执行标识、工具调用标识、输入摘要和失效时间，并以其自身的 outbox 交付计费和审计记录。

不在本决定中实现用户账户、JWT、远程审批协议、计费上报、容器 Sandbox 或长期记忆存储。

## 放弃的方案

- 让 Agent 直接调用 Platform：会把网络协议、账户模型和认证 SDK 引入核心状态机，破坏依赖方向。
- 将执行身份作为 system prompt 或 user message：会泄露审计字段给模型，并使授权事实与自然语言上下文混淆。
- 由工具各自实现授权：会造成策略不一致，也无法在 MCP、Sandbox 和未来工具之间复用审批语义。
