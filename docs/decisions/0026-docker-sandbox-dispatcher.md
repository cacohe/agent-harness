# ADR 0026：Docker Sandbox dispatcher

状态：已接受

## 背景

Sandbox capability 已定义，但没有可运行的隔离执行 adapter。单实例阶段需要可验证的隔离边界，不能把 Host 子进程或 `run_shell` 宣称为 Sandbox。

## 决策

新增 `tools/sandbox-docker`。它以 Docker CLI 启动一次性 OCI 容器，并通过 stdin/stdout JSON worker 协议提交 `SandboxTask` 和接收一个 JSON 结果。默认禁网、只读根文件系统、tmpfs、非 root、移除 capabilities、禁止提权，并限制 PID、CPU、内存、输出与期限。

## 后果

Docker daemon、镜像供应链和 worker 镜像属于 Host 运维边界。该 adapter 不挂载宿主工作区、不继承密钥、不把 Docker 引入 core。未来 Platform 可用同一 SandboxDispatcher capability 替换为远程服务或 microVM。

## 放弃的方案

- 使用 run_shell：没有容器隔离。
- 默认开放网络或挂载 Docker socket：会破坏 Sandbox 边界。
- 在 Agent 中直接启动容器：会污染核心状态机。
