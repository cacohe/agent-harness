# OpenAI Compatible Adapter 规则

- 这个 package 只把 OpenAI-compatible Chat Completions HTTP/SSE 协议转换为 `@agent-harness/kernel` capability。
- 不得导入 Agent、Runtime、Host、Session 或任何模型 SDK；网络依赖只能由构造参数传入或 Node.js 原生 `fetch` 提供。
- 所有外部 HTTP 与 SSE 数据都在此处严格校验。不得在不完整或矛盾的 tool call 上推测调用。
- 配置不得读取环境变量；鉴权、请求头与 URL 都由显式配置决定。
