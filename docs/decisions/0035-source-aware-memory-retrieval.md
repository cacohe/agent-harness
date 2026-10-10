# ADR 0035：长期记忆检索携带受限来源

状态：已接受

## 背景

文档导入已经把文件送入 Platform 的对象存储、权威元数据与分块索引流水线，但 `MemoryMatch` 只有 `id` 和 `content`。模型无法区分用户显式保存的陈述与文件分块，也无法在使用文档内容时指出文件和 chunk。把任意元数据直接透传到 prompt 会扩大注入面，并使 Runtime 隐式依赖 Platform 的数据库结构。

## 决策

`MemoryMatch` 增加可选的判别联合 `source`。`statement` 来源只包含 `type`；`document` 来源必须且只能包含 `type`、`documentId`、`fileName` 与 `chunkId`。`source` 暂时可选，使只返回 `id` 和 `content` 的现有 Platform 兼容迁移；新 Platform 应为可归因结果提供来源。

Memory Gateway adapter 在网络边界严格校验字段集合、类型、UTF-8 大小和文件名，并复制、冻结嵌套来源。`RetrievedMemoryContext` 在 capability 边界重复验证不可信实现的结果并创建独立副本。完整 JSON 继续受结果数、单字段和摘要总字节限制，`<` 继续转义，来源与正文都明确标记为不可信参考数据。模型使用文档内容时以 `fileName` 和 `chunkId` 归因，但不得把来源字段解释为指令。

Platform 负责把 PG 中的显式陈述映射为 `statement`，把只属于当前已授权 memory space 且已完成索引的 Qdrant 分块映射为 `document`。检索结果仍是当前模型步骤的临时上下文，不写入 append-only 会话事件；Runtime 不理解 PG、Qdrant、OSS、租户或计费。

## 后果

文件导入与检索形成可归因的 RAG 闭环，模型可以说明答案来自哪个文件分块。协议保持向后兼容，旧响应没有来源时仍可使用，但无法提供文档归因。来源字段会占用现有 8192 UTF-8 字节摘要预算，因此 Platform 仍需返回少量、精确的结果。

## 放弃的方案

- 透传任意 metadata 对象：难以限制大小与语义，且会把 Platform 内部结构泄漏给 Runtime。
- 把来源写入会话事件：会把可删除、可重建的检索投影混入对话事实。
- 让 Runtime 查询文档元数据：会增加第二次 I/O、竞态和存储耦合；Platform 已能在授权后的检索事务中完成映射。
