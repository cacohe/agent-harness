# @agent-harness/test-support

## 职责

提供确定性的模型、工具、会话、标识符和结算信号替身，供工作区测试验证可观察行为。

## 使用

测试通过根入口导入 `ScriptedModelProvider`、`ControlledSessionLog`、`fakeTool` 等组件，显式编排脚本与故障。

## 不负责

不作为生产组合依赖，也不连接真实外部服务。
