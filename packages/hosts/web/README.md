# @agent-harness/web

## 职责

提供 `agent-harness-web` 可执行入口、仅绑定 loopback 的 HTTP/SSE server 与静态浏览器聊天界面。

## 使用

传入绝对 `--config` 路径启动；Host 从配置指定的环境变量读取 API key，浏览器不会接触密钥。协议提供工作目录选择、会话恢复、消息提交、取消、会话关闭与 SSE 事件订阅。开始对话前必须通过本机系统文件夹对话框选择工作目录；之后 Agent 只能在该目录内列目录和读写文件。会话与规范工作目录的绑定由 Host 持久保存，刷新页面会按上次会话 ID 从 JSONL 恢复对话记录。

## 限制

首版组合 JSONL、OpenAI-compatible 模型和受限工作目录文件工具；不提供 shell，也不支持远程监听、认证、MCP、Skills 或 Platform Memory。Host 校验 loopback authority 与浏览器 Origin，但它仍不是可暴露到网络的多用户服务。
