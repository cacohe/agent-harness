# 包目录

这里仅提供工作区导航。整体依赖方向与运行时模型见 [`docs/architecture.md`](../docs/architecture.md)，每个具体包的公开能力、边界和使用方式见其目录中的 README。

| 路径 | 说明 |
| --- | --- |
| [`kernel`](kernel/README.md) | 协议无关的领域契约 |
| [`core`](core/README.md) | Agent 循环 |
| [`context`](context/README.md) | Prompt 与上下文实现 |
| [`llm`](llm/README.md) | 模型提供方适配器 |
| [`memory`](memory/README.md) | 长期记忆能力 |
| [`platform`](platform/README.md) | Platform HTTP 适配器 |
| [`session`](session/README.md) | 会话实现与恢复 |
| [`skills`](skills/README.md) | Skill 目录、上下文和工具 |
| [`tools`](tools/README.md) | 工具组合、治理与适配器 |
| [`runtime`](runtime/README.md) | 显式组合与资源所有权 |
| [`hosts`](hosts/README.md) | 进程与浏览器入口 |
| [`test-support`](test-support/README.md) | 确定性测试组件 |
