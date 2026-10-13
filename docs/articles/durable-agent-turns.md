# 为什么 Agent Runtime 需要持久化的 turn 事实

语言模型的流式输出不等于 Agent 的可恢复状态。浏览器断连、模型连接中断、工具超时和进程退出都可能发生在任意 await 边界；若只保存最终文本，系统无法回答“工具是否已经执行”“哪一个 step 尚未结算”或“重试会不会重复产生副作用”。

Agent Harness Lab 把 `turn.started`、`step.started`、`assistant.settled`、`tool.completed`、`step.ended` 和 `turn.ended` 追加写入会话日志。模型下一次请求从这些事实投影，恢复逻辑也只分析同一份历史，而不是维护独立的内存状态机副本。

这种做法不让 JSONL 自动成为分布式数据库：当前实现明确要求单 writer。它解决的是单实例内的可重放性、审计性与中断修复；多实例部署仍需要具备并发控制和原子追加能力的外部会话存储。

关键取舍是把临时流与持久事实分开。stream chunk 用于 UI 或观测，允许丢失；完整 assistant settlement 和工具终态必须持久化。这样重连客户端可以重建对话，恢复器可以补齐可确认的中断结算，而模型不会从两份可能漂移的历史读取上下文。
