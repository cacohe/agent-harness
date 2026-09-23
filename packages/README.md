# Packages

workspace 按能力域分组；包名为 `@agent-harness/<目录叶名>`。依赖规则见本目录 `AGENTS.md`，布局决定见 `docs/decisions/0011-capability-domain-package-layout.md`。

```text
domain/                         领域词汇
core/agent|tools/               Agent 循环与工具
llm/model|openai-compatible/    模型接口与协议 adapter
session/session|session-jsonl/  会话接口与 JSONL adapter
runtime/                        显式组合根
hosts/cli/                      进程入口
test-support/                   测试基础设施
```
