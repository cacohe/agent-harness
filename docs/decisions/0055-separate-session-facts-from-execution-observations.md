# ADR 0055：分离会话事实与执行观测

状态：已接受

## 背景

`AgentExecutionEvent` 同时转发已经提交的 `SessionEvent`，又定义模型与工具的瞬态执行事件。其中 `tool.completed` 既表示持久会话事实，也表示携带耗时的执行观测，但两者字段与语义不同。Kernel 中还出现了一套未接入运行时的 `AgentRuntimeEvent`、`EventEnvelope` 和流事件定义，形成第二套生命周期词汇。

## 决策

`SessionEvent` 是 turn、step、assistant settlement 与工具结果的唯一持久生命周期事实。`AgentObserver.onSessionEvent` 在 append 成功后直接接收其 `EventEnvelope`，不再通过 `AgentExecutionEvent` 包装。

模型和工具的开始、结束、耗时、底层异常与模型用量属于瞬态执行观测，由 `ExecutionObservation` 和 `AgentObserver.onObservation` 表达。观测事件使用 `model.invocation.*` 与 `tool.invocation.*` 名称，避免与持久会话事件同名。一次 invocation 只有一种结束事件，终态通过 `outcome` 或 `termination` 字段表达。

`ModelStreamEvent` 继续通过 `AgentObserver.onStream` 独立通知。删除没有调用方的聚合事件目录；各类事件在拥有其业务语义的 capability 目录定义，由 Kernel 公共入口统一导出。

## 后果

会话恢复、消息投影和持久化继续只依赖 `SessionEvent`。观察者能够明确区分已经提交的事实与可能丢失的瞬态信号，不再需要从 `session.event` 包装中取出信封，也不会遇到两个含义不同的 `tool.completed`。

调用方需要分别实现 `onSessionEvent` 与 `onObservation`。可靠 trace、外部投递和去重仍由 observer 下游负责；执行观测不会写入会话日志。

本决定取代 ADR 0016 和 ADR 0051 中由单一 `AgentExecutionEvent` 同时承载两类通知的接口形态，不改变其提交后通知、最佳努力投递和注入时钟等约束。

## 放弃的方案

- 不把全部执行观测写入 `SessionEvent`：调用耗时、底层异常名称和 usage 通知不是恢复模型可见状态所需的事实。
- 不保留覆盖所有领域的 `AgentRuntimeEvent` 大联合：它会重复 session、model 和 observability 各自拥有的协议，并让不同变化原因集中到一个文件。
- 不继续用 `AgentExecutionEvent` 包装会话信封并复用持久事件名称：这会让观察者无法从名称判断事件是否已经持久提交。
