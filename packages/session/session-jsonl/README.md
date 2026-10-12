# @agent-harness/session-jsonl

## 职责

提供以 JSONL 保存会话事件头与原子事件批次的耐久 `JsonlSessionRepository`，以及进程内写入租约。

## 使用

构造仓库时传入绝对根目录；正常入口只导出生产适配器，故障注入仅通过 `@agent-harness/session-jsonl/testing` 使用。

## 限制

writer 所有权仅保证单个 Node.js 进程内互斥，不承诺跨进程安全。同一根目录不可由多个 Host 进程共享。
