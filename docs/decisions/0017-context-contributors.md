# ADR 0017：以受限贡献器组装易变上下文

## 背景

模型请求除会话历史和工具 schema 外，还需要基础系统提示词、当前时间及未来的已启用 Skills 摘要。它们不是用户对话事实，写入会话日志会污染重放和模型历史；把它们散落在 Host 也会绕过统一输入预算。

## 决策

`core/agent` 的 `BoundedPromptAssembler` 接受显式 `ContextContributor` 列表。每个贡献器仅能同步生成非空 system 消息，并收到事件快照和可用工具定义。Assembler 将静态 system prompt 与贡献消息计入 `maxInputBytes`，随后附加裁剪后的会话历史。`CurrentTimeContext` 通过构造函数注入的 `Clock` 生成 UTC 时间消息。

## 后果

Host 或 Platform 可以在组合点增加 Skills 名称和描述等上下文，而不会将 Skill 正文或运行时配置持久化为对话事实。贡献器必须保持本地、确定性且快速；需要 I/O 的检索属于后续显式 capability，不能隐藏在请求组装路径。

## 放弃的方案

不使用全局 prompt registry 或 Host 字符串拼接，因为它们会隐藏依赖并绕过输入预算。也不允许贡献器返回 user、assistant 或 tool 消息，避免外部上下文伪造会话事实。
