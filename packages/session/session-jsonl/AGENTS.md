# JSONL Session Adapter 规则

- 持久文件必须先经过严格结构校验，完整换行的无效记录一律报告损坏。
- 每个 batch 使用一条物理记录，并在 durability barrier 完成后才报告成功。
- writer 所有权只保证单进程互斥；不得暗示或模拟跨进程锁。
- 文件路径只能由配置的绝对根目录和无碰撞编码的 Session ID 组成。
- fault injection 仅通过显式 `./testing` 入口提供，普通 package root 不导出测试接缝。
