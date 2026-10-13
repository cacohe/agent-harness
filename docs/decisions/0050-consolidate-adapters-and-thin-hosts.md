# ADR 0050：收敛具体适配器并保持 Host 轻量

状态：已接受

## 背景

此前每个 JSONL、模型、MCP、Skills、Memory 或本地工具实现各自是 workspace package。它们多数只包含少量文件、共享相同的 `kernel` 依赖和 Node.js 运行环境；这些边界没有提供独立发布、独立权限或独立构建收益，却让依赖清单、project reference 和 Host 组合代码重复增长。

## 决策

保留 `kernel`、`core`、`runtime`、`adapters`、两个 Host 和 `test-support` 七个 workspace package。所有具体能力实现收敛到 `packages/adapters/<capability>`，通过 `@agent-harness/adapters/<capability>` 子路径导出。架构 gate 保证 adapters 只依赖 kernel。

`adapters/local-runtime` 提供本地参考 Host 共用的 JSONL 与 OpenAI-compatible 默认构造。CLI 与 Web 保留配置解析、凭据取得、工作目录安全边界、MCP/Platform 命令和进程协议；它们不再各自实现相同的本地默认 adapter 选择。

新增 workspace package 默认禁止，除非它必须由构建系统隔离依赖、拥有独立运行环境或第三方依赖、构成稳定可替换的 capability 边界，或具有不同构建、发布、权限或许可证要求。

## 后果

仓库仍以 package 边界保护 kernel/core/runtime 的依赖方向，但不把每个小 adapter 误当成独立产品。Host 保持显式、可读的配置映射，同时共享本地参考运行时的重复装配。

## 放弃的方案

- 保留每个 adapter 的独立 package：不能为这些小实现提供足以抵消维护成本的边界收益。
- 将具体 adapter 直接纳入 kernel 或 core：会破坏协议与外部 I/O 的依赖防火墙。
- 让 CLI/Web 各自维护默认 JSONL 和 OpenAI-compatible 构造：会使默认行为无谓分叉。
