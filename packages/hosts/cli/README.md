# CLI Host

`agent-harness run|resume --config /绝对/config.json --session 会话 --message 内容` 执行单轮（stdout 为 JSONL）；`chat` 进入多轮交互，stderr 只显示用户输入与最终助手回复。`import --config /绝对/config.json --file /绝对/文件 --media-type MIME` 使用 `memory` 配置导入文件；`document-status --config /绝对/config.json --document ID` 查询文档的权威索引状态。两个文档命令都不创建 Agent 会话。

配置使用绝对 `sessionRoot`，并在 `model.apiKeyEnv` 指定 API key 的环境变量名称。`shell.enabled` 默认 `false`；仅在显式开启时注册本机 `run_shell` 工具。配置文件不接受 API key 或 headers 字段。stdout 输出 JSONL 的 stream、result、document.imported、document.status 或 error 记录，stderr 输出提示、usage 和不含密钥的诊断。

当前 Host 仅支持单实例运行；不得让多个进程或服务实例共享同一个 `sessionRoot`。
