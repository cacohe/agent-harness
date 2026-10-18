/** 会话级串行 Agent 执行器，只依赖 Kernel 定义并由组合方注入 capability 接口。 */
import {
  AgentBusyError,
  AgentClosedError,
  type AgentIdGenerator,
  type AgentObserver,
  type AgentOptions,
  type AgentPhase,
  type AgentRunOptions,
  type AssistantMessage,
  type AttemptId,
  assertJsonValue,
  assertNever,
  type Clock,
  type EventEnvelope,
  type ExecutionId,
  type ExecutionMetadata,
  type ExecutionObservation,
  freezeJsonValue,
  isAbortError,
  type ModelProvider,
  type ModelRequest,
  type ModelStreamEvent,
  type PromptAssembler,
  type SessionEvent,
  type SessionLog,
  SettlementPersistenceError,
  type SettlementSignalFactory,
  type StepId,
  type ToolCall,
  type ToolResult,
  type ToolSet,
  type TurnId,
  type UserMessage,
} from '@agent-harness/kernel';
import { AgentIdReservations } from './agent-id-reservations.js';
import { isAbortSignal, throwIfAborted, waitForSignal } from './cancellation.js';
import { freezeExecutionMetadata } from './execution-metadata.js';
import { AgentInbox, type QueuedRun } from './inbox.js';
import {
  type ActiveTurn,
  type Attempt,
  buildTerminalEvents,
  createStep,
  type Step,
} from './lifecycle.js';
import { assertCumulativeUsage } from './model-usage.js';

const textEncoder = new TextEncoder();
const DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS = 90_000;
const DEFAULT_TOOL_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_TOOL_RESULT_BYTES = 1_048_576;
const DEFAULT_MAX_QUEUED_RUNS = 32;

/**
 * 只依赖 Kernel capability 接口的会话级串行 Agent 执行器。
 * 它接纳输入、按 FIFO 调度 turn，并保证已打开的 turn/step 在成功、失败与取消路径上恰好结算一次。
 */
export class Agent {
  readonly #model: ModelProvider;
  readonly #session: SessionLog;
  readonly #tools: ToolSet;
  readonly #idGenerator: AgentIdGenerator;
  readonly #maxSteps: number;
  readonly #settlementSignalFactory: SettlementSignalFactory;
  readonly #clock: Clock | undefined;
  readonly #promptAssembler: PromptAssembler;
  readonly #runTimeoutMs: number | undefined;
  readonly #modelAttemptTimeoutMs: number;
  readonly #toolTimeoutMs: number;
  readonly #maxModelOutputBytes: number | undefined;
  readonly #maxToolResultBytes: number;
  readonly #maxQueuedRuns: number;
  readonly #observers: readonly AgentObserver[];
  readonly #idReservations: AgentIdReservations;
  readonly #inbox = new AgentInbox();
  #phase: AgentPhase = { kind: 'idle' };
  #activeRunAbortController: AbortController | undefined;
  #accepting = true;
  #inboxDrain: Promise<void> | undefined;

  constructor(options: AgentOptions) {
    assertPositiveInteger('maxSteps', options.maxSteps);
    for (const [name, value] of [
      ['runTimeoutMs', options.runTimeoutMs],
      ['modelAttemptTimeoutMs', options.modelAttemptTimeoutMs],
      ['toolTimeoutMs', options.toolTimeoutMs],
      ['maxModelOutputBytes', options.maxModelOutputBytes],
      ['maxToolResultBytes', options.maxToolResultBytes],
      ['maxQueuedRuns', options.maxQueuedRuns],
    ] as const) {
      if (value !== undefined) {
        assertPositiveInteger(name, value);
      }
    }

    this.#model = options.model;
    this.#session = options.session;
    this.#tools = options.tools;
    this.#idGenerator = options.ids;
    this.#maxSteps = options.maxSteps;
    this.#settlementSignalFactory = options.settlementSignals;
    this.#clock = options.clock;
    this.#promptAssembler = options.prompts;
    this.#runTimeoutMs = options.runTimeoutMs;
    this.#modelAttemptTimeoutMs = options.modelAttemptTimeoutMs ?? DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS;
    this.#toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxModelOutputBytes = options.maxModelOutputBytes;
    this.#maxToolResultBytes = options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
    this.#maxQueuedRuns = options.maxQueuedRuns ?? DEFAULT_MAX_QUEUED_RUNS;
    this.#observers = Object.freeze([...(options.observers ?? [])]);
    this.#idReservations = new AgentIdReservations(options.reservedIds);
  }

