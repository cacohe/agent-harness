# ADR 0025：CLI 的 MCP stdio 组合

状态：已接受；工具来源互斥部分由 ADR 0028 取代

## 背景

`tools/mcp` 已定义不依赖传输的工具映射，但 CLI 不能启动真实 MCP server，因此 MCP 尚不能作为可配置的工具来源。MCP 协议与 stdio 进程生命周期属于 Host，不能引入 Agent、Runtime 或工具映射 adapter。

## 决策

CLI 在 `mcp` 配置存在时构造 `StdioMcpClient`，通过官方 MCP TypeScript client 完成当前协议协商、stdio JSON-RPC 与子进程生命周期，并注入既有 `McpToolAdapter`。启动时先完成工具发现，关闭时在 Runtime 之后关闭 MCP adapter。

`mcp.environment` 只允许把子进程变量名映射到 Host 环境变量名；密钥值不写入 JSON。子进程使用 SDK 的安全默认继承环境，再叠加显式映射。为避免工具目录重复与执行路由隐式化，当前 CLI 将 MCP 与本机 shell 配置设为互斥。

## 后果

MCP stdio server 成为可配置、可运行的 CLI 工具来源，同时 Agent、Runtime 与 `tools/mcp` 保持不依赖 SDK 或子进程。Streamable HTTP MCP、多个工具来源的合并和 Platform 托管的认证仍由后续 Host adapter 负责。

## 放弃的方案

- 将 SDK 或子进程管理放入 `tools/mcp`：会使协议映射 adapter 承担 Host 生命周期与进程所有权。
- 将 MCP 与 shell 直接拼接为一个未校验的工具表：会使重复工具名的模型可见目录与执行路由不一致。
- 将 MCP 密钥直接保存到 JSON：会扩大本地密钥泄露面。
