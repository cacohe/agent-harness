# @agent-harness/memory-gateway

## 职责

把 Platform 的记忆检索、明确记忆写入、文档导入、状态查询与删除协议转换为受限能力。

## 使用

分别组合 `MemoryGatewayRetriever`、`createMemoryWriterTool` 和三个文档操作类；每个客户端均由调用方显式注入。

## 不负责

不保存向量、文档或租户状态，也不决定记忆空间的授权。
