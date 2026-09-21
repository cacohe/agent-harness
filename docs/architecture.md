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

第一阶段内核由 `domain`、`session`、`model`、`tools`、`agent` 和 `test-support` 组成。内存会话实现 sequence 分配，纯投影重建模型消息；Agent 按顺序执行工具，并在开始下一 step 前持久化全部结果。真实模型、HTTP 和动态插件系统不属于第一阶段。

`session` 拥有 reader、writer、repository 与 writer lease capability。`session-jsonl` 是独立 adapter，只依赖 `session` 和 `domain`。它将 header 与原子事件 batch 分别保存为一条 JSONL 记录；完整 batch 写入并经过 durability barrier 后才对调用方可见。读取使用严格 UTF-8 解码并忽略没有换行的末尾残片，writer 获得所有权后先截断并同步该残片。完整换行的无效记录视为损坏。

JSONL repository 在每次创建或打开前逐层建立根目录；每创建一层都同步其父目录项和新目录，再解析根目录的真实路径并验证结果仍为目录。文件布局与 lease key 都使用该规范路径，避免符号链接别名绕过进程内互斥。Session ID 按 UTF-16 code unit 单射编码为路径段。Writer lease 当前只保证同一 Node.js 进程内、跨 repository 实例的单 writer 所有权。跨进程互斥属于后续可替换实现，当前 adapter 不使用带超时的 lockfile，也不承诺多进程安全。

创建会话时，adapter 在规范根目录下构造随机 staging 目录，完整写入并同步 header 和 staging 目录项，再把整个目录原子 rename 为最终目录，最后同步规范根目录。Rename 是发布点；发布后的普通取消不会把成功发布报告为失败。发布后根目录同步失败会报告带 `published: true` 的结构化不确定创建错误。发布前遗留的 staging 目录不占用 Session ID；当前实现只清理本次调用已知的 staging，不自动扫描进程崩溃留下的孤立目录。

Append、read 与 flush 等待 writer 队列时响应各自的取消信号。已经启动的文件 I/O 必须先完成，随后才能检查取消并决定是否回滚，避免回滚与未完成写入竞争。若 append 写入失败且回滚也失败，writer 永久进入 poisoned 状态；之后 append、read 与 flush 拒绝执行，只有 close 继续关闭文件并释放 lease。Close 调用方可以取消等待，但资源释放在后台继续完成。

## 生命周期

拥有资源的组件通过显式 `start` 和 `stop` 操作管理生命周期。运行时按顺序启动；部分启动失败时，以相反顺序停止已经成功启动的组件。关闭过程停止接纳输入，按 host 策略取消或排空活动，刷新会话 writer，最后释放外部资源。普通会话 I/O 使用 run signal；失败或取消后的 terminal settlement 使用组合方注入的独立总 deadline signal。同一结算链共享一个 signal，并优先以单个原子 batch 持久化尚未提交的 terminal events。
