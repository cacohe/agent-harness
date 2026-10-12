# @agent-harness/mcp

## 职责

`McpToolAdapter` 将调用方提供的 MCP 客户端转换为 `ToolCapability`，并在启动时取得、校验工具目录。

## 使用

Host 注入客户端，先调用 `start`，再将适配器与其他工具来源组合；关闭时调用 `close` 释放传输资源。

## 不负责

不创建进程、不保存认证信息，也不决定 MCP 传输方式。
