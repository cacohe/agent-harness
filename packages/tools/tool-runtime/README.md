# @agent-harness/tool-runtime

## 职责

提供本地 `ToolRegistry`、多来源 `CompositeToolCapability`、`PolicyControlledTools` 和 `SandboxToolRegistry`。

## 使用

Host 在启动时组合目录快照；重复工具名会被拒绝，策略包装器在执行前调用授权能力。

## 不负责

不定义外部工具协议、用户审批界面或具体沙箱传输方式。
