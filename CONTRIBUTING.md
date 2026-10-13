# 贡献指南

感谢贡献。Agent Harness Lab 是面向可靠执行语义的参考实现；请优先提交能证明行为、边界或文档改进的聚焦变更。

## 开始前

- 使用 Node.js 24+ 和仓库指定的 pnpm 版本。
- 不提交 `.env`、会话 JSONL、真实 API key、认证 header 或其他敏感数据。
- 修改运行时代码前阅读 [架构说明](docs/architecture.md) 与 [仓库规则](AGENTS.md)。

## 工作流

1. 从最新 `main` 创建独立 feature branch。
2. 变更协议、依赖方向、生命周期、恢复语义或公开 capability 时，在 `docs/decisions/` 新增 ADR。
3. 为可观察行为补充确定性测试；覆盖新增异步边界的失败与取消路径。
4. 提交 Pull Request，不直接向 `main` 提交或推送。
5. 运行 `pnpm run check`。PR 的 CI 通过且满足适用的独立审查要求后可以直接合并。

## 代码与文档约定

- 保持依赖方向：`hosts → runtime → core → kernel`；adapter 只依赖 `kernel`。
- 不为假设需求引入新 package、registry 或全局运行时。
- Markdown、ADR、注释与面向用户的说明使用中文；代码标识符和协议字段保持英文。
- 使用清晰的领域命名，保持改动范围聚焦，并更新受影响的示例与文档。

## 讨论与漏洞

功能建议请使用 Issue；不要在公开 Issue 中报告安全漏洞，详见 [SECURITY.md](SECURITY.md)。
