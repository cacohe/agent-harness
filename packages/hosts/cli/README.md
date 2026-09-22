# CLI Host

`agent-harness run --config /绝对/config.json --session 会话 --message 内容` 创建会话并运行一次；`resume` 使用同一参数恢复已有会话。

配置使用绝对 `sessionRoot`，并在 `model.apiKeyEnv` 指定 API key 的环境变量名称。配置文件不接受 API key 或 headers 字段。stdout 输出 JSONL 的 stream、result 或 error 记录，stderr 输出 usage 和不含密钥的诊断。
