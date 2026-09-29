# ADR 0015：Sandbox 任务派发 capability

## 背景

工具执行策略已经可以在副作用前执行许可判断，但 Agent 仍只能在 Host 进程内运行工具。代码执行等高风险工作需要能够委派给隔离执行环境，同时保持 Agent 核心不依赖容器、队列或 Platform HTTP 协议。

## 决策

`core/tools` 定义 `SandboxDispatcher` capability 与 `SandboxTask` 请求/结果词汇。Sandbox tool adapter 接收 dispatcher 作为构造参数，将模型已校验的 JSON 输入和当前冻结执行上下文转交给它；缺少执行上下文时拒绝派发。dispatcher 必须响应取消信号；其结果必须是 JSON。

请求中包含稳定任务 ID、工具名称、输入、可选工作目录与资源限制。具体的容器镜像、任务队列、Pi bridge、平台令牌与回调 URL 都属于 adapter 配置，不进入 domain 或 Agent。

## 后果

Agent 将 Sandbox 调用当作普通工具结果：开始的 step 仍会在成功、失败与取消路径上恰好结算一次，结果仍写入 append-only session log。单实例阶段可以组合一个进程内 dispatcher；多实例或远程 Sandbox 以后以 adapter 替换。

## 放弃的方案

- 将容器或平台客户端直接导入 Agent：破坏核心依赖方向且使本地 Host 无法替换。
- 将现有 `run_shell` 标记为 Sandbox：它没有强隔离，安全语义不真实。
- 在工具中自行发起网络请求：会绕过统一的执行上下文、取消与授权策略。
