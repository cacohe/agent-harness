# ADR 0032：显式长期记忆写入工具

状态：已接受

## 背景

长期记忆检索已经通过 Platform Memory Gateway 接入，但用户明确要求“记住”的偏好或事实仍无法写入。若 Runtime 直接连接 PG 或 Qdrant，会把租户、授权、向量化和存储事务带入通用执行循环；若默认允许模型保存任意推断，又会污染长期记忆。

## 决策

`memory/memory-gateway` 提供 `remember_memory` function tool。工具只接受一条有界 `statement`，描述明确要求仅在用户显式要求长期记住时调用，并把 Host 已绑定的 `memorySpaceId` 与陈述交给 `MemoryGatewayWriterClient`。client 响应只返回 Platform 权威记录 ID，adapter 严格校验响应并把 ID 写入普通工具结果。

`PlatformHttpClient` 实现 writer client，向 `POST /agent/memory-statements` 发送 `{ requestId, memorySpaceId, statement }` JSON 命令。CLI 复用检索所用的 Platform client；只有 `memory.writeEnabled: true` 时才注册写入工具，默认保持只读。Platform 必须在同一数据库事务中写入 PG 权威记录、计费审计和向量索引 outbox，并以请求幂等键避免传输重放导致重复写入。Qdrant consumer 根据权威记录 ID 幂等写入整条陈述向量，并把索引状态回写 Platform；搜索只暴露已经完成索引的记录。

## 后果

长期记忆形成显式的读取与写入闭环，同时 Runtime、Agent 和会话事件格式保持不变。成功写入的权威 ID 作为工具结果进入会话历史；记忆正文仍由 Platform 管理，后续请求通过检索临时注入。Platform 可以拒绝未授权的 memory space 或陈述，CLI 不持有数据库连接或租户规则。

## 放弃的方案

- 自动保存模型推断：缺少用户意图边界，容易形成错误或敏感记忆。
- CLI 同时写 PG 与 Qdrant：无法保证权威记录、向量和审计的一致事务。
- 把记忆正文新增为会话事件：会混淆对话事实与可删除、可重建的长期记忆索引。
