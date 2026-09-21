# ADR 0005：JSONL 创建发布与不确定提交隔离

状态：已接受

补充：ADR 0004

## 背景

ADR 0004 确立了单进程 writer、原子 batch、durability barrier 和 torn-tail 修复，但没有完整定义 create 的发布点、路径别名、排队取消以及回滚失败后的句柄状态。若取消在文件操作已经启动后立即触发回滚，回滚可能与尚未完成的写入竞争。若 create 在文件已经可见后按普通取消返回失败，调用方也无法判断 Session ID 是否已经占用。

## 决策

所有可取消 I/O 使用惰性 operation factory：先检查 signal，再启动并等待本次 I/O 完成，最后检查 signal。回滚只能在相关 write 或 sync 已经结算后开始。排队的 append 在轮到执行前再次检查 signal；read 与 flush 等待队列时也能及时取消。Close 一旦开始就在后台等待队列、关闭文件并释放 lease，调用方的 signal 只取消本次等待。

Repository 在创建和打开前确保根目录存在并解析 `realpath`。最终布局与 writer lease key 都以该规范根目录为准。Session ID 按每个 UTF-16 code unit 的固定宽度十六进制序列编码，保证包括 lone surrogate 在内的所有 JavaScript 字符串不会发生路径碰撞。

Create 在规范根目录下使用随机 sibling staging 目录。它依次写入完整 header、同步文件、同步 staging 目录，再原子 rename 整个目录为最终目录，并同步规范根目录。Rename 是发布点。发布前失败只清理本次 staging；崩溃遗留的随机 staging 不占用最终 Session ID，也不阻止重试。实现不自动扫描或删除其他 staging。发布后的 signal 取消不再作为普通 create 失败返回；发布后根目录同步失败抛出 `SessionCreateUncertainError`，其 `published` 固定为 `true`。

Append 写入前调用与 reader 相同的严格 `SessionEvent` 校验。完整记录使用 fatal UTF-8 解码。若 write 或 sync 失败且截断回滚成功，writer 保持可用；若截断或回滚 sync 也失败，首次调用抛出 `SessionUncertainCommitError`，writer 随即永久 poisoned。Poisoned writer 的 append、read 和 flush 抛出 `SessionPoisonedError`，close 仍负责关闭文件并释放 lease。

## 后果

取消不会使 rollback 与仍在运行的 write 交错，排队取消也不会在队列恢复后偷偷写入。Create 的调用方可以区分未发布失败、成功发布和已发布但 durability 不确定三种结果。符号链接别名不能在同一进程内获得第二个 writer。发生不确定 append 后，调用方不能从内存快照继续运行 Agent，必须关闭句柄并由人工或恢复流程检查文件。

根目录规范化在每次 create/open 时产生额外文件系统调用。Close 的调用等待可取消，但底层资源回收可能在调用返回拒绝后继续。随机 staging 目录在进程崩溃后可能残留；因为它不占用 Session ID，本阶段不增加自动清扫策略。

## 放弃的方案

- 在构造函数中只做词法 `resolve` 无法合并 symlink 别名的 lease key。
- 用 UTF-8 replacement 编码路径会让 lone surrogate 与 U+FFFD 碰撞。
- Rename 后继续按普通 signal 报告取消会让调用方误以为 Session ID 没有发布。
- 不确定回滚后继续 read 或 append 会基于无法确认的文件尾部产生错误历史。
- 让 close 随调用方取消一起停止会泄漏文件描述符和 writer lease。
