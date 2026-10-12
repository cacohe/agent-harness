# 架构

Agent Harness Lab 使用 append-only 会话事件日志和显式 Agent 状态机。运行时将 capability 接口与具体 adapter 组合，capability 所属 package 不通过全局上下文发现依赖。

## 依赖层次

`kernel` 定义 Agent 循环使用的全部协议无关概念、状态、接口、事件与错误。单一 `core` package 只实现 Agent 核心循环状态机。上下文、会话和工具实现分别属于 `context/`、`session/` 和 `tools/` 能力域；adapter 实现外部存储与模型协议。`runtime` 校验并组合 Agent 循环及协议无关实现，`hosts` 组合外部 adapter 并通过进程协议暴露应用。

依赖统一指向 `kernel`。Core、能力实现和 adapter 都只依赖内核契约，彼此不建立生产依赖；Runtime 和 Host 在组合点注入具体实现。

## Package 布局

workspace 按能力域分组（见 ADR 0011），npm 包名仍为 `@agent-harness/<leaf>`：

```text
packages/
  kernel/                      Agent 概念、状态、接口、事件与错误
  core/                        Agent 核心循环状态机
  context/
    context-runtime/           Prompt 组装、时间上下文与模型消息投影
  tools/
    local/                     可复用本地 Shell 与工作目录工具
    mcp/                       MCP 工具 adapter
    platform-policy/           Platform 一次性工具许可 adapter
    sandbox-docker/            Docker OCI Sandbox dispatcher
  llm/
    openai-compatible/         Chat Completions adapter
    gateway/                   Platform LLM Gateway adapter
  memory/
    memory-context/            长期记忆上下文贡献器
    memory-gateway/            Platform 长期记忆与文件导入 Gateway adapter
  platform/
    platform-http/             Platform Gateway 与 Permit HTTP adapter
  session/
    session-memory/            内存会话实现
    session-jsonl/             JSONL 会话 adapter
  skills/
    skill-context/             已启用 Skill 摘要上下文贡献器
    skill-filesystem/          受限文件系统 Skill catalog
    skill-tool/                Skill 正文加载工具 adapter
  runtime/                     显式组合根
  hosts/cli/                   命令行进程入口
  hosts/web/                   本地 Web UI 与 SSE 进程入口
  test-support/                确定性 fake 与集成测试
```

依赖方向：

