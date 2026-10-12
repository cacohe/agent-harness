/** Agent 核心循环状态机，只依赖 Kernel 定义并由组合方注入的 capability 接口。 */
import {
  assertNever,
  isAbortError,
  type AssistantMessage,
  type SessionEvent,
  type TurnId,
  type UserMessage,
  type ExecutionMetadata,
  AgentClosedError,
  SettlementPersistenceError,
  type AgentExecutionEvent,
  type AgentIdGenerator,
  type AgentObserver,
  type AgentOptions,
  type AgentPhase,
  type AgentRunOptions,
  type ModelProvider,
  type ModelStreamEvent,
  type PromptAssembler,
  type SessionLog,
  type SettlementSignalFactory,
  type ToolCapability,
} from '@agent-harness/kernel'
import { AgentIdReservations } from './agent-id-reservations.js'
import {
  assertCumulativeUsage,
  executeWithContext,
  freezeExecutionMetadata,
  isAbortSignal,
  throwIfAborted,
  utf8ByteLength,
  waitForSignal,
} from './execution-support.js'
import {
  buildTerminalEvents,
  createStepLifecycle,
  type AttemptLifecycle,
  type StepLifecycle,
} from './lifecycle.js'

/** 保持尚未纳入 turn 的用户输入，并确保每条输入至多领取一次。 */
class AgentInbox {
  readonly #messages: UserMessage[] = []

  /** 将用户消息加入队列。 */
  enqueue(message: UserMessage): void {
    this.#messages.push(message)
  }

  /** 从队列中领取一条用户消息。 */
  claim(): UserMessage | undefined {
    return this.#messages.shift()
  }

  /** 队列中的用户消息数量。 */
  get size(): number {
    return this.#messages.length
  }
}

/**
 * 只依赖 Kernel capability 接口的可重放 Agent 核心循环。
 * 同一时刻至多一个活动 turn；已打开的 turn/step 在成功、失败与取消路径上恰好结算一次。
 */
export class Agent {
  readonly #model: ModelProvider
  readonly #session: SessionLog
  readonly #tools: ToolCapability
  readonly #ids: AgentIdGenerator
  readonly #maxSteps: number
  readonly #settlementSignals: SettlementSignalFactory
  readonly #prompts: PromptAssembler
  readonly #runTimeoutMs: number | undefined
  readonly #maxModelOutputBytes: number | undefined
  readonly #observers: readonly AgentObserver[]
  readonly #reservations: AgentIdReservations  // 标识符预留池，保证同一个 Agent 里，turn / step / attempt / message / toolCall 的 ID 不重复
  readonly #inbox = new AgentInbox()
  #phase: AgentPhase = { kind: 'idle' }
  #controller: AbortController | undefined
  #accepting = true
  #idle: Promise<void> = Promise.resolve()  // 表示刚构造出来的 Agent 已经空闲
  #resolveIdle: (() => void) | undefined

  constructor(options: AgentOptions) {
    // 参数校验
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1) {
      throw new Error('maxSteps must be a positive integer')
    }
    if (options.runTimeoutMs !== undefined && (!Number.isSafeInteger(options.runTimeoutMs) || options.runTimeoutMs < 1)) {
      throw new TypeError('runTimeoutMs 必须是正整数')
    }
    if (options.maxModelOutputBytes !== undefined && (!Number.isSafeInteger(options.maxModelOutputBytes) || options.maxModelOutputBytes < 1)) {
      throw new TypeError('maxModelOutputBytes 必须是正整数')
    }

