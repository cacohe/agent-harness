# Packages

workspace 按能力域分组；包名为 `@agent-harness/<目录叶名>`。依赖规则见本目录 `AGENTS.md`，布局决定见 `docs/decisions/0011-capability-domain-package-layout.md`。

```text
kernel/                         Agent 概念、状态、接口、事件与错误
core/                           Agent 核心循环实现
context/context-runtime/        Prompt 组装、时间上下文与模型消息投影
llm/*/                          模型协议 adapter
memory/memory-context/          长期记忆上下文贡献器
session/*/                      会话内存、恢复与持久化实现
skills/skill-context/           已启用 Skill 摘要上下文贡献器
tools/tool-runtime|mcp|*/       工具运行时与工具 adapter
runtime/                        显式组合根
hosts/cli/                      进程入口
test-support/                   测试基础设施
```
