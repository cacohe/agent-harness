# @agent-harness/gateway

## 职责

将已解析且已授权的 Platform 模型选择与流式客户端映射为 `ModelProvider`。

## 使用

使用 `LlmGatewayModelProvider` 并注入 `LlmGatewayClient` 与单个模型选择；适配器会校验返回的流协议。

## 不负责

不管理身份、凭据、模型授权、计费或重试策略。
