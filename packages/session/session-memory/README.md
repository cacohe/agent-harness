# @agent-harness/session-memory

## 职责

提供 `InMemorySessionLog`，用于进程内、非持久化的会话日志。

## 使用

适用于测试和短生命周期组合；它实现 `kernel` 的会话日志契约。

## 不负责

不跨进程保存数据，也不提供崩溃恢复。
