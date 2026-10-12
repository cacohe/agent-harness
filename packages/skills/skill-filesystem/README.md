# @agent-harness/skill-filesystem

## 职责

`FilesystemSkillCatalog` 在 Host 指定根目录内解析启用的 Skill，并校验真实路径与 frontmatter。

## 使用

构造时传入受信根目录和启用列表；初始化暴露摘要，正文仅通过显式按 ID 读取。

## 不负责

不选择启用项、不注入 prompt，也不将正文变成模型上下文。
