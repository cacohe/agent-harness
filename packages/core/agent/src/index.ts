/**
 * Agent 核心循环状态机
 * 只依赖 model / session / tools 的 capability 接口；
 */
import {
  assertNever,
  isAbortError,
  serializeError,
  type AssistantSettlement,
  type AssistantMessage,
  type AttemptId,
  type MessageId,
  type SessionEvent,
  type EventEnvelope,
  type StepId,
  type ToolCall,
  type ToolCallId,
  type ToolResult,
  type TurnId,
  type TurnOutcome,
  type UserMessage,
  type ModelMessage,
} from '@agent-harness/domain'
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelToolDefinition,
} from '@agent-harness/model'
import { deriveModelMessages, type SessionLog } from '@agent-harness/session'
import type { ToolCapability } from '@agent-harness/tools'

/** Agent 对外可见的阶段：空闲，或正在执行某个 turn/step。 */
export type AgentPhase =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'running'
      readonly turnId: TurnId
      readonly stepId?: StepId
    }

/** 为 turn、step、attempt、message 生成新标识符；冲突检查由 Agent 统一 reservation 负责。 */
export interface AgentIdGenerator {
  turn(): TurnId
  step(): StepId
  attempt(): AttemptId
  message(): MessageId
}

/** 接收瞬态模型流事件；失败不得影响 Agent 生命周期。 */
export interface AgentObserver {
  onStream?(event: ModelStreamEvent): void | Promise<void>
}

/** 为当前 run 的结算链创建新信号；Agent 对一条链只调用一次。 */
export interface SettlementSignalFactory {
  create(): AbortSignal
}

/** 将持久会话事实和当前工具表组装为一次模型请求。 */
export interface PromptAssembler {
  assemble(
    events: readonly EventEnvelope[],
    tools: readonly ModelToolDefinition[],
  ): ModelRequest
}

/** 默认上下文策略：保留完整的最近用户 turn，并限制模型输入字节数。 */
export class BoundedPromptAssembler implements PromptAssembler {
  readonly #systemPrompt: string | undefined
  readonly #maxInputBytes: number

  constructor(options: { readonly maxInputBytes: number, readonly systemPrompt?: string }) {
    if (!Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1) {
      throw new TypeError('maxInputBytes 必须是正整数')
    }
    if (options.systemPrompt !== undefined && options.systemPrompt.length === 0) {
      throw new TypeError('systemPrompt 若提供则必须是非空字符串')
    }
    this.#maxInputBytes = options.maxInputBytes
    this.#systemPrompt = options.systemPrompt
  }

