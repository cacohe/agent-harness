# @agent-harness/memory-context

## 职责

`RetrievedMemoryContext` 将调用方提供的有限 `MemoryMatch` 投影为系统上下文。

## 使用

把实例作为 context contributor 注入 prompt 组装；检索结果只在本次模型请求中可见。

## 不负责

不检索、不写入长期记忆，也不把结果加入会话事件日志。
