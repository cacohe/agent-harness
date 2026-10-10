# ADR 0023：单实例 Host 的 Platform HTTP 命令协议

状态：已接受

## 背景

`llm/gateway` 与 `tools/platform-policy` 已定义了协议无关的注入接口，但单实例 Host 仍缺少可以实际调用 Platform 的实现。若各 Host 自行定义 HTTP 路径、认证头、流格式和幂等键，模型计费、工具许可与审计会出现不一致；若把这些细节放入 Runtime，则会破坏 Runtime 只组合单个 `ModelProvider` 与工具 capability 的边界。

## 决策

新增 `platform/platform-http` adapter，包名 `@agent-harness/platform-http`。一个显式构造的 `PlatformHttpClient` 以结构化方法同时满足 Gateway 与 Permit 的注入接口，但不导入 Runtime、Agent 或 adapter 类型。ADR 0031 在相同认证与传输边界上增加 Memory Gateway 命令；记忆组合与响应契约以该 ADR 为准。

Host 显式传入 HTTPS Platform API 根路径、完整认证头、可替换 `fetch`、请求 ID 生成器和响应字节上限。初始决定定义两个命令端点：

- `POST /agent/model-calls`：请求体为 `{ requestId, modelId, request }`，响应为 `application/x-ndjson`，每行是一个 Gateway 模型流事件；
- `POST /agent/tool-permits`：请求体为 `{ requestId, ...permitRequest }`，响应为 JSON，并由既有 permit adapter 继续校验完整绑定。

ADR 0031 与 ADR 0032 随后在同一传输边界增加长期记忆检索与显式陈述写入端点。

每个命令带 `Idempotency-Key`。模型调用的 key 由注入生成器生成，供一次逻辑调用的传输重试复用；工具许可 key 由执行身份、授权版本、工具调用和输入摘要稳定派生。HTTP client 严格校验成功状态、Content-Type、UTF-8、NDJSON 完整行、JSON 语法和响应总字节数，并传递取消信号。

Platform 服务端是计费与审计的权威：它必须在接收同一幂等命令时，将模型调用或工具许可的账务、审计事件与可重试 outbox 原子持久化。模型流完成后，服务端以 `requestId` 持久化最终 usage 与收费结果，再标记命令完成；同一 key 的重放必须返回同一调用结果或继续同一未完成流，绝不重复收费。Harness 不以失败隔离的 observer 充当收费 outbox；observer 仅用于观测和对账。

## 后果

单实例 Host 可以把同一个 `PlatformHttpClient` 分别注入 `LlmGatewayModelProvider` 和 `PlatformPermitPolicy`，而 Runtime 继续不知道 HTTP、认证、模型目录、账户和计费。Platform 可以通过幂等键安全处理网络重试，并由自己的 outbox 将审计和计费通知投递到外部系统。

该协议只定义 Harness 到 Platform 的命令面，不提供 Platform 服务端、数据库 schema、消息代理或用户管理 API。Gateway 的响应仍需经过 `llm/gateway` 的事件与工具输入校验，permit 响应仍需经过 `tools/platform-policy` 的绑定和过期校验。

## 放弃的方案

- 让 Runtime 直接通过 fetch 调用 Platform：会使模型选择、认证和账务协议污染通用组合根。
- 将 observer 事件直接作为计费来源：通知可能丢失或重复，无法在进程崩溃时提供收费原子性。
- 在 Host 中分别实现两个未约束的 HTTP client：会造成认证、取消、幂等和边界校验行为漂移。
