# @agent-harness/platform-http

## 职责

`PlatformHttpClient` 实现 Harness 到 Platform 的 HTTPS 命令客户端，并严格处理 JSON、NDJSON、大小限制与取消。

## 使用

Host 注入端点、认证和请求 ID 生成器，再将同一客户端交给网关、记忆或许可适配器。

## 不负责

不实现 Platform 服务端的认证、授权、计费、审计或可靠 outbox。
