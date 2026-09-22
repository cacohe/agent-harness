# Agent Harness Lab

面向生产设计的 Agent Harness 实现。实现保持精简、便于理解，同时保留可靠运行时所需的失败、取消、持久化与组件替换能力。

核心思路：用 **append-only 会话事件日志** 作为模型可见历史的唯一事实源，用显式 **Agent 状态机** 驱动 turn/step 循环，通过 **capability 接口 + adapter + host** 组合应用，不使用服务定位器或进程全局运行时。

## 基本架构

依赖向内：

```text
hosts  →  runtime  →  agent / session / model / tools
                ↑           ↑
     llm|session adapters   （capability 包）
                ↓
             domain
```


| 层次                                      | 职责                               |
| --------------------------------------- | -------------------------------- |
| `domain`                                | 稳定标识符、事件、消息与错误                   |
| `session` / `model` / `tools` / `agent` | 核心行为与 capability 接口              |
| `session-jsonl` / `openai-compatible`   | 把文件系统、HTTP 等转为接口实现               |
| `runtime`                               | 显式组合根：`create` / `resume` / 生命周期 |
| `hosts`                                 | 进程入口：配置、信号、stdout/stderr         |


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

当前最小可运行入口是 `@agent-harness/cli`：组合 JSONL 会话、OpenAI-compatible 模型、空工具表与 Runtime。

### 1. 准备配置文件

`--config` **必须是绝对路径**。配置中不写 API key，只写环境变量名：

```json
{
  "sessionRoot": "/绝对路径/sessions",
  "maxSteps": 8,
  "settlementTimeoutMs": 30000,
  "model": {
    "id": "openai-compatible",
    "baseUrl": "https://api.deepseek.com/v1",
    "model": "deepseek-chat",
    "apiKeyEnv": "DEEPSEEK_API_KEY"
  }
}
```

Windows 示例：`sessionRoot` 可为 `F:/data/agent-sessions`，配置文件用 `F:/path/to/config.json`。

字段说明：

- `sessionRoot`：JSONL 会话根目录（绝对路径）
- `maxSteps`：单次 turn 内最大 step 数
- `settlementTimeoutMs`：失败/取消路径上 terminal settlement 的超时
- `model.baseUrl`：OpenAI-compatible API 根（通常以 `/v1` 结尾）
- `model.apiKeyEnv`：存放 API key 的环境变量名

### 2. 设置密钥并运行

```bash
# Unix
export DEEPSEEK_API_KEY=sk-...
pnpm run build
node packages/hosts/cli/lib/index.js run \
  --config /绝对路径/config.json \
  --session demo-1 \
  --message "你好，介绍一下你自己"

# Windows PowerShell
$env:DEEPSEEK_API_KEY = "sk-..."
pnpm run build
node packages/hosts/cli/lib/index.js run `
  --config F:/path/to/config.json `
  --session demo-1 `
  --message "你好，介绍一下你自己"
```

恢复已有会话：

```bash
node packages/hosts/cli/lib/index.js resume \
  --config /绝对路径/config.json \
  --session demo-1 \
  --message "继续上一次的话题"
```

### 3. 输出约定

- **stdout**：仅 JSONL（`stream` / `result` / `error`）
- **stderr**：usage 与不含密钥的诊断
- **SIGINT / SIGTERM**：取消当前 run，并在 finally 中关闭资源

首个 CLI 尚未注册业务工具；需要工具时请在 Host 组合点接入 `ToolRegistry`（见下节）。

## 如何开发新功能

### 工作流

1. 改运行时代码前阅读 `[docs/architecture.md](docs/architecture.md)` 与相关 `[AGENTS.md](AGENTS.md)`
2. 影响依赖方向、事件兼容性、生命周期或公共 capability 时，在 `docs/decisions/` 新增 ADR
3. 用确定性 fake 测接口；在 adapter 入口测外部协议
4. 交付前运行 `pnpm run check`

### 按变更类型落点


| 目标             | 落点                                                         |
| -------------- | ---------------------------------------------------------- |
| 领域事件 / 消息形状    | `packages/domain`，并更新投影与恢复逻辑                               |
| 会话读写 / 恢复分析    | `packages/session`；持久化实现放 `session-jsonl` 或新 adapter       |
| 模型协议           | 接口在 `packages/model`；实现在 `packages/adapters/*`             |
| 工具             | 接口与 `ToolRegistry` 在 `packages/tools`；在 host/runtime 组合时注入 |
| Agent 循环 / 结算  | `packages/agent`                                           |
| 组合与 resume     | `packages/runtime`                                         |
| 进程协议（CLI/HTTP） | `packages/hosts/*`                                         |


新增或替换 capability 时，可遵循 `[.agents/skills/add-capability/SKILL.md](.agents/skills/add-capability/SKILL.md)`：明确 owner / provider / consumer，接口放消费方 core package，外部实现放 adapters，构造放 runtime 或 host；需要按 key 选择实现前不要加 registry。

### 依赖方向（不可违反）

```text
hosts → runtime → agent / tools / model / session → domain
                 → adapters → capability 所属 package → domain
```

`domain` 无 workspace 依赖。Core 不依赖具体 adapter。修改依赖后跑 `pnpm run gate:architecture`。

### 测试约定

- 断言可观察行为与已提交事件顺序，不测私有结构
- 单元测试不调用真实模型 API；使用 `test-support` 中的 fake
- 覆盖新增 await 边界上的取消与失败结算

## 相关文档

- `[AGENTS.md](AGENTS.md)` — 仓库与 Agent 工作规则
- `[docs/architecture.md](docs/architecture.md)` — 当前架构
- `[docs/decisions/](docs/decisions/)` — 已接受的架构决定
- `[packages/hosts/cli/README.md](packages/hosts/cli/README.md)` — CLI 简要说明

