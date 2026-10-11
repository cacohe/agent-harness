# ADR 0040：Core 只保留 Agent 核心循环

## 状态

已接受。

## 背景

ADR 0038 将 Agent 循环使用的协议无关契约集中到 `kernel`，ADR 0039 将循环实现合并到单一 `core` package，但 Core 仍拥有默认 prompt 组装、上下文贡献器和模型消息投影。这些实现会因输入预算、上下文来源和投影策略变化，与 Agent 生命周期状态机的变化原因不同。

Agent 相关的概念、状态、事件、错误和 capability 接口必须有一个稳定且无外部依赖的权威位置；Agent 核心循环则应只编排这些接口，不拥有任何可替换能力的默认策略。

## 决策

- `kernel` 继续拥有 Agent 循环使用的全部协议无关概念与接口，包括 `AgentOptions`、`PromptAssembler`、`ContextContributor`、`Clock`、`MemoryRetriever` 和 `SkillCatalog`。
- `core` 只保留 `Agent` 核心循环状态机及其内部生命周期实现，并且只依赖 `kernel`。
- `PromptAssembler` 成为构造 Agent 时的必需依赖。Core 不创建默认实现。
- 默认 prompt 组装、当前时间上下文和模型消息投影迁入 `context/context-runtime`。
- 长期记忆和已启用 Skill 的上下文贡献器分别迁入 `memory/memory-context` 与 `skills/skill-context`。
- 这些协议无关实现 package 只依赖 `kernel`。Runtime 或 Host 在组合点选择并注入实现。
- 会话事件格式和模型可见行为保持不变。

本决定取代 ADR 0039 中把上下文组装和消息投影保留在 Core 的部分。

## 放弃的方案

- 继续由 Core 提供默认 prompt 策略：调用方便，但会让 Core 同时承担生命周期编排和上下文策略两种变化原因。
- 把 prompt、memory 和 skill 的概念迁出 Kernel：会拆散 Agent 循环的权威契约，并迫使 Core 依赖多个能力 package。
- 把所有上下文实现放进一个 package：会让 memory 和 skill 的实现所有权脱离各自能力域，并增加不必要的实现间耦合。

## 后果

Core 的变化原因收敛为 Agent 循环与结算语义。上下文预算、投影和能力贡献器可以独立替换，而不会扩大 Core 的公共 API 或依赖。直接构造 Agent 的调用方必须明确选择 prompt 策略；Runtime 仍提供当前默认策略，保持 Host 行为稳定。架构 gate 将 Core 源码限制为 Agent 循环文件且只允许导出 `Agent`，同时拒绝 Core 依赖这些实现 package，也拒绝实现 package 依赖 Core 或彼此依赖。
