# CLI Host 规则

- CLI 只负责 argv、JSON 配置、进程信号与 stdout/stderr，并在此处显式组合 runtime、JSONL、模型 adapter 和工具表。
- 配置、argv、环境变量名和文件内容都是不可信输入，必须在使用前校验；API key 只能按配置的环境变量名读取，绝不写入 stdout、stderr 或错误对象。
- stdout 只能写 JSONL 事件；usage 和诊断只能写 stderr。
- 收到 SIGINT 或 SIGTERM 后取消当前操作，并始终关闭 Runtime。
