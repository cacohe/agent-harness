# ADR 0038：集中 Agent 内核契约并收紧依赖方向

## 背景

Agent 循环使用的概念和接口此前分散在 `domain`、模型、会话、工具与 Agent package 中。`core/agent` 因而需要同时依赖多个实现或 capability package，adapter 也会依赖 core package。目录虽然按能力域分组，但依赖图不能清楚区分稳定契约、核心行为和外部系统实现，新增能力容易形成横向耦合。

项目当前需要一个可以独立理解和编译的协议无关内核，同时保留精简的核心循环与可替换 adapter。该边界由项目所有者确认采用。

## 决策

将原 `domain` 重命名为 `kernel`，包名为 `@agent-harness/kernel`。Kernel 集中定义 Agent 循环使用的协议无关概念、状态、接口、事件和错误，包括模型、会话、工具、上下文、记忆、Skill、观察与 Agent 生命周期契约。Kernel 没有 workspace 依赖，也不接触文件系统、网络、进程或模型 SDK。

`packages/core/*` 只保留核心行为实现，并且生产依赖只能指向 Kernel：

- `core/agent` 实现 Agent 状态机、上下文组装和模型消息投影；
- `core/session` 实现内存会话日志和生命周期分析；
- `core/tools` 实现工具注册、组合、Sandbox 路由和执行策略包装。

外部 adapter 只保留协议转换、边界校验与资源交互实现，其生产依赖只能指向 Kernel。Adapter 专用的配置和传输协作者类型可以留在自身 package；不同 adapter 不通过生产依赖共享这些私有协议。Runtime 组合 Kernel 与 core，Host 组合 Runtime 和 adapter。测试可以使用 devDependency 引用具体实现。

删除独立的模型契约 package，并把会话核心实现移入 `core/session`。架构 gate 按 package 路径白名单检查所有生产 workspace 依赖；新增未分类 package 会直接失败。本决定取代 ADR 0011 中 capability 接口所有权和依赖方向的部分，ADR 0011 的能力域目录分组仍然有效。

## 后果

Agent 循环的完整契约可以从一个 package 查看，Core 和 adapter 的依赖方向一致且可机械验证。具体实现的替换不再要求其他实现 package 参与编译，Runtime 与 Host 成为明确的组合位置。

Kernel 的公共 API 面积增大，因此新增契约必须确实属于 Agent 循环或其稳定端口。纯实现辅助函数、外部协议 DTO 和单个 adapter 的配置不得为了复用方便进入 Kernel。契约变更需要同步检查所有 core、adapter、runtime 和 host 调用方。

## 放弃的方案

保留 `domain` 名称并继续让各 capability package 拥有接口。该方案改动较小，但无法满足 Core 只依赖单一稳定边界，也会继续允许 adapter 依赖 core。

将目录命名为 `contracts`、`api` 或 `spi`。这些名称强调类型集合或扩展接口，却不能表达其中还包含状态、事件、不变量和错误；`kernel` 更准确地表达 Agent 执行语义的最小稳定核心。

把所有实现一并放入 Kernel。该方案会让内核承担状态机、存储和协议行为，失去无 I/O、无外部依赖和可独立替换的边界。
