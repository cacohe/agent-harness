# ADR 0054：工具契约、工具集与模型投影

状态：已接受

## 背景

工具领域此前以 `ModelToolDefinition` 作为 `ToolSpecification` 和 `ToolDefinition` 的父接口，容易让模型传输投影看起来像工具领域的原始定义。`ToolDefinition` 实际表示带直接执行器的工具，但名称未说明这一点。`ToolCapability` 同时拥有目录和执行路由，而其父接口 `ToolCatalog` 没有独立消费者。

这会模糊工具自身契约、模型可见投影和一次 Agent 运行中工具集三种不同概念，也扩大了公共类型层次。

## 决策

工具领域使用以下术语：

- `ToolContract` 是工具的原始调用契约，拥有名称、描述、输入 schema 和输入规范化器；`parseInput` 是不可信模型输入进入执行器前的权威校验。
- `ExecutableTool` 扩展 `ToolContract` 并提供直接执行器。它不表示操作必须在本地完成；执行器可使用组合方显式注入的外部依赖。
- `ModelToolDefinition` 是 `ToolContract` 的只读模型投影，由 `toModelToolDefinition` 构造，不再作为工具契约的父接口。
- `ToolSet` 表示一次 Agent 运行中固定的模型目录与调用路由，直接定义 `list` 和 `execute`。删除无独立消费者的 `ToolCatalog`。

`CompositeToolSet`、`PolicyControlledToolSet`、`SandboxToolSet` 和 MCP adapter 均实现 `ToolSet`。Sandbox 仍是执行环境：`SandboxToolSet` 仅将已校验的 `ToolContract` 调用委派给 `SandboxDispatcher`，不把沙箱定义为工具。

本决定不新增 `ToolId`、版本或通用执行后端抽象；当前运行内唯一的工具名称与持久化的 `ToolCallId` 已满足路由和审计需要。

## 后果

Core 继续只依赖 Kernel 的 `ToolSet`，对本地、MCP、策略或沙箱执行方式无感知。模型 adapter 继续只接收 `ModelToolDefinition` 并负责供应商 function-calling 协议编解码。具体工具与外部 I/O 仍留在 adapters。

这是公开 TypeScript API 的破坏性命名调整；所有消费者必须迁移到新的领域术语。工具调用、工具结果、会话事件、恢复和 Core 的执行顺序不变。

## 放弃的方案

- 保留旧接口并提供别名：会长期暴露两套词汇，不能真正消除领域歧义。
- 将 `ToolSet` 替换为裸 `ExecutableTool[]`：会迫使 Core 获得名称路由、远程适配和组合职责。
- 新建 Local/MCP/Sandbox 的继承树：会将传输协议和执行环境细节混入工具的核心身份。
- 为尚未出现的跨名称治理需求新增 `ToolId`、版本或执行后端框架：会增加无当前消费者的抽象。
