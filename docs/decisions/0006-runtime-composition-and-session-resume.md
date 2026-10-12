# ADR 0006：Runtime 显式组合与中断会话恢复

状态：已接受

## 背景

持久 JSONL 会话允许进程重启后重新取得 writer，但进程可能在工具调用已经写入、结果尚未写入时退出。此时工具可能尚未运行，也可能已经完成并产生外部副作用。把这种状态自动归类为失败或取消会给模型和调用方错误的确定性。恢复还需要在暴露 Agent 前闭合遗留生命周期，并让组合方可靠拥有 Agent 与 writer 的关闭顺序。

## 决策

`ToolResult` 增加 `unknown` 状态，并携带明确原因，表示恢复过程无法判断工具是否执行及其外部副作用。`StepOutcome` 与 `TurnOutcome` 增加 `interrupted`，专门表示进程中断留下的生命周期，不与调用方取消混用。模型消息投影保留 `unknown` 工具结果，使下一次模型请求能够基于不确定事实继续。

`kernel/session` 提供纯生命周期分析。分析完整事件信封序列，严格检查 turn 与 step 嵌套、标识符对应、assistant settlement 与 tool result 关联、每个 tool call 至多一个 result，以及闭合生命周期不能继续接收所属事件。结构非法时抛出 `SessionLifecycleCorruptionError`，不猜测修复。只有日志尾部的活动 turn 或 step 可以恢复：已完成 assistant message 中缺失的工具结果按原 tool call 顺序补为 `unknown`，随后追加 `step.ended: interrupted` 与 `turn.ended: interrupted`。全部修复事件使用读取时的末尾 sequence 作为 `expectedSequence`，在一个原子 batch 中提交。

`runtime` package 是组合根，显式接收 `SessionRepository`、`ModelProvider`、`ToolCapability`、步数上限、结算期限、可选 observer 与标识符 factory。`create` 和 `resume` 只有在 writer 建立、历史校验和必要修复全部成功后才返回 handle。建立失败时使用独立有界信号关闭 writer；主错误与清理错误同时发生时使用 `AggregateError` 保留两者。

Handle 关闭时先停止 Agent 接纳新 run，取消活动 run 并等待 `whenIdle()`，再使用同一个新建的有界生命周期信号刷新和关闭 writer。调用方信号只取消本次关闭等待，后台清理继续。Runtime 跟踪其 handle，关闭时取消尚未完成的建立操作并聚合 handle 清理错误。`settlementTimeoutMs` 必须是正有限整数，每个 run 结算和每条关闭链分别创建新信号，不能跨 run 共享 deadline。

生产标识符由 `UuidAgentIds` 使用 `crypto.randomUUID()` 生成。恢复后的 turn、step、attempt 和 message 不延续进程内计数器，避免与持久历史中的固定标识符碰撞。测试可以通过显式 factory 注入确定性实现。

## 后果

恢复不会重复执行结果未知的工具，也不会把崩溃误记为用户取消。修复要么完整持久化，要么不暴露 Agent；sequence 冲突会阻止基于过期快照写入。严格分析会拒绝人工拼接或旧实现产生的矛盾生命周期，需要人工检查后才能继续。

Runtime 只组合现有 capability，不成为服务定位器，也不让 Agent 依赖具体存储 adapter。Handle 明确拥有 writer，因此调用方必须关闭 handle 或关闭整个 Runtime。当前恢复只处理单进程 writer；它不改变 JSONL adapter 的跨进程限制。

## 放弃的方案

- 自动重试缺少结果的工具可能重复产生不可逆副作用。
- 把未知执行记为 `failure` 或 `cancelled` 会伪造没有证据的执行结论。
- 在返回 Agent 后异步修复会允许新 turn 与遗留生命周期交错。
- 为每个修复事件单独 append 会暴露部分闭合状态。
- 从历史最大编号推导新标识符会把标识符格式与恢复算法耦合，并不能覆盖任意品牌字符串。
- 让 Runtime 通过全局上下文发现组件会隐藏依赖与 writer 所有权。
