# @agent-harness/openai-compatible

## 职责

以 Node.js 原生 `fetch` 实现 OpenAI-compatible Chat Completions HTTP/SSE 到 `ModelProvider` 的转换。

## 使用

使用 `OpenAiCompatibleModelProvider` 并显式传入提供方 ID、绝对 API 根路径、API 密钥与模型名；根路径后会追加 `chat/completions`。

## 限制

只支持 Chat Completions 流式协议；不读取环境变量，不实现重试、超时、回退或供应商选择。Responses、Anthropic 和 Gemini 应使用各自适配器。
