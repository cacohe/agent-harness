# ADR 0045：统一工具执行上下文并分离 Sandbox 工具规格

## 背景

`ToolCapability` 同时存在 `execute(call, signal)` 与可选的 `executeWithContext(call, context)` 两套调用路径。调用方必须在运行时探测实现是否支持后者，导致执行上下文成为非必需能力。`SandboxToolRegistry` 又接收带进程内 `execute` 函数的 `ToolDefinition`，但实际仅使用其模型描述与 `parseInput`，使契约包含无效字段。

## 决策

`ToolCapability.execute` 统一接收 `ToolExecutionContext`。所有能力实现都必须显式接收并传播取消信号与可选执行身份；删除兼容调用辅助函数和 `ExecutionAwareToolCapability`。

新增 `ToolSpecification`，只包含模型可见描述和 `parseInput`。`ToolDefinition` 继承该规格并只用于进程内 `ToolRegistry`，额外要求本地 `execute` 函数。`SandboxToolRegistry` 只要求 `ToolSpecification`，将规范化调用和已冻结执行身份交给 `SandboxDispatcher`。

## 后果

工具能力的调用路径唯一，跨来源组合不再依赖运行时特征探测。Sandbox 配置不再要求永远不会调用的本地执行函数。此变更是公开 TypeScript 契约的破坏性调整，所有实现方需要把 `AbortSignal` 包装在 `ToolExecutionContext` 中。

## 放弃的方案

继续保留旧签名并将上下文作为可选增强。该方案维持短期兼容，却让执行身份传播依赖隐藏的运行时分支，并长期保留两套工具实现协议。
