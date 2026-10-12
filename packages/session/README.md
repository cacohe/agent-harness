# 会话能力

本层实现会话日志、持久化与恢复分析；其公共契约位于 `kernel`，不在本层重复定义。

- [`session-memory`](session-memory/README.md)：进程内日志实现。
- [`session-lifecycle`](session-lifecycle/README.md)：历史结构验证与恢复修复。
- [`session-jsonl`](session-jsonl/README.md)：耐久 JSONL 适配器。
