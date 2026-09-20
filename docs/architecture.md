# 架构

Agent Harness Lab 使用 append-only 会话事件日志和显式 Agent 状态机。运行时将 capability 接口与具体 adapter 组合，core package 不通过全局上下文发现依赖。

## 依赖层次

`domain` 定义稳定值类型和事件。`session`、`model`、`tools` 与 `agent` 拥有核心行为和 capability 接口。`adapters` 实现外部存储、模型、工具和进程集成。`runtime` 校验并组合完整应用。`hosts` 通过进程协议暴露应用。

依赖向内指向。模型 provider 实现 `model` 拥有的接口；会话存储实现 `session` 拥有的接口。Agent loop 只依赖这些接口。

## 执行模型

一个 turn 包含零个或多个 step。Step 组装 prompt 和可见工具 schema，准备模型调用，提交已接纳输入，流式处理一个 assistant attempt，提交其结算，执行工具调用，并在派生下一次请求前记录结果。

```text
input -> turn/start -> step/start -> model stream -> assistant settlement
                                      |                   |
                                      +------ tool calls -+
                                               |
                                         tool results
                                               |
                                         next step or
                                      step/end -> turn/end
```

每个 Agent 同时只有一个活动。取消使用 `AbortSignal`。每个已打开的 turn 和 step 恰好结算一次。模型可见事实持久化失败后，执行必须在下一次模型请求前停止。

## 会话日志

会话事件日志是模型可见历史、重放、恢复、审计和 UI 重建的事实源。临时流式 chunk 发送给 observer；已完成、中断或失败的 assistant attempt 作为单个持久事件提交。

每个会话身份只有一个 writer。事件 sequence 严格单调。所有可能阻塞的操作接受 `AbortSignal`，事件 batch 以全有或全无方式追加。存储实现在读入持久数据时校验，并提供显式 `flush` 与 `close` 操作。

## 替换接缝

首批替换接缝包括模型 provider、会话持久化、prompt 组装、工具定义、工具执行策略、标识符、时间、日志和 host 协议。每个接缝包含消费者侧 core package 拥有的接口、至少一个实现，以及 `runtime` 或 host 中的组合点。

拦截能力有意受限。只有模型请求准备和工具执行使用 around middleware。状态、流和日志通知使用失败隔离的 observer，不能阻止生命周期继续。

第一阶段内核由 `domain`、`session`、`model`、`tools`、`agent` 和 `test-support` 组成。内存会话实现 sequence 分配，纯投影重建模型消息；Agent 按顺序执行工具，并在开始下一 step 前持久化全部结果。真实模型、HTTP、JSONL 和动态插件系统不属于第一阶段。

## 生命周期

拥有资源的组件通过显式 `start` 和 `stop` 操作管理生命周期。运行时按顺序启动；部分启动失败时，以相反顺序停止已经成功启动的组件。关闭过程停止接纳输入，按 host 策略取消或排空活动，刷新会话 writer，最后释放外部资源。普通会话 I/O 使用 run signal；失败或取消后的 terminal settlement 使用组合方注入的独立总 deadline signal。同一结算链共享一个 signal，并优先以单个原子 batch 持久化尚未提交的 terminal events。
