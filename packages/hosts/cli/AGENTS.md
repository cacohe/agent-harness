# CLI Host 规则

- CLI 只负责 argv、JSON 配置、进程信号、行输入与 stdout/stderr，并在此处显式组合 runtime、JSONL、模型 adapter 和工具表。
- 配置、argv、环境变量名和文件内容都是不可信输入，必须在使用前校验；API key 只能按配置的环境变量名读取，绝不写入 stdout、stderr 或错误对象。
- stdout：`run` / `resume` 只写 JSONL 事件；`chat` 正常路径不写 stdout，只在 stderr 展示「你 / 助手」对话。
- 提示、usage 和诊断写 stderr。
- 收到 SIGINT 或 SIGTERM 后：`chat` 优先取消当前 turn，空闲时退出循环；单轮命令取消当前操作。始终关闭 Runtime。
- `run_shell` 等可复用副作用工具定义在 `tools/`；Host 只按配置组合，不保留工具实现。
