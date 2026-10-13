# ADR 0048：按领域拆分 Kernel 协议

## 背景

`kernel/src/facts.ts` 同时承载标识符、JSON 序列化约束、可持久化错误、模型消息与结算、执行身份以及会话事件。`facts` 只准确描述其中的会话事件，无法让调用方从文件名判断协议的业务归属。

## 决策

移除 `facts.ts`，按变化原因和领域归属安置原有公开契约：

- `identifiers.ts` 定义品牌标识符与构造函数；
- `serialization.ts` 定义 JSON 可持久化值、校验和错误快照；
- `exhaustiveness.ts` 定义封闭联合类型的穷尽分支断言；
- `model.ts` 定义模型可见消息和模型 attempt 结算；
- `agent.ts` 定义执行身份；
- `session/protocol.ts` 定义会话事件、事件信封及会话读写契约。

根入口继续导出相同的公共词汇，不改变 package API。工具协议和通用运行时继续只位于 `tools/`。

## 后果

Kernel 目录结构直接表达协议所属领域，模型、会话和 Agent 各自拥有随其变化的契约。模块间仅以 TypeScript type-only import 组合跨领域事件，因此不会引入运行时循环依赖。

## 放弃的方案

仅将 `facts.ts` 改名为 `protocol.ts`。这会继续把无共同变化原因的协议聚合到一个泛化文件，不能改善可发现性或职责边界。
