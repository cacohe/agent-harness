# @agent-harness/local

## 职责

提供 Host 可复用的本地 Shell 与工作目录工具：`createShellTool`、`createWorkspaceTools`，以及工作目录路径校验。

## 使用

Host 注入工作目录或 shell 选项后，把返回的 `ToolDefinition` 交给 `ToolRegistry`。Web Host 只组合工作目录内的列目录与文件读写；CLI 可额外启用 `run_shell`。

## 不负责

不实现通用工具运行时，也不提供进程隔离或沙箱边界。
