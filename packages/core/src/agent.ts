/** 会话级串行 Agent 执行器，只依赖 Kernel 定义并由组合方注入 capability 接口。 */
import {
  AgentBusyError,
  AgentClosedError,
  type AgentExecutionEvent,
  type AgentIdGenerator,
  type AgentObserver,
  type AgentOptions,
  type AgentPhase,
  type AgentRunOptions,
  type AssistantMessage,
  assertNever,
  type Clock,
  type ExecutionId,
  type ExecutionMetadata,
  isAbortError,
  type ModelProvider,
  type ModelStreamEvent,
  type PromptAssembler,
  type SessionEvent,
  type SessionLog,
  SettlementPersistenceError,
  type SettlementSignalFactory,
  type ToolCapability,
  type ToolResult,
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
  readonly #tools: ToolCapability;
  readonly #ids: AgentIdGenerator;
  readonly #maxSteps: number;
  readonly #settlementSignals: SettlementSignalFactory;
  readonly #clock: Clock | undefined;
  readonly #prompts: PromptAssembler;
  readonly #runTimeoutMs: number | undefined;
  readonly #modelAttemptTimeoutMs: number;
  readonly #toolTimeoutMs: number;
  readonly #maxModelOutputBytes: number | undefined;
  readonly #maxToolResultBytes: number;
  readonly #maxQueuedRuns: number;
  readonly #observers: readonly AgentObserver[];
  readonly #reservations: AgentIdReservations; // 标识符预留池，保证同一个 Agent 里，turn / step / attempt / message / toolCall 的 ID 不重复
  readonly #inbox = new AgentInbox();
  #phase: AgentPhase = { kind: 'idle' };
  #controller: AbortController | undefined;
  #accepting = true;
  #draining: Promise<void> | undefined; // 正在 draining 的 promise，用于保证只有一个 drain 在执行

  constructor(options: AgentOptions) {
    // 参数校验
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1) {
      throw new Error('maxSteps must be a positive integer');
    }
    for (const [name, value] of [
      ['runTimeoutMs', options.runTimeoutMs],
      ['modelAttemptTimeoutMs', options.modelAttemptTimeoutMs],
      ['toolTimeoutMs', options.toolTimeoutMs],
      ['maxModelOutputBytes', options.maxModelOutputBytes],
      ['maxToolResultBytes', options.maxToolResultBytes],
      ['maxQueuedRuns', options.maxQueuedRuns],
    ] as const) {
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
        throw new TypeError(`${name} 必须是正整数`);
      }
    }

    // 赋值参数
    this.#model = options.model;
    this.#session = options.session;
    this.#tools = options.tools;
    this.#ids = options.ids;
    this.#maxSteps = options.maxSteps;
    this.#settlementSignals = options.settlementSignals;
    this.#clock = options.clock;
    this.#prompts = options.prompts;
    this.#runTimeoutMs = options.runTimeoutMs;
    this.#modelAttemptTimeoutMs = options.modelAttemptTimeoutMs ?? DEFAULT_MODEL_ATTEMPT_TIMEOUT_MS;
    this.#toolTimeoutMs = options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    this.#maxModelOutputBytes = options.maxModelOutputBytes;
    this.#maxToolResultBytes = options.maxToolResultBytes ?? DEFAULT_MAX_TOOL_RESULT_BYTES;
    this.#maxQueuedRuns = options.maxQueuedRuns ?? DEFAULT_MAX_QUEUED_RUNS;
    this.#observers = options.observers ?? [];
    this.#reservations = new AgentIdReservations(options.reservedIds);
  }

  get phase(): AgentPhase {
    return this.#phase;
  }

  /** 取消当前活动 run；不影响是否继续接纳新的 run。 */
  cancel(reason: unknown = new Error('agent run cancelled')): void {
    this.#controller?.abort(reason);
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
      const draining = this.#draining;
      if (draining === undefined) {
        return;
      }
      await draining;
      if (this.#draining === undefined) {
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

    return new Promise<AssistantMessage>((resolve, reject) => {
      const externalSignal = isAbortSignal(options)
        ? options
        : (options.signal ?? new AbortController().signal);
      let queued: QueuedRun;
      const onAbort = (): void => {
        if (!this.#inbox.remove(queued)) {
          return;
        }
        queued.clearAbortListener();
        reject(externalSignal.reason);
      };
      queued = {
        message,
        options,
        resolve,
        reject,
        clearAbortListener: () => externalSignal.removeEventListener('abort', onAbort),
      };
      if (externalSignal.aborted) {
        reject(externalSignal.reason);
        return;
      }
      if (this.#inbox.size >= this.#maxQueuedRuns) {
        reject(new AgentBusyError(`Agent 输入队列已达到上限 ${this.#maxQueuedRuns}`));
        return;
      }
      externalSignal.addEventListener('abort', onAbort, { once: true });
      this.#inbox.enqueue(queued);
      this.#ensureInboxDraining();
    });
  }

  /** 确保只有一个 FIFO drain；单个输入失败不会阻断后续输入。 */
  #ensureInboxDraining(): void {
    if (this.#draining !== undefined) {
      return;
    }
    this.#draining = this.#drainInbox().finally(() => {
      this.#draining = undefined;
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
        queued.resolve(await this.#runTurn(queued.message, queued.options));
      } catch (error) {
        queued.reject(error);
      }
    }
  }

  /** 执行已从 inbox 领取的一条输入。 */
  async #runTurn(
    message: UserMessage,
    options: AbortSignal | AgentRunOptions,
  ): Promise<AssistantMessage> {
    const externalSignal = isAbortSignal(options)
      ? options
      : (options.signal ?? new AbortController().signal);
    const execution = freezeExecutionMetadata(
      isAbortSignal(options) ? undefined : options.execution,
    );
    const turn: ActiveTurn = {
      turnId: this.#reservations.turn(this.#ids.turn()),
      started: false,
      ended: false,
    };
    const controller = new AbortController();
    this.#controller = controller;
    const timeoutSignal =
      this.#runTimeoutMs === undefined ? undefined : AbortSignal.timeout(this.#runTimeoutMs);
    const signal = AbortSignal.any([
      externalSignal,
      controller.signal,
      ...(timeoutSignal === undefined ? [] : [timeoutSignal]),
    ]);
    this.#phase = { kind: 'running', turnId: turn.turnId };

    try {
      // 提交 turn 开始事件
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

      // 提交用户消息事件
      this.#reservations.message(message.id);
      await this.#append([{ type: 'user.message', message }], signal);

      // 循环执行 step，直至无工具调用或触及步数上限
      for (let stepNumber = 1; stepNumber <= this.#maxSteps; stepNumber += 1) {
        throwIfAborted(signal);

        // 创建 step 生命周期
        const stepId = this.#reservations.step(this.#ids.step());
        const step = createStep(stepId);
        turn.activeStep = step;
        this.#phase = { kind: 'running', turnId: turn.turnId, stepId };

        // 执行一步 step，获取返回的 assistant 消息
        const messageFromStep = await this.#runStep(turn.turnId, step, signal, execution);

        // 如果 step 没有工具调用，则提交 turn 结束事件
        if (messageFromStep.toolCalls.length === 0) {
          await this.#append(
            [{ type: 'turn.ended', turnId: turn.turnId, outcome: 'completed' }],
            signal,
          );
          turn.ended = true;
          return messageFromStep;
        }

        // 如果 step 数量达到上限，则抛出错误
        if (stepNumber === this.#maxSteps) {
          throw new Error(`agent exceeded maxSteps (${this.#maxSteps})`);
        }
      }

      throw new Error('agent loop ended without a final assistant message');
    } catch (error) {
      // 构建 terminal settlement 事件
      const outcome = signal.aborted || isAbortError(error) ? 'cancelled' : 'failed';
      const terminalEvents = buildTerminalEvents({
        error,
        outcome,
        turn,
      });

      // 如果 terminal settlement 事件不为空，则提交结算事件
      if (terminalEvents.length > 0) {
        try {
          const settlementSignal = this.#settlementSignals.create();
          await this.#append(terminalEvents, settlementSignal);
        } catch (persistenceError) {
          throw new SettlementPersistenceError(error, persistenceError, outcome);
        }
      }
      throw error;
    } finally {
      this.#controller = undefined;
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
    const executionEvent = this.#executionEvent(execution);
    // 提交 step 开始事件
    const stepId = step.stepId;
    await this.#append([{ type: 'step.started', turnId, stepId }], signal);
    step.started = true;
    throwIfAborted(signal);

    // 组装请求
    const request = await waitForSignal(
      this.#prompts.assemble(await this.#session.read({ signal }), this.#tools.list(), signal),
      signal,
    );

    // 准备模型；准备失败尚未形成 attempt，保持其不会消耗 attempt 标识符的恢复语义。
    const modelSignal = this.#deadlineSignal(signal, this.#modelAttemptTimeoutMs);
    const prepared = await this.#model.prepare(modelSignal);
    throwIfAborted(modelSignal);
    const attempt: Attempt = {
      attemptId: this.#reservations.attempt(this.#ids.attempt()),
      partialText: '',
      observedToolCalls: [],
      settlementPersisted: false,
      toolResults: new Map(),
      persistedToolResults: new Set(),
    };
    step.attempt = attempt;
    let outputBytes = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let usageSequence = 0;
    const modelStartedAt = this.#now();
    if (modelStartedAt !== undefined) {
      this.#notifyExecution({
        type: 'model.started',
        sessionId: this.#session.sessionId,
        turnId,
        stepId,
        attemptId: attempt.attemptId,
        ...executionEvent,
        startedAt: modelStartedAt,
      });
    }

    try {
      // 循环获取模型流式生成时的中间输出
      for await (const event of prepared.stream(request, modelSignal)) {
        throwIfAborted(modelSignal);
        this.#notifyStream(event);
        switch (event.type) {
          // 文本增量
          case 'text.delta':
            outputBytes += utf8ByteLength(event.text);
            this.#assertOutputBudget(outputBytes);
            attempt.partialText += event.text;
            break;

          // 工具调用
          case 'tool.call':
            outputBytes += utf8ByteLength(JSON.stringify(event.call));
            this.#assertOutputBudget(outputBytes);
            this.#reservations.toolCall(event.call.id);
            attempt.observedToolCalls.push(event.call);
            break;

          // 使用量
          case 'usage':
            assertCumulativeUsage(event.inputTokens, event.outputTokens, inputTokens, outputTokens);
            usageSequence += 1;
            this.#notifyExecution({
              type: 'model.usage',
              sessionId: this.#session.sessionId,
              turnId,
              stepId,
              attemptId: attempt.attemptId,
              ...executionEvent,
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
      if (modelStartedAt !== undefined) {
        this.#notifyExecution({
          type: 'model.completed',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          ...executionEvent,
          ...this.#withDuration(modelStartedAt),
        });
      }
    } catch (error) {
      if (modelStartedAt !== undefined) {
        this.#notifyExecution({
          type: modelSignal.aborted || isAbortError(error) ? 'model.cancelled' : 'model.failed',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          ...executionEvent,
          ...this.#withDuration(modelStartedAt),
          ...(error instanceof Error ? { errorName: error.name } : {}),
        });
      }
      throw error;
    }
    throwIfAborted(signal);

    // 构建 assistant 消息
    const assistantMessage: AssistantMessage = {
      id: this.#reservations.message(this.#ids.message()),
      role: 'assistant',
      content: attempt.partialText,
      toolCalls: attempt.observedToolCalls,
    };

    // 构建结算结果
    attempt.settlement = {
      status: 'completed',
      attemptId: attempt.attemptId,
      message: assistantMessage,
    };

    // 提交结算事件
    await this.#append(
      [
        {
          type: 'assistant.settled',
          turnId,
          stepId,
          settlement: attempt.settlement,
        },
      ],
      signal,
    );
    attempt.settlementPersisted = true;

    // 执行工具调用
    for (const call of attempt.observedToolCalls) {
      const toolSignal = this.#deadlineSignal(signal, this.#toolTimeoutMs);
      const toolStartedAt = this.#now();
      if (toolStartedAt !== undefined) {
        this.#notifyExecution({
          type: 'tool.started',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          ...executionEvent,
          toolCallId: call.id,
          toolName: call.name,
          startedAt: toolStartedAt,
        });
      }
      let result: ToolResult;
      try {
        result = await this.#tools.execute(call, {
          signal: toolSignal,
          ...(execution === undefined ? {} : { execution }),
        });
      } catch (error) {
        if (toolSignal.aborted && !signal.aborted) {
          result = {
            status: 'cancelled',
            callId: call.id,
            reason: `工具调用超过 toolTimeoutMs (${this.#toolTimeoutMs})`,
          };
        } else {
          if (toolStartedAt !== undefined) {
            this.#notifyExecution({
              type: toolSignal.aborted || isAbortError(error) ? 'tool.cancelled' : 'tool.failed',
              sessionId: this.#session.sessionId,
              turnId,
              stepId,
              attemptId: attempt.attemptId,
              ...executionEvent,
              toolCallId: call.id,
              toolName: call.name,
              ...this.#withDuration(toolStartedAt),
              ...(error instanceof Error ? { errorName: error.name } : {}),
            });
          }
          throw error;
        }
      }
      result = this.#boundToolResult(result);
      attempt.toolResults.set(call.id, result);
      if (toolStartedAt !== undefined) {
        this.#notifyExecution({
          type: 'tool.completed',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          ...executionEvent,
          toolCallId: call.id,
          toolName: call.name,
          ...this.#withDuration(toolStartedAt),
          status: result.status,
        });
      }
      // 提交工具调用完成事件
      await this.#append([{ type: 'tool.completed', turnId, stepId, result }], signal);
      attempt.persistedToolResults.add(call.id);
    }

    // 提交 step 结束事件
    await this.#append([{ type: 'step.ended', turnId, stepId, outcome: 'completed' }], signal);
    step.ended = true;
    return assistantMessage;
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

  #executionEvent(execution: ExecutionMetadata | undefined): {
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
      this.#notifyExecution({ type: 'session.event', envelope });
    }
  }

  /** 向 observer 派发LLM流事件（模型生成时的中间输出）；用于在 Agent 外部展示模型生成过程，不做持久化。 */
  #notifyStream(event: ModelStreamEvent): void {
    for (const observer of this.#observers) {
      try {
        void Promise.resolve(observer.onStream?.(event)).catch(() => undefined);
      } catch {
        // 观察者只接收瞬态通知，其失败不能改变 Agent 生命周期。
      }
    }
  }

  /** 向 observer 派发结构化执行事件（模型生成时的使用量、工具调用结果等），与持久化的会话日志一致。 */
  #notifyExecution(event: AgentExecutionEvent): void {
    for (const observer of this.#observers) {
      try {
        void Promise.resolve(observer.onExecution?.(event)).catch(() => undefined);
      } catch {
        // 观察者只接收执行通知，其失败不能改变 Agent 生命周期。
      }
    }
  }
}

/** 计算模型事件文本的 UTF-8 字节数，供单次输出预算使用。 */
function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}
