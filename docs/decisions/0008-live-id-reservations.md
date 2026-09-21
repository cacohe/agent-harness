# ADR 0008：实时持久化路径统一保留标识符

状态：已接受

修订：ADR 0007 中 collision guard 的所有权与覆盖范围

## 背景

ADR 0007 让 Runtime 包装生成器并检查 turn、step、attempt 和 assistant message ID，但 Agent 还会直接持久化调用方提供的 user message ID 和模型提供的 tool call ID。只在组合层检查生成器会允许实时日志写入重复的外部 ID；该日志随后会被严格恢复分析拒绝。直接构造 Agent 时也没有 Runtime 守卫，实时写入约束会与恢复约束脱节。

## 决策

统一 ID reservation 归 `agent` package 和每个 Agent 实例所有。Reservation 分别维护 turn、step、attempt、message 和 tool call 命名空间。框架生成的每个 ID 在对应事件持久化前保留；调用方传入的 `UserMessage.id` 在 `user.message` 持久化前保留；模型流产生的 `ToolCall.id` 在加入 observed tool calls 和 assistant settlement 前保留。冲突抛出 `AgentIdCollisionError`，冲突值本身不得进入持久日志。

Agent 可接收历史 reservation 快照；未提供时从空集合开始，因此直接使用 Agent 也会阻止同一实例内的重复生成 ID、user message ID 和 tool call ID。`session` 生命周期分析返回的不可变快照增加 tool call 命名空间。Runtime 只把恢复快照传给 Agent，不再执行另一套 reservation 逻辑。错误类型由 `agent` 导出；`runtime` 重导出该类型，保持组合层既有导入路径兼容。

Reservation 记录已经生成或接纳的 ID，即使后续持久化因其他原因失败也不回收。调用方若要安全重试，需要提供新 ID；复用失败尝试中的身份会让两个逻辑操作无法区分。

## 后果

实时写入和恢复分析使用相同的全历史唯一性规则。外部 ID 冲突会在对应 user 或 assistant 事件写入前失败，terminal settlement 仍可以使用已经保留且不冲突的生命周期 ID 闭合当前 turn。恢复后的 Agent 与直接构造的 Agent 具有相同安全属性。

Runtime 不再需要了解每次模型流中的外部 ID，也不会复制 Agent 的执行状态。Reservation 集合随会话历史和当前 Agent 已接纳 ID 增长；这是维持 append-only 日志全历史唯一性所需的内存成本。

## 放弃的方案

- 只校验生成器无法覆盖 user message 和 tool call 等外部身份。
- 在 Session adapter 中拒绝重复 ID 会把领域生命周期规则复制到每一种物理存储，并且发现冲突时机过晚。
- 持久化后再运行严格分析已经产生不可自动恢复的日志。
- 冲突或写入失败后释放 reservation 会允许调用方把同一身份用于另一个逻辑操作。
