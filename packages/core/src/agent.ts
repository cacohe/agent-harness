/** 会话级串行 Agent 执行器，只依赖 Kernel 定义并由组合方注入 capability 接口。 */
import {
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
  readonly #maxModelOutputBytes: number | undefined;
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
    if (
      options.runTimeoutMs !== undefined &&
      (!Number.isSafeInteger(options.runTimeoutMs) || options.runTimeoutMs < 1)
    ) {
      throw new TypeError('runTimeoutMs 必须是正整数');
    }
    if (
      options.maxModelOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxModelOutputBytes) || options.maxModelOutputBytes < 1)
    ) {
      throw new TypeError('maxModelOutputBytes 必须是正整数');
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
    this.#maxModelOutputBytes = options.maxModelOutputBytes;
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
      if (draining === undefined) return;
      await draining;
      if (this.#draining === undefined) return;
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
    if (!this.#accepting) return Promise.reject(new AgentClosedError('Agent 已停止接纳新的 run'));

    return new Promise<AssistantMessage>((resolve, reject) => {
      const externalSignal = isAbortSignal(options)
        ? options
        : (options.signal ?? new AbortController().signal);
      let queued: QueuedRun;
      const onAbort = (): void => {
        if (!this.#inbox.remove(queued)) return;
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
      externalSignal.addEventListener('abort', onAbort, { once: true });
      this.#inbox.enqueue(queued);
      this.#ensureInboxDraining();
    });
  }

  /** 确保只有一个 FIFO drain；单个输入失败不会阻断后续输入。 */
  #ensureInboxDraining(): void {
    if (this.#draining !== undefined) return;
    this.#draining = this.#drainInbox().finally(() => {
      this.#draining = undefined;
      if (this.#inbox.hasPending) this.#ensureInboxDraining();
    });
  }

  /** 串行领取已接纳输入，并仅结算各自调用，不让单项失败中断后续领取。 */
  async #drainInbox(): Promise<void> {
    for (;;) {
      const queued = this.#inbox.claim();
      if (queued === undefined) return;
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
    if (modelStartedAt !== undefined)
      this.#notifyExecution({
        type: 'model.started',
        sessionId: this.#session.sessionId,
        turnId,
        stepId,
        attemptId: attempt.attemptId,
        startedAt: modelStartedAt,
      });

    try {
      const prepared = await this.#model.prepare(signal);
      throwIfAborted(signal);
      // 循环获取模型流式生成时的中间输出
      for await (const event of prepared.stream(request, signal)) {
        throwIfAborted(signal);
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
      if (modelStartedAt !== undefined)
        this.#notifyExecution({
          type: 'model.completed',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          durationMs: this.#durationSince(modelStartedAt),
        });
    } catch (error) {
      if (modelStartedAt !== undefined)
        this.#notifyExecution({
          type: 'model.failed',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          durationMs: this.#durationSince(modelStartedAt),
          ...(error instanceof Error ? { errorName: error.name } : {}),
        });
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
      const toolStartedAt = this.#now();
      if (toolStartedAt !== undefined)
        this.#notifyExecution({
          type: 'tool.started',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          toolCallId: call.id,
          toolName: call.name,
          startedAt: toolStartedAt,
        });
      const result = await this.#tools.execute(call, {
        signal,
        ...(execution === undefined ? {} : { execution }),
      });
      attempt.toolResults.set(call.id, result);
      if (toolStartedAt !== undefined)
        this.#notifyExecution({
          type: 'tool.completed',
          sessionId: this.#session.sessionId,
          turnId,
          stepId,
          attemptId: attempt.attemptId,
          toolCallId: call.id,
          toolName: call.name,
          durationMs: this.#durationSince(toolStartedAt),
          status: result.status,
        });
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

  #now(): Date | undefined {
    if (this.#clock === undefined) return undefined;
    const value = this.#clock.now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw new TypeError('Clock.now 必须返回有效 Date');
    }
    return value;
  }

  #durationSince(startedAt: Date): number {
    const finishedAt = this.#now();
    if (finishedAt === undefined) throw new Error('执行观测时钟不可用');
    return Math.max(0, finishedAt.getTime() - startedAt.getTime());
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