    // 赋值参数
    this.#model = options.model
    this.#session = options.session
    this.#tools = options.tools
    this.#ids = options.ids
    this.#maxSteps = options.maxSteps
    this.#settlementSignals = options.settlementSignals
    this.#prompts = options.prompts
    this.#runTimeoutMs = options.runTimeoutMs
    this.#maxModelOutputBytes = options.maxModelOutputBytes
    this.#observers = options.observers ?? []
    this.#reservations = new AgentIdReservations(options.reservedIds)
  }

  get phase(): AgentPhase {
    return this.#phase
  }

  /** 取消当前活动 run；不影响是否继续接纳新的 run。 */
  cancel(reason: unknown = new Error('agent run cancelled')): void {
    this.#controller?.abort(reason)
  }

  /** 永久停止接纳新 run，并取消当前活动。重复调用安全。 */
  stop(reason: unknown = new Error('agent stopped')): void {
    this.#accepting = false
    this.cancel(reason)
  }

  /** 等待当前活动彻底离开 Agent 状态机。 */
  whenIdle(): Promise<void> {
    return this.#idle
  }

  /**
   * 执行一次 turn：写入用户消息，循环 step，直至无工具调用或触及步数上限。
   * 失败或取消时用独立结算信号补写尚未闭合的 turn/step 事件，再重新抛出原错误。
   */
  async run(
    message: UserMessage,
    options: AbortSignal | AgentRunOptions = {},
  ): Promise<AssistantMessage> {
    if (!this.#accepting) throw new AgentClosedError('Agent 已停止接纳新的 run')
    if (this.#phase.kind !== 'idle') throw new Error('agent is already running')

    const externalSignal = isAbortSignal(options)
      ? options
      : options.signal ?? new AbortController().signal
    const execution = freezeExecutionMetadata(
      isAbortSignal(options) ? undefined : options.execution,
    )
    const turnId = this.#reservations.turn(this.#ids.turn())
    this.#idle = new Promise<void>(resolve => {
      this.#resolveIdle = resolve
    })

    this.#inbox.enqueue(message)
    const admitted = this.#inbox.claim()
    if (admitted === undefined) throw new Error('agent inbox unexpectedly empty')

    const controller = new AbortController()
    this.#controller = controller
    const timeoutSignal = this.#runTimeoutMs === undefined ? undefined : AbortSignal.timeout(this.#runTimeoutMs)
    const signal = AbortSignal.any([externalSignal, controller.signal, ...(timeoutSignal === undefined ? [] : [timeoutSignal])])
    this.#phase = { kind: 'running', turnId }
    let turnStarted = false
    let turnEnded = false
    let activeStep: StepLifecycle | undefined

    try {
      await this.#append([{
        type: 'turn.started',
        turnId,
        ...(execution === undefined ? {} : { execution }),
      }], signal)
      turnStarted = true
      this.#reservations.message(admitted.id)
      await this.#append([{ type: 'user.message', message: admitted }], signal)

      for (let stepNumber = 1; stepNumber <= this.#maxSteps; stepNumber += 1) {
        throwIfAborted(signal)
        const stepId = this.#reservations.step(this.#ids.step())
        activeStep = createStepLifecycle(stepId)
        this.#phase = { kind: 'running', turnId, stepId }
        const messageFromStep = await this.#runStep(turnId, activeStep, signal, execution)

        if (messageFromStep.toolCalls.length === 0) {
          await this.#append([
            { type: 'turn.ended', turnId, outcome: 'completed' },
          ], signal)
          turnEnded = true
          return messageFromStep
        }

        if (stepNumber === this.#maxSteps) {
          throw new Error(`agent exceeded maxSteps (${this.#maxSteps})`)
        }
      }

      throw new Error('agent loop ended without a final assistant message')
    } catch (error) {
      const outcome = signal.aborted || isAbortError(error)
        ? 'cancelled'
        : 'failed'
      const terminalEvents = buildTerminalEvents({
        error,
        outcome,
        turnId,
        turnStarted,
        turnEnded,
        step: activeStep,
      })

      if (terminalEvents.length > 0) {
        try {
          const settlementSignal = this.#settlementSignals.create()
          await this.#append(terminalEvents, settlementSignal)
        } catch (persistenceError) {
          throw new SettlementPersistenceError(error, persistenceError, outcome)
        }
      }
      throw error
    } finally {
      this.#controller = undefined
      this.#phase = { kind: 'idle' }
      this.#resolveIdle?.()
      this.#resolveIdle = undefined
    }
  }

  /**
   * 执行单个 step：组装请求、流式模型、持久化 assistant 结算、顺序执行工具并闭合 step。
   * 流式 chunk 只通知 observer；持久事实写入会话事件。
   */
  async #runStep(
    turnId: TurnId,
    lifecycle: StepLifecycle,
    signal: AbortSignal,
    execution: ExecutionMetadata | undefined,
  ): Promise<AssistantMessage> {
    const stepId = lifecycle.stepId
    await this.#append([{ type: 'step.started', turnId, stepId }], signal)
    lifecycle.started = true
    throwIfAborted(signal)

    const request = await waitForSignal(
      this.#prompts.assemble(await this.#session.read({ signal }), this.#tools.list(), signal),
      signal,
    )
    const prepared = await this.#model.prepare(signal)
    throwIfAborted(signal)
    const attempt: AttemptLifecycle = {
      attemptId: this.#reservations.attempt(this.#ids.attempt()),
      partialText: '',
      observedToolCalls: [],
      settlementPersisted: false,
      toolResults: new Map(),
      persistedToolResults: new Set(),
    }
    lifecycle.attempt = attempt
    let outputBytes = 0
    let inputTokens = 0
    let outputTokens = 0
    let usageSequence = 0

    for await (const event of prepared.stream(request, signal)) {
      throwIfAborted(signal)
      this.#notifyStream(event)
      switch (event.type) {
        case 'text.delta':
          outputBytes += utf8ByteLength(event.text)
          this.#assertOutputBudget(outputBytes)
          attempt.partialText += event.text
          break
        case 'tool.call':
          outputBytes += utf8ByteLength(JSON.stringify(event.call))
          this.#assertOutputBudget(outputBytes)
          this.#reservations.toolCall(event.call.id)
          attempt.observedToolCalls.push(event.call)
          break
        case 'usage':
          assertCumulativeUsage(event.inputTokens, event.outputTokens, inputTokens, outputTokens)
          usageSequence += 1
          this.#notifyExecution({
            type: 'model.usage',
            sessionId: this.#session.sessionId,
            turnId,
            stepId,
            attemptId: attempt.attemptId,
            usageSequence,
            inputTokensDelta: event.inputTokens - inputTokens,
            outputTokensDelta: event.outputTokens - outputTokens,
          })
          inputTokens = event.inputTokens
          outputTokens = event.outputTokens
          break
        default:
          assertNever(event)
      }
    }
    throwIfAborted(signal)

    const assistantMessage: AssistantMessage = {
      id: this.#reservations.message(this.#ids.message()),
      role: 'assistant',
      content: attempt.partialText,
      toolCalls: attempt.observedToolCalls,
    }
    attempt.settlement = {
      status: 'completed',
      attemptId: attempt.attemptId,
      message: assistantMessage,
    }
    await this.#append([
      {
        type: 'assistant.settled',
        turnId,
        stepId,
        settlement: attempt.settlement,
      },
    ], signal)
    attempt.settlementPersisted = true

    for (const call of attempt.observedToolCalls) {
      const result = await executeWithContext(this.#tools, call, {
        signal,
        ...(execution === undefined ? {} : { execution }),
      })
      attempt.toolResults.set(call.id, result)
      await this.#append([
        { type: 'tool.completed', turnId, stepId, result },
      ], signal)
      attempt.persistedToolResults.add(call.id)
    }

    await this.#append([
      { type: 'step.ended', turnId, stepId, outcome: 'completed' },
    ], signal)
    lifecycle.ended = true
    return assistantMessage
  }

  /** 控制单次 run 的模型输出预算，避免模型无限输出。 */
  #assertOutputBudget(bytes: number): void {
    if (this.#maxModelOutputBytes !== undefined && bytes > this.#maxModelOutputBytes) {
      throw new Error(`模型输出超过 maxModelOutputBytes (${this.#maxModelOutputBytes})`)
    }
  }

  /** 提交会话事件，并向 observer 发送与持久化事实一致的通知。 */
  async #append(events: readonly SessionEvent[], signal: AbortSignal): Promise<void> {
    const appended = await this.#session.append(events, { signal })
    for (const envelope of appended) {
      this.#notifyExecution({ type: 'session.event', envelope })
    }
  }

  /** 向 observer 派发LLM流事件（模型生成时的中间输出）；用于在 Agent 外部展示模型生成过程，不做持久化。 */
  #notifyStream(event: ModelStreamEvent): void {
    for (const observer of this.#observers) {
      try {
        void Promise.resolve(observer.onStream?.(event)).catch(() => undefined)
      } catch {
        // 观察者只接收瞬态通知，其失败不能改变 Agent 生命周期。
      }
    }
  }

  /** 向 observer 派发结构化执行事件（模型生成时的使用量、工具调用结果等），与持久化的会话日志一致。 */
  #notifyExecution(event: AgentExecutionEvent): void {
    for (const observer of this.#observers) {
      try {
        void Promise.resolve(observer.onExecution?.(event)).catch(() => undefined)
      } catch {
        // 观察者只接收执行通知，其失败不能改变 Agent 生命周期。
      }
    }
  }
}
