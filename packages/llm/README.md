# 模型适配器

本层把外部模型调用协议转换为 `ModelProvider`，不选择模型、不读取 Host 环境变量，也不实现 Agent 循环。

- [`openai-compatible`](openai-compatible/README.md)：Chat Completions HTTP/SSE。
- [`gateway`](gateway/README.md)：已授权的 Platform 模型网关。
