# 安全政策

## 支持范围

安全修复只面向 `main` 分支的当前代码。项目尚未发布稳定版本，也不提供托管服务或多租户部署支持。

## 报告漏洞

请不要在公开 Issue 中披露尚未修复的漏洞、访问令牌、会话数据或可复现攻击的敏感细节。请通过 GitHub Security Advisory 的私密报告入口提交：<https://github.com/cacohe/agent-harness/security/advisories/new>。

报告请包含受影响的提交或路径、复现步骤、影响范围和已知缓解措施。维护者会确认收到报告、评估影响，并在修复可用后公开说明。

## 安全边界

- JSONL 会话存储仅支持同一 `sessionRoot` 的单 writer，不能作为多进程或多实例共享存储。
- Web Host 仅设计为绑定 loopback 的单用户本地界面，不能暴露到局域网或互联网。
- `run_shell` 没有沙箱，显式启用后以 Host 进程权限执行，仅适用于受信任的本地实验环境。
- MCP、模型服务和 Platform adapter 是外部信任边界；配置只引用环境变量名，禁止提交实际凭据。
- filesystem Skills 的路径安全校验依赖 Linux；请在 Linux Host 或 WSL 中启用此能力。
