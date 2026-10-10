# Packages

workspace 按能力域分组；包名为 `@agent-harness/<目录叶名>`。依赖规则见本目录 `AGENTS.md`，布局决定见 `docs/decisions/0011-capability-domain-package-layout.md`。

```text
kernel/                         Agent 概念、状态、接口、事件与错误
core/agent|session|tools/       Agent、会话与工具核心实现
llm/*/                          模型协议 adapter
session/session-jsonl/          JSONL 会话 adapter
runtime/                        显式组合根
hosts/cli/                      进程入口
test-support/                   测试基础设施
```
