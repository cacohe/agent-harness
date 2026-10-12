# @agent-harness/core

## 职责

实现单一 Agent 核心循环状态机，包括 FIFO inbox、turn/step 生命周期、流式 assistant 结算、工具续步与取消。

## 使用

通过 `Agent` 注入 `kernel` 能力；每次 `run` 只返回本次输入的结果。具体模型、会话和工具由 Runtime 或 Host 组合。

## 不负责

不访问网络、文件系统或进程，也不选择任何适配器。
