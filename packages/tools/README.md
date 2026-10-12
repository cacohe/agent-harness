# 工具能力

本层实现工具目录、组合、执行治理和外部工具协议适配器。Host 负责选择并组合实际来源。

- [`tool-runtime`](tool-runtime/README.md)：本地目录、组合与策略包装。
- [`mcp`](mcp/README.md)：MCP 客户端适配器。
- [`platform-policy`](platform-policy/README.md)：Platform 单次许可策略。
- [`sandbox-docker`](sandbox-docker/README.md)：Docker OCI 沙箱调度器。
