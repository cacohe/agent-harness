import { appendFile, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionRepository } from '@agent-harness/adapters/session-jsonl';
import {
  createJsonlRepositoryForTesting,
  createNodeJsonlIoForTesting,
  encodePathSegment,
  type JsonlFile,
  type JsonlIo,
  wrapJsonlFile,
} from '@agent-harness/adapters/session-jsonl/testing';
import {
  brandId,
  type MessageId,
  SessionAlreadyExistsError,
  SessionAlreadyOwnedError,
  type SessionBatchId,
  SessionClosedError,
  SessionCorruptionError,
  SessionCreateUncertainError,
  type SessionEvent,
  type SessionId,
  SessionPoisonedError,
  SessionSequenceConflictError,
  SessionUncertainCommitError,
  type StepId,
  type ToolCallId,
  type TurnId,
} from '@agent-harness/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const signal = (): AbortSignal => new AbortController().signal;

describe('JsonlSessionRepository', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agent-harness-jsonl-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('拒绝相对根目录配置', () => {
    expect(() => new JsonlSessionRepository({ rootDirectory: 'sessions' })).toThrow(
      'rootDirectory 必须是绝对路径',
    );
  });

  it('修改 testing I/O 副本不影响默认 repository', async () => {
    const testingIo = createNodeJsonlIoForTesting();
    testingIo.mkdir = async () => {
      throw new Error('仅测试副本失败');
    };
    await expect(
      testRepositoryAt(root, testingIo).create(sessionId('isolated-testing-io'), {
        signal: signal(),
      }),
    ).rejects.toThrow('仅测试副本失败');

    const writer = await repositoryAt(root).create(sessionId('default-io-unaffected'), {
      signal: signal(),
    });
    await writer.close({ signal: signal() });
  });

  it('逐层创建 configured root 时同步每层父目录项', async () => {
    const parent = join(root, 'new-parent');
    const configuredRoot = join(parent, 'sessions');
    const syncedDirectories: string[] = [];
    const baseIo = createNodeJsonlIoForTesting();
    const io: JsonlIo = {
      ...baseIo,
      async open(path, flags) {
        const file = await baseIo.open(path, flags);
        if (flags !== 'r') return file;
        return wrapJsonlFile(file, {
          async sync() {
            syncedDirectories.push(path);
            await file.sync();
          },
        });
      },
    };

    const writer = await testRepositoryAt(configuredRoot, io).create(sessionId('durable-root'), {
      signal: signal(),
    });
    await writer.close({ signal: signal() });
    expect(syncedDirectories).toContain(root);
    expect(syncedDirectories).toContain(parent);
    await expect(stat(configuredRoot)).resolves.toMatchObject({
      isDirectory: expect.any(Function),
    });
  });

  it('mkdir 完成后的取消不会跳过父目录同步', async () => {
    const configuredRoot = join(root, 'cancelled-root');
    const controller = new AbortController();
    const syncedDirectories: string[] = [];
    const baseIo = createNodeJsonlIoForTesting();
    const io: JsonlIo = {
      ...baseIo,
      async mkdir(path, options) {
        await baseIo.mkdir(path, options);
        if (path === configuredRoot) {
          controller.abort(new Error('mkdir 后取消'));
        }
      },
      async open(path, flags) {
        const file = await baseIo.open(path, flags);
        if (flags !== 'r') return file;
        return wrapJsonlFile(file, {
          async sync() {
            syncedDirectories.push(path);
            await file.sync();
          },
        });
      },
    };

    await expect(
      testRepositoryAt(configuredRoot, io).create(sessionId('cancelled-root-create'), {
        signal: controller.signal,
      }),
    ).rejects.toThrow('mkdir 后取消');
    expect(syncedDirectories).toContain(root);
    expect(syncedDirectories).toContain(configuredRoot);
  });

  it('创建、原子追加、关闭并重新打开会话', async () => {
    const id = sessionId('round-trip');
    const repository = repositoryAt(root);
    const writer = await repository.create(id, { signal: signal() });
    const events = [turnStarted('turn-1'), userMessage('message-1')] as const;

    const appended = await writer.append(events, {
      signal: signal(),
      expectedSequence: 0,
      batchId: batchId('batch-1'),
    });
    expect(appended.map((event) => event.sequence)).toEqual([1, 2]);
    await writer.close({ signal: signal() });

    const reader = await repository.open(id, { mode: 'read', signal: signal() });
    await expect(reader.read({ signal: signal() })).resolves.toEqual(appended);
    const lines = (await readFile(filePath(root, id), 'utf8')).trimEnd().split('\n');
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({
      type: 'session.batch',
      batchId: 'batch-1',
      expectedSequence: 0,
      envelopes: [{ sequence: 1 }, { sequence: 2 }],
    });
  });

  it('往返保存 unknown 工具结果和 interrupted 生命周期', async () => {
    const id = sessionId('recovery-events');
    const repository = repositoryAt(root);
    const writer = await repository.create(id, { signal: signal() });
    const turnId = brandId<'TurnId'>('recovery-turn') as TurnId;
    const stepId = brandId<'StepId'>('recovery-step') as StepId;
    const callId = brandId<'ToolCallId'>('recovery-call') as ToolCallId;
    const events: readonly SessionEvent[] = [
      {
        type: 'tool.completed',
        turnId,
        stepId,
        result: { status: 'unknown', callId, reason: '副作用状态未知' },
      },
      { type: 'step.ended', turnId, stepId, outcome: 'interrupted' },
      { type: 'turn.ended', turnId, outcome: 'interrupted' },
    ];

    const appended = await writer.append(events, { signal: signal() });
    await writer.close({ signal: signal() });
    const reader = await repository.open(id, { mode: 'read', signal: signal() });

    await expect(reader.read({ signal: signal() })).resolves.toEqual(appended);
    await reader.close({ signal: signal() });
  });

  it('跨 repository 实例阻止第二个 writer，并在关闭后释放', async () => {
    const id = sessionId('owned');
    const first = repositoryAt(root);
    const second = repositoryAt(root);
    const writer = await first.create(id, { signal: signal() });

    await expect(second.open(id, { mode: 'write', signal: signal() })).rejects.toBeInstanceOf(
      SessionAlreadyOwnedError,
    );
    await writer.close({ signal: signal() });

    const reopened = await second.open(id, { mode: 'write', signal: signal() });
    await reopened.close({ signal: signal() });
  });

  it('真实根路径与 symlink 别名共享 writer lease key', async ({ skip }) => {
    if (process.platform === 'win32') {
      skip();
      return;
    }
    const id = sessionId('symlink-owned');
    const alias = join(root, 'root-alias');
    await symlink(root, alias, 'dir');
    const writer = await repositoryAt(root).create(id, { signal: signal() });

    await expect(
      repositoryAt(alias).open(id, { mode: 'write', signal: signal() }),
    ).rejects.toBeInstanceOf(SessionAlreadyOwnedError);
    await writer.close({ signal: signal() });
  });

  it('将路径穿越字符编码为根目录内的单个目录段', async () => {
    const id = sessionId('../../outside/会话');
    const writer = await repositoryAt(root).create(id, { signal: signal() });
    await writer.close({ signal: signal() });

    const path = filePath(root, id);
    expect(path.startsWith(join(root, 's-'))).toBe(true);
    expect(path.includes('..')).toBe(false);
    await expect(stat(path)).resolves.toMatchObject({ isFile: expect.any(Function) });
  });

  it('lone surrogate 与 U+FFFD 使用不同目录且均可恢复', async () => {
    const firstId = sessionId('\uD800');
    const secondId = sessionId('\uFFFD');
    expect(encodePathSegment(firstId)).not.toBe(encodePathSegment(secondId));
    const repository = repositoryAt(root);
    const first = await repository.create(firstId, { signal: signal() });
    await first.close({ signal: signal() });
    const second = await repository.create(secondId, { signal: signal() });
    await second.close({ signal: signal() });

    await expect(
      repository.open(firstId, { mode: 'read', signal: signal() }),
    ).resolves.toBeDefined();
    await expect(
      repository.open(secondId, { mode: 'read', signal: signal() }),
    ).resolves.toBeDefined();
  });

  it('拒绝 expected sequence 冲突与重复 batch ID', async () => {
    const id = sessionId('conflict');
    const writer = await repositoryAt(root).create(id, { signal: signal() });
    const repeated = batchId('same-batch');
    await writer.append([turnStarted('turn-1')], {
      signal: signal(),
      expectedSequence: 0,
      batchId: repeated,
    });

    await expect(
      writer.append([turnStarted('turn-2')], {
        signal: signal(),
        expectedSequence: 0,
        batchId: batchId('other'),
      }),
    ).rejects.toBeInstanceOf(SessionSequenceConflictError);
    await expect(
      writer.append([turnStarted('turn-2')], {
        signal: signal(),
        expectedSequence: 1,
        batchId: repeated,
      }),
    ).rejects.toBeInstanceOf(SessionSequenceConflictError);
    await writer.close({ signal: signal() });
  });

  it('reader 忽略 torn tail，writer 获得所有权后修复并继续追加', async () => {
    const id = sessionId('torn-tail');
    const repository = repositoryAt(root);
    const writer = await repository.create(id, { signal: signal() });
    await writer.append([turnStarted('turn-1')], { signal: signal() });
    await writer.close({ signal: signal() });
    await appendFile(filePath(root, id), '{"type":"session.batch"', 'utf8');

    const reader = await repository.open(id, { mode: 'read', signal: signal() });
    await expect(reader.read({ signal: signal() })).resolves.toHaveLength(1);
    await reader.close({ signal: signal() });

    const repairWriter = await repository.open(id, { mode: 'write', signal: signal() });
    await repairWriter.append([turnStarted('turn-2')], {
      signal: signal(),
      expectedSequence: 1,
    });
    await repairWriter.close({ signal: signal() });
    expect(await readFile(filePath(root, id), 'utf8')).not.toContain(
      '{"type":"session.batch"{"type"',
    );
    const reopened = await repository.open(id, { mode: 'read', signal: signal() });
    await expect(reopened.read({ signal: signal() })).resolves.toHaveLength(2);
  });

  it('拒绝以完整换行结尾的损坏记录', async () => {
    const id = sessionId('corrupt');
    const repository = repositoryAt(root);
    const writer = await repository.create(id, { signal: signal() });
    await writer.close({ signal: signal() });
    await appendFile(filePath(root, id), '{"unknown":true}\n', 'utf8');

    await expect(repository.open(id, { mode: 'read', signal: signal() })).rejects.toBeInstanceOf(
      SessionCorruptionError,
    );
    await expect(repository.open(id, { mode: 'write', signal: signal() })).rejects.toBeInstanceOf(
      SessionCorruptionError,
    );
  });

  it('将完整行中的非法 UTF-8 报告为损坏', async () => {
    const id = sessionId('invalid-utf8');
    const repository = repositoryAt(root);
    const writer = await repository.create(id, { signal: signal() });
    await writer.close({ signal: signal() });
    await appendFile(filePath(root, id), Buffer.from([0xc3, 0x28, 0x0a]));

    await expect(repository.open(id, { mode: 'read', signal: signal() })).rejects.toBeInstanceOf(
      SessionCorruptionError,
    );
  });

  it('写入前使用严格事件校验拒绝多余字段与未知 discriminant', async () => {
    const id = sessionId('strict-write-validation');
    const writer = await repositoryAt(root).create(id, { signal: signal() });
    const invalidEvents = [
      { type: 'turn.started', turnId: 'turn', extra: true },
      { type: 'unknown.event' },
      { type: 'user.message', message: { id: 'message', role: 'user' } },
    ] as unknown as SessionEvent[];

    for (const event of invalidEvents) {
      await expect(writer.append([event], { signal: signal() })).rejects.toBeInstanceOf(
        SessionCorruptionError,
      );
    }
    await expect(writer.read({ signal: signal() })).resolves.toEqual([]);
    await writer.close({ signal: signal() });
    expect((await readFile(filePath(root, id), 'utf8')).split('\n')).toHaveLength(2);
  });

  it('取消的 append 不提交事件', async () => {
    const id = sessionId('cancelled');
    const repository = repositoryAt(root);
    const writer = await repository.create(id, { signal: signal() });
    const controller = new AbortController();
    controller.abort(new Error('停止写入'));

    await expect(
      writer.append([turnStarted('turn-1')], {
        signal: controller.signal,
      }),
    ).rejects.toThrow('停止写入');
    await expect(writer.read({ signal: signal() })).resolves.toEqual([]);
    await writer.close({ signal: signal() });
  });

  it('预先取消时不启动任何根目录 I/O', async () => {
    let mkdirCalls = 0;
    const baseIo = createNodeJsonlIoForTesting();
    const io: JsonlIo = {
      ...baseIo,
      async mkdir(path, options) {
        mkdirCalls += 1;
        await baseIo.mkdir(path, options);
      },
    };
    const repository = testRepositoryAt(root, io);
    const controller = new AbortController();
    controller.abort(new Error('预检取消'));

    await expect(
      repository.create(sessionId('pre-aborted'), {
        signal: controller.signal,
      }),
    ).rejects.toThrow('预检取消');
    expect(mkdirCalls).toBe(0);
  });

  it('partial write 失败后完成回滚，不留下事件', async () => {
    let inject = false;
    let injectedWrites = 0;
    const io = decorateFiles(createNodeJsonlIoForTesting(), (file) =>
      wrapJsonlFile(file, {
        async write(buffer, offset, length, position) {
          if (!inject) return file.write(buffer, offset, length, position);
          injectedWrites += 1;
          if (injectedWrites === 1) {
            const partialLength = Math.max(1, Math.floor(length / 2));
            return file.write(buffer, offset, partialLength, position);
          }
          throw new Error('注入 partial write 后续失败');
        },
      }),
    );
    const repository = testRepositoryAt(root, io);
    const id = sessionId('partial-write');
    const writer = await repository.create(id, { signal: signal() });
    inject = true;

    await expect(writer.append([turnStarted('turn')], { signal: signal() })).rejects.toThrow(
      '注入 partial write 后续失败',
    );
    await expect(writer.read({ signal: signal() })).resolves.toEqual([]);
    await writer.close({ signal: signal() });
    const reader = await repositoryAt(root).open(id, {
      mode: 'read',
      signal: signal(),
    });
    await expect(reader.read({ signal: signal() })).resolves.toEqual([]);
  });

  it('进行中的 write 完成后才响应取消并开始回滚', async () => {
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    let block = false;
    let truncateStarted = false;
    const io = decorateFiles(createNodeJsonlIoForTesting(), (file) =>
      wrapJsonlFile(file, {
        async write(buffer, offset, length, position) {
          if (block) {
            writeStarted.resolve();
            await releaseWrite.promise;
          }
          return file.write(buffer, offset, length, position);
        },
        async truncate(length) {
          truncateStarted = true;
          await file.truncate(length);
        },
      }),
    );
    const repository = testRepositoryAt(root, io);
    const writer = await repository.create(sessionId('write-cancel-order'), {
      signal: signal(),
    });
    block = true;
    const controller = new AbortController();
    const append = writer.append([turnStarted('turn')], {
      signal: controller.signal,
    });
    let appendSettled = false;
    void append
      .finally(() => {
        appendSettled = true;
      })
      .catch(() => undefined);
    await writeStarted.promise;
    controller.abort(new Error('write 期间取消'));

    await Promise.resolve();
    expect(appendSettled).toBe(false);
    expect(truncateStarted).toBe(false);
    releaseWrite.resolve();
    await expect(append).rejects.toThrow('write 期间取消');
    await expect(writer.read({ signal: signal() })).resolves.toEqual([]);
    expect(truncateStarted).toBe(true);
    await writer.close({ signal: signal() });
  });

  it('datasync 失败后截断并同步回滚', async () => {
    let inject = false;
    let failed = false;
    let truncates = 0;
    const io = decorateFiles(createNodeJsonlIoForTesting(), (file) =>
      wrapJsonlFile(file, {
        async datasync() {
          if (inject && !failed) {
            failed = true;
            throw new Error('注入 datasync 失败');
          }
          await file.datasync();
        },
        async truncate(length) {
          truncates += 1;
          await file.truncate(length);
        },
      }),
    );
    const repository = testRepositoryAt(root, io);
    const writer = await repository.create(sessionId('sync-rollback'), {
      signal: signal(),
    });
    inject = true;

    await expect(writer.append([turnStarted('turn')], { signal: signal() })).rejects.toThrow(
      '注入 datasync 失败',
    );
    expect(truncates).toBe(1);
    await expect(writer.read({ signal: signal() })).resolves.toEqual([]);
    await writer.close({ signal: signal() });
  });

  it('回滚失败后永久 poison writer，close 仍释放 lease', async () => {
    let inject = false;
    let injectedWrites = 0;
    const io = decorateFiles(createNodeJsonlIoForTesting(), (file) =>
      wrapJsonlFile(file, {
        async write(buffer, offset, length, position) {
          if (!inject) return file.write(buffer, offset, length, position);
          injectedWrites += 1;
          throw new Error('注入 write 失败');
        },
        async truncate() {
          if (inject) throw new Error('注入 truncate 回滚失败');
          await file.truncate(0);
        },
      }),
    );
    const repository = testRepositoryAt(root, io);
    const id = sessionId('poisoned');
    const writer = await repository.create(id, { signal: signal() });
    inject = true;

    await expect(
      writer.append([turnStarted('first')], { signal: signal() }),
    ).rejects.toBeInstanceOf(SessionUncertainCommitError);
    await expect(
      writer.append([turnStarted('second')], { signal: signal() }),
    ).rejects.toBeInstanceOf(SessionPoisonedError);
    await expect(writer.read({ signal: signal() })).rejects.toBeInstanceOf(SessionPoisonedError);
    await expect(writer.flush({ signal: signal() })).rejects.toBeInstanceOf(SessionPoisonedError);
    expect(injectedWrites).toBe(1);
    await writer.close({ signal: signal() });

    const reopened = await repositoryAt(root).open(id, {
      mode: 'write',
      signal: signal(),
    });
    await reopened.close({ signal: signal() });
  });

  it('排队操作取消时立即拒绝，队列恢复后也不会写入', async () => {
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    let block = false;
    let blockedWrites = 0;
    const io = decorateFiles(createNodeJsonlIoForTesting(), (file) =>
      wrapJsonlFile(file, {
        async write(buffer, offset, length, position) {
          if (block) {
            blockedWrites += 1;
            writeStarted.resolve();
            await releaseWrite.promise;
          }
          return file.write(buffer, offset, length, position);
        },
      }),
    );
    const repository = testRepositoryAt(root, io);
    const id = sessionId('queued-cancel');
    const writer = await repository.create(id, { signal: signal() });
    block = true;
    const first = writer.append([turnStarted('first')], { signal: signal() });
    await writeStarted.promise;

    const appendController = new AbortController();
    const queuedAppend = writer.append([turnStarted('second')], {
      signal: appendController.signal,
    });
    appendController.abort(new Error('取消排队 append'));
    await expect(queuedAppend).rejects.toThrow('取消排队 append');

    const readController = new AbortController();
    const queuedRead = writer.read({ signal: readController.signal });
    readController.abort(new Error('取消排队 read'));
    await expect(queuedRead).rejects.toThrow('取消排队 read');

    const flushController = new AbortController();
    const queuedFlush = writer.flush({ signal: flushController.signal });
    flushController.abort(new Error('取消排队 flush'));
    await expect(queuedFlush).rejects.toThrow('取消排队 flush');

    releaseWrite.resolve();
    await first;
    await writer.close({ signal: signal() });
    expect(blockedWrites).toBe(1);
    const reader = await repositoryAt(root).open(id, {
      mode: 'read',
      signal: signal(),
    });
    await expect(reader.read({ signal: signal() })).resolves.toHaveLength(1);
  });

  it('close 调用取消后在后台完成关闭并释放 lease', async () => {
    const writeStarted = deferred<void>();
    const releaseWrite = deferred<void>();
    let block = false;
    const io = decorateFiles(createNodeJsonlIoForTesting(), (file) =>
      wrapJsonlFile(file, {
        async write(buffer, offset, length, position) {
          if (block) {
            writeStarted.resolve();
            await releaseWrite.promise;
          }
          return file.write(buffer, offset, length, position);
        },
      }),
    );
    const repository = testRepositoryAt(root, io);
    const id = sessionId('close-background');
    const writer = await repository.create(id, { signal: signal() });
    block = true;
    const append = writer.append([turnStarted('turn')], { signal: signal() });
    await writeStarted.promise;
    const controller = new AbortController();
    const closing = writer.close({ signal: controller.signal });
    controller.abort(new Error('停止等待 close'));
    await expect(closing).rejects.toThrow('停止等待 close');

    releaseWrite.resolve();
    await append;
    await writer.close({ signal: signal() });
    const reopened = await repositoryAt(root).open(id, {
      mode: 'write',
      signal: signal(),
    });
    await reopened.close({ signal: signal() });
  });

  it('rename 后取消仍返回已发布 writer', async () => {
    const controller = new AbortController();
    const baseIo = createNodeJsonlIoForTesting();
    const io: JsonlIo = {
      ...baseIo,
      async rename(source, destination) {
        await baseIo.rename(source, destination);
        controller.abort(new Error('rename 后取消'));
      },
    };
    const id = sessionId('published-cancel');
    const writer = await testRepositoryAt(root, io).create(id, {
      signal: controller.signal,
    });
    await writer.close({ signal: signal() });
    await expect(stat(filePath(root, id))).resolves.toBeDefined();
  });

  it('rename 后根目录 sync 失败报告 published uncertain create', async () => {
    let published = false;
    const baseIo = createNodeJsonlIoForTesting();
    const io: JsonlIo = {
      ...baseIo,
      async rename(source, destination) {
        await baseIo.rename(source, destination);
        published = true;
      },
      async open(path, flags) {
        const file = await baseIo.open(path, flags);
        if (published && path === root && flags === 'r') {
          return wrapJsonlFile(file, {
            async sync() {
              throw new Error('注入 root sync 失败');
            },
          });
        }
        return file;
      },
    };
    const id = sessionId('published-uncertain');
    const repository = testRepositoryAt(root, io);

    const failure = await repository
      .create(id, { signal: signal() })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SessionCreateUncertainError);
    expect(failure).toMatchObject({ published: true, sessionId: id });
    await expect(
      repositoryAt(root).open(id, { mode: 'read', signal: signal() }),
    ).resolves.toBeDefined();
    await expect(repository.create(id, { signal: signal() })).rejects.toBeInstanceOf(
      SessionAlreadyExistsError,
    );
  });

  it('拒绝 BigInt、函数和循环引用，不产生部分 batch', async () => {
    const id = sessionId('invalid-json');
    const writer = await repositoryAt(root).create(id, { signal: signal() });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const output of [1n, () => undefined, cyclic]) {
      const invalid = {
        type: 'tool.completed',
        turnId: brandId<'TurnId'>('turn'),
        stepId: brandId<'StepId'>('step'),
        result: {
          status: 'success',
          callId: brandId<'ToolCallId'>('call'),
          output,
        },
      } as unknown as SessionEvent;
      await expect(
        writer.append([turnStarted('before'), invalid], {
          signal: signal(),
        }),
      ).rejects.toThrow();
    }
    await expect(writer.read({ signal: signal() })).resolves.toEqual([]);
    await writer.close({ signal: signal() });
  });

  it('关闭 reader 和 writer 后拒绝操作，重复关闭安全', async () => {
    const id = sessionId('closed');
    const repository = repositoryAt(root);
    const writer = await repository.create(id, { signal: signal() });
    await writer.close({ signal: signal() });
    await expect(writer.close({ signal: signal() })).resolves.toBeUndefined();
    await expect(writer.read({ signal: signal() })).rejects.toBeInstanceOf(SessionClosedError);
    await expect(writer.append([turnStarted('turn')], { signal: signal() })).rejects.toBeInstanceOf(
      SessionClosedError,
    );

    const reader = await repository.open(id, { mode: 'read', signal: signal() });
    await reader.close({ signal: signal() });
    await expect(reader.close({ signal: signal() })).resolves.toBeUndefined();
    await expect(reader.read({ signal: signal() })).rejects.toBeInstanceOf(SessionClosedError);
  });
});

