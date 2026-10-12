# @agent-harness/runtime

## 职责

`AgentRuntime` 显式组合 Agent 所需能力，并拥有会话写入器与 Agent 句柄的生命周期。

## 使用

通过 `create` 创建新会话，或通过 `resume` 在完成历史校验和修复后恢复；调用 `close` 取消活动 Agent、等待 idle 并释放 writer。

## 不负责

不直接选择模型、存储、工具或 Host 协议；这些都通过 options 注入。
