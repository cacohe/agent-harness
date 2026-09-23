# AGENTS.md

Agent Harness Lab 是面向生产设计的 Agent Harness 实现。代码应足够精简、便于理解，同时保留可靠运行时所需的失败、取消、持久化和组件替换接缝。

## 必需工作流

- 修改运行时代码前阅读 `docs/architecture.md`。
- 实现重要架构变更前或同时在 `docs/decisions/` 记录决定。
- 每个 Coding Agent 或 Review Agent 使用独立 Git worktree；编码与审查必须由不同 Agent 执行。
- 人类所有者决定架构。Agent 可以实现已接受的决定、指出缺失决定并提出具体选项，但不能静默选择实质不同的架构。
- 交付变更前运行 `pnpm run check`，并报告实际执行的命令。

## 工程规则

- 必须使用 TypeScript、ESM、Node.js 24 和 `strict: true`。
- 依赖通过构造函数或函数参数显式传入，不得引入服务定位器或进程全局运行时。
- 模型可见状态从 append-only 会话事件日志重建。
- Domain 代码不得导入运行时、adapter、host、文件系统、网络、进程或模型 SDK 模块。
- Capability 所属 package 只依赖 capability 接口与 `domain`，不依赖具体 adapter。
- Adapter 把外部系统转换为 capability 接口，并放在对应能力域目录（如 `llm/`、`session/`）。
- Host 组合运行时并拥有进程生命周期。
- 每个已经开始的 turn 和 step 必须在取消与失败路径上也恰好结算一次。
- 流式通知是临时数据；持久化的 assistant 结算必须写入会话事件。
- 在配置、存储、进程、工具 JSON 和网络协议入口校验不可信数据。
- 避免推测性抽象；只有已经存在两个实现，或外部系统本身会变化时才增加替换接缝。
- 仓库中的 Markdown、AGENTS、ADR、Skill、JSDoc 和代码注释统一使用中文；代码标识符、包名、协议字段和必要错误码保留英文。
- 文件末尾恰好保留一个换行。格式、依赖方向、package 元数据、类型检查和测试必须由 `scripts/` 或 package script 中的可执行 gate 检查。

## 仓库结构

workspace 按能力域分组（ADR 0011）；npm 包名为 `@agent-harness/<目录叶名>`。

```text
docs/                              架构与决定
packages/
  domain/                          纯标识符、事件、消息与错误
  core/
    agent/                         Inbox 与 Agent 状态机
    tools/                         工具定义、注册与调度
  llm/
    model/                         模型 provider 接口与流事件词汇
    openai-compatible/             OpenAI-compatible 模型 adapter
  session/
    session/                       事件日志、投影与持久化接口
    session-jsonl/                 JSONL 会话存储 adapter
  runtime/                         显式组合与生命周期
  hosts/cli/                       CLI 等进程入口
  test-support/                    确定性 fake 与 fixture
scripts/                           可执行仓库 gate
.agents/skills/                    可复用仓库工作流
```

目录内更具体的 `AGENTS.md` 规则优先适用。