  get phase(): AgentPhase {
    return this.#phase;
  }

  /** 取消当前活动 run；不影响是否继续接纳新的 run。 */
  cancel(reason: unknown = new Error('agent run cancelled')): void {
    this.#activeRunAbortController?.abort(reason);
  }

  /** 永久停止接纳新 run，并取消当前活动。重复调用安全。 */
  stop(reason: unknown = new Error('agent stopped')): void {
    this.#accepting = false;
    this.cancel(reason);
    this.#inbox.rejectAll(new AgentClosedError('Agent 已停止接纳新的 run'));
  }

  /** 等待当前 drain 完成，其中包含活动 turn 与已接纳的排队输入。 */
  async whenIdle(): Promise<void> {
    for (;;) {
      const inboxDrain = this.#inboxDrain;
      if (inboxDrain === undefined) {
        return;
      }
      await inboxDrain;
      if (this.#inboxDrain === undefined) {
        return;
      }
    }
  }

  /**
   * 接纳一条用户输入，按 FIFO 等待执行，并返回其对应 turn 的最终助手消息。
   * 若在领取前取消，仅从等待队列移除，不会写入会话事件。
   */
  run(
    message: UserMessage,
    options: AbortSignal | AgentRunOptions = {},
  ): Promise<AssistantMessage> {
    if (!this.#accepting) {
      return Promise.reject(new AgentClosedError('Agent 已停止接纳新的 run'));
    }

    let accepted: AcceptedRun;
    try {
      accepted = acceptRun(message, options);
    } catch (error) {
      return Promise.reject(error);
    }

    return new Promise<AssistantMessage>((resolve, reject) => {
      let queued: QueuedRun;
      const onAbort = (): void => {
        if (!this.#inbox.remove(queued)) {
          return;
        }
        queued.clearAbortListener();
        reject(accepted.signal.reason);
      };
      queued = {
        message: accepted.message,
        signal: accepted.signal,
        ...(accepted.execution === undefined ? {} : { execution: accepted.execution }),
        resolve,
        reject,
        clearAbortListener: () => accepted.signal.removeEventListener('abort', onAbort),
      };
      if (accepted.signal.aborted) {
        reject(accepted.signal.reason);
        return;
      }
      if (this.#inbox.size >= this.#maxQueuedRuns) {
        reject(new AgentBusyError(`Agent 输入队列已达到上限 ${this.#maxQueuedRuns}`));
        return;
      }
      accepted.signal.addEventListener('abort', onAbort, { once: true });
      this.#inbox.enqueue(queued);
      this.#ensureInboxDraining();
    });
  }

