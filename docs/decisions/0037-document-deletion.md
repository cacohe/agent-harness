# ADR 0037：Platform 文档删除与异步物理清理

状态：已接受

## 背景

文档可以导入、查询索引状态并参与检索，但没有删除入口。直接由 Harness 分别删除 Qdrant、OSS 与 PG 会产生跨系统部分失败，也会绕过 Platform 的 memory space 授权、保留规则和审计。删除若等待所有物理存储同步完成，又会把长耗时清理和重试绑定到一次客户端请求。

## 决策

`memory/memory-gateway` 增加协议无关的 `MemoryGatewayDocumentDeleter`。Host 注入已绑定 Platform 身份的 `memorySpaceId` 与 `MemoryGatewayDocumentDeleteClient`，调用方只提供 `documentId`。请求和响应均严格校验、复制并冻结；响应文档 ID 必须与请求一致，状态只能是 `deleting` 或 `deleted`。状态查询同时接受这两个状态。

`PlatformHttpClient` 使用 `POST /agent/document-deletions`，JSON body 为 `{ requestId, memorySpaceId, documentId }`，复用认证、幂等键、响应限制、Content-Type、UTF-8、JSON 和取消边界。CLI 增加 `document-delete --config <绝对路径> --document <ID>`，输出一条 `document.deletion` JSONL 记录，不创建 Runtime、会话、模型、MCP 或 Skills。

Platform 在单个 PG 事务中验证主体、memory space、document、保留策略或 legal hold，写入幂等删除命令、审计、文档墓碑与清理 outbox。事务提交后文档和所属 chunk 必须立即从检索候选中排除，此时可以返回 `deleting`。Worker 幂等删除 Qdrant 向量和 OSS 文件；全部完成后把 PG 状态推进为 `deleted`。PG 保留最小墓碑、命令和审计记录，以支持幂等重试和合规证明；其保留期限由 Platform 策略决定。拒绝删除应使用非成功 HTTP 状态，不伪装成生命周期状态。

## 后果

Host 可以提交删除并观察最终状态，同时 Runtime 不接触数据库、对象存储、向量库或租户策略。网络响应丢失后，调用方可以再次提交；Platform 以文档身份和命令记录保证重复删除安全。逻辑删除与物理清理之间存在短暂窗口，但墓碑过滤保证该文档不再进入新的检索结果。

## 放弃的方案

- Harness 依次删除 Qdrant、OSS 和 PG：无法原子提交，部分失败时会失去权威恢复点。
- 删除请求阻塞到物理清理完成：会放大超时与断线恢复问题，并要求客户端持有长连接。
- 立即删除全部 PG 记录：会破坏幂等重试、审计和删除完成证明。
- 在 CLI 配置统一保留天数：保留与 legal hold 属于 Platform 的租户和合规策略，不应由 Runtime 或本地 Host 决定。
