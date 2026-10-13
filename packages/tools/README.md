# 工具能力

本层实现具体工具与外部协议适配器。通用工具目录、组合、授权包装和 Sandbox 路由位于 `kernel`。Host 负责选择并组合实际来源。

- [`local`](local/README.md)：可复用本地 Shell 与工作目录工具。
- [`mcp`](mcp/README.md)：MCP 客户端适配器。
- [`platform-policy`](platform-policy/README.md)：Platform 单次许可策略。
- [`sandbox-docker`](sandbox-docker/README.md)：Docker OCI 沙箱调度器。
