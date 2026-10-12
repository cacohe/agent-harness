# @agent-harness/skill-tool

## 职责

`createSkillLoaderTool` 将 `SkillCatalog` 转换为按 ID 读取正文的 `load_skill` 函数工具。

## 使用

调用方传入目录、结果大小限制和取消信号治理，再与其他工具组合。

## 不负责

不发现 Skill，也不决定模型是否应当调用该工具。
