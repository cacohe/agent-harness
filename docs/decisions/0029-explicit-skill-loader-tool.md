# ADR 0029：通过显式工具按需加载 Skill 正文

状态：已接受

## 背景

文件系统 Skill catalog 已能列出摘要和读取正文，但 CLI 只把摘要加入 prompt，没有模型可调用的正文读取入口。自动注入所有正文会浪费上下文预算，并把未使用 Skill 的指令加入每次模型请求。

## 决策

新增 `skills/skill-tool` adapter，将组合方提供的 `SkillCatalog` 映射为内置 function tool `load_skill`。工具输入只接受摘要中展示的 Skill `id`，执行时传递当前调用的取消信号，并将 `{ id, content }` 作为普通工具结果返回。adapter 对 ID 与正文设置 UTF-8 字节上限；具体 catalog 仍负责启用范围、授权和存储读取。

`EnabledSkillsContext` 在名称和描述之外显示稳定 ID。CLI 创建文件系统 catalog 后，同时组合摘要贡献器与 `load_skill` 工具；正文只在模型明确调用工具后进入持久化工具结果和下一步模型请求。

## 后果

模型能够按任务需要加载已启用 Skill，调用、失败和取消沿用现有工具循环与会话事件语义。Skill 正文一旦成功加载，会作为工具结果成为模型可见且可恢复的会话事实；未加载正文仍不会进入 prompt 或日志。

## 放弃的方案

- 自动注入全部正文：会扩大 token 消耗和提示注入面。
- 在 Agent loop 中增加 Skill 专用分支：会重复工具调用、结算和恢复语义。
- 让文件系统 adapter 直接实现工具：会把存储方式与模型调用接口耦合。
