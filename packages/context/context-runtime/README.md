# @agent-harness/context-runtime

## 职责

提供默认的 `BoundedPromptAssembler`、`CurrentTimeContext` 和 `deriveModelMessages`，把持久会话事实投影为受预算约束的模型消息。

## 使用

组合方把 prompt assembler 和可选 context contributor 注入 Agent 或 Runtime；所有内容都计入输入预算。

## 不负责

不读取会话、不调用模型，也不持久化上下文贡献内容。
