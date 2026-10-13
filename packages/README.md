# 包目录

这里仅提供工作区导航。整体依赖方向与运行时模型见 [`docs/architecture.md`](../docs/architecture.md)，每个具体包的公开能力、边界和使用方式见其目录中的 README。

| 路径 | 说明 |
| --- | --- |
| [`kernel`](kernel/README.md) | 协议无关的领域契约 |
| [`core`](core/README.md) | Agent 循环 |
| [`adapters`](adapters/README.md) | 所有具体能力实现与本地默认装配 |
| [`runtime`](runtime/README.md) | 显式组合与资源所有权 |
| [`hosts`](hosts/README.md) | 进程与浏览器入口 |
| [`test-support`](test-support/README.md) | 确定性测试组件 |
