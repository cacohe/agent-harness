# ADR 0042：本地 Web Host 与 SSE 对话界面

状态：已接受

## 背景

CLI 可以运行和恢复 Agent，但用户需要 clone 仓库后在本机浏览器中持续查看流式回复、发送后续输入和取消当前执行。把浏览器协议、静态资源或 HTTP server 放进 Core 会破坏协议无关的 Agent 循环；将 API key 下发给浏览器也会扩大泄露边界。

## 决策

新增 `hosts/web`。它只监听 `127.0.0.1`，接受绝对 `--config` 路径和可选端口，运行纯本地的聊天 UI。Host 严格校验 OpenAI-compatible 模型配置，从环境变量读取密钥；静态页面不接收配置或密钥。

Web UI 为每个浏览器生成 session ID。Host 为每个 session 保留一个独占 Runtime handle，并通过 `POST /sessions/:id/messages` 接纳消息、`POST /sessions/:id/cancel` 取消当前 turn、`POST /sessions/:id/close` 释放会话。`GET /sessions/:id/events` 以 SSE 广播模型流、持久会话事件和 terminal 结果。浏览器在新建会话或离开页面时尽力关闭旧会话；若它异常退出，最后一个 SSE 订阅断开后 Host 会在可配置的空闲超时后回收 Runtime、writer 和 event stream。关闭中的会话拒绝新的 SSE 订阅，避免 EventSource 自动重连重新保留 stream。输入排队语义仍由 Core 的 FIFO inbox 拥有。

首版只组合 JSONL、OpenAI-compatible provider 与空工具表。它不提供远程监听、认证、shell、MCP、Skills、文件访问或 Platform Memory；这些涉及额外权限模型或 UI 协议，必须在有明确产品需求时单独决定。

## 后果

用户无需自行构建前端即可从源码启动本地浏览器交互，且密钥和会话 writer 仍仅在 Node.js Host 进程内。空闲回收避免刷新浏览器或意外断连无限累积本地资源。服务不能安全地暴露到局域网或互联网，也不能替代多租户服务。关闭 Host 会有序停止 session、刷新 JSONL 并结束 SSE 连接。

## 放弃的方案

- 将 HTTP/SSE 逻辑放进 Runtime 或 Core：会让循环依赖 Web 协议和 Node.js 网络实现。
- 将模型 API key 写入浏览器设置：会让本地扩展、网页脚本和浏览器存储成为密钥边界。
- 首版同时暴露 shell 与工作目录：尚无文件浏览、权限确认或工作区选择 UI，直接暴露会使本地副作用缺少用户可见边界。
