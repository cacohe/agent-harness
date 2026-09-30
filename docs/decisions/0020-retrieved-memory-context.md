# ADR 0020：以异步贡献器检索长期记忆

## 背景

长期记忆检索需要 I/O，原有 ContextContributor 只支持同步上下文，无法在 Agent 的取消和失败边界内调用检索 adapter。把检索结果写入会话日志会把临时召回混入对话事实。

## 决策

PromptAssembler 与 ContextContributor 演进为接受 AbortSignal 的异步 capability。`MemoryRetriever` 由 Host 或 Platform 实现，按最新用户消息检索 `MemoryMatch`；`RetrievedMemoryContext` 对查询、结果数量、字段和摘要字节数做严格限制，将内容编码为带边界的“不可信参考数据”，再以 system message 加入请求。检索结果不写入会话事件。

## 后果

PG 权威记忆元数据和 Qdrant 向量检索可以作为外部 MemoryRetriever adapter 接入，且网络取消沿 Agent run signal 传播。任一检索失败会使当前 step 走既有失败结算路径，避免模型在缺失所需上下文时继续执行。

## 放弃的方案

不在 ContextContributor 中隐藏不可取消 I/O，也不把每次检索结果持久化为对话历史。后者会污染后续 prompt，并使向量索引的短暂召回变成不可撤销事实。
