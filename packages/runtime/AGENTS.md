# Runtime Package 规则

- Runtime 只负责显式组合和资源所有权，不实现模型、工具、存储或 host 协议。
- 生产源码只能依赖 capability 所属 package，不得导入具体 adapter、测试支持或全局服务上下文。
- `resume` 必须在返回 handle 前完成历史校验和原子修复；任何建立失败都必须关闭已取得的 writer。
- Handle 先停止 Agent、等待 idle，再刷新并关闭 writer。调用方取消只能停止等待，不能停止后台资源释放。
- Handle 只有清理成功后才释放 Runtime 所有权；后台失败必须保留给 Runtime 聚合。
- Runtime 必须把恢复得到的历史 ID 快照传给 Agent；实时 reservation 由 Agent 单点负责，不能在组合层复制。
- 每个 run 结算和每条生命周期清理链分别创建新的总 deadline；不得跨操作复用已经消耗或取消的信号。
- Runtime 新增 await 边界时，测试其失败、取消、重复关闭和错误聚合行为。
