# Agent Harness Lab

面向本地和自托管环境的 TypeScript Agent Runtime 参考实现。它关注可靠执行所需的会话持久化与恢复、串行调度、工具调用边界、上下文组装与可组合能力接入；它不是多租户 Agent 平台或完整业务产品。

核心思路：用 **append-only 会话事件日志** 作为模型可见历史的唯一事实源，用显式 **Agent 状态机** 驱动 turn/step 循环，通过 **capability 接口 + adapter + host** 组合应用，不使用服务定位器或进程全局运行时。

## 基本架构

依赖向内：

```text
hosts → runtime → core → kernel
  |          |       |
  +----------+-------+→ capability implementations / adapters → kernel
```


| 层次 | 目录落点 | 职责 |
|------|----------|------|
| Kernel | `packages/kernel` | Agent 概念、状态、接口、事件与错误 |
| Core | `packages/core` | Agent 核心循环状态机 |
| Adapters | `packages/adapters` | 上下文、JSONL、模型、MCP、Skills、Memory 与本地工具的具体实现 |
| 组合根 | `packages/runtime` | `create` / `resume` / 生命周期 |
| 进程入口 | `packages/hosts/*` | 配置、信号、stdout/stderr |


执行模型：

```text
input → turn/start → step/start → model stream → assistant settlement
                                       |                   |
                                       +------ tool calls -+
                                                |
                                          tool results
                                                |
                                          next step 或
                                       step/end → turn/end
```

- 每个 Agent 同时只有一个活动 turn；后续输入由 FIFO inbox 排队，取消使用 `AbortSignal`
- 已打开的 turn/step 在成功、失败与取消路径上恰好结算一次
- 流式 chunk 是临时通知；持久化的是完整 assistant settlement

更细的行为、所有权与失败语义见 `[docs/architecture.md](docs/architecture.md)`。架构决定见 `[docs/decisions/](docs/decisions/)`。

## 项目目录结构

```text
docs/                     架构与已接受决定（ADR）
packages/
  kernel/                 Agent 概念、状态、接口、事件与错误
  core/                   Inbox 与 Agent 核心循环状态机
  adapters/               按能力域分目录的具体 adapter 与本地默认装配
  runtime/                显式组合与 handle 生命周期
  hosts/
    cli/                  单进程 JSON 配置 CLI
    web/                  本地浏览器 UI 与 SSE Host
  test-support/           确定性 fake 与集成测试
scripts/                  架构 / 文档 gate
.agents/skills/           可复用仓库工作流
.github/workflows/        CI
```

## 环境要求

- Node.js 24+
- pnpm 10（见根目录 `packageManager`）

```bash
pnpm install
pnpm run build
```

常用脚本：


| 命令                   | 作用                                   |
| -------------------- | ------------------------------------ |
| `pnpm run build`     | 编译全部 package                         |
| `pnpm run typecheck` | TypeScript 工程引用检查                    |
| `pnpm run test`      | Vitest                               |
| `pnpm run lint`      | Biome 格式与 lint 检查                    |
| `pnpm run format`    | 用 Biome 写入格式与安全修复                 |
| `pnpm run check`     | lint + 架构 gate + 文档 gate + typecheck + test |
| `pnpm web -- --config /绝对/config.json` | 启动仅本机可访问的 Web UI |


## 本地启动 Agent

当前最小可运行入口是 `@agent-harness/cli`：组合 JSONL 会话、OpenAI-compatible 模型、空工具表与 Runtime。仓库提供示例配置与启动包装，避免手写绝对路径。

### 1. 准备示例环境

```bash
cp examples/cli/.env.example examples/cli/.env
# Windows PowerShell: Copy-Item examples/cli/.env.example examples/cli/.env
# 编辑 examples/cli/.env，填入 DEEPSEEK_API_KEY
pnpm run build
```

示例文件：

| 文件 | 作用 |
|------|------|
| `examples/cli/config.example.json` | 配置模板（不含密钥） |
| `examples/cli/.env.example` | 环境变量模板 |
| `examples/cli/.env` | 本地密钥（已 gitignore，需自行复制） |
| `examples/cli/config.json` | 首次 `pnpm agent` 时自动生成，`sessionRoot` 指向仓库内绝对路径 |

配置字段：

