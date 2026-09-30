# ADR 0019：以 Skill 摘要提供默认上下文

## 背景

已启用 Skills 需要让模型知道其名称和用途，但完整正文可能很长、包含操作细节，且不应成为每个请求的隐式 prompt 或会话历史。Host 和 Platform 还需要能在显式动作中读取 Skill 正文。

## 决策

`core/agent` 定义 `SkillCatalog`：同步列出已启用的 `SkillDescriptor`，并通过带取消信号的 `read` 按 ID 读取正文。`EnabledSkillsContext` 只使用 `listEnabled`，把经严格校验的名称和描述转换为一条 system 消息；不调用 `read`，不把正文或元数据写入会话事件。

## 后果

Host、Platform 或未来的 Skill adapter 可以拥有文件、数据库与授权细节，并在组合点提供 catalog。默认请求获得稳定、有限的能力摘要，正文读取需要由后续显式工具或策略决定。Skill 摘要与其他 ContextContributor 一样受总输入字节预算约束。

## 放弃的方案

不把完整 Skill 正文直接拼入 system prompt，因为它会放大上下文成本并让配置更新隐式改变每个请求。也不将 Skills 视为直接可执行的工具；真正执行仍需经过工具定义、策略和权限边界。
