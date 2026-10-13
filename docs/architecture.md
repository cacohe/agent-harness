# 架构

Agent Harness Lab 是面向本地和自托管环境的 TypeScript Agent Runtime 参考实现。它聚焦可靠执行所需的会话持久化与恢复、串行调度、工具调用边界、上下文组装与可组合能力接入；不提供多租户控制面或完整业务产品。

## 依赖层次

`kernel` 定义协议无关概念、状态、接口、事件、错误与纯内存工具运行时。`core` 只实现单 Agent 的核心循环。`adapters` 保存所有具体的模型、会话、工具、Skills、Memory、上下文与本地默认实现，并只依赖 kernel。`runtime` 拥有运行编排与资源生命周期；Host 只负责配置、凭据、进程协议和交互边界。

```text
hosts → runtime → core → kernel
  |          |       |
  +----------+-------+→ adapters → kernel
```

## Package 布局

workspace 只保留需要由构建系统强制隔离的边界（ADR 0050）：

```text
packages/
  kernel/        协议、会话生命周期与通用工具运行时
  core/          Agent 核心循环
  adapters/      具体 adapter；按能力域子目录与子路径导出
  runtime/       运行编排、恢复和资源生命周期
  hosts/cli/     CLI 配置与进程协议
  hosts/web/     本地 Web/SSE 配置与进程协议
  test-support/  确定性 fake 与 fixture
```

新增 workspace package 默认禁止。只有必须隔离依赖方向、拥有独立运行环境或第三方依赖、构成稳定的可替换边界，或具有不同构建、发布、权限或许可证要求时才新增。目录模块是没有这些边界需求时的默认选择。

## 执行与会话

一个 turn 包含零个或多个 step。每个 Agent 同时只有一个活动 turn，Core 用 FIFO inbox 串行领取输入；每个 `run` 只获得其自身 turn 的结果或错误。取消使用 `AbortSignal`。开始的 turn 与 step 在成功、失败和取消路径均恰好结算一次。

会话事件日志是模型可见历史、重放、恢复、审计和 UI 重建的事实源；流式 chunk 仅为临时 observer 通知。每个会话身份只有一个 writer，sequence 严格单调，事件 batch 原子追加。`kernel/session` 验证生命周期历史；发现有效尾部中断时，Runtime 在暴露 Agent 前以原子 batch 补齐未知工具结果与 interrupted 结算。结构性矛盾拒绝恢复。

## 替换接缝与默认装配

Kernel 以 context、skills、memory、模型、会话和工具等能力域定义协议。`@agent-harness/adapters/context` 提供默认 prompt 组装与模型消息投影；`adapters/session-memory` 与 `adapters/session-jsonl` 提供会话实现；其余子路径提供 OpenAI-compatible、Gateway、MCP、Platform、Skills、Memory、本地工具与 Docker sandbox adapter。

`adapters/local-runtime` 收敛 CLI 和 Web 共用的本地 JSONL 与 OpenAI-compatible 默认构造。Host 保留已解析配置、环境变量/凭据、工作目录安全边界、MCP/Platform 命令和 HTTP/CLI 交互协议，因此默认装配可读且可替换，不会在两个 Host 中演化为两套实现。

`AgentProfile` 带 ID、版本和静态指令。Runtime 只在使用默认 prompt 组装器时冻结并注入它；自定义 `PromptAssembler` 完全拥有组装顺序。Profile 当前不写入会话事件，审计需求必须使用独立契约。

工具领域只位于 `kernel/tools/protocol.ts` 与 `kernel/tools/runtime.ts`。`PolicyControlledTools` 在副作用前调用策略；Sandbox、Platform 许可与 MCP 通过 adapters 接入。Kernel 和 Core 不依赖外部网络协议、账户模型、SDK、文件系统或进程。

## 生命周期

拥有资源的组件显式 `start`/`stop`。部分启动失败时按相反顺序释放已启动资源。Runtime handle 关闭时停止接纳输入、取消活动 turn、等待 idle、刷新并关闭 writer；调用方可取消等待，而后台清理继续。结算与关闭均拥有独立的有界 deadline，不共享超时预算。