- `sessionRoot`：JSONL 会话根目录（必须绝对路径；包装脚本会自动写入）
- `maxSteps`：单次 turn 内最大 step 数
- `settlementTimeoutMs`：失败/取消路径上 terminal settlement 的超时
- `runTimeoutMs`：单个 turn 的协作式执行期限，默认 120 秒；provider 与工具必须响应 `AbortSignal`
- `maxModelOutputBytes`、`maxInputBytes`：模型输出与输入上下文的字节预算，默认各 1 MiB
- `agentProfile`（可选）：包含非空 `id`、`version` 与 `instructions` 的版本化 Agent 静态指令；不写入会话事件
- 本地直连模型使用 `model.baseUrl`、`model.model` 和 `model.apiKeyEnv`：OpenAI-compatible API 根、模型名与存放 API key 的环境变量名（默认 `DEEPSEEK_API_KEY`）
- Platform Gateway 模型使用 `model.platformBaseUrl`、`model.modelId` 和 `model.authorizationEnv`：HTTPS Platform API 根、Platform 已解析的模型 ID 与存放完整认证头值的环境变量名。该模式由 Host 注入单个 provider，不允许运行中切换模型。
- `shell`（可选）：`enabled`、`cwd`（绝对路径）、`timeoutMs`、`maxOutputBytes`；控制本机 `run_shell` 工具
- `mcp`（可选）：`command`、`args`、可选绝对 `cwd` 与 `environment` 映射；启动一个 MCP stdio server。`environment` 的键是子进程变量名，值是 Host 中保存实际值的环境变量名，避免将密钥写进配置。
- `skills`（Linux，可选）：`root`、明确启用的 `enabled` ID 数组与可选 `maxSkillBytes`；prompt 只包含 Skill 名称、ID 和描述，模型通过 `load_skill` 工具按需读取正文。
- `memory`（可选）：`platformBaseUrl`、`authorizationEnv`、`memorySpaceId`，以及可选 `limit`、`maxResponseBytes`、`maxDocumentBytes`、`writeEnabled`；通过 Platform HTTP 检索长期记忆并作为不可信参考上下文加入当前请求。检索响应可用 `source.type` 区分显式陈述与文档分块；文档来源携带 `documentId`、`fileName` 和 `chunkId` 供回答归因，旧的无来源响应仍兼容。`writeEnabled` 默认为 `false`，显式设为 `true` 后注册 `remember_memory` 工具，只用于用户明确要求长期记住的陈述。`maxDocumentBytes` 默认 10 MiB，限制独立 `import` 命令的文件读取与上传。

密钥只放在环境变量 / `.env` 中，不要写进 JSON 配置。`run_shell` 默认关闭；显式启用后仍以当前用户权限执行命令，无沙箱，仅适合本地实验。

Platform Gateway 配置示例：

```json
"model": {
  "id": "platform-gateway",
  "platformBaseUrl": "https://platform.example/v1",
  "modelId": "approved-model-id",
  "authorizationEnv": "PLATFORM_AUTHORIZATION"
}
```

`PLATFORM_AUTHORIZATION` 的值是完整 HTTP Authorization header（例如 `Bearer <token>`）；CLI 不会把它输出到诊断。该配置只组合模型 Gateway。工具许可要求每个 turn 由 Platform/Host 冻结执行身份，因此仍由具备该身份上下文的 Host 组合。

MCP stdio 配置示例：

```json
"mcp": {
  "command": "npx",
  "args": ["-y", "@example/mcp-server"],
  "environment": { "API_TOKEN": "MCP_API_TOKEN" }
}
```

CLI 可以同时启用 `mcp` 与 `shell`；启动时会合并工具目录并拒绝重复工具名。MCP server 的 stdout 必须只输出 MCP 协议数据。

当前 CLI 与 JSONL 会话存储只支持单实例运行。同一 `sessionRoot` 不得被多个 Node.js 进程、容器或服务实例同时使用。

### 2. 运行

```bash
# run：创建新会话（同一 session id 只能成功一次）
pnpm agent run --session demo-1 --message "你好，介绍一下你自己"
# resume：打开已有会话继续对话
pnpm agent resume --session demo-1 --message "继续上一次的话题"
# chat：同一进程多轮交互（会话不存在则创建，已存在则恢复）
pnpm agent chat --session demo-1 --message "你好"
# import：通过 Platform Memory 配置导入文件，不创建 Agent 会话
pnpm agent import --file /绝对路径/资料.pdf --media-type application/pdf
# document-status：查询异步索引状态，不创建 Agent 会话
pnpm agent document-status --document document-id
# document-delete：提交受 Platform 授权与保留策略约束的文档删除
pnpm agent document-delete --document document-id
```

### 本地 Web UI

