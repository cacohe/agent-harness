import {
  assertNever,
  isAbortError,
  serializeError,
  type AssistantSettlement,
  type AssistantMessage,
  type AttemptId,
  type MessageId,
  type SessionEvent,
  type StepId,
  type ToolCall,
  type ToolCallId,
  type ToolResult,
  type TurnId,
  type TurnOutcome,
  type UserMessage,
} from '@agent-harness/domain'
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
} from '@agent-harness/model'
import { deriveModelMessages, type SessionLog } from '@agent-harness/session'
import type { ToolCapability } from '@agent-harness/tools'

export type AgentPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running'
      readonly turnId: TurnId
      readonly stepId?: StepId
    }

export interface AgentIdGenerator {
  turn(): TurnId
  step(): StepId
  attempt(): AttemptId
  message(): MessageId
}

export interface AgentObserver {
  onStream?(event: ModelStreamEvent): void | Promise<void>
}

/** 为当前 run 的结算链创建新信号；Agent 对一条链只调用一次。 */
export interface SettlementSignalFactory {
  create(): AbortSignal
}

export interface AgentOptions {
  readonly model: ModelProvider
  readonly session: SessionLog
  readonly tools: ToolCapability
  readonly ids: AgentIdGenerator
  readonly maxSteps: number
  readonly settlementSignals: SettlementSignalFactory
  readonly observers?: readonly AgentObserver[]
  /** 初始化恢复历史已经占用的各类 ID；Agent 会继续保留实时 reservation。 */
  readonly reservedIds?: AgentIdReservationSeed
}

/** 表示 Agent 已停止接纳新的 run。 */
export class AgentClosedError extends Error {
  override readonly name = 'AgentClosedError'
}

/** 初始化 Agent 实例内统一标识符 reservation 的不可变快照。 */
export interface AgentIdReservationSeed {
  readonly turnIds: readonly TurnId[]
  readonly stepIds: readonly StepId[]
  readonly attemptIds: readonly AttemptId[]
  readonly messageIds: readonly MessageId[]
  readonly toolCallIds: readonly ToolCallId[]
}

/** 表示实时路径准备持久化的 ID 已在历史或当前 Agent 中占用。 */
export class AgentIdCollisionError extends Error {
  override readonly name = 'AgentIdCollisionError'
  readonly kind: 'turn' | 'step' | 'attempt' | 'message' | 'toolCall'
  readonly value: string

  constructor(
    kind: 'turn' | 'step' | 'attempt' | 'message' | 'toolCall',
    value: string,
  ) {
    super(`${kind} 标识符与会话历史或当前 Agent 已保留的值冲突：${value}`)
    this.kind = kind
    this.value = value
  }
}

/** 同时保留原始运行结果和 terminal settlement 持久化失败。 */
export class SettlementPersistenceError extends Error {
  readonly originalError: unknown
  readonly persistenceError: unknown
  readonly outcome: RuntimeFailureOutcome

  constructor(
    originalError: unknown,
    persistenceError: unknown,
    outcome: RuntimeFailureOutcome,
  ) {
    super(`failed to persist ${outcome} terminal settlement`, {
      cause: persistenceError,
    })
    this.name = 'SettlementPersistenceError'
    this.originalError = originalError
    this.persistenceError = persistenceError
    this.outcome = outcome
  }
}

/** 保持尚未纳入 turn 的用户输入，并确保每条输入至多领取一次。 */
export class AgentInbox {
  readonly #messages: UserMessage[] = []

  enqueue(message: UserMessage): void {
    this.#messages.push(message)
  }

  claim(): UserMessage | undefined {
    return this.#messages.shift()
  }

  get size(): number {
    return this.#messages.length
  }
}

/** 只依赖 capability 接口的可重放 Agent 内核。 */
export class Agent {
  readonly #model: ModelProvider
  readonly #session: SessionLog
  readonly #tools: ToolCapability
  readonly #ids: AgentIdGenerator
  readonly #maxSteps: number
  readonly #settlementSignals: SettlementSignalFactory
  readonly #observers: readonly AgentObserver[]
  readonly #reservations: AgentIdReservations
  readonly #inbox = new AgentInbox()
  #phase: AgentPhase = { kind: 'idle' }
  #controller: AbortController | undefined
  #accepting = true
  #idle: Promise<void> = Promise.resolve()
  #resolveIdle: (() => void) | undefined

