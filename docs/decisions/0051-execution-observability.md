# ADR 0051：以瞬态执行事件提供可观测性

状态：已接受

## 背景

会话事件日志保存模型可见事实，现有 observer 只能看到持久事件和模型 usage，难以统一关联模型与工具执行的开始、结束、失败和耗时。

## 决策

Kernel 扩展 `AgentExecutionEvent`，加入模型与工具的开始、完成、失败、取消事件，携带 session、turn、step、attempt 与工具调用关联 ID。Core 仅在组合方提供 `Clock` 时发射带时间的事件；Runtime 为生产 handle 注入 `SystemClock`。时钟抛错或返回无效时间时跳过新的开始事件；已发送开始事件仍会发送终态，但省略耗时。observer 投递保持最佳努力，不写入会话日志。

可靠审计、trace 导出和 outbox 由 Host 或 Platform adapter 在 observer 下游实现并自行去重、持久化。

## 后果

模型事实与观测数据分离，恢复语义不受影响；直接嵌入 Core 的调用方可不提供 Clock，但不会收到新增的时间观测事件。

## 放弃的方案

- 将 trace 写入会话事件：会污染模型历史并改变恢复语义。
- 由 Core 直接读取系统时间：会引入隐式进程依赖，降低测试确定性。
