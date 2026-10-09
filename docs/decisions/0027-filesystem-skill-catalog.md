# ADR 0027：文件系统 Skill catalog

状态：已接受

## 背景

Agent 已定义 SkillCatalog 和摘要上下文，但没有可运行的 Skill 来源或 Host 组合点。

## 决策

新增 `skills/skill-filesystem` adapter。Host 只加载配置中明确启用的 Skill ID，通过已打开文件描述符校验每个 `SKILL.md` 的真实路径，拒绝符号链接逃逸和非规范 frontmatter。创建 catalog 时只在固定上限内读取元数据；正文仅在 `read` 时读取，并在读取时拒绝无效 UTF-8 和超限文件。

CLI 通过可选 `skills` 配置创建 catalog，并将 `EnabledSkillsContext` 注入默认 prompt assembler。模型只看到名称和描述，正文不自动进入 prompt 或会话日志。

## 后果

单实例 CLI 可以安全启用本地 Skills。文件变化会在按需读取时重新校验，但已注入摘要固定为本次 CLI 生命周期开始时的快照。已打开文件的真实目标通过 Linux `/proc/self/fd` 校验，因此当前 adapter 的安全边界要求 Linux Host。

## 放弃的方案

- 扫描并默认启用根目录全部 Skill：会扩大未授权能力集合。
- 自动注入正文：会浪费上下文预算并扩大提示注入面。
- 在 core 中读取文件：会破坏 capability 与 adapter 边界。
