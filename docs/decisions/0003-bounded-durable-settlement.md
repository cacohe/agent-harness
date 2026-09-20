# ADR 0003：有界的持久取消结算

状态：已接受

## 背景

模型调用前的 `prepare` 可能失败或取消，此时尚未开始 assistant attempt。运行期间的普通会话 I/O 应响应 run 的取消信号，但 run signal 一旦取消，就不能再用于必须尽力持久化的 terminal settlement。若结算改用没有期限的信号，存储故障又可能让 Agent 永久挂起。持久化失败还可能遮蔽原始取消，导致调用方错误地把取消归类为普通失败。

## 决策

模型 `prepare` 不属于 assistant attempt。只有 `prepare` 成功且即将消费 stream 时才创建 `attemptId`。`prepare` 失败或取消不会写入 `assistant.settled`，已经开始的 step 和 turn 仍会结算。

所有可能阻塞的 Session 操作都接受明确的 `AbortSignal`。普通读取、追加、刷新和关闭使用当前 run signal。`append(batch)` 必须具有全有或全无语义；信号触发或写入失败不得留下部分批次。

失败或取消需要补写 terminal events 时，Agent 通过注入的 `SettlementSignalFactory` 为本次 run 创建一个新的总 deadline signal。同一条结算链只创建一次并共享该 signal，不为每次写入重置期限。尚未持久化的 assistant settlement、工具结果、`step.ended` 和 `turn.ended` 尽可能组成一个原子 append batch。

若 terminal batch 持久化失败，Agent 抛出结构化 `SettlementPersistenceError`，同时保留原始错误、持久化错误和原始 outcome。持久化失败不能把 `cancelled` 改写为 `failed`。Factory 接口和结算生命周期归 `agent` package，deadline 配置归组合方，I/O signal 与原子追加保证归 `session` package。

## 后果

普通操作能及时响应取消，而 terminal settlement 仍有独立且有上界的持久化机会。调用方能区分业务失败、用户取消和结算持久化失败，并在无法确认 durable closure 时阻止不安全恢复。具体存储 adapter 必须实现原子 batch，并在每个可能阻塞的 I/O 边界响应 signal。

## 放弃的方案

- 复用已经取消的 run signal 会让 terminal settlement 必然立即失败。
- 为每个 terminal 写入创建独立 timeout 会重复获得完整预算，使总清理时间没有统一上界。
- 使用不带 deadline 的独立 signal 会让故障存储永久阻塞 Agent。
- 只抛持久化错误会丢失原始取消或失败分类。
