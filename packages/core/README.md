# @agent-harness/core

## 职责

实现单一会话级串行 Agent 执行器：接纳输入并以有容量边界的 FIFO 调度 turn，执行 turn/step 生命周期、流式 assistant 结算、工具续步与取消。它维护 turn、模型 attempt、单次工具调用及工具返回载荷写入的独立资源边界，但不拥有具体 adapter 或重试策略。

## 使用

通过 `Agent` 注入 `kernel` 能力；每次 `run` 只返回本次输入的结果。具体模型、会话和工具由 Runtime 或 Host 组合。

## 不负责

不访问网络、文件系统或进程，也不选择任何适配器。
