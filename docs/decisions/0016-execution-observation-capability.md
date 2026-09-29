# ADR 0016：以提交后的结构化事件提供执行观测

## 背景

Platform 需要把一次 turn 的生命周期、工具结果和模型用量关联到同一执行记录，以支持审计、指标和计费。会话日志已经是模型可见状态的权威来源，但流式 observer 只包含临时模型 chunk，不能表示已成功持久化的状态变化。

## 决策

`core/agent` 定义 `AgentExecutionEvent`，并通过 `AgentObserver.onExecution` 发出两类事件：

- `session.event`：仅在 `SessionLog.append` 成功后发出对应的持久化会话事件；
- `model.usage`：模型流产生的瞬态输入、输出 token 计量，带有 session、turn、step、attempt 与 attempt 内单调 `usageSequence`。model capability 的 usage 是累计值；Agent 将它转换为可安全累加的 token 增量。

observer 只接收通知。无论同步抛错或异步拒绝，都不得改变 Agent 生命周期。可靠投递、重试和外部计费记账由组合方在 observer adapter 中使用独立 outbox 实现，不把网络副作用引入 Agent 内核。

## 后果

Host 或 Platform 可以在组合点注入 observer，并用持久化事件重建审计状态；模型用量可按 `sessionId`、turn、step、attempt 与 `usageSequence` 去重后累加 token 增量。通知可能丢失或重复，因此外部 adapter 必须以会话 sequence 或完整 usage 标识去重，并在需要可靠性时自行持久化 outbox。

## 放弃的方案

不把观测事件写入模型可见会话日志：用量和投递状态不是对话事实，会污染 prompt。也不让 observer 阻塞执行或参与事务提交，因为外部遥测故障不应导致已成功持久化的 turn 失败。
