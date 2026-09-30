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
  type SessionId,
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
  type ExecutionMetadata,
} from '@agent-harness/domain'
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  ModelToolDefinition,
} from '@agent-harness/model'
import { deriveModelMessages, type SessionLog } from '@agent-harness/session'
import { executeWithContext, type ToolCapability } from '@agent-harness/tools'

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
  onExecution?(event: AgentExecutionEvent): void | Promise<void>
}

/** 为审计、指标与计费 adapter 提供的结构化执行通知。 */
export type AgentExecutionEvent =
  | { readonly type: 'session.event', readonly envelope: EventEnvelope }
  | {
    readonly type: 'model.usage'
    readonly sessionId: SessionId
    readonly turnId: TurnId
    readonly stepId: StepId
    readonly attemptId: AttemptId
    /** 在该 attempt 内从一开始递增的 usage 报告序号。 */
    readonly usageSequence: number
    /** 相对上一条累计 usage 的输入 token 增量。 */
    readonly inputTokensDelta: number
    /** 相对上一条累计 usage 的输出 token 增量。 */
    readonly outputTokensDelta: number
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

/** 提供组装请求时可用的、不会进入会话事件日志的上下文。 */
export interface ContextContributor {
  contribute(input: ContextContributorInput): readonly ModelMessage[]
}

/** 传给上下文贡献器的只读事实快照。 */
export interface ContextContributorInput {
  readonly events: readonly EventEnvelope[]
  readonly tools: readonly ModelToolDefinition[]
}

/** 为贡献当前时间等易变上下文提供可替换的时钟。 */
export interface Clock {
  now(): Date
}

/** Host 或 Platform 提供的、当前已启用 Skill 元数据与正文读取能力。 */
export interface SkillCatalog {
  listEnabled(): readonly SkillDescriptor[]
  read(skillId: string, signal: AbortSignal): Promise<string>
}

/** 可安全展示给模型的 Skill 摘要；正文仅通过显式 read 按需取得。 */
export interface SkillDescriptor {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** 将组合方提供的当前时间作为一条系统消息加入每次模型请求。 */
export class CurrentTimeContext implements ContextContributor {
  readonly #clock: Clock

  constructor(clock: Clock) {
    this.#clock = clock
  }

  contribute(_input: ContextContributorInput): readonly ModelMessage[] {
    const now = this.#clock.now()
    if (!(now instanceof Date) || Number.isNaN(now.getTime())) {
      throw new TypeError('Clock.now 必须返回有效 Date')
    }
    return [{ role: 'system', content: `当前时间（UTC）：${now.toISOString()}` }]
  }
}

/** 将已启用 Skills 的名称和描述加入请求，不读取或注入 Skill 正文。 */
export class EnabledSkillsContext implements ContextContributor {
  readonly #skills: SkillCatalog

  constructor(skills: SkillCatalog) {
    this.#skills = skills
  }

  contribute(_input: ContextContributorInput): readonly ModelMessage[] {
    const descriptors = this.#skills.listEnabled()
    if (!Array.isArray(descriptors)) throw new TypeError('SkillCatalog.listEnabled 必须返回数组')
    if (descriptors.length > MAX_ENABLED_SKILLS) {
      throw new RangeError(`已启用 Skills 数量不能超过 ${MAX_ENABLED_SKILLS}`)
    }
    const names = new Set<string>()
    const lines: string[] = []
    let summaryBytes = 0
    for (const skill of descriptors) {
      assertSkillDescriptor(skill)
      assertSkillFieldBytes(skill.id)
      assertSkillFieldBytes(skill.name)
      assertSkillFieldBytes(skill.description)
      if (names.has(skill.name)) throw new TypeError(`已启用 Skill 名称重复：${skill.name}`)
      names.add(skill.name)
      const line = `- ${skill.name}：${skill.description}`
      summaryBytes += utf8ByteLength(line) + (lines.length === 0 ? 0 : 1)
      if (summaryBytes > MAX_SKILLS_SUMMARY_BYTES) {
        throw new RangeError(`Skill 摘要不能超过 ${MAX_SKILLS_SUMMARY_BYTES} UTF-8 字节`)
      }
      lines.push(line)
    }
    return lines.length === 0 ? [] : [{ role: 'system', content: `当前启用 Skills：\n${lines.join('\n')}` }]
  }
}

const MAX_ENABLED_SKILLS = 128
const MAX_SKILL_FIELD_BYTES = 2_048
const MAX_SKILLS_SUMMARY_BYTES = 16_384

/** UTF-8 字节数不小于 UTF-16 code unit 数，先快速拒绝超长不可信字符串。 */
function assertSkillFieldBytes(value: string): void {
  if (value.length > MAX_SKILL_FIELD_BYTES || utf8ByteLength(value) > MAX_SKILL_FIELD_BYTES) {
    throw new RangeError(`Skill 字段不能超过 ${MAX_SKILL_FIELD_BYTES} UTF-8 字节`)
  }
}

/** 默认上下文策略：保留完整的最近用户 turn，并限制模型输入字节数。 */
export class BoundedPromptAssembler implements PromptAssembler {
  readonly #systemPrompt: string | undefined
  readonly #contributors: readonly ContextContributor[]
  readonly #maxInputBytes: number

  constructor(options: {
    readonly maxInputBytes: number
    readonly systemPrompt?: string
    readonly contributors?: readonly ContextContributor[]
  }) {
    if (!Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes < 1) {
      throw new TypeError('maxInputBytes 必须是正整数')
    }
    if (options.systemPrompt !== undefined && options.systemPrompt.length === 0) {
      throw new TypeError('systemPrompt 若提供则必须是非空字符串')
    }
    this.#maxInputBytes = options.maxInputBytes
    this.#systemPrompt = options.systemPrompt
    this.#contributors = options.contributors ?? []
  }

  assemble(events: readonly EventEnvelope[], tools: readonly ModelToolDefinition[]): ModelRequest {
    const history = deriveModelMessages(events)
    const context = this.#contextMessages({ events, tools })
    const start = this.#findStart(history, tools, context)
    const messages: readonly ModelMessage[] = [...context, ...history.slice(start)]
    return { messages, tools }
  }

  #contextMessages(input: ContextContributorInput): readonly ModelMessage[] {
    const messages: ModelMessage[] = this.#systemPrompt === undefined
      ? []
      : [{ role: 'system', content: this.#systemPrompt }]
    for (const contributor of this.#contributors) {
      for (const message of contributor.contribute(input)) {
        if (message.role !== 'system' || message.content.length === 0) {
          throw new TypeError('ContextContributor 只能返回非空 system 消息')
        }
        messages.push(message)
      }
    }
    return messages
  }

  #findStart(
    messages: readonly ModelMessage[],
    tools: readonly ModelToolDefinition[],
    context: readonly ModelMessage[],
  ): number {
    let bytes = utf8ByteLength(JSON.stringify(context)) + utf8ByteLength(JSON.stringify(tools))
    if (bytes > this.#maxInputBytes) {
      throw new Error('上下文与工具定义超过 maxInputBytes')
    }
    let start = messages.length
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      bytes += utf8ByteLength(JSON.stringify(messages[index]))
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

/** 一次 turn 的调用选项；执行上下文只在本次 run 内有效。 */
export interface AgentRunOptions {
  readonly signal?: AbortSignal
  readonly execution?: ExecutionMetadata
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

  /** 成功提交会话事件后，向 observer 发送与持久化事实一致的通知。 */
  async #append(events: readonly SessionEvent[], signal: AbortSignal): Promise<void> {
    const appended = await this.#session.append(events, { signal })
    for (const envelope of appended) {
      this.#notifyExecution({ type: 'session.event', envelope })
    }
  }

  /** 向 observer 派发结构化执行事件；同步与异步失败均被隔离。 */
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

function isAbortSignal(value: AbortSignal | AgentRunOptions): value is AbortSignal {
  return 'aborted' in value && typeof value.aborted === 'boolean'
}

/** 在模型输入边界校验 Host 返回的 Skill 摘要，避免把未验证配置拼入 prompt。 */
function assertSkillDescriptor(value: unknown): asserts value is SkillDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Skill 必须是对象')
  }
  const keys = Object.keys(value)
  const expected = ['description', 'id', 'name']
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new TypeError('Skill 只能包含 id、name 与 description')
  }
  for (const key of expected) {
    const field = (value as Record<string, unknown>)[key]
    if (typeof field !== 'string' || field.length === 0) {
      throw new TypeError(`Skill.${key} 必须是非空字符串`)
    }
  }
}

/** 在 Agent 边界拒绝不可信的执行审计字段，避免坏数据进入持久会话。 */
function freezeExecutionMetadata(
  execution: ExecutionMetadata | undefined,
): ExecutionMetadata | undefined {
  if (execution === undefined) return undefined
  if (typeof execution !== 'object' || execution === null || Array.isArray(execution)) {
    throw new TypeError('execution 必须是对象')
  }
  const keys = Object.keys(execution)
  const expected = ['authorizationVersion', 'id', 'subject']
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new TypeError('execution 只能包含 id、subject 与 authorizationVersion')
  }
  const { id, subject, authorizationVersion } = execution
  for (const [name, value] of Object.entries({ id, subject, authorizationVersion })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`execution.${name} 必须是非空字符串`)
    }
  }
  return Object.freeze({ id, subject, authorizationVersion })
}

/** 拒绝不符合模型 capability 累计语义的 usage，避免下游重复计费。 */
function assertCumulativeUsage(
  inputTokens: number,
  outputTokens: number,
  previousInputTokens: number,
  previousOutputTokens: number,
): void {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < previousInputTokens) {
    throw new TypeError('模型 inputTokens 必须是单调不减的非负安全整数')
  }
  if (!Number.isSafeInteger(outputTokens) || outputTokens < previousOutputTokens) {
    throw new TypeError('模型 outputTokens 必须是单调不减的非负安全整数')
  }
}

const textEncoder = new TextEncoder()

/** 计算字符串的 UTF-8 字节长度，避免依赖 Node Buffer。 */
function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength
}
