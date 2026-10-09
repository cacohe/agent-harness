# ADR 0028：统一组合多个工具来源

状态：已接受

## 背景

CLI 已能分别使用本机 function tool 或 MCP 工具，但两者互斥。文件系统 Skill catalog 后续也需要通过显式工具按需读取正文。若 Host 直接拼接模型目录并另写执行分支，重复工具名会让模型可见目录与实际路由产生歧义。

## 决策

`core/tools` 提供 `CompositeToolCapability`。组合方传入已经完成启动的 `ToolCapability`；构造时一次性取得各来源的目录快照，拒绝跨来源重复名称，并保存名称到来源的确定性路由。执行时保留 `ToolExecutionContext`，使 Platform 策略使用的冻结执行身份能够继续传给支持上下文的来源。

CLI 先启动 MCP adapter，再将本机 `ToolRegistry` 与 MCP adapter 组合为单一 capability。MCP 与 shell 可以同时启用；任何名称冲突都在 Runtime 接纳用户输入前失败。CLI 仍拥有 MCP 生命周期，并在 Runtime 关闭后释放 MCP client。

## 后果

Agent loop 继续只依赖一个 `ToolCapability`，Host 可以局部增加 Skill、Sandbox 或其他真实工具来源。工具目录固定为组合时的快照；需要刷新动态目录时，Host 必须建立新的组合，而不是在活动 Agent 中改变路由。

## 放弃的方案

- 在 Agent loop 中按来源分支：会把 Host 组合和外部协议泄漏进核心状态机。
- 让后注册工具覆盖同名工具：模型目录和执行目标会依赖隐式顺序。
- 引入全局工具 registry 或动态插件系统：当前没有热更新需求，也会隐藏依赖和生命周期。
