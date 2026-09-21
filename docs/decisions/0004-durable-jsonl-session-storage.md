# ADR 0004：单进程 writer 的持久 JSONL 会话存储

状态：已接受

## 背景

内存会话无法在进程重启后恢复 Agent，也不能验证磁盘损坏、写入中断与所有权冲突。会话 capability 需要支持只读恢复和单 writer 追加，同时保持 Agent 对文件布局无感知。Node.js 24 没有内置、可移植的 kernel file lock；带超时的 lockfile 可能在进程暂停时错误抢占仍然活跃的 writer。

## 决策

`session` package 拥有 `SessionReader`、`SessionLog`、`SessionRepository` 和 `SessionWriteLeaseProvider` 接口；独立的 `session-jsonl` adapter 实现文件存储。根目录必须由组合方提供绝对路径。Session ID 使用 UTF-8 的 base64url 无碰撞编码形成单个目录段，物理文件为 `<root>/<encoded-id>/session.v1.jsonl`。

文件首行是带格式版本和 Session ID 的 header。后续每个原子 append batch 独占一行，包含 `batchId`、追加前的 `expectedSequence` 和完整事件信封数组。每条完整记录严格校验字段集合、事件联合类型、JSON 值、Session ID、sequence 与 batch 连续性。工具输入和成功输出限定为递归 JSON 值。

创建先写入并同步临时 header，再通过原子 rename 发布，并同步会话目录。Append 在序列化和校验完整 batch 后记录旧文件长度，完整写入一行并执行 `fdatasync` 后才返回。写入或同步失败时截断至旧长度并再次同步；回滚也失败时抛出 `SessionUncertainCommitError`，同时保留写入错误和回滚错误。

只读打开只解析最后一个完整换行之前的 committed prefix。写打开先取得 writer lease，再截断并同步 torn tail，之后才能追加。完整换行但 JSON 或结构无效的记录一律报告损坏，不作为 torn tail 修复。

默认 lease provider 在同一 Node.js 进程内按规范文件路径互斥，并覆盖不同 repository 实例。关闭 writer 释放 lease，创建和打开失败也必须释放。本阶段明确不保证跨进程 writer 安全；后续可以替换 lease provider 实现 kernel lock，而不改变 Agent 或存储格式。

## 后果

Agent 可以通过稳定的 `session` capability 使用内存或 JSONL 存储。一个物理 batch 对应一次原子语义追加，能够检查并发 sequence 冲突、重放顺序与重复 batch。真实磁盘故障仍可能产生不确定提交，调用方必须把对应错误视为不可安全自动重试。每次 append 的 durability barrier 优先保证教学实现的语义清晰，会牺牲吞吐量。

当前单进程 lease 不能阻止另一个进程同时打开同一文件。需要多进程部署前必须新增跨进程 lease adapter 和对应故障测试，不能复用当前保证作为多进程安全依据。

## 放弃的方案

- 让 Agent 直接打开 JSONL 文件会把文件布局、损坏处理和同步策略泄漏到核心状态机。
- 每个事件单独占一行无法保留 terminal settlement 等批次的全有或全无语义。
- 把没有换行的末尾残片视为损坏会让可恢复的进程崩溃变成永久故障。
- 使用带租期或超时的 lockfile 会在暂停、时钟跳变或长时间 I/O 时错误抢占活跃 writer。
- 依赖 DSH 的 native lock 实现会使学习仓库反向耦合参考项目。
