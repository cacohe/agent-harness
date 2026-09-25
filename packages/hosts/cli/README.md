# CLI Host

`agent-harness run|resume --config /绝对/config.json --session 会话 --message 内容` 执行单轮（stdout 为 JSONL）；`chat` 进入多轮交互，stderr 只显示用户输入与最终助手回复。

配置使用绝对 `sessionRoot`，并在 `model.apiKeyEnv` 指定 API key 的环境变量名称。`shell.enabled` 默认 `false`；仅在显式开启时注册本机 `run_shell` 工具。配置文件不接受 API key 或 headers 字段。stdout 输出 JSONL 的 stream、result 或 error 记录，stderr 输出提示、usage 和不含密钥的诊断。

当前 Host 仅支持单实例运行；不得让多个进程或服务实例共享同一个 `sessionRoot`。
