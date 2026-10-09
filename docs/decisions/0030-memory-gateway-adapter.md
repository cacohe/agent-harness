# ADR 0030：注入已授权的长期记忆 Gateway

状态：已接受

## 背景

`MemoryRetriever` 与受限上下文投影已经存在，但没有可替换的外部检索 adapter。Runtime 不应直接连接 PG、Qdrant 或 OSS，也不应拥有租户、身份、授权和记忆计费逻辑。

## 决策

新增 `memory/memory-gateway` adapter。Host 或 Platform 解析当前 Agent 可用的 memory space，并向 adapter 注入单个 `memorySpaceId` 与 `MemoryGatewayClient`。Client 拥有认证、授权、网络协议、向量检索、权威记录查询和计费；adapter 只发送受限查询，将不可信响应严格转换为 `MemoryMatch`。

adapter 限制查询、结果数量和字段 UTF-8 字节数，拒绝未知字段与重复 ID，复制并冻结结果，并在 client 调用前后检查取消。Runtime 不包含 memory space registry，也不能由用户输入在执行中切换空间。

## 后果

PG 权威记录、Qdrant 向量和 OSS 文件资料可以在 Platform 内组合，而 Agent 只看见有限的检索文本。不同部署可以替换 client 或直接注入另一种 `MemoryRetriever`，无需修改 Agent loop。

## 放弃的方案

- Runtime 直接连接 PG、Qdrant 与 OSS：会把租户数据和基础设施细节带入核心。
- 让模型提供 memory space ID：会绕过 Host 已解析的授权范围。
- 在 adapter 内维护全局 memory registry：会隐藏依赖、身份和生命周期。
