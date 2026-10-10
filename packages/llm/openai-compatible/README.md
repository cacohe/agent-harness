# OpenAI Compatible Model Adapter

该 package 以 Node.js 原生 `fetch` 调用 OpenAI-compatible 的 `/v1/chat/completions` SSE 接口，并实现 `@agent-harness/kernel` 的 `ModelProvider`。

构造函数需要显式传入 provider 标识、绝对 API 根路径（例如 `https://api.example.com/v1`）、API key 与模型名。它会在根路径后追加 `chat/completions`；不要传入完整 endpoint。它不读取环境变量，也不实现重试、超时、回退或供应商选择。

仅支持 Chat Completions 流式协议。OpenAI Responses、Anthropic Messages 和 Gemini 协议需要各自独立的 adapter。
