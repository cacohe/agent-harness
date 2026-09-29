# 架构

Agent Harness Lab 使用 append-only 会话事件日志和显式 Agent 状态机。运行时将 capability 接口与具体 adapter 组合，capability 所属 package 不通过全局上下文发现依赖。

## 依赖层次

`domain` 定义稳定值类型和事件。`session/session`、`llm/model`、`core/tools` 与 `core/agent` 拥有核心行为和 capability 接口。各能力域下的 adapter（如 `session/session-jsonl`、`llm/openai-compatible`）实现外部存储与模型协议。`runtime` 校验并组合完整应用。`hosts` 通过进程协议暴露应用。

依赖向内指向。模型 provider 实现 `llm/model` 拥有的接口；会话存储实现 `session/session` 拥有的接口。Agent loop 只依赖这些接口。

## Package 布局

workspace 按能力域分组（见 ADR 0011），npm 包名仍为 `@agent-harness/<leaf>`：

```text
packages/
  domain/                      领域词汇（无 workspace 依赖）
  core/
    agent/                     Agent 状态机
    tools/                     工具注册与调度
  llm/
    model/                     模型 provider 接口
    openai-compatible/         Chat Completions adapter
  session/
    session/                   事件日志、投影与持久化接口
    session-jsonl/             JSONL 会话 adapter
  runtime/                     显式组合根
  hosts/cli/                   进程入口
  test-support/                确定性 fake 与集成测试
```

依赖方向：

```text
hosts → runtime → core|llm|session 下的 capability 包 → domain
               → llm|session 下的 adapter → capability 所属 package → domain
```

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

首批替换接缝包括模型 provider、会话持久化、prompt 组装、工具定义、工具执行策略、标识符、时间、日志和 host 协议。`core/agent` 拥有 `PromptAssembler`，默认实现以完整用户 turn 为边界裁剪历史，并限制输入字节数；组合方可提供 system prompt 或替换策略。每个接缝包含消费者侧 capability package 拥有的接口、至少一个实现，以及 `runtime` 或 host 中的组合点。

`core/tools` 还拥有执行治理接口。调用方可以为单次 `Agent.run` 提供冻结的 `ExecutionMetadata`；它作为 `turn.started` 的审计字段持久化，不参与模型消息投影。`PolicyControlledTools` 在任何工具副作用前调用 `ToolExecutionPolicy`，拒绝会成为 `ToolAuthorizationError` 工具结果并照常持久化。Platform、审批和 Sandbox 通过该策略或工具 adapter 接入；domain、agent 与 session 不依赖其网络协议、账户模型或 SDK。

`SandboxToolRegistry` 是一类工具 adapter：它先在 Host 侧用每个 `ToolDefinition.parseInput` 校验模型输入，再通过 `SandboxDispatcher` 派发带有 call ID、工作目录和资源限制的任务。dispatcher 可以是单实例进程内实现或远程 Platform adapter；它必须响应取消信号。`run_shell` 不是 Sandbox，不可替代此接口。

拦截能力有意受限。只有模型请求准备和工具执行使用 around middleware。状态、流和日志通知使用失败隔离的 observer，不能阻止生命周期继续。`AgentObserver.onExecution` 在每批会话事件成功追加后逐条通知 `session.event`，因此 Platform 可以以 session sequence 重建审计状态；模型 capability 的 usage 是同一 attempt 内单调不减的累计 token，Agent 将其转换为带 session、turn、step、attempt 与单调 `usageSequence` 的 `model.usage` token 增量通知，供 Platform 去重后累加。observer 投递不具备可靠性保证，需要可靠投递的 Platform adapter 必须自行持久化 outbox 并以 sequence 去重。

第一阶段内核由 `domain`、`session/session`、`llm/model`、`core/tools`、`core/agent` 和 `test-support` 组成。内存会话实现 sequence 分配，纯投影重建模型消息；Agent 按顺序执行工具，并在开始下一 step 前持久化全部结果。真实模型与 HTTP 集成由 `llm/`、`session/` 下的 adapter 提供，动态插件系统仍不属于当前范围。

`session/session` 拥有 reader、writer、repository 与 writer lease capability。`session/session-jsonl` 是独立 adapter，只依赖 `session/session` 和 `domain`。它将 header 与原子事件 batch 分别保存为一条 JSONL 记录；完整 batch 写入并经过 durability barrier 后才对调用方可见。读取使用严格 UTF-8 解码并忽略没有换行的末尾残片，writer 获得所有权后先截断并同步该残片。完整换行的无效记录视为损坏。

JSONL repository 在每次创建或打开前逐层建立根目录；每创建一层都同步其父目录项和新目录，再解析根目录的真实路径并验证结果仍为目录。文件布局与 lease key 都使用该规范路径，避免符号链接别名绕过进程内互斥。Session ID 按 UTF-16 code unit 单射编码为路径段。当前阶段的 JSONL adapter 与 CLI 只支持单实例部署：同一 `sessionRoot` 不得由多个 Node.js 进程或服务实例共享。Writer lease 当前只保证同一 Node.js 进程内、跨 repository 实例的单 writer 所有权；跨进程互斥属于未来可替换实现，当前 adapter 不使用带超时的 lockfile，也不承诺多进程安全。

创建会话时，adapter 在规范根目录下构造随机 staging 目录，完整写入并同步 header 和 staging 目录项，再把整个目录原子 rename 为最终目录，最后同步规范根目录。Rename 是发布点；发布后的普通取消不会把成功发布报告为失败。发布后根目录同步失败会报告带 `published: true` 的结构化不确定创建错误。发布前遗留的 staging 目录不占用 Session ID；当前实现只清理本次调用已知的 staging，不自动扫描进程崩溃留下的孤立目录。