```text
hosts → runtime → core → kernel
  |          |       |
  +----------+-------+→ capability implementations / adapters → kernel
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

每个 Agent 同时只有一个活动 turn，但可以接纳多个用户输入。Core 以 FIFO inbox 串行领取输入；每个 `run` 调用只收到其自身 turn 的结果或错误。`stop` 停止接纳新输入、取消活动 turn，并拒绝尚未开始的输入。取消使用 `AbortSignal`。每个已打开的 turn 和 step 恰好结算一次。模型可见事实持久化失败后，执行必须在下一次模型请求前停止。

## 会话日志

会话事件日志是模型可见历史、重放、恢复、审计和 UI 重建的事实源。临时流式 chunk 发送给 observer；已完成、中断或失败的 assistant attempt 作为单个持久事件提交。

每个会话身份只有一个 writer。事件 sequence 严格单调。所有可能阻塞的操作接受 `AbortSignal`，事件 batch 以全有或全无方式追加。存储实现在读入持久数据时校验，并提供显式 `flush` 与 `close` 操作。

## 替换接缝

首批替换接缝包括模型 provider、会话持久化、prompt 组装、工具定义、工具执行策略、标识符、时间、日志和 host 协议。`kernel` 拥有这些协议无关接口；`context/context-runtime` 的默认 prompt 实现以完整用户 turn 为边界裁剪历史，并限制输入字节数。组合方必须为 Agent 显式注入 `PromptAssembler`，可以提供 system prompt、受限 `ContextContributor` 或替换策略。贡献器只产生 system 消息，静态提示词和贡献内容都计入输入预算；异步贡献器接收本次 run 的取消信号。当前时间通过注入的 `Clock` 提供。`SkillCatalog` 由 Host 或 Platform 提供已启用 Skill 的摘要与按需正文读取接口，`skills/skill-context` 的 `EnabledSkillsContext` 只注入名称、ID 和描述，不读取正文。`MemoryRetriever` 可以检索长期记忆，`memory/memory-context` 的 `RetrievedMemoryContext` 仅将有限的临时检索结果加入系统上下文，不将其写入会话事件。会话事件日志继续只保存对话事实。每个接缝包含 `kernel` 契约、至少一个实现，以及 `runtime` 或 host 中的组合点。

`skills/skill-filesystem` 从 Host 明确配置的根目录和启用列表构建 `SkillCatalog`。adapter 在 Linux Host 上根据已打开文件描述符校验真实路径，在目录边界内限制元数据与正文读取并校验 frontmatter；初始化只保存摘要，正文由工具或其他明确调用方按 ID 读取。CLI 负责创建该 adapter，并通过 `EnabledSkillsContext` 将摘要接入 prompt。

`skills/skill-tool` 将 `SkillCatalog` 映射为 `load_skill` function tool。它只接受摘要中展示的 ID，传递工具调用取消信号，并限制返回正文大小。CLI 将该工具与其他来源统一组合；成功正文作为普通工具结果持久化，未调用的正文不会进入上下文。

`kernel` 定义并实现纯内存、协议无关的工具运行时：`ToolRegistry`、`CompositeToolCapability`、`PolicyControlledTools` 与 `SandboxToolRegistry`。工具领域只包含 `tools/protocol.ts`（调用、结果、事件和能力契约）与 `tools/runtime.ts`（通用运行时）；其他 Kernel 模块只引用协议，不再声明工具概念。组合时取得各来源目录快照、拒绝重复名称，并以确定性路由保留执行上下文。调用方可以为单次 `Agent.run` 提供冻结的 `ExecutionMetadata`；它作为 `turn.started` 的审计字段持久化，不参与模型消息投影。`PolicyControlledTools` 在任何工具副作用前调用 `ToolExecutionPolicy`，拒绝会成为 `ToolAuthorizationError` 工具结果并照常持久化。Platform、审批和 Sandbox 通过该策略或工具 adapter 接入；kernel 与 core 不依赖其网络协议、账户模型或 SDK。

`SandboxToolRegistry` 是一类工具 adapter：它先在 Host 侧用每个不要求本地执行函数的 `ToolSpecification.parseInput` 校验模型输入，再通过 `SandboxDispatcher` 派发带有 call ID、工作目录和资源限制的任务。dispatcher 可以是单实例进程内实现或远程 Platform adapter；它必须响应取消信号，并接收已冻结的执行身份。`run_shell` 不是 Sandbox，不可替代此接口。

`tools/sandbox-docker` 是单实例 Docker OCI dispatcher。它将任务交给明确实现 stdin/stdout JSON worker 协议的镜像；默认禁网、只读根文件系统、非 root、无 capabilities、禁止提权，并限制 CPU、内存、PID、期限与输出。它不挂载宿主工作区、Docker socket 或密钥；镜像供应链与 Docker daemon 的安全配置属于 Host 运维边界。

`tools/mcp` 将组合方提供的 MCP client 转换为 `ToolCapability`。它的 `start` 在 Agent 接纳输入前拉取并严格校验工具表，`close` 释放 client；工具调用与关闭均传递取消信号。CLI 的 `mcp` 配置可显式组合官方 SDK 的 stdio client；子进程仅继承 SDK 的安全默认环境和由配置映射的环境变量，配置不保存密钥。CLI 在 MCP 启动后通过 `CompositeToolCapability` 合并本机 function tools 与 MCP，并在 Runtime 接纳输入前拒绝重复工具名。MCP transport、进程创建、网络认证和租户凭据属于 Host 或 Platform adapter，不进入 core 或 MCP 工具映射层。

`tools/platform-policy` 将组合方提供的 `PlatformPermitClient` 转换为 `ToolExecutionPolicy`。`PolicyControlledTools` 先冻结 ToolCall 与执行身份，并让策略和真实工具共享同一快照；adapter 对该 ToolCall JSON 进行规范编码和 SHA-256 摘要，要求 Platform 许可回显完整执行身份、tool call、工具名和输入摘要，并校验失效时间。Client 负责原子领取与记账、传输、认证和审批协议；adapter 对无效、过期或绑定不匹配的响应失败关闭。

拦截能力有意受限。只有模型请求准备和工具执行使用 around middleware。状态、流和日志通知使用失败隔离的 observer，不能阻止生命周期继续。`AgentObserver.onExecution` 在每批会话事件成功追加后逐条通知 `session.event`，因此 Platform 可以以 session sequence 重建审计状态；模型 capability 的 usage 是同一 attempt 内单调不减的累计 token，Agent 将其转换为带 session、turn、step、attempt 与单调 `usageSequence` 的 `model.usage` token 增量通知，供 Platform 去重后累加。observer 投递不具备可靠性保证，需要可靠投递的 Platform adapter 必须自行持久化 outbox 并以 sequence 去重。

Agent 概念、工具契约与纯内存工具运行时，以及会话生命周期分析与恢复修复位于 `kernel`；Agent 循环只位于 `core`。`context/context-runtime` 实现 prompt 组装和模型消息投影，`session/session-memory` 实现进程内事件日志。真实模型、工具 adapter 与本地工具集成由各能力域的 `llm/`、`session/`、`tools/` 提供，动态插件系统仍不属于当前范围。

`kernel` 拥有 reader、writer、repository 与 writer lease capability。`session/session-jsonl` 是独立 adapter，只依赖 `kernel`。它将 header 与原子事件 batch 分别保存为一条 JSONL 记录；完整 batch 写入并经过 durability barrier 后才对调用方可见。读取使用严格 UTF-8 解码并忽略没有换行的末尾残片，writer 获得所有权后先截断并同步该残片。完整换行的无效记录视为损坏。

JSONL repository 在每次创建或打开前逐层建立根目录；每创建一层都同步其父目录项和新目录，再解析根目录的真实路径并验证结果仍为目录。文件布局与 lease key 都使用该规范路径，避免符号链接别名绕过进程内互斥。Session ID 按 UTF-16 code unit 单射编码为路径段。当前阶段的 JSONL adapter 与 CLI 只支持单实例部署：同一 `sessionRoot` 不得由多个 Node.js 进程或服务实例共享。Writer lease 当前只保证同一 Node.js 进程内、跨 repository 实例的单 writer 所有权；跨进程互斥属于未来可替换实现，当前 adapter 不使用带超时的 lockfile，也不承诺多进程安全。

创建会话时，adapter 在规范根目录下构造随机 staging 目录，完整写入并同步 header 和 staging 目录项，再把整个目录原子 rename 为最终目录，最后同步规范根目录。Rename 是发布点；发布后的普通取消不会把成功发布报告为失败。发布后根目录同步失败会报告带 `published: true` 的结构化不确定创建错误。发布前遗留的 staging 目录不占用 Session ID；当前实现只清理本次调用已知的 staging，不自动扫描进程崩溃留下的孤立目录。

Append、read 与 flush 等待 writer 队列时响应各自的取消信号。已经启动的文件 I/O 必须先完成，随后才能检查取消并决定是否回滚，避免回滚与未完成写入竞争。若 append 写入失败且回滚也失败，writer 永久进入 poisoned 状态；之后 append、read 与 flush 拒绝执行，只有 close 继续关闭文件并释放 lease。Close 调用方可以取消等待，但资源释放在后台继续完成。

在 Windows 上，目录 fd 的 `fsync` 常返回 `EPERM`。JSONL adapter 忽略目录同步上的该错误，但会话文件的 `fdatasync` 仍必须成功；因此文件内容耐久屏障保留，目录项元数据在部分 Windows 环境可能延迟落盘。会话创建在 `rename` 发布 staging 目录前会关闭其中已打开的文件句柄，并在发布后重新打开正式路径；Windows 不允许对仍含打开句柄的目录执行 `rename`。

`kernel/session` 使用纯生命周期分析验证恢复历史。分析要求 turn 与 step 正确嵌套，事件标识符与当前生命周期一致，assistant settlement 和 tool result 合法关联，已经闭合的生命周期不再追加所属事件。只有成功完成且产生工具调用的 step 才能继续下一 step；工具结果必须严格构成 assistant tool call 顺序的连续前缀。结构矛盾直接拒绝恢复。日志尾部的活动 step 会为该前缀之后的缺失结果补写 `unknown`，再以 `interrupted` 闭合 step 和 turn；活动 turn 只补写 `turn.ended: interrupted`。这些修复使用读取时的末尾 sequence，在暴露 Agent 前作为一个原子 batch 提交。`unknown` 表示工具可能已经执行且外部副作用无法确认，并会进入后续模型消息投影。分析同时返回历史已使用的 turn、step、attempt、message 和 tool call ID 不可变快照。

`runtime` 是显式组合根，接收 repository、model、tools、运行限制、observer 和可选标识符 factory。`create` 创建新 writer；`resume` 取得 writer、读取并校验历史、原子修复后才构造 Agent。生产标识符使用随机 UUID，测试可以替换 factory。Runtime 把历史 ID 快照传入 Agent，不复制实时 reservation。Runtime 不包含 registry、服务定位器或动态插件装载。

`llm/openai-compatible` 实现首个真实模型 provider。它只依赖 `kernel`，使用组合方显式传入的 URL、API key、模型名和可选 `fetch` 实现调用 OpenAI-compatible `/v1/chat/completions`。它把 ModelRequest 映射为 Chat Completions 的 system、user、assistant、tool 与 function tools 字段，并把 SSE 文本、usage 与完整 tool call 映射回模型 capability。无工具定义或不含 tool call 的 assistant 消息会省略对应空数组字段，避免部分供应商对 `tools: []` / `tool_calls: []` 返回 HTTP 400。适配器限制未完成 SSE 数据的缓存和整个响应字节数，且在流结束并收到 `[DONE]` 后才发布 tool call；缺少 `[DONE]`、无效 UTF-8/JSON、字段类型错误、冲突的 tool fragment 或不能解析为 JSON 的 arguments 都终止本次 stream。它不支持 OpenAI Responses、Anthropic Messages 或 Gemini 协议，也不负责重试或供应商选择。

`llm/gateway` 让 Host 或 Platform 把一个已经解析、已授权的模型选择注入为单个 `ModelProvider`。Gateway client 拥有身份、密钥、模型授权、调用协议与计费；adapter 只严格校验 Gateway 流并转换为模型 capability 事件。工具输入在复制前限制规范 JSON 字节数和嵌套深度，避免不可信流绕过 Runtime 后续的输出预算。Runtime 不包含模型 registry、租户或计费逻辑，用户输入也不能在运行中选择任意模型。

`memory/memory-gateway` 让 Host 或 Platform 把一个已解析、已授权的 memory space 注入为单个 `MemoryRetriever`。Gateway client 拥有认证、租户、PG/Qdrant/OSS 组合、检索协议与计费；adapter 限制查询和结果并严格转换为 `MemoryMatch`。结果可以携带受限的 `statement` 或 `document` 来源；文档来源包含文件名、文档 ID 与 chunk ID，供模型归因，但与正文一样是不可信参考数据。缺少来源的旧响应继续兼容。同一 adapter 可以提供默认关闭的 `remember_memory` function tool，只将用户明确要求保存的有界陈述交给 Platform，并严格校验返回的权威记录 ID。它还提供独立于 Agent loop 的文档能力：`MemoryGatewayDocumentImporter` 提交受限文件名、MIME type 和完整字节，复制字节并附加大小与 SHA-256；`MemoryGatewayDocumentStatusReader` 查询 PG 权威的 `queued`、`indexing`、`ready`、`failed`、`deleting` 或 `deleted` 状态，失败只携带受限稳定码；`MemoryGatewayDocumentDeleter` 提交已绑定 memory space 的删除命令。Platform 在 PG 事务中写入墓碑和 outbox 后立即从检索中排除文档，再异步幂等清理 Qdrant 与 OSS，并在每次命令或查询时重新验证 memory space 与 document 的归属。Runtime 不包含 memory registry、租户或向量数据库逻辑，用户输入不能切换 memory space。

`platform/platform-http` 为单实例 Host 实现 Gateway、Memory 与 Permit 的 HTTPS Platform HTTP 命令协议。它向模型调用发送 NDJSON 流命令，向长期记忆检索、显式记忆写入、文档状态查询、文档删除与工具许可发送 JSON 命令；文档导入使用有界二进制 body 和 Base64URL 编码的结构化 metadata header。所有命令使用幂等键、响应大小限制、严格 Content-Type/UTF-8/JSON 校验与取消传播保护网络边界；任何未完整读取的响应 body 都会取消。Platform 服务端必须把计费、审计和可靠 outbox 作为命令处理事务的一部分；记忆写入在 PG 事务中提交权威记录与向量索引 outbox，Qdrant consumer 再按权威 ID 幂等写入整条陈述向量。文档上传先进入隔离 OSS 对象，PG 事务记录权威元数据与索引 outbox，未引用的临时对象由 Platform 清扫；文档删除在 PG 写入墓碑和清理 outbox，立即停止新检索，再异步清理 Qdrant 与 OSS；文档状态查询只读取 PG 权威状态。Harness observer 只用于观测和对账。CLI 可以独立配置 Platform 模型和 Platform Memory；它不创建工具许可策略，因为本地 CLI 没有 Platform 冻结的执行身份。

`hosts/cli` 是单进程 JSON 配置入口。它接受绝对 `--config` 路径及 `run`、`resume`、`chat`、`--session`、可选 `--message` 参数，显式组合 JSONL repository、OpenAI-compatible provider、可选 `run_shell` 工具和 Runtime。独立的 `import` 命令读取受限普通文件并调用 Platform 文档导入；`document-status` 查询一个文档的权威状态；`document-delete` 提交删除命令；这些命令都不创建 Runtime、模型、MCP 或 Skills。`runTimeoutMs`、`maxModelOutputBytes` 和 `maxInputBytes` 分别限制一个 turn 的协作式执行期限、模型输出与输入上下文；超时按取消路径结算。所有 provider 与工具都必须响应传入的 `AbortSignal`；不受进程隔离的任意第三方实现无法获得硬超时保证。shell 默认不注册，显式启用时只继承最小环境，并在 Unix 中终止整个进程组；它仍仅适合本地实验 Host，不以沙箱为安全边界。

`hosts/web` 是仅绑定 `127.0.0.1` 的本地浏览器入口。它读取受限的 OpenAI-compatible JSON 配置，只从 Host 环境变量取得 API key，并校验请求 authority 与可选 Origin；浏览器从不接触密钥。每个浏览器 session 在 Host 中持有独占 Runtime handle 和 JSONL writer；Host 另行持久保存 session 与规范工作目录的绑定。`POST /sessions/:id/open` 按已有 session ID 和 Host 元数据恢复 writer，`POST /sessions/:id/messages` 接纳 FIFO 输入，`POST /sessions/:id/cancel` 取消活动 turn，`POST /sessions/:id/close` 释放会话。`GET /sessions/:id/events` 先注册带缓冲的订阅者，再发送持久历史快照及快照之后的事件，避免恢复窗口丢失完成事件。刷新页面不立即 close；最后一个 SSE 订阅断开后，Host 按配置的空闲超时回收 session。用户选择工作目录后，Host 只注册限制在该目录内的列目录与文件读写工具；任意 shell 不属于该边界，Web Host 不提供 `run_shell`。

每个 Agent 拥有统一 ID reservation，分别覆盖 turn、step、attempt、message 和 tool call 命名空间。框架生成 ID、调用方提供的 user message ID 和模型提供的 tool call ID 都必须在对应持久事件写入前保留；与历史或当前 Agent 已接纳值冲突时立即失败。直接构造 Agent 从空 reservation 开始，也执行同一规则。

## 生命周期

拥有资源的组件通过显式 `start` 和 `stop` 操作管理生命周期。运行时按顺序启动；部分启动失败时，以相反顺序停止已经成功启动的组件。关闭过程停止接纳输入，按 host 策略取消或排空活动，刷新会话 writer，最后释放外部资源。普通会话 I/O 使用 run signal；失败或取消后的 terminal settlement 使用组合方注入的独立总 deadline signal。同一结算链共享一个 signal，并优先以单个原子 batch 持久化尚未提交的 terminal events。

Agent 提供 `stop` 与 `whenIdle`，保持直接 `run` 接口。Runtime handle 关闭时停止接纳新 run、取消活动、等待 Agent idle，再用新建的有界生命周期信号刷新并关闭 writer。调用方可以取消本次关闭等待，但后台清理继续；重复关闭共享同一清理过程。Handle 只有在清理成功后才从 Runtime 所有权集合移除，失败 promise 会被保留，使 Runtime 后续关闭仍能观察并聚合后台错误。Runtime 关闭会取消尚未完成的会话建立，并关闭其拥有的全部 handle。每个 run 的 terminal settlement 和每条关闭链各自获得新的 deadline，不能跨操作共享超时预算。
