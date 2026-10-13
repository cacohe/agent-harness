# ADR 0049：按能力域组织 Kernel 协议，并引入 Agent Profile

## 背景

`kernel/context.ts` 同时定义 prompt、Skill 与 Memory 契约，能力域无法从目录结构发现。Host 只能用无身份和版本的 `systemPrompt` 字符串表达某个 Agent 的静态指令，无法区分 Agent 人格与 Host 的工作区、安全边界提示。

## 决策

将 Kernel 契约按能力域放入 `context/protocol.ts`、`skills/protocol.ts` 与 `memory/protocol.ts`，根入口继续导出相同词汇。

Kernel 定义 `{ id, version, instructions }` 形式的 `AgentProfile`。Host 或 Platform 在配置边界解析 profile；Runtime 冻结其字段，并在使用默认 prompt 组装器时把 `instructions` 作为最前面的 system message。自定义 `prompts` 已完全拥有组装顺序，因此不得同时提供 `agentProfile`。

Agent Profile 不写入会话事件，也不混入执行身份或授权元数据。Host 仍可在 profile 指令前加入工作区、工具和安全边界；需要跨会话审计 profile 版本时，再扩展独立会话审计契约。

## 后果

调用方能以稳定 ID 和版本选择静态 Agent 人格，同时保持动态上下文贡献、会话历史和工具定义的既有注入顺序与输入预算。Kernel 保留协议，不拥有产品角色的具体文本。

## 放弃的方案

继续只使用 `systemPrompt` 字符串。它无法表达 profile 的身份或版本，也无法在组合代码中清楚地区分 Agent 指令和 Host 强制边界。
