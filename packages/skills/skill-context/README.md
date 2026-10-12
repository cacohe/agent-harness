# @agent-harness/skill-context

## 职责

`EnabledSkillsContext` 仅将已启用 Skill 的 ID、名称和描述写入系统上下文。

## 使用

把 Host 提供的 `SkillCatalog` 注入该 contributor，再组合进 prompt assembler。

## 不负责

不扫描目录，也不读取 Skill 正文。
