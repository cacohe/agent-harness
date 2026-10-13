# 公开仓库检查清单

本文件记录从私有仓库切换为公开仓库前后需要由仓库所有者在 GitHub 中完成的操作。配置不进入源码，避免将平台状态误认为代码事实。

## 公开前

- 人工检查当前文件与完整 Git 历史，确认没有 API key、认证 header、私有会话、个人路径或不应公开的第三方资料。
- 确认 [LICENSE](../LICENSE)、[NOTICE](../NOTICE)、[SECURITY.md](../SECURITY.md)、[CONTRIBUTING.md](../CONTRIBUTING.md) 与 [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) 的内容及版权归属。
- 确认 README 的运行边界与实际实现一致，尤其是 JSONL 单 writer、loopback Web、无沙箱 shell 和 Linux-only filesystem Skills。
- 在 GitHub 设置仓库描述、主页、topics 与 social preview。

## 公开后可免费启用的 GitHub 设置

- 启用 Dependabot alerts 与 Dependabot security updates；仓库中的 `dependabot.yml` 负责版本更新 PR。
- 启用公开仓库可用的 secret scanning 与 push protection。
- 启用公开仓库可用的 CodeQL code scanning；工作流位于 `.github/workflows/codeql.yml`。
- 启用私密漏洞报告，并确认 [SECURITY.md](../SECURITY.md) 中的链接可用。
- 为 `main` 设置 ruleset：禁止直接推送，要求 Pull Request 的 `Quality gates` 成功；允许满足审查要求的 CI 通过 PR 自动合并。
- 保持 Issues 启用；是否启用 Discussions 由维护者按社区互动量决定。

## 不在本项目范围内的声明

即使所有检查完成，项目仍不是多租户托管平台、分布式会话存储、高可用服务或经认证的安全产品。公开文档不得暗示这些能力已经存在。