  constructor(options: AgentOptions) {
    if (!Number.isInteger(options.maxSteps) || options.maxSteps < 1) {
      throw new Error('maxSteps must be a positive integer')
    }
    this.#model = options.model
    this.#session = options.session
    this.#tools = options.tools
    this.#ids = options.ids
    this.#maxSteps = options.maxSteps
    this.#settlementSignals = options.settlementSignals
    this.#observers = options.observers ?? []
    this.#reservations = new AgentIdReservations(options.reservedIds)
  }

  get phase(): AgentPhase {
    return this.#phase
  }

  get inbox(): AgentInbox {
    return this.#inbox
  }

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

  async run(
    message: UserMessage,
    externalSignal: AbortSignal = new AbortController().signal,
  ): Promise<AssistantMessage> {
    if (!this.#accepting) throw new AgentClosedError('Agent 已停止接纳新的 run')
    if (this.#phase.kind !== 'idle') throw new Error('agent is already running')

    const turnId = this.#reservations.turn(this.#ids.turn())
    this.#idle = new Promise<void>(resolve => {
      this.#resolveIdle = resolve
    })

    this.#inbox.enqueue(message)
    const admitted = this.#inbox.claim()
    if (admitted === undefined) throw new Error('agent inbox unexpectedly empty')

    const controller = new AbortController()
    this.#controller = controller
    const signal = AbortSignal.any([externalSignal, controller.signal])
    this.#phase = { kind: 'running', turnId }
    let turnStarted = false
    let turnEnded = false
    let activeStep: StepLifecycle | undefined

    try {
      await this.#session.append([{ type: 'turn.started', turnId }], { signal })
      turnStarted = true
      this.#reservations.message(admitted.id)
      await this.#session.append(
        [{ type: 'user.message', message: admitted }],
        { signal },
      )

      for (let stepNumber = 1; stepNumber <= this.#maxSteps; stepNumber += 1) {
        throwIfAborted(signal)
        const stepId = this.#reservations.step(this.#ids.step())
        activeStep = createStepLifecycle(stepId)
        this.#phase = { kind: 'running', turnId, stepId }
        const messageFromStep = await this.#runStep(turnId, activeStep, signal)

        if (messageFromStep.toolCalls.length === 0) {
          await this.#session.append([
            { type: 'turn.ended', turnId, outcome: 'completed' },
          ], { signal })
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
          await this.#session.append(terminalEvents, { signal: settlementSignal })
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

  async #runStep(
    turnId: TurnId,
    lifecycle: StepLifecycle,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    const stepId = lifecycle.stepId
    await this.#session.append([{ type: 'step.started', turnId, stepId }], {
      signal,
    })
    lifecycle.started = true
    throwIfAborted(signal)

    const request: ModelRequest = {
      messages: deriveModelMessages(await this.#session.read({ signal })),
      tools: this.#tools.list(),
    }
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

    for await (const event of prepared.stream(request, signal)) {
      throwIfAborted(signal)
      this.#notifyStream(event)
      switch (event.type) {
        case 'text.delta':
          attempt.partialText += event.text
          break
        case 'tool.call':
          this.#reservations.toolCall(event.call.id)
          attempt.observedToolCalls.push(event.call)
          break
        case 'usage':
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
    await this.#session.append([
      {
        type: 'assistant.settled',
        turnId,
        stepId,
        settlement: attempt.settlement,
      },
    ], { signal })
    attempt.settlementPersisted = true

    for (const call of attempt.observedToolCalls) {
      const result = await this.#tools.execute(call, signal)
      attempt.toolResults.set(call.id, result)
      await this.#session.append([
        { type: 'tool.completed', turnId, stepId, result },
      ], { signal })
      attempt.persistedToolResults.add(call.id)
    }

    await this.#session.append([
      { type: 'step.ended', turnId, stepId, outcome: 'completed' },
    ], { signal })
    lifecycle.ended = true
    return assistantMessage
  }

  #notifyStream(event: ModelStreamEvent): void {
    for (const observer of this.#observers) {
      try {
        void Promise.resolve(observer.onStream?.(event)).catch(() => undefined)
      } catch {
        // 观察者只接收瞬态通知，其失败不能改变 Agent 生命周期。
      }
    }
  }
}

interface AttemptLifecycle {
  readonly attemptId: AttemptId
  partialText: string
  readonly observedToolCalls: ToolCall[]
  settlement?: AssistantSettlement
  settlementPersisted: boolean
  readonly toolResults: Map<ToolCallId, ToolResult>
  readonly persistedToolResults: Set<ToolCallId>
}

interface StepLifecycle {
  readonly stepId: StepId
  started: boolean
  ended: boolean
  attempt?: AttemptLifecycle
}

