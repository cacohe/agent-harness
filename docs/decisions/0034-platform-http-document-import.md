# ADR 0034：Platform HTTP 文档上传与 CLI 导入入口

状态：已接受

## 背景

协议无关的 `MemoryGatewayDocumentImporter` 已定义受限文件导入，但仍没有实际传输和 Host 入口。当前 capability 明确限制完整文件不超过 10 MiB，因此无需为本阶段提前引入预签名 URL、multipart 分段和部分上传恢复；同时不能把二进制编码进 JSON，避免额外的 Base64 体积与内存开销。

## 决策

`PlatformHttpClient` 实现 `MemoryGatewayDocumentClient`，向 `POST /agent/document-imports` 发送原始文件字节。`Content-Type` 保存规范 MIME type；`X-Agent-Document-Metadata` 保存 Base64URL 编码的 UTF-8 JSON `{ requestId, memorySpaceId, fileName, sizeBytes, contentSha256 }`；`Idempotency-Key` 与 metadata 中的 request ID 相同。client 在发送前重新复制字节，验证大小、SHA-256、字段集合和各字段上限，并复用 HTTPS、认证、响应限制、JSON 校验与取消处理。响应为 `{ documentId, status }`，业务结构继续由 importer 校验。

Platform 先把请求体流式写入以 request ID 命名的隔离 OSS 对象并核对大小与摘要，再在 PG 事务中写入幂等命令、权威文档元数据、计费审计和索引 outbox。相同幂等键与相同摘要返回原结果，字段或摘要冲突必须拒绝。事务提交后的 worker 解析、分块并按 document ID 与 chunk ID 幂等写入 Qdrant；失败状态保存在 PG。未被 PG 命令引用的临时 OSS 对象由 Platform 清扫。

CLI 新增 `import --config <绝对路径> --file <绝对路径> --media-type <MIME>`。它要求已有 `memory` 配置，在启动 Runtime、模型、MCP 或 Skills 前独立执行。默认文件读取器打开普通文件，先检查非空与 `memory.maxDocumentBytes`，按固定块读取并检测读取期间的长度变化，再调用 importer。成功只向 stdout 写一条 `document.imported` JSONL 记录。

## 后果

单实例 CLI 可以把有限文件送入 Platform 的 OSS、PG 与 Qdrant 索引流水线，而 Agent loop 和会话事件保持不变。认证值不会进入配置、metadata、stdout 或错误。当前原始 body 协议适合有界文件；出现超过内存上限的真实需求时，应新增分段或预签名上传 adapter，而不是放宽此命令的内存契约。

## 放弃的方案

- JSON Base64 文件：增加约三分之一传输体积并产生额外大字符串副本。
- 当前阶段使用预签名 multipart：会引入 URL 约束、分段重试、完成令牌和孤儿分片恢复，但现有 10 MiB 上限不需要这些复杂度。
- 让 CLI 直接持有 OSS 凭据：会绕过 Platform 的租户授权、幂等命令和审计事务。
