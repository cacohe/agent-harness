# ADR 0010：单进程 JSON 配置 CLI Host

状态：已接受

## 背景

真实模型 adapter 和持久会话已有独立实现，但还缺少一个展示应用组合、配置入口和进程取消的最小 Host。把环境变量读取或文件路径放入 core 会让部署细节反向渗透 capability。

## 决策

新增 `hosts/cli`，接受 `run` 与 `resume` 子命令、绝对配置路径、会话 ID 和消息。JSON 配置严格限定 session 根路径、运行限制和模型连接字段；API key 仅通过 `apiKeyEnv` 指定的环境变量读取，配置文件没有 API key 或 headers 字段。Host 组合 JSONL、OpenAI-compatible、空工具表和 Runtime。stdout 只写 JSONL stream/result/error，stderr 只写 usage 或不含敏感信息的诊断。SIGINT/SIGTERM 取消 controller，并在 finally 关闭资源。

## 后果

核心保持不知道 argv、文件和环境变量，Host 可以由其他 HTTP 或 SDK Host 替换。首个 CLI 没有工具注册、重试或并发会话策略；这些需要以后由明确配置和独立组件加入。

## 放弃的方案

- 在 Runtime 中读取环境变量会隐藏密钥来源。
- 允许配置文件直接保存 API key 会增加泄露风险。
- 让 stdout 同时写人类日志会破坏 JSONL 消费者。
