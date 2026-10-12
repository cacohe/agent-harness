# ADR 0047：收敛会话生命周期分析到 Kernel

## 背景

会话生命周期分析只使用 Kernel 的事件事实、标识符、结果和错误；它既不读取存储，也不依赖 JSONL 或其他会话 adapter。将其保留为独立的 `session-lifecycle` package，使通用会话协议与其运行时约束分属两个能力域。

## 决策

将 `analyzeSessionLifecycle` 迁入 `kernel/src/session/lifecycle.ts`，并从 Kernel 根入口导出。`SessionLifecycleRepairPlan`、生命周期错误和事件契约继续位于 `session.ts`。

`runtime` 仍拥有恢复时读取历史、调用分析并原子追加修复的编排；Kernel 分析函数不执行 I/O。删除已无职责的 `@agent-harness/session-lifecycle` package。

## 后果

会话事实、校验和恢复修复可从 Kernel 统一发现。具体存储 adapter 保持在 `session/`，不会引入 Kernel 对文件系统、网络或其他 workspace package 的依赖。

## 放弃的方案

保留独立 package。该方案可维持更细的 package 名称，但不能表达生命周期校验是 Agent 通用会话运行时，而非某种会话实现。
