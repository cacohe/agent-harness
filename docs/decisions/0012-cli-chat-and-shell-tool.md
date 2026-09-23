# ADR 0012：CLI 多轮交互与 Host 侧 shell 工具

状态：已接受

## 背景

现有 CLI 只有单次 `run` / `resume`，每次进程退出；继续对话依赖外部重复调用。首个 Host 也未注册任何工具，无法验证 Agent 的 tool-call 循环。需要最小可本地演示的多轮入口和一种真实副作用工具，同时不把进程与 shell 细节渗入 `core`。

## 决策

在 `hosts/cli` 增加 `chat` 子命令：`--config` 与 `--session` 必填，`--message` 可选作为首轮输入。同一进程内保持 Runtime handle 打开，从可注入的行输入源循环读取用户消息并调用 `agent.run`；输入 `/exit`、`/quit` 或 EOF 正常结束。空行跳过。会话不存在时 `create`，已存在时 `resume`。SIGINT/SIGTERM：若有进行中的 turn 则取消该 turn；空闲等待输入时结束交互循环。`chat` 不向 stdout 刷 stream/result JSONL，仅在 stderr 展示用户输入与最终助手文本；`run` / `resume` 仍保持 JSONL 协议。

在 CLI Host 组合点注册 `run_shell` 工具（`ToolDefinition`），实现留在 Host 包内，不新增 tools adapter package。工具输入为 `{ command: string }`；在配置的绝对 `cwd` 下通过平台 shell 执行（Windows：`ComSpec /d /s /c`；Unix：`/bin/sh -c`）。响应取消信号时终止子进程。输出截断到配置的字节上限，返回 JSON：`exitCode`、`stdout`、`stderr`、`truncated`、`timedOut`。可选配置块 `shell`：`enabled`（默认 true）、`cwd`（绝对路径，默认进程 cwd）、`timeoutMs`、`maxOutputBytes`。`enabled: false` 时不注册该工具。

## 后果

多轮与 shell 副作用成为 Host 职责，Agent 与 Runtime 接口不变。Shell 以当前用户权限在本机执行，无沙箱；适用于本地实验 Host，不作为多租户或远程 Agent 的默认安全模型。后续若出现第二种进程工具实现，再抽 capability 包。

## 放弃的方案

- 在 `core/tools` 内实现 shell：会把进程与文件系统依赖引入 capability 包。
- 新增独立 `tools/shell` package：当前只有一个 Host 消费者，过早拆包。
- 用超时 lockfile 或交互式确认包装每次命令：超出最小演示范围。