function repositoryAt(rootDirectory: string): JsonlSessionRepository {
  return new JsonlSessionRepository({
    rootDirectory,
    clock: { now: () => '2026-09-20T00:00:00.000Z' },
  });
}

function testRepositoryAt(rootDirectory: string, io: JsonlIo) {
  return createJsonlRepositoryForTesting(
    {
      rootDirectory,
      clock: { now: () => '2026-09-20T00:00:00.000Z' },
    },
    io,
  );
}

function decorateFiles(io: JsonlIo, decorate: (file: JsonlFile) => JsonlFile): JsonlIo {
  return {
    ...io,
    async open(path, flags) {
      return decorate(await io.open(path, flags));
    },
  };
}

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => resolvePromise?.(value),
  };
}

function sessionId(value: string): SessionId {
  return brandId<'SessionId'>(value);
}

function batchId(value: string): SessionBatchId {
  return brandId<'SessionBatchId'>(value);
}

function turnStarted(value: string): SessionEvent {
  return { type: 'turn.started', turnId: brandId<'TurnId'>(value) as TurnId };
}

function userMessage(value: string): SessionEvent {
  return {
    type: 'user.message',
    message: {
      id: brandId<'MessageId'>(value) as MessageId,
      role: 'user',
      content: '你好',
    },
  };
}

function filePath(rootDirectory: string, id: SessionId): string {
  return join(rootDirectory, encodePathSegment(id), 'session.v1.jsonl');
}
