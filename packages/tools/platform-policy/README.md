# @agent-harness/platform-policy

## 职责

`PlatformPermitPolicy` 在工具副作用前向 Platform 请求一次性许可，并校验回显的执行身份与输入摘要。

## 使用

将该策略包装到 `PolicyControlledTools`；客户端、时钟和请求约束由组合方注入。

## 不负责

不执行实际工具，也不负责 Platform 的许可记账或审批界面。
