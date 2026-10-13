import { randomUUID } from 'node:crypto';
import { BoundedPromptAssembler, SystemClock } from '@agent-harness/adapters/context';
import { Agent } from '@agent-harness/core';
import {
  type AgentIdGenerator,
  type AgentObserver,
  type AgentProfile,
  type AttemptId,
  analyzeSessionLifecycle,
  brandId,
  type Clock,
  type MessageId,
  type ModelProvider,
  PolicyControlledTools,
  type PromptAssembler,
  type SessionId,
  type SessionLifecycleIdNamespaces,
  type SessionLog,
  type SessionRepository,
  type SettlementSignalFactory,
  type StepId,
  type ToolCapability,
  type ToolExecutionPolicy,
  type TurnId,
} from '@agent-harness/kernel';
import { flushAndClose, waitFor } from './lifecycle.js';

const neverAbortedSignal = new AbortController().signal;
const DEFAULT_RUN_TIMEOUT_MS = 120_000;
const DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS = 90_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_MODEL_OUTPUT_BYTES = 1_048_576;
const DEFAULT_MAX_TOOL_RESULT_BYTES = 1_048_576;
const DEFAULT_MAX_INPUT_BYTES = 1_048_576;
const DEFAULT_MAX_QUEUED_RUNS = 32;

/** 为新建或恢复的 Agent 创建一组标识符。 */
export interface AgentIdGeneratorFactory {
  create(sessionId: SessionId): AgentIdGenerator;
}

/** 使用 UUID 为跨进程重启后的新生命周期生成标识符。 */
export class UuidAgentIds implements AgentIdGenerator {
  turn(): TurnId {
    return brandId<'TurnId'>(randomUUID());
  }

  step(): StepId {
    return brandId<'StepId'>(randomUUID());
  }

  attempt(): AttemptId {
    return brandId<'AttemptId'>(randomUUID());
  }

  message(): MessageId {
    return brandId<'MessageId'>(randomUUID());
  }
}

export interface AgentRuntimeOptions {
  readonly sessions: SessionRepository;
  readonly model: ModelProvider;
  readonly tools: ToolCapability;
  /** 可选的工具执行策略；由 Runtime 在组合点包裹真实工具。 */
  readonly toolPolicy?: ToolExecutionPolicy;
  readonly maxSteps: number;
  readonly settlementTimeoutMs: number;
  readonly runTimeoutMs?: number;
  readonly modelAttemptTimeoutMs?: number;
  readonly toolTimeoutMs?: number;
  readonly maxModelOutputBytes?: number;
  readonly maxToolResultBytes?: number;
  readonly maxInputBytes?: number;
  readonly maxQueuedRuns?: number;
  /** 由 Host 或 Platform 解析并提供的静态 Agent 指令。 */
  readonly agentProfile?: AgentProfile;
  readonly prompts?: PromptAssembler;
  readonly observers?: readonly AgentObserver[];
  readonly idGenerators?: AgentIdGeneratorFactory;
  readonly clock?: Clock;
}

export interface RuntimeOperationOptions {
  readonly signal: AbortSignal;
}

export interface RuntimeCloseOptions {
  readonly signal?: AbortSignal;
}

/** 表示 Runtime 或其 handle 已停止接纳新操作。 */
export class RuntimeClosedError extends Error {
  override readonly name = 'RuntimeClosedError';
}

/** 同时拥有 Agent 与会话 writer 的生命周期句柄。 */
export interface AgentRuntimeHandle {
  readonly agent: Agent;
  close(options?: RuntimeCloseOptions): Promise<void>;
}

