---
name: add-capability
description: 新增或替换 Agent Harness Lab capability 时，同时处理接口、实现、组合、事件影响、测试和架构检查。适用于模型、存储、prompt、工具、生命周期或 host capability；不适用于没有新增 capability 接缝的局部重构。
---

# 新增 capability

编辑前阅读 `AGENTS.md`、`packages/AGENTS.md` 和 `docs/architecture.md`。

明确 capability 的 owner、provider 和 consumer。Agent 循环使用的协议无关概念、状态、接口与错误放入 `packages/kernel`；只有 Agent 核心循环实现放入单一 `packages/core` package；会话、工具和外部系统实现放入对应能力域分组。构造逻辑放入 `packages/runtime` 或相关 host。Core、能力实现与 adapter 的生产依赖都只能指向 `kernel`。在需要按 key 选择实现前，不要增加 registry。

实现前判断 capability 是否改变模型可见输入或持久行为。若会改变，先定义或更新会话事件及其投影。如果变更影响依赖方向、事件兼容性、生命周期所有权或公共 capability 接口，则在 `docs/decisions/` 记录决定。

通过确定性 fake 测试接口，并在外部系统入口测试 adapter。覆盖每个新增 await 边界的失败和取消。先运行聚焦测试，再运行 `pnpm run check`。报告实际运行的命令和尚未解决的外部集成风险。
