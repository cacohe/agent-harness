# @agent-harness/cli

## 职责

提供 `agent-harness` 可执行入口，处理 argv、JSON 配置、进程信号、终端输入输出，并组合本地 Runtime。

## 命令边界

`run` 与 `resume` 执行单轮并向 stdout 写 JSONL；`chat` 在 stderr 呈现交互对话。`import`、`document-status` 和 `document-delete` 是独立文档操作，不创建 Agent 会话。

## 安全与限制

配置必须指定绝对 `sessionRoot` 与 API key 环境变量名，不能包含密钥或 headers。`run_shell` 默认关闭，只有 `shell.enabled` 明确开启时才注册。相同 `sessionRoot` 仅支持单个 Host 进程使用。