/** 显式组合 Agent capability，并拥有所有已打开 writer 的生命周期。 */
export class AgentRuntime {
  readonly #options: AgentRuntimeOptions;
  readonly #handles = new Set<OwnedAgentHandle>();
  readonly #setupControllers = new Set<AbortController>();
  readonly #setupWaiters = new Set<() => void>();
  readonly #settlementSignals: SettlementSignalFactory;
  readonly #agentProfile: AgentProfile | undefined;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(options: AgentRuntimeOptions) {
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1) {
      throw new TypeError('maxSteps 必须是正整数');
    }
    if (
      !Number.isFinite(options.settlementTimeoutMs) ||
      !Number.isInteger(options.settlementTimeoutMs) ||
      options.settlementTimeoutMs < 1
    ) {
      throw new TypeError('settlementTimeoutMs 必须是正有限整数');
    }
    for (const [name, value] of [
      ['runTimeoutMs', options.runTimeoutMs],
      ['modelAttemptTimeoutMs', options.modelAttemptTimeoutMs],
      ['toolTimeoutMs', options.toolTimeoutMs],
      ['maxModelOutputBytes', options.maxModelOutputBytes],
      ['maxToolResultBytes', options.maxToolResultBytes],
      ['maxInputBytes', options.maxInputBytes],
      ['maxQueuedRuns', options.maxQueuedRuns],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new TypeError(`${name} 必须是正整数`);
      }
    }
    if (options.agentProfile !== undefined && options.prompts !== undefined) {
      throw new TypeError('agentProfile 不能与自定义 prompts 同时提供');
    }
    this.#options = options;
    this.#agentProfile = freezeAgentProfile(options.agentProfile);
    this.#settlementSignals = {
      create: () => AbortSignal.timeout(options.settlementTimeoutMs),
    };
  }

  create(sessionId: SessionId, options: RuntimeOperationOptions): Promise<AgentRuntimeHandle> {
    return this.#startSetup(sessionId, options.signal, 'create');
  }

  resume(sessionId: SessionId, options: RuntimeOperationOptions): Promise<AgentRuntimeHandle> {
    return this.#startSetup(sessionId, options.signal, 'resume');
  }

  /** 停止全部 Agent，并等待各 writer 刷新和释放。重复调用安全。 */
  close(options: RuntimeCloseOptions = {}): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closing = true;
      for (const controller of this.#setupControllers) {
        controller.abort(new RuntimeClosedError('Runtime 正在关闭'));
      }
      const closingHandles = [...this.#handles];
      for (const handle of closingHandles) handle.beginClose();
      this.#closePromise = this.#closeAll(closingHandles);
    }
    return waitFor(this.#closePromise, options.signal ?? neverAbortedSignal);
  }

  closeAll(options: RuntimeCloseOptions = {}): Promise<void> {
    return this.close(options);
  }

  async #startSetup(
    sessionId: SessionId,
    externalSignal: AbortSignal,
    mode: 'create' | 'resume',
  ): Promise<AgentRuntimeHandle> {
    if (this.#closing) throw new RuntimeClosedError('Runtime 已关闭');
    const controller = new AbortController();
    this.#setupControllers.add(controller);
    const signal = AbortSignal.any([externalSignal, controller.signal]);
    try {
      const session =
        mode === 'create'
          ? await this.#options.sessions.create(sessionId, { signal })
          : await this.#options.sessions.open(sessionId, { mode: 'write', signal });
      try {
        const usedIds = mode === 'resume' ? await repairSession(session, signal) : emptyUsedIds;
        const generatedIds = this.#options.idGenerators?.create(sessionId) ?? new UuidAgentIds();
        const agent = new Agent({
          model: this.#options.model,
          session,
          tools:
            this.#options.toolPolicy === undefined
              ? this.#options.tools
              : new PolicyControlledTools(this.#options.tools, this.#options.toolPolicy),
          ids: generatedIds,
          maxSteps: this.#options.maxSteps,
          settlementSignals: this.#settlementSignals,
          clock: this.#options.clock ?? new SystemClock(),
          prompts:
            this.#options.prompts ??
            new BoundedPromptAssembler({
              maxInputBytes: this.#options.maxInputBytes ?? DEFAULT_MAX_INPUT_BYTES,
              ...(this.#agentProfile === undefined
                ? {}
                : { systemPrompt: this.#agentProfile.instructions }),
            }),
          runTimeoutMs: this.#options.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS,
          modelAttemptTimeoutMs:
            this.#options.modelAttemptTimeoutMs ?? DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS,
          toolTimeoutMs: this.#options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
          maxModelOutputBytes: this.#options.maxModelOutputBytes ?? DEFAULT_MAX_MODEL_OUTPUT_BYTES,
          maxToolResultBytes: this.#options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES,
          maxQueuedRuns: this.#options.maxQueuedRuns ?? DEFAULT_MAX_QUEUED_RUNS,
          ...(this.#options.observers === undefined ? {} : { observers: this.#options.observers }),
          reservedIds: usedIds,
        });
        const handle = new OwnedAgentHandle(agent, session, this.#options.settlementTimeoutMs, () =>
          this.#handles.delete(handle),
        );
        if (this.#closing) {
          agent.stop(new RuntimeClosedError('Runtime 在会话建立期间开始关闭'));
          throw new RuntimeClosedError('Runtime 在会话建立期间开始关闭');
        }
        this.#handles.add(handle);
        return handle;
      } catch (error) {
        throw await closeAfterSetupFailure(session, error, this.#options.settlementTimeoutMs);
      }
    } finally {
      this.#setupControllers.delete(controller);
      if (this.#setupControllers.size === 0) {
        for (const resolve of this.#setupWaiters) resolve();
        this.#setupWaiters.clear();
      }
    }
  }

  async #closeAll(closingHandles: readonly OwnedAgentHandle[]): Promise<void> {
    if (this.#setupControllers.size > 0) {
      await new Promise<void>((resolve) => this.#setupWaiters.add(resolve));
    }
    const results = await Promise.allSettled(closingHandles.map((handle) => handle.done()));
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '关闭 Runtime 时发生多个错误');
  }
}

class OwnedAgentHandle implements AgentRuntimeHandle {
  readonly agent: Agent;
  readonly #session: SessionLog;
  readonly #timeoutMs: number;
  readonly #onClosed: () => void;
  #closePromise: Promise<void> | undefined;

  constructor(agent: Agent, session: SessionLog, timeoutMs: number, onClosed: () => void) {
    this.agent = agent;
    this.#session = session;
    this.#timeoutMs = timeoutMs;
    this.#onClosed = onClosed;
  }

  close(options: RuntimeCloseOptions = {}): Promise<void> {
    this.beginClose();
    return waitFor(this.done(), options.signal ?? neverAbortedSignal);
  }

  beginClose(): void {
    if (this.#closePromise !== undefined) return;
    this.agent.stop(new RuntimeClosedError('Agent handle 正在关闭'));
    this.#closePromise = this.#close();
  }

  done(): Promise<void> {
    return this.#closePromise ?? Promise.resolve();
  }

  async #close(): Promise<void> {
    await this.agent.whenIdle();
    await flushAndClose(this.#session, this.#timeoutMs);
    this.#onClosed();
  }
}

async function repairSession(
  session: SessionLog,
  signal: AbortSignal,
): Promise<SessionLifecycleIdNamespaces> {
  const events = await session.read({ signal });
  const plan = analyzeSessionLifecycle(events);
  if (plan.events.length > 0) {
    await session.append(plan.events, {
      signal,
      expectedSequence: plan.expectedSequence,
    });
  }
  return plan.usedIds;
}

function freezeAgentProfile(profile: AgentProfile | undefined): AgentProfile | undefined {
  if (profile === undefined) return undefined;
  if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
    throw new TypeError('agentProfile 必须是对象');
  }
  const keys = Object.keys(profile);
  const expected = ['id', 'instructions', 'version'];
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new TypeError('agentProfile 只能包含 id、version 与 instructions');
  }
  const { id, version, instructions } = profile;
  for (const [name, value] of Object.entries({ id, version, instructions })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`agentProfile.${name} 必须是非空字符串`);
    }
  }
  return Object.freeze({ id, version, instructions });
}

const emptyUsedIds: SessionLifecycleIdNamespaces = Object.freeze({
  turnIds: Object.freeze([]),
  stepIds: Object.freeze([]),
  attemptIds: Object.freeze([]),
  messageIds: Object.freeze([]),
  toolCallIds: Object.freeze([]),
});

async function closeAfterSetupFailure(
  session: SessionLog,
  setupError: unknown,
  timeoutMs: number,
): Promise<never> {
  try {
    await flushAndClose(session, timeoutMs);
  } catch (cleanupError) {
    throw new AggregateError([setupError, cleanupError], '会话建立失败，且 writer 清理也失败', {
      cause: setupError,
    });
  }
  throw setupError;
}
