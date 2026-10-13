# Adapters

`@agent-harness/adapters` 集中保存具体能力实现，并通过子路径导出：上下文、JSONL 会话、OpenAI-compatible 与 Gateway 模型、MCP、Skills、Memory、Platform HTTP、本地工具与 Sandbox。

它只依赖 `@agent-harness/kernel`。`kernel`、`core` 不得反向依赖这里的实现；Host 负责配置、凭据和进程协议，`adapters/local-runtime` 提供 CLI 与 Web 共用的本地 JSONL、OpenAI-compatible 默认构造。
