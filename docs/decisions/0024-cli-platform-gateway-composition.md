# ADR 0024：CLI 的 Platform Gateway 模型组合

状态：已接受

## 背景

`platform/platform-http` 已提供可同时满足 Gateway 与 Permit capability 的 HTTPS client，但 CLI 仍固定构造 OpenAI-compatible provider。因此 Host 无法以 Platform 已选模型运行，前一阶段定义的 Gateway 命令协议没有可运行的组合点。

## 决策

CLI 的 `model` 配置接受两种互斥、严格校验的形状：既有的 OpenAI-compatible 配置，或 Platform Gateway 配置 `{ id, platformBaseUrl, modelId, authorizationEnv }`。后者从 `authorizationEnv` 读取完整 Authorization header，构造一个 `PlatformHttpClient`，并将它和已选的 `modelId` 注入 `LlmGatewayModelProvider`。认证值绝不写入配置、stdout 或诊断。

配置形状本身表达 provider 类型，保留原有本地 OpenAI-compatible 配置的兼容性，且禁止混合两组字段。Runtime 仍只接收一个 `ModelProvider`，不添加模型 registry、租户解析或运行中路由。

CLI 不把 `PlatformHttpClient` 注入 `PlatformPermitPolicy`。一次性工具许可必须绑定 Platform 冻结的执行身份、主体与授权版本；本地 CLI 没有可信来源来构造该元数据。拥有该上下文的 Platform Host 可在自己的组合点同时注入 permit client 与 policy。

## 后果

单实例 CLI 可以使用 Platform Gateway 的模型选择、身份与计费路径，同时保留本地直连开发方式。模型调用仍经过 Gateway adapter 的严格事件校验和 Platform HTTP adapter 的边界校验。

## 放弃的方案

- 在 Runtime 内按配置选择 provider：会将 Host 配置、认证与 Platform 协议引入通用组合根。
- 为 CLI 伪造静态执行身份并启用工具许可：会使许可未绑定真实的 Platform 权限快照。
- 把认证 header 直接写入 JSON：会提高密钥泄露风险。
