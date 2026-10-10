# ADR 0036：通过 Platform 查询文档索引状态

状态：已接受

## 背景

文档导入会返回 `queued`，随后由 Platform 的异步 worker 完成扫描、解析、分块、嵌入与索引。Host 目前无法判断文档何时进入可检索状态，也无法区分仍在排队和已经失败。让 CLI 读取 Platform 数据库或轮询 Qdrant 会绕过 memory space 授权，并把存储实现泄漏给 Host。

## 决策

`memory/memory-gateway` 增加协议无关的 `MemoryGatewayDocumentStatusReader`。Host 注入已经绑定 Platform 身份的 `memorySpaceId` 与 `MemoryGatewayDocumentStatusClient`，调用方只提供 `documentId`。状态投影为 `queued`、`indexing`、`ready` 或 `failed`；失败状态必须携带不超过 128 UTF-8 字节且格式受限的稳定 `failureCode`，不透传解析器异常、对象路径或自由文本。

Reader 在调用前校验并冻结请求，在返回后要求响应文档 ID 与请求一致、严格校验状态对应的字段集合并冻结结果。取消在网络调用前后传播。Platform 必须确认认证主体有权访问请求中的 memory space 与 document，并以 PG 权威索引状态回答；Qdrant 不是状态权威。

`PlatformHttpClient` 使用 `POST /agent/document-statuses`，JSON body 为 `{ requestId, memorySpaceId, documentId }`，并复用认证、幂等键、响应大小、Content-Type、UTF-8、JSON 和取消边界。使用 POST 可以避免文档 ID 出现在 URL 与常见访问日志中，并与其他 Platform command 协议保持一致。

CLI 增加 `document-status --config <绝对路径> --document <ID>`，要求已有 `memory` 配置，输出一条 `document.status` JSONL 记录，不创建 Runtime、会话、模型、MCP 或 Skills。

## 后果

导入方可以可靠观察异步索引是否已可检索，并用稳定失败码决定重试、重新导入或提示用户。Harness 不持久化索引状态，也不承担轮询、通知、重试或失败码本地化策略；这些策略由调用 Host 或 Platform UI 决定。

## 放弃的方案

- 由 CLI 查询 PG 或 Qdrant：绕过 Platform 授权和权威状态，且泄漏存储拓扑。
- 返回自由文本失败原因：可能暴露文件内容、对象路径或解析器内部信息，也无法形成稳定自动化契约。
- 在 `import` 中阻塞直到索引完成：会把长任务、重试和断线恢复强加给一次上传请求。
