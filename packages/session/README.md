# 会话能力

本层实现会话日志与持久化；其公共契约、生命周期校验与恢复修复位于 `kernel`，不在本层重复定义。

- [`session-memory`](session-memory/README.md)：进程内日志实现。
- [`session-jsonl`](session-jsonl/README.md)：耐久 JSONL 适配器。
