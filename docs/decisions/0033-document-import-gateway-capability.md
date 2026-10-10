# ADR 0033：文件资料导入 Gateway capability

状态：已接受

## 背景

长期记忆已经支持显式陈述的写入与检索，但用户文件资料仍没有受控导入边界。文件字节、显示名称和媒体类型都不可信；把 OSS SDK、文档解析器或 Qdrant client 放进 Runtime 会破坏能力边界，也会让 Agent 进程持有不必要的存储凭据。

## 决策

`memory/memory-gateway` 增加协议无关的 `MemoryGatewayDocumentImporter`。Host 从自己的可信文件入口读取完整文件，并提交文件名、规范 MIME type 与字节。importer 拒绝路径或控制字符文件名、无效媒体类型、空文件和超出配置上限的文件，复制字节以隔离调用方后续修改，并计算字节数与 SHA-256。它把这些字段连同 Host 已绑定的 `memorySpaceId` 交给 `MemoryGatewayDocumentClient`，严格接受 `{ documentId, status: "queued" | "ready" }` 响应。

默认实现以 10 MiB 为单文件上限并使用完整内存字节，保持取消、摘要和所有权语义直接。出现已经验证的大文件需求后，再增加流式导入 capability；当前接口不伪装成无界流式上传。

Platform client 负责认证和具体上传协议。Platform 服务端负责把文件字节写入 OSS，在 PG 中保存权威元数据与索引状态，并以事务 outbox 驱动解析、分块、嵌入及 Qdrant 幂等写入。只有完成索引的分块可以进入检索结果。失败任务、重试、恶意文档扫描、解析器隔离、文件删除和保留策略都属于 Platform。

## 后果

Host 可以在不向 Runtime 暴露对象存储、数据库和向量库的前提下导入有限文件，并获得稳定的文档 ID 与索引状态。文件导入不会写入会话事件，也不会自动把全文放进 prompt；Agent 仍只通过受限 Memory Retriever 获得相关分块。

本决定只建立 capability 与 Gateway adapter。Platform HTTP 上传协议和 CLI 文件入口由后续决定组合，避免在没有调用方之前把预签名 URL、multipart 或流式语义固化进核心接口。

## 放弃的方案

- 让 Agent 工具读取任意本地路径：会绕过 Host 的文件选择、权限和大小边界。
- 在 Runtime 中直接使用 OSS、PG 或 Qdrant SDK：会把外部协议与租户凭据带入执行循环。
- 把全文作为用户消息持久化：会放大会话日志并绕过分块检索预算。
- 现在定义无界流式上传：缺少真实的大文件调用方，会提前引入重放、摘要和部分上传恢复复杂度。
