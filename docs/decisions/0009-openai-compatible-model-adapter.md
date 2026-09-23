# ADR 0009：原生 fetch 的 OpenAI-compatible 模型适配器

状态：已接受

## 背景

Agent Harness Lab 已有稳定的 `ModelProvider` capability，但此前只有确定性 fake，无法展示真实模型的请求映射、HTTP 失败与流式工具调用处理。DeepSeek、OpenAI 与许多兼容服务共享 Chat Completions SSE 协议；引入完整模型 SDK 会额外带入供应商抽象和隐式行为，掩盖 harness 与协议适配器之间的职责分界。

## 决策

新增 `packages/adapters/openai-compatible`（目录后由 ADR 0011 调整为 `packages/llm/openai-compatible`），包名为 `@agent-harness/openai-compatible`。它仅依赖 `domain` 和 `model`，通过 Node.js 24 原生 `fetch` 实现 OpenAI-compatible `/v1/chat/completions` 的 streaming Chat Completions 协议。组合方显式提供 provider 标识、绝对 API 根路径（例如 `/v1`，不是完整 endpoint）、API key、模型名、可选额外请求头和可测试的 fetch 实现；adapter 不读取环境变量。额外请求头不能覆盖 `Authorization`、`Content-Type` 或 `Accept`。

适配器把现有 user、assistant 与 tool 模型消息映射为 Chat Completions 消息，并以键排序的稳定 JSON 表示 assistant tool arguments 与 tool result。工具 schema 映射为 function tool。请求不强制 `stream_options.include_usage`，以免拒绝不支持该扩展字段的兼容网关；服务端提供 usage 时仍会映射。响应使用增量 UTF-8 SSE 解析器；`text.delta` 与 usage 可在读取时发布，tool call fragment 按从零连续的 index 聚合，只有收到 `[DONE]` 后验证 id、name、跨 index 的 id 唯一性与完整 JSON arguments 才按 index 顺序发布。

HTTP 非成功、body 缺失、无效 UTF-8 或 JSON、缺少或错误类型字段、冲突 fragment、无效 tool arguments，以及未收到 `[DONE]` 的 EOF 都终止 stream。取消直接传播原始中止错误，并取消正在等待的 reader。适配器不实现重试、默认超时、fallback 或全局 provider registry；这些是后续策略与组合层的职责。

## 后果

首个真实 provider 可以用配置切换 DeepSeek、OpenAI 和兼容服务，而 Agent loop、会话日志和工具执行仍只依赖 `ModelProvider`。请求和响应的转换逻辑集中在一个小 package，网络测试能够通过注入 fetch fake 完全确定性运行。

Chat Completions 的兼容范围是显式限制。供应商若只支持 Responses、Anthropic Messages 或 Gemini，需要新增独立 adapter，不能把其字段分支加入这个 package。严格 EOF 与 tool fragment 校验会拒绝部分非标准网关输出；调用方需要修正网关兼容性或选择对应 adapter。

## 放弃的方案

- 使用 OpenAI、Vercel AI SDK 或 LangChain 会让本仓库依赖第三方的请求、流和工具调用策略，降低协议边界的可见性。
- 直接在 `model` 或 `agent` package 中调用 fetch 会反转 core 对 adapter 的依赖方向。
- 接受 EOF 作为成功结束会在传输截断时把不完整 tool call 当成安全调用。
- 在 adapter 内读取环境变量、选择供应商或重试会隐藏部署策略和密钥所有权。
