# Agent Harness Lab

> 面向可靠执行语义的 TypeScript Agent Runtime 参考实现。

Agent Harness Lab 不是 prompt wrapper，也不是多租户 Agent SaaS。它用 append-only 会话事件作为模型可见历史与恢复事实源，以显式状态机运行 turn/step，并用 capability、adapter 与 host 的清晰边界组合模型、工具、Skills、Memory 和会话存储。

[架构说明](docs/architecture.md) · [架构决定](docs/decisions/) · [贡献指南](CONTRIBUTING.md) · [安全政策](SECURITY.md) · [Apache-2.0](LICENSE)

## 为什么存在

这个项目关注 Agent 在真实执行环境中容易被忽略的边界：

- 单 writer、可重放的会话事实与中断恢复。
- turn/step 的成功、失败、取消恰好一次结算。
- 模型 attempt、工具调用、工具载荷与输入队列的独立资源边界（工具载荷预算不等于事件总大小，见 [ADR 0053](docs/decisions/0053-runtime-resource-governance.md)）。
- 工具授权、MCP、Skills、Memory 与模型 provider 的显式替换接缝。
- 稳定 `messageId` 的提交幂等性与可关联的执行观测事件。

## 架构

```text
hosts → runtime → core → kernel
  |          |       |
  +----------+-------+→ adapters → kernel
```

| 层次 | 职责 |
| --- | --- |
| `kernel` | 协议、会话生命周期、错误与通用工具运行时 |
| `core` | 单会话 Agent 状态机、串行调度与结算 |
| `adapters` | JSONL、模型、MCP、Skills、Memory 与本地工具实现 |
| `runtime` | 组合、恢复与资源生命周期 |
| `hosts` | CLI/Web 配置、凭据、交互和进程协议 |

一次 turn 的主路径：

```text
input → turn.started → step.started → model stream → assistant.settled
                                      │
                                      └→ tool.completed → 下一 step 或 turn.ended
```

## 快速开始

要求：Node.js 24+ 与根目录 `packageManager` 指定的 pnpm。

```bash
pnpm install
cp examples/cli/.env.example examples/cli/.env
# Windows PowerShell: Copy-Item examples/cli/.env.example examples/cli/.env
# 编辑 examples/cli/.env，填入 DEEPSEEK_API_KEY
pnpm run build
pnpm agent run --session demo-1 --message "你好，介绍一下你自己"
```

示例配置位于 [examples/cli/config.example.json](examples/cli/config.example.json)，密钥只通过环境变量提供。运行中的已存在会话使用 `resume`；重试时复用 `--message-id`，以避免重复执行工具。

```bash
pnpm agent resume --session demo-1 --message "继续上一次的话题" --message-id retry-001
pnpm agent chat --session demo-1 --message "你好"
```

本地 Web Host：

```bash
cp examples/web/.env.example examples/web/.env
pnpm run build
pnpm web
```

它只绑定 `127.0.0.1`；浏览器不会获得模型密钥。CLI 与 Web 的详细配置、MCP、Skills、Memory、文档导入和输出协议请见对应 [Host 文档](packages/hosts/README.md)。

## 运行与安全边界

- JSONL 会话存储是单实例、单 writer 方案；不能让多个进程、容器或服务实例共享同一 `sessionRoot`。
- Web Host 是本机单用户界面，不支持远程监听、认证或多租户服务。
- `run_shell` 默认关闭；启用后没有沙箱，只适用于受信任的本地实验。
- filesystem Skills 的安全校验依赖 Linux；Windows 请通过 WSL 使用此能力。
- 本项目是 production-oriented reference implementation，不宣称已完成高可用、多租户、合规审计或安全认证。

完整威胁与部署边界见 [SECURITY.md](SECURITY.md)。

## 开发

```bash
pnpm run check
```

该命令执行 Biome、架构与文档 gate、类型检查和测试。新增特性必须通过独立 feature branch 与 Pull Request 提交；CI 通过且满足适用审查要求后可合并。

| 文档 | 内容 |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | 当前架构、所有权和依赖方向 |
| [docs/decisions/](docs/decisions/) | 已接受的设计决定与取舍 |
| [docs/public-repository-checklist.md](docs/public-repository-checklist.md) | 公开仓库前后的维护者检查项 |
| [CONTRIBUTING.md](CONTRIBUTING.md) | 贡献流程与代码约定 |
| [SECURITY.md](SECURITY.md) | 漏洞报告与安全边界 |

## 许可证

本项目采用 [Apache License 2.0](LICENSE)。
