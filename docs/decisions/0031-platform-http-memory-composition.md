# ADR 0031：Platform HTTP 长期记忆检索与 CLI 组合

状态：已接受

## 背景

协议无关的 Memory Gateway adapter 已能校验查询和结果，但没有实际传输实现或 Host 组合点。CLI 需要在不连接 PG、Qdrant、OSS 的前提下验证完整的长期记忆检索链路。

## 决策

`PlatformHttpClient` 实现 `MemoryGatewayClient`，向 `POST /agent/memory-searches` 发送 JSON 命令 `{ requestId, memorySpaceId, query, limit }`，要求 JSON 响应，并复用既有 HTTPS、认证头、幂等键、响应字节限制、UTF-8/JSON 校验和取消处理。响应的业务结构继续由 `MemoryGatewayRetriever` 校验。

CLI 增加独立的可选 `memory` 配置，包括 Platform URL、认证环境变量名、Host 已解析的 memory space、结果上限和响应上限。它独立于模型配置，因此 OpenAI-compatible 与 Platform Gateway 模型均可组合 Platform Memory。CLI 将 retriever 注入 `RetrievedMemoryContext`；Runtime 不感知 HTTP、租户或数据库。

## 后果

单实例 CLI 具备可运行的远程长期记忆检索链路。Platform 服务端负责把认证主体、memory space、PG 权威记录、Qdrant 向量检索、OSS 文件资料、计费和审计绑定为一个命令事务。每个模型 step 会按最新用户消息重新检索；缓存和召回策略由 Platform 决定。

## 放弃的方案

- 只允许 Platform 模型使用 Memory：会把两个独立 capability 不必要地绑定。
- CLI 直接配置数据库连接：会泄漏 Platform 数据和租户边界。
- 把检索结果写入会话事件：会把临时召回固化为对话事实。
