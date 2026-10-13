# 为什么 Agent 的模型、工具与队列需要独立边界

单个 turn 的总超时不足以治理 Agent 执行。模型若接近总期限才返回，工具只剩极少预算；工具若返回巨大 JSON，又会把下一轮 prompt 推到不可控大小；串行 Agent 若无限接收输入，则慢调用会让内存和等待时间持续增长。

因此 Runtime 将 turn 总期限与模型 attempt、单次工具调用拆开。局部 deadline 只能缩短父 signal，不能延长 turn，也不会绕过调用方取消。模型 deadline 代表当前 step 不能可靠完成；工具 deadline 则会形成已结算的 `cancelled` 工具结果，使模型在下一 step 看见明确事实。

工具预算限制的是不受 Core 控制的返回载荷，而不是 `callId` 等协议元数据或整个会话事件。超限时，原始载荷不会进入会话，Core 写入有限的 `ToolResultTooLargeError`。这保留了工具已执行的审计事实，同时避免未知大小的数据膨胀后续 prompt。

最后，FIFO inbox 有容量上限。队列满时，新的调用得到 `AgentBusyError`，而已接纳的输入继续执行。这是 backpressure，不是重试：重试必须由 provider 或显式的新 attempt 语义拥有，不能由 Core 静默重放潜在副作用。