  /** 确保只有一个 FIFO drain；单个输入失败不会阻断后续输入。 */
  #ensureInboxDraining(): void {
    if (this.#inboxDrain !== undefined) {
      return;
    }
    this.#inboxDrain = this.#drainInbox().finally(() => {
      this.#inboxDrain = undefined;
      if (this.#inbox.hasPending) {
        this.#ensureInboxDraining();
      }
    });
  }

  /** 串行领取已接纳输入，并仅结算各自调用，不让单项失败中断后续领取。 */
  async #drainInbox(): Promise<void> {
    for (;;) {
      const queued = this.#inbox.claim();
      if (queued === undefined) {
        return;
      }
      queued.clearAbortListener();
      try {
        queued.resolve(await this.#runTurn(queued.message, queued.signal, queued.execution));
      } catch (error) {
        queued.reject(error);
      }
    }
  }

  /** 执行已从 inbox 领取的一条输入。 */
  async #runTurn(
    message: UserMessage,
    externalSignal: AbortSignal,
    execution: ExecutionMetadata | undefined,
  ): Promise<AssistantMessage> {
    const turn: ActiveTurn = {
      turnId: this.#idReservations.turn(this.#idGenerator.turn()),
      started: false,
      ended: false,
    };
    const controller = new AbortController();
    this.#activeRunAbortController = controller;
    const timeoutSignal =
      this.#runTimeoutMs === undefined ? undefined : AbortSignal.timeout(this.#runTimeoutMs);
    const signal = AbortSignal.any([
      externalSignal,
      controller.signal,
      ...(timeoutSignal === undefined ? [] : [timeoutSignal]),
    ]);
    this.#phase = { kind: 'running', turnId: turn.turnId };

    try {
      await this.#append(
        [
          {
            type: 'turn.started',
            turnId: turn.turnId,
            ...(execution === undefined ? {} : { execution }),
          },
        ],
        signal,
      );
      turn.started = true;

      this.#idReservations.message(message.id);
      await this.#append([{ type: 'user.message', message }], signal);

      for (let stepNumber = 1; ; stepNumber += 1) {
        throwIfAborted(signal);

        const stepId = this.#idReservations.step(this.#idGenerator.step());
        const step = createStep(stepId);
        turn.activeStep = step;
        this.#phase = { kind: 'running', turnId: turn.turnId, stepId };

        const messageFromStep = await this.#runStep(turn.turnId, step, signal, execution);

        if (messageFromStep.toolCalls.length === 0) {
          await this.#append(
            [{ type: 'turn.ended', turnId: turn.turnId, outcome: 'completed' }],
            signal,
          );
          turn.ended = true;
          return messageFromStep;
        }

        if (stepNumber === this.#maxSteps) {
          throw new Error(`agent exceeded maxSteps (${this.#maxSteps})`);
        }
      }
    } catch (error) {
      const outcome = signal.aborted || isAbortError(error) ? 'cancelled' : 'failed';
      const terminalEvents = buildTerminalEvents({
        error,
        outcome,
        turn,
      });

      if (terminalEvents.length > 0) {
        try {
          const settlementSignal = this.#settlementSignalFactory.create();
          await this.#append(terminalEvents, settlementSignal);
        } catch (persistenceError) {
          throw new SettlementPersistenceError(error, persistenceError, outcome);
        }
      }
      throw error;
    } finally {
      this.#activeRunAbortController = undefined;
      this.#phase = { kind: 'idle' };
    }
  }

  /**
   * 执行单个 step：组装请求、流式模型、持久化 assistant 结算、顺序执行工具并闭合 step。
   * 流式 chunk 只通知 observer；持久事实写入会话事件。
   */
  async #runStep(
    turnId: TurnId,
    step: Step,
    signal: AbortSignal,
    execution: ExecutionMetadata | undefined,
  ): Promise<AssistantMessage> {
    const stepId = step.stepId;
    await this.#append([{ type: 'step.started', turnId, stepId }], signal);
    step.started = true;
    throwIfAborted(signal);

    const sessionEvents = await this.#session.read({ signal });
    const request = await waitForSignal(
      this.#promptAssembler.assemble(sessionEvents, this.#tools.list(), signal),
      signal,
    );
    const attempt = await this.#runModelAttempt(request, turnId, step, signal, execution);
    throwIfAborted(signal);

    const assistantMessage: AssistantMessage = {
      id: this.#idReservations.message(this.#idGenerator.message()),
      role: 'assistant',
      content: attempt.partialText,
      toolCalls: Object.freeze([...attempt.observedToolCalls]),
    };
    attempt.settlement = {
      status: 'completed',
      attemptId: attempt.attemptId,
      message: assistantMessage,
    };
    await this.#append(
      [{ type: 'assistant.settled', turnId, stepId, settlement: attempt.settlement }],
      signal,
    );
    attempt.settlementPersisted = true;

    for (const call of attempt.observedToolCalls) {
      const result = await this.#executeToolCall(
        call,
        turnId,
        stepId,
        attempt.attemptId,
        signal,
        execution,
      );
      attempt.toolResults.set(call.id, result);
      await this.#append([{ type: 'tool.completed', turnId, stepId, result }], signal);
      attempt.persistedToolResults.add(call.id);
    }

    await this.#append([{ type: 'step.ended', turnId, stepId, outcome: 'completed' }], signal);
    step.ended = true;
    return assistantMessage;
  }

  /** 准备并消费一次模型调用；prepare 失败时不会创建或消耗 attempt 身份。 */
  async #runModelAttempt(
    request: ModelRequest,
    turnId: TurnId,
    step: Step,
    signal: AbortSignal,
    execution: ExecutionMetadata | undefined,
  ): Promise<Attempt> {
    const stepId = step.stepId;
    const modelSignal = this.#deadlineSignal(signal, this.#modelAttemptTimeoutMs);
    const prepared = await this.#model.prepare(modelSignal);
    throwIfAborted(modelSignal);
    const attempt: Attempt = {
      attemptId: this.#idReservations.attempt(this.#idGenerator.attempt()),
      partialText: '',
      observedToolCalls: [],
      settlementPersisted: false,
      toolResults: new Map(),
      persistedToolResults: new Set(),
    };
    step.attempt = attempt;
    const executionScope = this.#executionObservationScope(execution);
    let outputBytes = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let usageSequence = 0;
    const modelStartedAt = this.#now();

    if (modelStartedAt !== undefined) {
      this.#notifyObservation({
        type: 'model.invocation.started',
        sessionId: this.#session.sessionId,
        turnId,
        stepId,
        attemptId: attempt.attemptId,
        ...executionScope,
        startedAt: modelStartedAt,
      });
    }

    try {
      for await (const emittedEvent of prepared.stream(request, modelSignal)) {
        throwIfAborted(modelSignal);
        const event = snapshotModelStreamEvent(emittedEvent);
        this.#notifyStream(event);
        switch (event.type) {
          case 'text.delta':
            outputBytes += utf8ByteLength(event.text);
            this.#assertOutputBudget(outputBytes);
            attempt.partialText += event.text;
            break;

          case 'tool.call':
            outputBytes += utf8ByteLength(JSON.stringify(event.call));
            this.#assertOutputBudget(outputBytes);
            this.#idReservations.toolCall(event.call.id);
            attempt.observedToolCalls.push(event.call);
            break;

          case 'usage':
            assertCumulativeUsage(event.inputTokens, event.outputTokens, inputTokens, outputTokens);
            usageSequence += 1;
            this.#notifyObservation({
              type: 'model.invocation.usage',
              sessionId: this.#session.sessionId,
              turnId,
              stepId,
              attemptId: attempt.attemptId,
              ...executionScope,
              usageSequence,
              inputTokensDelta: event.inputTokens - inputTokens,
              outputTokensDelta: event.outputTokens - outputTokens,
            });
            inputTokens = event.inputTokens;
            outputTokens = event.outputTokens;
            break;
          default:
            assertNever(event);
        }
      }
      throwIfAborted(modelSignal);
      if (modelStartedAt !== undefined) {
        this.#notifyObservation({
          type: 'model.invocation.finished',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          ...executionScope,
          ...this.#withDuration(modelStartedAt),
          outcome: 'completed',
        });
      }
    } catch (error) {
      if (modelStartedAt !== undefined) {
        this.#notifyObservation({
          type: 'model.invocation.finished',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          ...executionScope,
          ...this.#withDuration(modelStartedAt),
          outcome: modelSignal.aborted || isAbortError(error) ? 'cancelled' : 'failed',
          ...(error instanceof Error ? { errorName: error.name } : {}),
        });
      }
      throw error;
    }
    return attempt;
  }

  /** 执行并规范化一次工具调用，保证已开始的调用恰好发出一个终态观测。 */
  async #executeToolCall(
    call: ToolCall,
    turnId: TurnId,
    stepId: StepId,
    attemptId: AttemptId,
    signal: AbortSignal,
    execution: ExecutionMetadata | undefined,
  ): Promise<ToolResult> {
    const toolSignal = this.#deadlineSignal(signal, this.#toolTimeoutMs);
    const executionScope = this.#executionObservationScope(execution);
    const toolStartedAt = this.#now();
    if (toolStartedAt !== undefined) {
      this.#notifyObservation({
        type: 'tool.invocation.started',
        sessionId: this.#session.sessionId,
        turnId,
        stepId,
        attemptId,
        ...executionScope,
        toolCallId: call.id,
        toolName: call.name,
        startedAt: toolStartedAt,
      });
    }

    try {
      const result = await this.#tools.execute(call, {
        signal: toolSignal,
        ...(execution === undefined ? {} : { execution }),
      });
      throwIfAborted(toolSignal);
      if (toolStartedAt !== undefined) {
        this.#notifyObservation({
          type: 'tool.invocation.finished',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId,
          ...executionScope,
          toolCallId: call.id,
          toolName: call.name,
          ...this.#withDuration(toolStartedAt),
          termination: 'returned',
          resultStatus: result.status,
        });
      }
      return this.#boundToolResult(result);
    } catch (error) {
      if (toolStartedAt !== undefined) {
        this.#notifyObservation({
          type: 'tool.invocation.finished',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId,
          ...executionScope,
          toolCallId: call.id,
          toolName: call.name,
          ...this.#withDuration(toolStartedAt),
          termination: toolSignal.aborted || isAbortError(error) ? 'cancelled' : 'failed',
          ...(error instanceof Error ? { errorName: error.name } : {}),
        });
      }
      if (toolSignal.aborted && !signal.aborted) {
        return {
          status: 'cancelled',
          callId: call.id,
          reason: `工具调用超过 toolTimeoutMs (${this.#toolTimeoutMs})`,
        };
      }
      throw error;
    }
  }

  /** 控制单次 run 的模型输出预算，避免模型无限输出。 */
  #assertOutputBudget(bytes: number): void {
    if (this.#maxModelOutputBytes !== undefined && bytes > this.#maxModelOutputBytes) {
      throw new Error(`模型输出超过 maxModelOutputBytes (${this.#maxModelOutputBytes})`);
    }
  }

  /** 局部 deadline 只能缩短父 turn 的有效期，不能延长或绕过取消。 */
  #deadlineSignal(parent: AbortSignal, timeoutMs: number): AbortSignal {
    return AbortSignal.any([parent, AbortSignal.timeout(timeoutMs)]);
  }

  /** 限制工具返回的可变载荷，避免其无限写入会话与后续 prompt。 */
  #boundToolResult(result: ToolResult): ToolResult {
    const bytes = utf8ByteLength(JSON.stringify(this.#toolResultPayload(result)));
    if (bytes <= this.#maxToolResultBytes) {
      return result;
    }
    return {
      status: 'failure',
      callId: result.callId,
      error: {
        name: 'ToolResultTooLargeError',
        message: `工具结果超过 maxToolResultBytes (${this.#maxToolResultBytes})`,
      },
    };
  }

  /** 不把协议元数据计入预算；预算针对不受 Core 控制的工具返回载荷。 */
  #toolResultPayload(result: ToolResult): unknown {
    switch (result.status) {
      case 'success':
        return result.output;
      case 'failure':
        return result.error;
      case 'cancelled':
      case 'unknown':
        return result.reason;
      default:
        return assertNever(result);
    }
  }

  #executionObservationScope(execution: ExecutionMetadata | undefined): {
    readonly executionId?: ExecutionId;
  } {
    return execution === undefined ? {} : { executionId: execution.id };
  }

  #now(): Date | undefined {
    if (this.#clock === undefined) {
      return undefined;
    }
    try {
      const value = this.#clock.now();
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
        return undefined;
      }
      return value;
    } catch {
      // 时钟仅服务于瞬态观测，不能影响 Agent 的执行或结算。
      return undefined;
    }
  }

  #withDuration(startedAt: Date): { readonly durationMs?: number } {
    const finishedAt = this.#now();
    if (finishedAt === undefined) {
      return {};
    }
    return { durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()) };
  }

  /** 提交会话事件，并向 observer 发送与持久化事实一致的通知。 */
  async #append(events: readonly SessionEvent[], signal: AbortSignal): Promise<void> {
    const appended = await this.#session.append(events, { signal });
    for (const envelope of appended) {
      this.#notifySessionEvent(envelope);
    }
  }

  /** 向 observer 派发LLM流事件（模型生成时的中间输出）；用于在 Agent 外部展示模型生成过程，不做持久化。 */
  #notifyStream(event: ModelStreamEvent): void {
    this.#notifyObservers((observer) => observer.onStream?.(event));
  }

  /** 向 observer 派发已经成功提交的会话事实。 */
  #notifySessionEvent(envelope: EventEnvelope): void {
    this.#notifyObservers((observer) => observer.onSessionEvent?.(envelope));
  }

  /** 向 observer 派发不进入会话日志的模型与工具调用观测信号。 */
  #notifyObservation(observation: ExecutionObservation): void {
    this.#notifyObservers((observer) => observer.onObservation?.(observation));
  }

  #notifyObservers(deliver: (observer: AgentObserver) => void | Promise<void>): void {
    for (const observer of this.#observers) {
      try {
        void Promise.resolve(deliver(observer)).catch(() => undefined);
      } catch {
        // 观察者仅接收通知，其失败不能改变 Agent 生命周期。
      }
    }
  }
}

