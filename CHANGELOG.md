# 变更记录

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 的记录方式，并使用语义化版本表达 GitHub Release。

## [Unreleased]

## [0.1.0] - 2026-10-13

### 新增

- append-only 会话事件、生命周期校验和中断恢复修复。
- 单会话 FIFO 调度、取消结算、输入幂等提交与执行观测。
- 模型 attempt、工具调用、工具返回载荷和队列的独立资源边界。
- JSONL、OpenAI-compatible、MCP、Skills、Memory、Platform 与本地工具 adapter。
- CLI 与 loopback Web Host，以及公开仓库协作与安全基线。

### 兼容性说明

- `0.1.0` 是参考实现的预发布版本，不承诺稳定的 npm 包 API、远程服务兼容性或多实例部署支持。
- filesystem Skills 依赖 Linux 安全语义；Windows 请通过 WSL 使用。
