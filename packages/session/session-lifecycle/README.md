# @agent-harness/session-lifecycle

## 职责

`analyzeSessionLifecycle` 验证持久历史的 turn、step、assistant settlement 与工具结果关系，并生成必要的恢复修复。

## 使用

Runtime 在暴露恢复的 Agent 前调用它，并将修复作为原子事件批次追加。

## 不负责

不读取文件、不追加事件，也不拥有 writer 生命周期。