Web Host 是只绑定 `127.0.0.1` 的浏览器聊天界面。它不将 API key 发送给浏览器，首版也不启用 shell、MCP 或文件工具。

```bash
cp examples/web/.env.example examples/web/.env
# 编辑 examples/web/.env，填入 DEEPSEEK_API_KEY
pnpm run build
pnpm web
```

启动后访问终端打印的本地地址（默认 `http://127.0.0.1:3080`）。`pnpm web -- --port 3090` 可改用其他 loopback 端口。首次启动会生成被 gitignore 的 `examples/web/config.json` 与 JSONL 会话目录。

`chat` 模式下在 stderr 提示后循环读取输入；输入 `/exit` 或 `/quit` 结束。可通过 `shell.enabled: true` 显式注册本机 `run_shell` 工具。

包装脚本会：

1. 若缺少 `examples/cli/config.json`，从 example 生成并把 `sessionRoot` 设为 `examples/cli/data/sessions`
2. 用 Node `--env-file=examples/cli/.env` 注入环境变量
3. 为 `run` / `resume` 自动补上绝对路径的 `--config`

自定义配置时仍可显式传入：

```bash
pnpm agent run --config /绝对路径/config.json --session demo-1 --message "你好"
```

### 3. 输出约定

- **stdout**：仅 JSONL（`stream` / `result` / `document.imported` / `document.status` / `document.deletion` / `error`）
- **stderr**：usage 与不含密钥的诊断
- **SIGINT / SIGTERM**：取消当前 run，并在 finally 中关闭资源

首个 CLI 提供多轮 `chat` 与可选 `run_shell`；更多工具可在 Host 组合点接入 `ToolRegistry`。

## 如何开发新功能

### 工作流

1. 改运行时代码前阅读 `[docs/architecture.md](docs/architecture.md)` 与相关 `[AGENTS.md](AGENTS.md)`
2. 影响依赖方向、事件兼容性、生命周期或公共 capability 时，在 `docs/decisions/` 新增 ADR
3. 用确定性 fake 测接口；在 adapter 入口测外部协议
4. 交付前运行 `pnpm run check`

### 按变更类型落点


| 目标             | 落点                                                         |
| -------------- | ---------------------------------------------------------- |
| 领域事件 / 消息形状    | `packages/kernel`，并更新投影与恢复逻辑 |
| Prompt / 上下文实现  | 接口在 `packages/kernel`，默认组装与投影放 `packages/context/context-runtime`，能力贡献器放对应能力域 |
| 会话读写 / 恢复分析    | 接口、生命周期校验与恢复修复在 `packages/kernel`，内存实现放 `session-memory`，持久化实现放 `session-jsonl` |
| 模型协议           | 接口在 `packages/kernel`；实现在 `packages/llm/*` |
| 工具             | 协议与通用运行时在 `packages/kernel/src/tools`；在 host/runtime 组合时注入 |
| 工具治理         | 可选 `ToolExecutionPolicy` 在工具副作用前判定许可；每个 turn 可带冻结执行审计快照 |
| Agent 循环 / 结算  | `packages/core` |
| 组合与 resume     | `packages/runtime` |
| 进程协议（CLI/HTTP） | `packages/hosts/*` |


新增或替换 capability 时，可遵循 `[.agents/skills/add-capability/SKILL.md](.agents/skills/add-capability/SKILL.md)`：明确 owner / provider / consumer，协议无关契约放 `kernel`，只有 Agent 循环实现放 `core`，其他实现放对应能力域目录，构造放 runtime 或 host；需要按 key 选择实现前不要加 registry。

### 依赖方向（不可违反）

```text
hosts → runtime → core → kernel
  |          |       |
  +----------+-------+→ capability implementations / adapters → kernel
```

`kernel` 无 workspace 依赖。Core、能力实现与 adapter 的生产依赖都只能指向 `kernel`。修改依赖后跑 `pnpm run gate:architecture`。

### 测试约定

- 断言可观察行为与已提交事件顺序，不测私有结构
- 单元测试不调用真实模型 API；使用 `test-support` 中的 fake
- 覆盖新增 await 边界上的取消与失败结算

## 相关文档

- `[AGENTS.md](AGENTS.md)` — 仓库与 Agent 工作规则
- `[docs/architecture.md](docs/architecture.md)` — 当前架构
- `[docs/decisions/](docs/decisions/)` — 已接受的架构决定
- `[packages/hosts/cli/README.md](packages/hosts/cli/README.md)` — CLI 简要说明
