# ADR 0053：运行时资源治理与执行关联

状态：已接受

## 背景

单一 turn 的总期限不能隔离模型与工具的资源使用：模型若接近总期限才返回，工具就没有独立预算。工具返回的大型 JSON 也会被写入会话并投影到后续 prompt，绕过模型输出预算。串行 Agent 的输入若没有容量边界，慢请求会使进程内存持续增长。最后，观测端需要将模型和工具事件与 Host 的执行身份直接关联，而不是反查会话事件。

## 决策

Core 为模型 attempt、单次工具调用、单个工具返回载荷与等待中的 FIFO 输入分别设定可配置边界。Runtime 与本地 Host 提供以下默认值：模型 attempt 90 秒、工具调用 30 秒、工具返回载荷 1 MiB、等待队列 32 条。载荷预算不包括 `callId`、状态和 Core 生成的受限失败结果等协议元数据。turn 的 `runTimeoutMs` 仍是总硬上限；子 deadline 仅收紧，不延长父 signal。

超出工具返回载荷预算时，Core 不持久化原始载荷，而是写入带原调用 ID 的 `ToolResultTooLargeError` 失败结果，使下一 step 能看到可审计、有限大小的事实。工具的局部 deadline 仅取消该工具：收到由 deadline 导致的 rejection 时，Core 将其规范化为 `cancelled` 工具结果并继续该 turn；父 turn 取消仍会终止整个 turn。队列已满时，新输入以 `AgentBusyError` 立即失败，已接纳输入不受影响。

所有模型和工具 `AgentExecutionEvent` 都直接包含可选 `executionId`。它来自 turn 开始时冻结的 `ExecutionMetadata`；未传执行上下文的调用保持字段缺失。此决策不引入 attempt 重试：重试必须由 Provider 或未来显式的 attempt 语义拥有，不能由 Core 隐式重放副作用。

## 后果

Host 可以按自身容量调整上限，并将 `AgentBusyError` 映射为临时过载响应。模型、工具和 adapter 必须协作响应 `AbortSignal`，否则 deadline 只能限制等待而不能强制终止底层 I/O。工具结果被替换后，模型看不到原始大载荷；需要传输大对象时应使用外部引用或专门的受限读取工具。

## 放弃的方案

- 只保留 turn 总期限：不同阶段会相互侵占预算，难以定位慢点。
- 只依赖模型输出预算：工具输出仍可无限写入会话。
- 队列无限增长：短期易用但无法提供内存与延迟上界。
- 为本次变更加入自动重试：会模糊 attempt 与副作用语义，并违背显式重试边界。