Append、read 与 flush 等待 writer 队列时响应各自的取消信号。已经启动的文件 I/O 必须先完成，随后才能检查取消并决定是否回滚，避免回滚与未完成写入竞争。若 append 写入失败且回滚也失败，writer 永久进入 poisoned 状态；之后 append、read 与 flush 拒绝执行，只有 close 继续关闭文件并释放 lease。Close 调用方可以取消等待，但资源释放在后台继续完成。

在 Windows 上，目录 fd 的 `fsync` 常返回 `EPERM`。JSONL adapter 忽略目录同步上的该错误，但会话文件的 `fdatasync` 仍必须成功；因此文件内容耐久屏障保留，目录项元数据在部分 Windows 环境可能延迟落盘。会话创建在 `rename` 发布 staging 目录前会关闭其中已打开的文件句柄，并在发布后重新打开正式路径；Windows 不允许对仍含打开句柄的目录执行 `rename`。

`session/session` 使用纯生命周期分析验证恢复历史。分析要求 turn 与 step 正确嵌套，事件标识符与当前生命周期一致，assistant settlement 和 tool result 合法关联，已经闭合的生命周期不再追加所属事件。只有成功完成且产生工具调用的 step 才能继续下一 step；工具结果必须严格构成 assistant tool call 顺序的连续前缀。结构矛盾直接拒绝恢复。日志尾部的活动 step 会为该前缀之后的缺失结果补写 `unknown`，再以 `interrupted` 闭合 step 和 turn；活动 turn 只补写 `turn.ended: interrupted`。这些修复使用读取时的末尾 sequence，在暴露 Agent 前作为一个原子 batch 提交。`unknown` 表示工具可能已经执行且外部副作用无法确认，并会进入后续模型消息投影。分析同时返回历史已使用的 turn、step、attempt、message 和 tool call ID 不可变快照。

`runtime` 是显式组合根，接收 repository、model、tools、运行限制、observer 和可选标识符 factory。`create` 创建新 writer；`resume` 取得 writer、读取并校验历史、原子修复后才构造 Agent。生产标识符使用随机 UUID，测试可以替换 factory。Runtime 把历史 ID 快照传入 Agent，不复制实时 reservation。Runtime 不包含 registry、服务定位器或动态插件装载。

`llm/openai-compatible` 实现首个真实模型 provider。它只依赖 `domain` 与 `llm/model`，使用组合方显式传入的 URL、API key、模型名和可选 `fetch` 实现调用 OpenAI-compatible `/v1/chat/completions`。它把 ModelRequest 映射为 Chat Completions 的 system、user、assistant、tool 与 function tools 字段，并把 SSE 文本、usage 与完整 tool call 映射回模型 capability。无工具定义或不含 tool call 的 assistant 消息会省略对应空数组字段，避免部分供应商对 `tools: []` / `tool_calls: []` 返回 HTTP 400。适配器限制未完成 SSE 数据的缓存和整个响应字节数，且在流结束并收到 `[DONE]` 后才发布 tool call；缺少 `[DONE]`、无效 UTF-8/JSON、字段类型错误、冲突的 tool fragment 或不能解析为 JSON 的 arguments 都终止本次 stream。它不支持 OpenAI Responses、Anthropic Messages 或 Gemini 协议，也不负责重试或供应商选择。

`hosts/cli` 是单进程 JSON 配置入口。它接受绝对 `--config` 路径及 `run`、`resume`、`chat`、`--session`、可选 `--message` 参数，显式组合 JSONL repository、OpenAI-compatible provider、可选 `run_shell` 工具和 Runtime。`runTimeoutMs`、`maxModelOutputBytes` 和 `maxInputBytes` 分别限制一个 turn 的协作式执行期限、模型输出与输入上下文；超时按取消路径结算。所有 provider 与工具都必须响应传入的 `AbortSignal`；不受进程隔离的任意第三方实现无法获得硬超时保证。shell 默认不注册，显式启用时只继承最小环境，并在 Unix 中终止整个进程组；它仍仅适合本地实验 Host，不以沙箱为安全边界。

每个 Agent 拥有统一 ID reservation，分别覆盖 turn、step、attempt、message 和 tool call 命名空间。框架生成 ID、调用方提供的 user message ID 和模型提供的 tool call ID 都必须在对应持久事件写入前保留；与历史或当前 Agent 已接纳值冲突时立即失败。直接构造 Agent 从空 reservation 开始，也执行同一规则。

## 生命周期

拥有资源的组件通过显式 `start` 和 `stop` 操作管理生命周期。运行时按顺序启动；部分启动失败时，以相反顺序停止已经成功启动的组件。关闭过程停止接纳输入，按 host 策略取消或排空活动，刷新会话 writer，最后释放外部资源。普通会话 I/O 使用 run signal；失败或取消后的 terminal settlement 使用组合方注入的独立总 deadline signal。同一结算链共享一个 signal，并优先以单个原子 batch 持久化尚未提交的 terminal events。

Agent 提供 `stop` 与 `whenIdle`，保持直接 `run` 接口。Runtime handle 关闭时停止接纳新 run、取消活动、等待 Agent idle，再用新建的有界生命周期信号刷新并关闭 writer。调用方可以取消本次关闭等待，但后台清理继续；重复关闭共享同一清理过程。Handle 只有在清理成功后才从 Runtime 所有权集合移除，失败 promise 会被保留，使 Runtime 后续关闭仍能观察并聚合后台错误。Runtime 关闭会取消尚未完成的会话建立，并关闭其拥有的全部 handle。每个 run 的 terminal settlement 和每条关闭链各自获得新的 deadline，不能跨操作共享超时预算。