  assemble(events: readonly EventEnvelope[], tools: readonly ModelToolDefinition[]): ModelRequest {
    const history = deriveModelMessages(events)
    const start = this.#findStart(history, tools)
    const messages: readonly ModelMessage[] = this.#systemPrompt === undefined
      ? history.slice(start)
      : [{ role: 'system', content: this.#systemPrompt }, ...history.slice(start)]
    return { messages, tools }
  }

  #findStart(messages: readonly ModelMessage[], tools: readonly ModelToolDefinition[]): number {
    const systemBytes = this.#systemPrompt === undefined ? 0 : Buffer.byteLength(this.#systemPrompt, 'utf8')
    let bytes = systemBytes + Buffer.byteLength(JSON.stringify(tools), 'utf8')
    let start = messages.length
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      bytes += Buffer.byteLength(JSON.stringify(messages[index]), 'utf8')
      if (bytes > this.#maxInputBytes) break
      if (messages[index]?.role === 'user') start = index
    }
    if (start === messages.length && messages.length > 0) {
      throw new Error('最新完整用户 turn 超过 maxInputBytes')
    }
    return start
  }
}

/** 初始化 Agent 实例内统一标识符 reservation 的不可变快照。 */
export interface AgentIdReservationSeed {
  readonly turnIds: readonly TurnId[]
  readonly stepIds: readonly StepId[]
  readonly attemptIds: readonly AttemptId[]
  readonly messageIds: readonly MessageId[]
  readonly toolCallIds: readonly ToolCallId[]
}

/** 构造 Agent 所需的全部显式依赖与运行限制。 */
export interface AgentOptions {
  readonly model: ModelProvider
  readonly session: SessionLog
  readonly tools: ToolCapability
  readonly ids: AgentIdGenerator
  readonly maxSteps: number
  readonly settlementSignals: SettlementSignalFactory
  readonly prompts?: PromptAssembler
  readonly runTimeoutMs?: number
  readonly maxModelOutputBytes?: number
  readonly observers?: readonly AgentObserver[]
  /** 初始化恢复历史已经占用的各类 ID；Agent 会继续保留实时 reservation。 */
  readonly reservedIds?: AgentIdReservationSeed
}

/** 表示 Agent 已停止接纳新的 run。 */
export class AgentClosedError extends Error {
  override readonly name = 'AgentClosedError'
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

type RuntimeFailureOutcome = Extract<TurnOutcome, 'failed' | 'cancelled'>

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
class AgentInbox {
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

/**
 * 只依赖 capability 接口的可重放 Agent 内核。
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
    if (options.runTimeoutMs !== undefined && (!Number.isSafeInteger(options.runTimeoutMs) || options.runTimeoutMs < 1)) {
      throw new TypeError('runTimeoutMs 必须是正整数')
    }
    if (options.maxModelOutputBytes !== undefined && (!Number.isSafeInteger(options.maxModelOutputBytes) || options.maxModelOutputBytes < 1)) {
      throw new TypeError('maxModelOutputBytes 必须是正整数')
    }
    this.#model = options.model
    this.#session = options.session
    this.#tools = options.tools
    this.#ids = options.ids
    this.#maxSteps = options.maxSteps
    this.#settlementSignals = options.settlementSignals
    this.#prompts = options.prompts ?? new BoundedPromptAssembler({ maxInputBytes: Number.MAX_SAFE_INTEGER })
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
    const timeoutSignal = this.#runTimeoutMs === undefined ? undefined : AbortSignal.timeout(this.#runTimeoutMs)
    const signal = AbortSignal.any([externalSignal, controller.signal, ...(timeoutSignal === undefined ? [] : [timeoutSignal])])
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

  /**
   * 执行单个 step：组装请求、流式模型、持久化 assistant 结算、顺序执行工具并闭合 step。
   * 流式 chunk 只通知 observer；持久事实写入会话事件。
   */
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

    const request = this.#prompts.assemble(await this.#session.read({ signal }), this.#tools.list())
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

    for await (const event of prepared.stream(request, signal)) {
      throwIfAborted(signal)
      this.#notifyStream(event)
      switch (event.type) {
        case 'text.delta':
          outputBytes += Buffer.byteLength(event.text, 'utf8')
          this.#assertOutputBudget(outputBytes)
          attempt.partialText += event.text
          break
        case 'tool.call':
          outputBytes += Buffer.byteLength(JSON.stringify(event.call), 'utf8')
          this.#assertOutputBudget(outputBytes)
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

  #assertOutputBudget(bytes: number): void {
    if (this.#maxModelOutputBytes !== undefined && bytes > this.#maxModelOutputBytes) {
      throw new Error(`模型输出超过 maxModelOutputBytes (${this.#maxModelOutputBytes})`)
    }
  }

  /** 向 observer 派发流事件；同步与异步失败均被隔离。 */
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

/** 跟踪单次模型 attempt 的流式累积、结算与工具结果，供失败路径补写事件。 */
interface AttemptLifecycle {
  readonly attemptId: AttemptId
  partialText: string
  readonly observedToolCalls: ToolCall[]
  settlement?: AssistantSettlement
  settlementPersisted: boolean
  readonly toolResults: Map<ToolCallId, ToolResult>
  readonly persistedToolResults: Set<ToolCallId>
}

/** 跟踪 step 是否已开始/结束，以及其中的 attempt，供 terminal settlement 使用。 */
interface StepLifecycle {
  readonly stepId: StepId
  started: boolean
  ended: boolean
  attempt?: AttemptLifecycle
}

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
