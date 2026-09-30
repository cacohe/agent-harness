# ADR 0018：以显式生命周期适配 MCP 工具

## 背景

MCP Server 是可替换的外部工具来源。Agent core 只认识同步的 `ToolCapability`，不能依赖 MCP SDK、stdio、HTTP、进程或认证协议；同时远程工具表必须在模型调用前完成校验。

## 决策

新增 `tools/mcp` adapter。它接收显式 `McpClient` capability，`start` 拉取并冻结工具表，`list` 只在成功启动后向模型公开工具 schema，`execute` 把工具调用转发为 client 调用。所有外部结果、工具描述和调用结果在 adapter 边界校验为 JSON。启动、执行和关闭均接受 `AbortSignal`。

## 后果

Host 或 Platform 可以分别实现 stdio、Streamable HTTP 或认证 client，并在组合点负责 start/close；Agent、Runtime 和 domain 不依赖 MCP 协议。当前 adapter 不解析 JSON Schema 来重复服务端参数校验；它保证模型输入和远程结果为 JSON，具体 MCP Server 仍是其 schema 的权威校验者。

## 放弃的方案

不把 MCP client 或网络传输放进 `core/tools`，也不在 adapter 内隐式启动子进程。两者都会把进程、凭据和连接所有权泄漏到核心循环。
