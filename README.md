# Agent Harness Lab

面向生产设计的 Agent Harness 实现。实现保持精简、便于理解，同时保留可靠运行时所需的失败、取消、持久化与组件替换能力。

核心思路：用 **append-only 会话事件日志** 作为模型可见历史的唯一事实源，用显式 **Agent 状态机** 驱动 turn/step 循环，通过 **capability 接口 + adapter + host** 组合应用，不使用服务定位器或进程全局运行时。

## 基本架构

依赖向内：

```text
hosts  →  runtime  →  core/agent|tools · llm/model · session/session
                ↑                              ↑
     llm/* · session/* adapters          （capability 包）
                ↓
             domain
```


| 层次 | 目录落点 | 职责 |
|------|----------|------|
| 领域词汇 | `packages/domain` | 稳定标识符、事件、消息与错误 |
| Capability | `core/*`、`llm/model`、`session/session` | 核心行为与接口 |
| Adapter | `llm/openai-compatible`、`session/session-jsonl`、`tools/mcp`、`tools/platform-policy` | 外部系统实现 |
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

- 每个 Agent 同时只有一个活动；取消使用 `AbortSignal`
- 已打开的 turn/step 在成功、失败与取消路径上恰好结算一次
- 流式 chunk 是临时通知；持久化的是完整 assistant settlement

更细的行为、所有权与失败语义见 `[docs/architecture.md](docs/architecture.md)`。架构决定见 `[docs/decisions/](docs/decisions/)`。

## 项目目录结构

```text
docs/                     架构与已接受决定（ADR）
packages/
  domain/                 纯领域类型（无 IO）
  core/
    agent/                Inbox 与 Agent 状态机
    tools/                工具定义、注册与调度
  llm/
    model/                模型 provider 接口与流事件
    openai-compatible/    OpenAI-compatible Chat Completions
  tools/
    mcp/                  MCP 工具 adapter
    platform-policy/      Platform 一次性工具许可 adapter
  session/
    session/              事件日志、投影、持久化接口
    session-jsonl/        JSONL 会话存储 adapter
  runtime/                显式组合与 handle 生命周期
  hosts/
    cli/                  单进程 JSON 配置 CLI
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
| `pnpm run check`     | 架构 gate + 文档 gate + typecheck + test |


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
- `systemPrompt`（可选）：不写入会话事件的静态 system 指令
- `model.baseUrl`：OpenAI-compatible API 根（通常以 `/v1` 结尾）
- `model.apiKeyEnv`：存放 API key 的环境变量名（默认 `DEEPSEEK_API_KEY`）
- `shell`（可选）：`enabled`、`cwd`（绝对路径）、`timeoutMs`、`maxOutputBytes`；控制本机 `run_shell` 工具

密钥只放在环境变量 / `.env` 中，不要写进 JSON 配置。`run_shell` 默认关闭；显式启用后仍以当前用户权限执行命令，无沙箱，仅适合本地实验。

当前 CLI 与 JSONL 会话存储只支持单实例运行。同一 `sessionRoot` 不得被多个 Node.js 进程、容器或服务实例同时使用。

### 2. 运行

```bash
# run：创建新会话（同一 session id 只能成功一次）
pnpm agent run --session demo-1 --message "你好，介绍一下你自己"
# resume：打开已有会话继续对话
pnpm agent resume --session demo-1 --message "继续上一次的话题"
# chat：同一进程多轮交互（会话不存在则创建，已存在则恢复）
pnpm agent chat --session demo-1 --message "你好"
```

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

- **stdout**：仅 JSONL（`stream` / `result` / `error`）
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
| 领域事件 / 消息形状    | `packages/domain`，并更新投影与恢复逻辑 |
| 会话读写 / 恢复分析    | `packages/session/session`；持久化实现放 `packages/session/session-jsonl` |
| 模型协议           | 接口在 `packages/llm/model`；实现在 `packages/llm/*` |
| 工具             | 接口与 `ToolRegistry` 在 `packages/core/tools`；在 host/runtime 组合时注入 |
| 工具治理         | 可选 `ToolExecutionPolicy` 在工具副作用前判定许可；每个 turn 可带冻结执行审计快照 |
| Agent 循环 / 结算  | `packages/core/agent` |
| 组合与 resume     | `packages/runtime` |
| 进程协议（CLI/HTTP） | `packages/hosts/*` |


新增或替换 capability 时，可遵循 `[.agents/skills/add-capability/SKILL.md](.agents/skills/add-capability/SKILL.md)`：明确 owner / provider / consumer，接口放消费方 capability 包，外部实现放对应能力域目录（如 `llm/`、`session/`），构造放 runtime 或 host；需要按 key 选择实现前不要加 registry。

### 依赖方向（不可违反）

```text
hosts → runtime → core|llm|session capability 包 → domain
               → llm|session adapters → capability 所属 package → domain
```

`domain` 无 workspace 依赖。Capability 包不依赖具体 adapter。修改依赖后跑 `pnpm run gate:architecture`。

### 测试约定

- 断言可观察行为与已提交事件顺序，不测私有结构
- 单元测试不调用真实模型 API；使用 `test-support` 中的 fake
- 覆盖新增 await 边界上的取消与失败结算

## 相关文档

- `[AGENTS.md](AGENTS.md)` — 仓库与 Agent 工作规则
- `[docs/architecture.md](docs/architecture.md)` — 当前架构
- `[docs/decisions/](docs/decisions/)` — 已接受的架构决定
- `[packages/hosts/cli/README.md](packages/hosts/cli/README.md)` — CLI 简要说明
