# ADR 0013：生产执行边界与上下文策略

状态：已接受

## 背景

Agent 会把不可信模型输出交给工具，并将会话历史送回模型。仅靠 `maxSteps` 和 terminal settlement deadline 不能限制单次运行时长、模型流体积或上下文大小。直接暴露本机 shell 会把宿主机权限和环境变量变成模型可达能力。

## 决策

`agent` 拥有 `PromptAssembler` capability。它从 append-only 事件快照和当前工具目录构造 `ModelRequest`；默认实现支持静态 system prompt、完整 turn 边界裁剪和输入字节预算。超过预算而无法保留最新完整用户 turn 时失败，不发送不完整工具上下文。

Runtime 向 Agent 注入每个 turn 的总 deadline 和模型输出预算。Agent 把总 deadline 传给模型与工具；累计文本和工具调用 JSON 超过预算时以失败结算该 turn。OpenAI-compatible adapter 另外限制未形成完整事件的缓存和整个响应字节数，避免恶意或故障上游无限占用内存。

Host 侧 `run_shell` 默认不注册。显式启用时仅继承最小运行环境，并在 Unix 中以独立进程组启动和终止整组进程。它仍是本地实验能力，不能作为多租户隔离边界。

JSONL adapter 保持单机文件存储定位；生产多实例必须在 `SessionWriteLeaseProvider` 注入具有 fencing/租约语义的外部实现。CLI 不把 JSONL 标记为多实例安全。

## 后果

模型可见输入和资源预算成为可替换、可测试的显式依赖。静态提示词不写入会话日志；会话事件仍是对话事实源。运行超时会走既有取消与 terminal settlement 路径。

跨进程 session 所有权不由不具备可靠分布式锁语义的本地文件锁伪造；生产 host 必须组合外部 lease provider 与相应 repository。

## 放弃的方案

- 继续让 Agent 直接调用 `deriveModelMessages`：无法实现上下文预算、system prompt 或策略替换。
- 以本地 lockfile 宣称多实例安全：崩溃、网络文件系统和失效租约会使该承诺不成立。
- 默认开启 shell 并继承完整环境：会使模型输出能够读取密钥并逃逸资源预算。
