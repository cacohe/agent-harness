# @agent-harness/web

## 职责

提供 `agent-harness-web` 可执行入口、仅绑定 loopback 的 HTTP/SSE server 与静态浏览器聊天界面。

## 使用

传入绝对 `--config` 路径启动；Host 从配置指定的环境变量读取 API key，浏览器不会接触密钥。协议提供消息提交、取消、会话关闭与 SSE 事件订阅。

## 限制

首版只组合 JSONL、OpenAI-compatible 模型和空工具表；不支持远程监听、认证、shell、MCP、Skills、文件访问或 Platform Memory。