interface AcceptedRun {
  readonly message: UserMessage;
  readonly signal: AbortSignal;
  readonly execution?: ExecutionMetadata;
}

/** 在跨越排队边界前校验并复制调用方输入。 */
function acceptRun(message: UserMessage, options: AbortSignal | AgentRunOptions): AcceptedRun {
  const shorthandSignal = isAbortSignal(options);
  const signal = shorthandSignal ? options : (options.signal ?? new AbortController().signal);
  const execution = freezeExecutionMetadata(shorthandSignal ? undefined : options.execution);
  return Object.freeze({
    message: snapshotUserMessage(message),
    signal,
    ...(execution === undefined ? {} : { execution }),
  });
}

function snapshotUserMessage(message: UserMessage): UserMessage {
  if (typeof message !== 'object' || message === null) {
    throw new TypeError('message 必须是对象');
  }
  if (typeof message.id !== 'string' || message.id.length === 0) {
    throw new TypeError('message.id 必须是非空字符串');
  }
  if (message.role !== 'user') {
    throw new TypeError('message.role 必须是 user');
  }
  if (typeof message.content !== 'string') {
    throw new TypeError('message.content 必须是字符串');
  }
  return Object.freeze({ id: message.id, role: message.role, content: message.content });
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} 必须是正整数`);
  }
}

/** 在通知 observer 或保存工具调用前取得模型事件的不可变快照。 */
function snapshotModelStreamEvent(event: ModelStreamEvent): ModelStreamEvent {
  switch (event.type) {
    case 'text.delta':
      if (typeof event.text !== 'string') {
        throw new TypeError('模型 text.delta.text 必须是字符串');
      }
      return Object.freeze({ type: event.type, text: event.text });
    case 'tool.call':
      return Object.freeze({ type: event.type, call: snapshotToolCall(event.call) });
    case 'usage':
      return Object.freeze({
        type: event.type,
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
      });
    default:
      return assertNever(event);
  }
}

function snapshotToolCall(call: ToolCall): ToolCall {
  if (typeof call !== 'object' || call === null) {
    throw new TypeError('模型 tool.call.call 必须是对象');
  }
  if (typeof call.id !== 'string' || call.id.length === 0) {
    throw new TypeError('模型 tool.call.call.id 必须是非空字符串');
  }
  if (typeof call.name !== 'string' || call.name.length === 0) {
    throw new TypeError('模型 tool.call.call.name 必须是非空字符串');
  }
  assertJsonValue(call.input);
  return Object.freeze({ id: call.id, name: call.name, input: freezeJsonValue(call.input) });
}

/** 计算模型事件文本的 UTF-8 字节数，供单次输出预算使用。 */
function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}
