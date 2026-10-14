import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonlSessionRepository } from '@agent-harness/adapters/session-jsonl';
import { InMemorySessionLog } from '@agent-harness/adapters/session-memory';
import {
  AgentClosedError,
  AgentIdCollisionError,
  type AgentIdGenerator,
  type AttemptId,
  analyzeSessionLifecycle,
  brandId,
  type EventEnvelope,
  type MessageId,
  type SessionAppendOptions,
  type SessionEvent,
  type SessionId,
  type SessionLog,
  type SessionOpenOptions,
  type SessionOperationOptions,
  type SessionReader,
  type SessionRepository,
  type StepId,
  type ToolCallId,
  ToolRegistry,
  type TurnId,
  type UserMessage,
} from '@agent-harness/kernel';
import { AgentRuntime, RuntimeClosedError } from '@agent-harness/runtime';
import { ScriptedModelProvider, SequentialAgentIds } from '@agent-harness/test-support';
import { afterEach, describe, expect, it } from 'vitest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

function id(value: string): SessionId {
  return brandId<'SessionId'>(value) as SessionId;
}

function user(value: string): UserMessage {
  return {
    id: brandId<'MessageId'>(`user-${value}`) as MessageId,
    role: 'user',
    content: value,
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

function runtime(
  sessions: SessionRepository,
  model: ScriptedModelProvider,
  extra: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
): AgentRuntime {
  return new AgentRuntime({
    sessions,
    model,
    tools: new ToolRegistry([]),
    maxSteps: 4,
    settlementTimeoutMs: 1_000,
    ...extra,
  });
}

async function jsonlRepository(): Promise<JsonlSessionRepository> {
  const root = await mkdtemp(join(tmpdir(), 'agent-runtime-'));
  temporaryDirectories.push(root);
  return new JsonlSessionRepository({ rootDirectory: root });
}

describe('AgentRuntime', () => {
  it('冻结并通过默认 prompt 注入版本化 AgentProfile', async () => {
    const profile = { id: 'coding', version: '2026-10', instructions: '先检查再修改。' };
    const model = new ScriptedModelProvider([{ events: [{ type: 'text.delta', text: '完成' }] }]);
    const instance = runtime(repositoryReturning(new InMemorySessionLog(id('profile'))), model, {
      agentProfile: profile,
    });
    profile.instructions = '已被调用方修改';

    const handle = await instance.create(id('profile'), { signal: signal() });
    await handle.agent.run(user('开始'));

    expect(model.requests[0]?.messages).toEqual([
      { role: 'system', content: '先检查再修改。' },
      user('开始'),
    ]);
  });

  it('通过 JSONL 完成 create-run-close-resume-run', async () => {
    const sessions = await jsonlRepository();
    const sessionId = id('jsonl-resume');
    const firstRuntime = runtime(
      sessions,
      new ScriptedModelProvider([{ events: [{ type: 'text.delta', text: '一' }] }]),
      { idGenerators: { create: () => new SequentialAgentIds() } },
    );
    const firstHandle = await firstRuntime.create(sessionId, { signal: signal() });
    await firstHandle.agent.run(user('first'));
    await firstHandle.close();

    const secondModel = new ScriptedModelProvider([
      { events: [{ type: 'text.delta', text: '二' }] },
    ]);
    const secondRuntime = runtime(sessions, secondModel);
    const secondHandle = await secondRuntime.resume(sessionId, { signal: signal() });
    await secondHandle.agent.run(user('second'));
    await secondHandle.close();

    expect(secondModel.requests[0]?.messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
  });

  it('恢复时确定性拒绝 factory 与历史 ID 冲突', async () => {
    const sessions = await jsonlRepository();
    const sessionId = id('history-id-collision');
    const firstRuntime = runtime(
      sessions,
      new ScriptedModelProvider([{ events: [{ type: 'text.delta', text: '完成' }] }]),
      { idGenerators: { create: () => new SequentialAgentIds() } },
    );
    const firstHandle = await firstRuntime.create(sessionId, { signal: signal() });
    await firstHandle.agent.run(user('first'));
    await firstHandle.close();
    const secondModel = new ScriptedModelProvider([
      { events: [{ type: 'text.delta', text: '不应调用' }] },
    ]);
    const secondRuntime = runtime(sessions, secondModel, {
      idGenerators: { create: () => new SequentialAgentIds() },
    });
    const secondHandle = await secondRuntime.resume(sessionId, { signal: signal() });

    await expect(secondHandle.agent.run(user('second'))).rejects.toMatchObject({
      name: 'AgentIdCollisionError',
      kind: 'turn',
      value: 'turn-1',
    });

    await secondHandle.close();
    expect(secondModel.requests).toEqual([]);
    const reader = await sessions.open(sessionId, { mode: 'read', signal: signal() });
    await expect(reader.read({ signal: signal() })).resolves.toHaveLength(6);
    await reader.close({ signal: signal() });
  });

  it('恢复后拒绝历史中已经使用的 user message ID', async () => {
    const sessions = await jsonlRepository();
    const sessionId = id('history-user-id-collision');
    const firstRuntime = runtime(
      sessions,
      new ScriptedModelProvider([{ events: [{ type: 'text.delta', text: 'first' }] }]),
    );
    const firstHandle = await firstRuntime.create(sessionId, { signal: signal() });
    await firstHandle.agent.run(user('shared'));
    await firstHandle.close();
    const secondModel = new ScriptedModelProvider([
      { events: [{ type: 'text.delta', text: '不应调用' }] },
    ]);
    const secondRuntime = runtime(sessions, secondModel);
    const secondHandle = await secondRuntime.resume(sessionId, { signal: signal() });

    await expect(secondHandle.agent.run(user('shared'))).rejects.toMatchObject({
      name: 'AgentIdCollisionError',
      kind: 'message',
      value: 'user-shared',
    });

    await secondHandle.close();
    expect(secondModel.requests).toEqual([]);
    const reader = await sessions.open(sessionId, { mode: 'read', signal: signal() });
    const events = await reader.read({ signal: signal() });
    expect(() => analyzeSessionLifecycle(events)).not.toThrow();
    await reader.close({ signal: signal() });
  });

  it('恢复后拒绝历史中已经使用的模型 tool call ID', async () => {
    const sessions = await jsonlRepository();
    const sessionId = id('history-tool-id-collision');
    const callId = brandId<'ToolCallId'>('history-call') as ToolCallId;
    const firstRuntime = runtime(
      sessions,
      new ScriptedModelProvider([
        {
          events: [
            {
              type: 'tool.call',
              call: { id: callId, name: 'missing', input: {} },
            },
          ],
        },
        { events: [{ type: 'text.delta', text: 'first complete' }] },
      ]),
    );
    const firstHandle = await firstRuntime.create(sessionId, { signal: signal() });
    await firstHandle.agent.run(user('first-tool-turn'));
    await firstHandle.close();
    const secondRuntime = runtime(
      sessions,
      new ScriptedModelProvider([
        {
          events: [
            {
              type: 'tool.call',
              call: { id: callId, name: 'missing', input: {} },
            },
          ],
        },
      ]),
    );
    const secondHandle = await secondRuntime.resume(sessionId, { signal: signal() });

    await expect(secondHandle.agent.run(user('second-tool-turn'))).rejects.toMatchObject({
      name: 'AgentIdCollisionError',
      kind: 'toolCall',
      value: 'history-call',
    });

    await secondHandle.close();
    const reader = await sessions.open(sessionId, { mode: 'read', signal: signal() });
    const events = await reader.read({ signal: signal() });
    expect(() => analyzeSessionLifecycle(events)).not.toThrow();
    await reader.close({ signal: signal() });
  });

  it('同一 Agent 进程内重复生成 ID 时立即拒绝', async () => {
    const session = new LifecycleSessionLog(id('process-id-collision'));
    const harness = runtime(
      repositoryReturning(session),
      new ScriptedModelProvider([
        { events: [{ type: 'text.delta', text: 'first' }] },
        { events: [{ type: 'text.delta', text: 'second' }] },
      ]),
      { idGenerators: { create: () => new RepeatingAgentIds() } },
    );
    const handle = await harness.resume(session.sessionId, { signal: signal() });
    await handle.agent.run(user('first'));

    await expect(handle.agent.run(user('second'))).rejects.toBeInstanceOf(AgentIdCollisionError);

    await handle.close();
  });

  it('resume 使用 expectedSequence 将 repair 作为一个 batch 追加', async () => {
    const sessionId = id('atomic-repair');
    const delegate = new InMemorySessionLog(sessionId);
    const turnId = brandId<'TurnId'>('open-turn') as TurnId;
    await delegate.append([{ type: 'turn.started', turnId }], { signal: signal() });
    const appends: Array<{
      readonly events: readonly SessionEvent[];
      readonly options: SessionAppendOptions;
    }> = [];
    const tracking = new DelegatingSessionLog(delegate, (events, options) => {
      appends.push({ events, options });
    });
    const harness = runtime(repositoryReturning(tracking), new ScriptedModelProvider([]));

    const handle = await harness.resume(sessionId, { signal: signal() });

    expect(appends).toHaveLength(1);
    expect(appends[0]?.options.expectedSequence).toBe(1);
    expect(appends[0]?.events).toEqual([{ type: 'turn.ended', turnId, outcome: 'interrupted' }]);
    await handle.close();
  });

  it('repair 失败后关闭 writer 并释放 JSONL lease', async () => {
    const sessions = await jsonlRepository();
    const sessionId = id('invalid-history');
    const writer = await sessions.create(sessionId, { signal: signal() });
    const turnId = brandId<'TurnId'>('duplicate-turn') as TurnId;
    await writer.append(
      [
        { type: 'turn.started', turnId },
        { type: 'turn.started', turnId },
      ],
      { signal: signal() },
    );
    await writer.close({ signal: signal() });
    const harness = runtime(sessions, new ScriptedModelProvider([]));

    await expect(harness.resume(sessionId, { signal: signal() })).rejects.toThrow();

    const reopened = await sessions.open(sessionId, { mode: 'write', signal: signal() });
    await reopened.close({ signal: signal() });
  });

  it('repair batch 写入失败时仍关闭 writer', async () => {
    const session = new LifecycleSessionLog(id('repair-append-failure'));
    await session.append(
      [
        {
          type: 'turn.started',
          turnId: brandId<'TurnId'>('open-turn') as TurnId,
        },
      ],
      { signal: signal() },
    );
    const repairError = new Error('repair append failed');
    session.appendError = repairError;
    const harness = runtime(repositoryReturning(session), new ScriptedModelProvider([]));

    await expect(harness.resume(session.sessionId, { signal: signal() })).rejects.toBe(repairError);
    expect(session.flushCalls).toBe(1);
    expect(session.closeCalls).toBe(1);
  });

  it('setup 与 cleanup 同时失败时保留两个错误', async () => {
    const session = new LifecycleSessionLog(id('setup-cleanup-failure'));
    const setupError = new Error('id factory failed');
    const cleanupError = new Error('close failed');
    session.closeError = cleanupError;
    const harness = runtime(repositoryReturning(session), new ScriptedModelProvider([]), {
      idGenerators: {
        create: () => {
          throw setupError;
        },
      },
    });

    let received: unknown;
    try {
      await harness.resume(session.sessionId, { signal: signal() });
    } catch (error) {
      received = error;
    }

    expect(received).toBeInstanceOf(AggregateError);
    expect((received as AggregateError).errors).toEqual([setupError, cleanupError]);
    expect(session.closeCalls).toBe(1);
  });

  it('close 会取消阻塞模型、等待 Agent idle 并关闭 writer', async () => {
    const sessionId = id('blocked-model');
    const session = new LifecycleSessionLog(sessionId);
    const started = deferred();
    const model = new ScriptedModelProvider([
      {
        events: [],
        prepare: async (prepareSignal) => {
          started.resolve();
          await rejectWhenAborted(prepareSignal);
        },
      },
    ]);
    const harness = runtime(repositoryReturning(session), model);
    const handle = await harness.resume(sessionId, { signal: signal() });
    const run = handle.agent.run(user('blocked'));
    await started.promise;

    await handle.close();

    await expect(run).rejects.toBeInstanceOf(RuntimeClosedError);
    expect(session.flushCalls).toBe(1);
    expect(session.closeCalls).toBe(1);
    await expect(handle.agent.run(user('late'))).rejects.toBeInstanceOf(AgentClosedError);
  });

  it('调用方取消 close 等待后，后台仍完成资源释放', async () => {
    const session = new LifecycleSessionLog(id('abandoned-close'));
    const closeGate = deferred();
    session.closeGate = closeGate.promise;
    const harness = runtime(repositoryReturning(session), new ScriptedModelProvider([]));
    const handle = await harness.resume(session.sessionId, { signal: signal() });
    const controller = new AbortController();
    const firstWait = handle.close({ signal: controller.signal });
    controller.abort(new Error('调用方不再等待'));

    await expect(firstWait).rejects.toThrow('调用方不再等待');
    expect(session.closeCalls).toBe(1);
    closeGate.resolve();
    await handle.close();
    expect(session.closeCalls).toBe(1);
  });

  it('调用方放弃等待后，Runtime 仍观察后台关闭失败', async () => {
    const session = new LifecycleSessionLog(id('background-close-failure'));
    const closeGate = deferred();
    const closeError = new Error('background close failed');
    session.closeGate = closeGate.promise;
    session.closeError = closeError;
    const harness = runtime(repositoryReturning(session), new ScriptedModelProvider([]));
    const handle = await harness.resume(session.sessionId, { signal: signal() });
    const controller = new AbortController();
    const abandoned = handle.close({ signal: controller.signal });
    controller.abort(new Error('放弃等待'));
    await expect(abandoned).rejects.toThrow('放弃等待');
    closeGate.resolve();

    await expect(harness.close()).rejects.toBe(closeError);
    expect(session.closeCalls).toBe(1);
  });

  it('handle 与 Runtime 重复 close 都是幂等的', async () => {
    const session = new LifecycleSessionLog(id('double-close'));
    const harness = runtime(repositoryReturning(session), new ScriptedModelProvider([]));
    const handle = await harness.resume(session.sessionId, { signal: signal() });

    await Promise.all([handle.close(), handle.close()]);
    await Promise.all([harness.close(), harness.closeAll()]);

    expect(session.flushCalls).toBe(1);
    expect(session.closeCalls).toBe(1);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN])(
    '拒绝无效 settlementTimeoutMs：%s',
    (settlementTimeoutMs) => {
      expect(() =>
        runtime(
          repositoryReturning(new LifecycleSessionLog(id('config'))),
          new ScriptedModelProvider([]),
          { settlementTimeoutMs },
        ),
      ).toThrow('settlementTimeoutMs');
    },
  );
});

class DelegatingSessionLog implements SessionLog {
  readonly sessionId: SessionId;
  readonly #delegate: SessionLog;
  readonly #onAppend: (events: readonly SessionEvent[], options: SessionAppendOptions) => void;

  constructor(
    delegate: SessionLog,
    onAppend: (events: readonly SessionEvent[], options: SessionAppendOptions) => void,
  ) {
    this.sessionId = delegate.sessionId;
    this.#delegate = delegate;
    this.#onAppend = onAppend;
  }

  append(
    events: readonly SessionEvent[],
    options: SessionAppendOptions,
  ): Promise<readonly EventEnvelope[]> {
    this.#onAppend(events, options);
    return this.#delegate.append(events, options);
  }

  read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    return this.#delegate.read(options);
  }

  flush(options: SessionOperationOptions): Promise<void> {
    return this.#delegate.flush(options);
  }

  close(options: SessionOperationOptions): Promise<void> {
    return this.#delegate.close(options);
  }
}

class LifecycleSessionLog implements SessionLog {
  readonly sessionId: SessionId;
  readonly #delegate: InMemorySessionLog;
  flushCalls = 0;
  closeCalls = 0;
  closeGate: Promise<void> | undefined;
  closeError: unknown;
  appendError: unknown;

  constructor(sessionId: SessionId) {
    this.sessionId = sessionId;
    this.#delegate = new InMemorySessionLog(sessionId);
  }

  append(
    events: readonly SessionEvent[],
    options: SessionAppendOptions,
  ): Promise<readonly EventEnvelope[]> {
    if (this.appendError !== undefined) {
      return Promise.reject(this.appendError);
    }
    return this.#delegate.append(events, options);
  }

  read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    return this.#delegate.read(options);
  }

  async flush(options: SessionOperationOptions): Promise<void> {
    this.flushCalls += 1;
    options.signal.throwIfAborted();
  }

  async close(_options: SessionOperationOptions): Promise<void> {
    this.closeCalls += 1;
    await this.closeGate;
    if (this.closeError !== undefined) {
      throw this.closeError;
    }
  }
}

function repositoryReturning(session: SessionLog): SessionRepository {
  return {
    create: async () => session,
    open: async (
      _sessionId: SessionId,
      _options: SessionOpenOptions,
    ): Promise<SessionReader | SessionLog> => session,
  } as SessionRepository;
}

class RepeatingAgentIds implements AgentIdGenerator {
  turn(): TurnId {
    return brandId<'TurnId'>('repeated-turn') as TurnId;
  }

  step(): StepId {
    return brandId<'StepId'>('repeated-step') as StepId;
  }

  attempt(): AttemptId {
    return brandId<'AttemptId'>('repeated-attempt') as AttemptId;
  }

  message(): MessageId {
    return brandId<'MessageId'>('repeated-message') as MessageId;
  }
}

function deferred(): {
  readonly promise: Promise<void>;
  resolve(): void;
} {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      resolvePromise?.();
    },
  };
}

function rejectWhenAborted(abortSignal: AbortSignal): Promise<never> {
  if (abortSignal.aborted) {
    return Promise.reject(abortSignal.reason);
  }
  return new Promise<never>((_resolve, reject) => {
    abortSignal.addEventListener('abort', () => reject(abortSignal.reason), {
      once: true,
    });
  });
}
