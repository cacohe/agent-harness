# ADR 0044：Kernel 拥有通用工具运行时，Host 只组合工具

## 背景

工具契约位于 Kernel，但注册、路由、授权包装和 Sandbox 路由位于独立 `tools/tool-runtime` package；CLI 与 Web 还各自定义本地工具。通用工具语义因此跨越多个位置，Host 也同时承担工具实现与组合职责。

## 决策

Kernel 除协议无关工具契约外，还拥有纯内存、无外部系统依赖的通用工具运行时实现，包括 `ToolRegistry`、`CompositeToolCapability`、`PolicyControlledTools`、`SandboxToolRegistry` 及其输入、输出、快照与调用辅助逻辑。工具调用、结果、执行上下文、治理和生命周期契约集中在 Kernel 的工具领域。

`tools/` 仅放具体工具或外部 adapter。可复用的本地 Shell 与工作目录工具放入 `tools/local`。CLI 与 Web 只读取配置、提供具体依赖、选择允许工具并组合 Runtime；不再定义可复用工具实现。

具体外部资源的启动和关闭仍由 adapter 与 Host 所有；Kernel 只定义其可选的协议无关生命周期契约，不创建进程、网络连接或容器。

本决定取代 ADR 0039 中“`tools/tool-runtime` 提供工具注册、组合、策略包装和 Sandbox 路由”的部分。

## 后果

调用方只依赖 Kernel 即可获得完整的协议无关工具语义，Core 继续只通过 `ToolCapability` 编排 Agent 循环。具体工具与 Host 组合的边界更清楚；不再保留 `@agent-harness/tool-runtime`。

Kernel 的公共实现范围扩大，因此其中的工具运行时代码必须保持纯内存、协议无关，禁止引入文件系统、网络、进程或模型 SDK 依赖。

## 放弃的方案

保留 `tools/tool-runtime` 作为能力域实现。该方案维持既有 package 边界，但使通用工具运行时与工具契约分离，也让 Host 工具实现继续分散。
