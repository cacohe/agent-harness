# ADR 0021：协议无关的 Platform 工具许可 adapter

状态：已接受

## 背景

ADR 0014 已定义冻结执行上下文和 `ToolExecutionPolicy`，但还没有把 Platform 的权限快照与一次工具调用绑定。Agent Runtime 不应知道 HTTP、JWT、租户账户或审批服务协议；同时，未经校验的远程许可不能直接触发工具副作用。

## 决策

新增 `tools/platform-policy` adapter。它把组合方提供的 `PlatformPermitClient` 转换为 `ToolExecutionPolicy`。Client 的一次 `authorizeTool` 调用必须由 Platform 原子完成许可领取与记账，并响应 `AbortSignal`；传输、认证、重试和审批等待由 Client 或上层 Host 拥有。

许可请求包含 execution ID、主体、冻结授权版本、tool call ID、工具名，以及对模型工具输入进行规范 JSON 编码后的 SHA-256 摘要。`PolicyControlledTools` 在授权 await 前复制并深度冻结 ToolCall 与执行身份，让策略和真实工具使用同一快照。Adapter 不持有账户或密钥，只严格校验 Platform 响应字段。允许响应必须返回非空 permit ID，并回显 execution ID、主体、授权版本、tool call ID、工具名和输入摘要，同时携带晚于注入时钟的规范 ISO 失效时间。任何未知字段、绑定不匹配、过期或无效响应都失败关闭，不执行工具。拒绝响应只保留非空原因。

本阶段不定义 HTTP 路径、JWT 格式、审批恢复协议或可靠 outbox；这些属于具体 Platform client 和 Hosted Service。许可绑定的是 Agent 接纳的规范 ToolCall JSON，工具 parser 仍在工具执行边界负责业务校验。

## 后果

Runtime 或 Host 可以把 Platform 权限服务接入既有 `PolicyControlledTools`，而 core、Agent 和 session 不依赖 Platform SDK。相同 JSON 对象的字段顺序不会改变摘要；远程响应不能把另一执行身份、授权版本、工具或输入的许可重放到当前调用。授权等待期间外部引用的修改也不会改变真实执行收到的快照。

Permit ID 当前只用于验证远程许可已经形成；Platform 是一次性消费与审计的权威。审批恢复、计费 outbox 和具体网络认证仍需后续 adapter 实现。

## 放弃的方案

- 在 Agent 中直接调用 Platform：会把网络、身份和租户协议引入核心状态机。
- 只让 Platform 返回布尔值：无法证明许可绑定了哪次 execution、tool call 和输入，也无法校验过期。
- 在 adapter 中实现 JWT、HTTP 重试或审批轮询：会把部署策略固化到通用许可映射层。
- 使用普通 `JSON.stringify` 计算摘要：对象字段顺序会导致语义相同的输入产生不同摘要。
