# ADR 0022：协议无关的 Platform LLM Gateway adapter

状态：已接受

## 背景

Platform 需要根据后台默认模型与用户选择，为每个 Agent 确定一个可用模型，并在实际调用处完成身份认证、权限校验和计费。把模型注册表、租户、计费规则或 Gateway HTTP 协议放入 Runtime，会让通用 Agent loop 依赖 Hosted Service 的部署细节；把这些逻辑放入 OpenAI-compatible adapter，又会把单一供应商协议与 Platform 策略混在一起。

## 决策

新增 `llm/gateway` adapter。Host 或 Platform 先解析默认模型和用户选择，再以一个已选 `modelId` 构造 `LlmGatewayModelProvider`；每个 provider 只代表一个模型，不提供 registry 或运行中路由。

`LlmGatewayClient` 由 Host 或 Platform 实现，接收冻结模型选择并返回本次模型调用的流式句柄。Client 负责身份、密钥、模型授权、重试策略、实际网络协议，以及一次调用的计费与审计原子性。adapter 将其不可信流严格校验为 `ModelStreamEvent`：只接受精确字段的文本、工具调用和累计 token 事件；工具输入在复制前以显式栈校验规范 JSON 字节数与嵌套深度，再复制冻结后交给 Agent。Gateway 返回无效结果、未知字段或无效数值时失败关闭。

Runtime 继续只接收一个 `ModelProvider`，不拥有 provider registry、模型选择、租户上下文或计费依赖。Agent 既有的 `model.usage` observer 通知仍用于外部观测与对账，但不作为 Gateway 计费成功的唯一依据。

## 后果

本地 Host 可以在启动时把配置中的默认模型解析成单个 provider；Hosted Platform 可以在创建每个 Agent 时，根据冻结的用户权限和选择构造对应 provider。不同 Gateway 协议、认证方式或供应商路由变化只影响 `LlmGatewayClient` 实现，不影响 Runtime、Agent、会话或 OpenAI-compatible adapter。

Gateway client 应在自己的持久化边界内完成可重试的计费与审计。由于 observer 是失败隔离的临时通知，依赖它单独实现收费会在进程崩溃时产生漏记风险。

## 放弃的方案

- 在 Runtime 增加按模型名路由的 provider registry：会把模型选择、租户和计费策略引入通用组合根。
- 让 Agent 每次 run 接受任意模型名：会使用户输入直接影响 provider 选择，绕过 Host 或 Platform 的权限冻结。
- 在 adapter 中实现 HTTP、JWT 或供应商 fallback：这些是具体 Gateway client 的传输和部署策略，不是通用协议映射。