function createStepLifecycle(stepId: StepId): StepLifecycle {
  return { stepId, started: false, ended: false }
}

function buildTerminalEvents(options: {
  readonly error: unknown
  readonly outcome: RuntimeFailureOutcome
  readonly turnId: TurnId
  readonly turnStarted: boolean
  readonly turnEnded: boolean
  readonly step: StepLifecycle | undefined
}): SessionEvent[] {
  const events: SessionEvent[] = []
  const { error, outcome, turnId, step } = options

  if (step?.started === true && !step.ended) {
    const attempt = step.attempt
    if (attempt !== undefined) {
      const settlement = attempt.settlement ?? failedAttemptSettlement(
        attempt,
        outcome,
        error,
      )
      if (!attempt.settlementPersisted) {
        events.push({
          type: 'assistant.settled',
          turnId,
          stepId: step.stepId,
          settlement,
        })
      }
      if (settlement.status === 'completed') {
        for (const call of settlement.message.toolCalls) {
          if (attempt.persistedToolResults.has(call.id)) continue
          events.push({
            type: 'tool.completed',
            turnId,
            stepId: step.stepId,
            result: attempt.toolResults.get(call.id)
              ?? unexecutedToolResult(call, outcome, error),
          })
        }
      }
    }
    events.push({
      type: 'step.ended',
      turnId,
      stepId: step.stepId,
      outcome,
    })
  }

  if (options.turnStarted && !options.turnEnded) {
    events.push({
      type: 'turn.ended',
      turnId,
      outcome,
      error: serializeError(error),
    })
  }
  return events
}

function failedAttemptSettlement(
  attempt: AttemptLifecycle,
  outcome: RuntimeFailureOutcome,
  error: unknown,
): AssistantSettlement {
  if (outcome === 'cancelled') {
    return {
      status: 'interrupted',
      attemptId: attempt.attemptId,
      partialText: attempt.partialText,
      observedToolCalls: attempt.observedToolCalls,
      reason: errorMessage(error),
    }
  }
  return {
    status: 'failed',
    attemptId: attempt.attemptId,
    partialText: attempt.partialText,
    observedToolCalls: attempt.observedToolCalls,
    error: serializeError(error),
  }
}

function unexecutedToolResult(
  call: ToolCall,
  outcome: RuntimeFailureOutcome,
  error: unknown,
): ToolResult {
  if (outcome === 'cancelled') {
    return { status: 'cancelled', callId: call.id, reason: errorMessage(error) }
  }
  return {
    status: 'failure',
    callId: call.id,
    error: {
      name: 'ToolNotExecutedError',
      message: `tool was not executed because the step failed: ${errorMessage(error)}`,
    },
  }
}

type RuntimeFailureOutcome = Extract<TurnOutcome, 'failed' | 'cancelled'>

class AgentIdReservations {
  readonly #turnIds: Set<string>
  readonly #stepIds: Set<string>
  readonly #attemptIds: Set<string>
  readonly #messageIds: Set<string>
  readonly #toolCallIds: Set<string>

  constructor(seed: AgentIdReservationSeed | undefined) {
    this.#turnIds = new Set(seed?.turnIds)
    this.#stepIds = new Set(seed?.stepIds)
    this.#attemptIds = new Set(seed?.attemptIds)
    this.#messageIds = new Set(seed?.messageIds)
    this.#toolCallIds = new Set(seed?.toolCallIds)
  }

  turn(value: TurnId): TurnId {
    return this.#reserve('turn', this.#turnIds, value)
  }

  step(value: StepId): StepId {
    return this.#reserve('step', this.#stepIds, value)
  }

  attempt(value: AttemptId): AttemptId {
    return this.#reserve('attempt', this.#attemptIds, value)
  }

  message(value: MessageId): MessageId {
    return this.#reserve('message', this.#messageIds, value)
  }

  toolCall(value: ToolCallId): ToolCallId {
    return this.#reserve('toolCall', this.#toolCallIds, value)
  }

  #reserve<T extends string>(
    kind: 'turn' | 'step' | 'attempt' | 'message' | 'toolCall',
    values: Set<string>,
    value: T,
  ): T {
    if (values.has(value)) throw new AgentIdCollisionError(kind, value)
    values.add(value)
    return value
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError(signal)
}

function cancellationError(signal: AbortSignal): Error {
  const reason = signal.reason
  const message = reason instanceof Error
    ? reason.message
    : String(reason ?? 'cancelled')
  const error = new Error(message, { cause: reason })
  error.name = 'AbortError'
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
