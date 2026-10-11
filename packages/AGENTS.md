# Package 规则

每个 package 只承担一个主要职责，并只发布消费者需要的最小接口。

## 依赖方向

允许的依赖方向如下：

```text
hosts -> runtime -> core -> kernel
  |          |        |
  +----------+--------+-> capability implementations / adapters -> kernel
```

`kernel` 没有 workspace 依赖，并集中定义 Agent 循环使用的协议无关概念与接口。单一 `core` package 只包含 Agent 核心循环并且只依赖 `kernel`。会话、工具等能力实现位于各自能力域；它们与 adapter 的生产依赖都只能指向 `kernel`。Runtime 与 host 负责组合实现；测试可以通过 devDependency 使用需要的实现。

增加或修改 workspace 依赖后运行 `pnpm run gate:architecture`。该 gate 是机械检查规则的权威实现。

## 公共 API

- package 根部的 `src/index.ts` 只定义稳定公共导出；可执行 Host 允许保留最小启动代码。实现放入按职责命名的模块，内部目录不得为缩短路径堆叠 barrel。
- 从每个 package 入口审慎导出领域词汇和 capability 接口。
- 实现辅助函数保持私有，除非已经存在真实外部消费者。
- 封闭状态与事件集合使用可辨识联合类型和穷尽 switch。
- Session、message、turn、tool call 和 attempt 标识符使用品牌字符串。
- 每个可能阻塞的异步操作接受或拥有 `AbortSignal`。

## 测试

- 测试可观察行为和失败结算，不测试私有方法结构。
- 使用确定性模型与工具 fake；单元测试不得调用真实模型 API。
- 对事件驱动行为断言已提交的事件顺序和派生的模型请求。
- 覆盖本次变更新增的 await 边界处的取消行为。
