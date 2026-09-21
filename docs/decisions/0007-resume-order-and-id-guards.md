# ADR 0007：恢复顺序与标识符冲突守卫

状态：已接受

补充：ADR 0006

## 背景

ADR 0006 规定恢复时补写未知工具结果并使用 UUID，但恢复分析还必须证明历史符合 Agent loop 的实际转移。一个 step 只有在前一步成功完成工具调用后才会开始；工具结果也按 assistant tool call 顺序持久化。可替换的测试标识符 factory 可能在恢复后从头计数，单凭生产 UUID 的低碰撞概率不能保护持久日志。Handle 的后台清理错误还必须由拥有它的 Runtime 观察，即使最初调用方已经取消等待。

## 决策

生命周期分析只允许在上一 step 的 outcome 和 assistant settlement 都是 `completed`，且 assistant message 至少包含一个 tool call 时开始下一 step。失败、取消、中断、缺少 settlement 或无工具的最终 assistant message 都结束 step 链，之后出现 `step.started` 视为日志损坏。非 completed 的 `turn.ended` 仍可跟在已 completed step 后，用于记录步数上限等 step 之后发生的 turn 失败。

`tool.completed` 必须严格按照 assistant message 中 tool call 的顺序构成连续前缀。恢复只为该前缀之后的缺失后缀追加 `unknown`，保证模型消息投影不会看到乱序工具结果。

分析结果包含不可变的历史 turn、step、attempt 和 message ID 命名空间快照。Runtime 使用 collision guard 包装默认 UUID generator 和注入 factory；每次生成先检查对应历史集合和本进程已经生成的值，冲突时抛出 `AgentIdCollisionError`，且不重试或改写标识符。该守卫使确定性测试 factory 与生产 generator 遵守相同的持久唯一性要求。

Owned handle 只有在 Agent 排空、writer 刷新和关闭全部成功后才从 Runtime 所有权集合移除。清理失败时保留同一个 rejected close promise；Runtime 后续关闭必须观察并聚合该错误。

## 后果

恢复只接受 Agent loop 确实可能产生的事件顺序，工具结果投影保持请求顺序。注入从头计数的 generator 会在首次冲突时安全失败，调用方需要提供与历史不冲突的实现；框架不会用概率重试掩盖错误配置。

失败 handle 会一直保留在 Runtime 中直到 Runtime 本身完成失败结算，因此集合可能在清理故障期间持有对象。这是保留错误可观察性和 writer 所有权所需的有限状态。

## 放弃的方案

- 允许任意已闭合 step 继续会接受真实 Agent 不可能生成的生命周期。
- 按集合而不是前缀判断工具结果会让恢复投影改变 assistant 声明的调用顺序。
- 只检查一次随机 UUID 是否与历史不同不能证明可替换 factory 的安全性。
- 发生冲突后自动重试会隐藏确定性 generator 的配置错误，并可能无界循环。
- 后台 close 失败后立即移除 handle 会让 Runtime 错误地报告全部资源已经成功释放。
