# @agent-harness/sandbox-docker

## 职责

`DockerSandboxDispatcher` 将 sandbox 任务派发给实现 worker JSON 协议的 Docker OCI 容器。

## 使用

Host 配置镜像和资源限制，再把 dispatcher 提供给 `SandboxToolRegistry` 或其他调用方。

## 不负责

不注册函数工具，也不挂载宿主工作区、Docker socket 或密钥。
