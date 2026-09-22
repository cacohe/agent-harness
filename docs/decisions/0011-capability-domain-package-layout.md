# ADR 0011：按能力域分组 package 目录

状态：已接受

## 背景

package 数量增加后，扁平的 `packages/<name>` 难以一眼看出能力归属。DeepSeek Harness 使用 `packages/<group>/<pkg>` 按能力域分组。本仓库仍坚持显式组合与 capability 所有权，不引入 Cordis 插件树，但可以采用类似的目录分组，降低浏览与演进成本。

## 决策

workspace 目录改为按能力域分组，npm 包名 `@agent-harness/<leaf>` 保持不变：

```text
packages/domain/                 领域词汇
packages/core/agent|tools/       Agent 循环与工具
packages/llm/model|openai-compatible/  模型接口与协议 adapter
packages/session/session|session-jsonl/  会话接口与 JSONL adapter
packages/runtime/                显式组合根
packages/hosts/cli/              进程入口
packages/test-support/           测试基础设施
```

依赖方向与组合规则不变：core capability 包不依赖 adapter/host；adapter 只依赖其 capability 所属包与 domain；runtime 与 host 仍是仅有的组合根。架构 gate 以 package 相对路径（含分组前缀）校验。

## 后果

目录与能力域对齐，便于对照 DSH 式浏览；包名与 import 路径不变，消费者无感。新增模型或会话实现优先落在 `llm/`、`session/` 下。不因此引入插件注册表或动态装载。

## 放弃的方案

- 继续完全扁平目录会在包增多后加剧定位成本。
- 照搬 Cordis「Everything is a Plugin」会与 ADR 0001 冲突。
- 改名为 `@agent-harness/core-agent` 等会无谓破坏既有包名。
