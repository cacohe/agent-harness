import {
  assertJsonValue,
  assertNever,
  type AttemptId,
  type EventEnvelope,
  type AssistantSettlement,
  type MessageId,
  type ModelMessage,
  type SessionEvent,
  type SessionBatchId,
  type SessionId,
  type StepOutcome,
  type StepId,
  type ToolCallId,
  type TurnId,
} from '@agent-harness/domain'

/** 提供不可变的会话事件快照。 */
export interface SessionReader {
  readonly sessionId: SessionId

  read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]>
  /** 开始释放资源；取消只停止本次等待，后台释放仍须继续。 */
  close(options: SessionOperationOptions): Promise<void>
}

/** 定义可取消、append-only 且支持原子事件批次的会话 writer。 */
export interface SessionLog extends SessionReader {
  /** 原子追加一个事件批次；失败或取消时不得留下部分批次。 */
  append(
    events: readonly SessionEvent[],
    options: SessionAppendOptions,
  ): Promise<readonly EventEnvelope[]>
  flush(options: SessionOperationOptions): Promise<void>
}

export interface SessionOperationOptions {
  /** 控制当前存储操作，不代表 Agent 的 durable settlement 分类。 */
  readonly signal: AbortSignal
}

/** 为原子追加提供取消、乐观 sequence 与可选批次身份。 */
export interface SessionAppendOptions extends SessionOperationOptions {
  /** 提供时必须等于追加前最后一个 sequence，首批为零。 */
  readonly expectedSequence?: number
  /** 提供时成为持久批次身份；同一会话内不得重复。 */
  readonly batchId?: SessionBatchId
}

/** 区分只读快照与独占 writer 的打开模式。 */
export type SessionOpenOptions =
  | { readonly mode: 'read'; readonly signal: AbortSignal }
  | { readonly mode: 'write'; readonly signal: AbortSignal }

/** 创建并按模式打开会话，不暴露具体存储布局。 */
export interface SessionRepository {
  create(sessionId: SessionId, options: SessionOperationOptions): Promise<SessionLog>
  open(sessionId: SessionId, options: Extract<SessionOpenOptions, { mode: 'read' }>): Promise<SessionReader>
  open(sessionId: SessionId, options: Extract<SessionOpenOptions, { mode: 'write' }>): Promise<SessionLog>
}

/** 表示请求的会话不存在。 */
export class SessionNotFoundError extends Error {
  override readonly name = 'SessionNotFoundError'
}
/** 表示 create 的会话身份已经存在。 */
export class SessionAlreadyExistsError extends Error {
  override readonly name = 'SessionAlreadyExistsError'
}
/** 表示当前进程已有该会话的 writer。 */
export class SessionAlreadyOwnedError extends Error {
  override readonly name = 'SessionAlreadyOwnedError'
}
/** 表示完整持久记录无法通过协议校验。 */
export class SessionCorruptionError extends Error {
  override readonly name = 'SessionCorruptionError'
}
/** 表示调用方预期的日志尾部或 batch 身份冲突。 */
export class SessionSequenceConflictError extends Error {
  override readonly name = 'SessionSequenceConflictError'
}
/** 表示会话句柄已经关闭。 */
export class SessionClosedError extends Error {
  override readonly name = 'SessionClosedError'
}

/** 表示事件顺序或生命周期关联无法安全恢复。 */
export class SessionLifecycleCorruptionError extends Error {
  override readonly name = 'SessionLifecycleCorruptionError'
  readonly sequence: number | undefined

  constructor(message: string, sequence?: number) {
    super(sequence === undefined ? message : `sequence ${sequence}：${message}`)
    this.sequence = sequence
  }
}

/** 表示 create 已发布完整会话目录，但根目录同步失败。 */
export class SessionCreateUncertainError extends Error {
  override readonly name = 'SessionCreateUncertainError'
  readonly sessionId: SessionId
  readonly published = true

  constructor(sessionId: SessionId, cause: unknown) {
    super('会话已经发布，但 create 的 durability 结果不确定', { cause })
    this.sessionId = sessionId
  }
}

/** 表示 writer 曾发生不确定提交，关闭前不得继续观察或写入。 */
export class SessionPoisonedError extends Error {
  override readonly name = 'SessionPoisonedError'
  readonly poisonReason: SessionUncertainCommitError

  constructor(poisonReason: SessionUncertainCommitError) {
    super('会话 writer 因不确定提交而不可继续使用', { cause: poisonReason })
    this.poisonReason = poisonReason
  }
}

/** 表示写入失败且回滚也失败，调用方不能推断批次是否提交。 */
export class SessionUncertainCommitError extends Error {
  readonly writeError: unknown
  readonly rollbackError: unknown

  constructor(writeError: unknown, rollbackError: unknown) {
    super('会话批次提交结果不确定', { cause: rollbackError })
    this.name = 'SessionUncertainCommitError'
    this.writeError = writeError
    this.rollbackError = rollbackError
  }
}

/** 释放单 writer 所有权；重复释放必须安全。 */
export interface SessionWriteLease {
  release(): void
}

/** 为规范存储路径提供单 writer 所有权。 */
export interface SessionWriteLeaseProvider {
  acquire(key: string, signal: AbortSignal): Promise<SessionWriteLease>
}

/** 为事件信封提供可替换且可测试的时间。 */
export interface SessionClock {
  now(): string
}

/** 面向测试和进程内运行时的 append-only 会话实现。 */
export class InMemorySessionLog implements SessionLog {
  readonly sessionId: SessionId
  readonly #clock: SessionClock
  readonly #events: EventEnvelope[] = []
  readonly #batchIds = new Set<SessionBatchId>()
  #closed = false

  constructor(sessionId: SessionId, clock: SessionClock = systemSessionClock) {
    this.sessionId = sessionId
    this.#clock = clock
  }

  async append(
    events: readonly SessionEvent[],
    options: SessionAppendOptions,
  ): Promise<readonly EventEnvelope[]> {
    this.#assertOpen()
    options.signal.throwIfAborted()
    if (events.length === 0) return []
    if (
      options.expectedSequence !== undefined
      && options.expectedSequence !== this.#events.length
    ) {
      throw new SessionSequenceConflictError('expected sequence 与当前日志不一致')
    }
    if (options.batchId !== undefined && this.#batchIds.has(options.batchId)) {
      throw new SessionSequenceConflictError('batchId 已存在')
    }
    for (const event of events) assertJsonValue(event)
    const firstSequence = this.#events.length + 1
    const envelopes = events.map((event, index): EventEnvelope =>
      immutableSnapshot({
        version: 1,
        sessionId: this.sessionId,
        sequence: firstSequence + index,
        timestamp: this.#clock.now(),
        event,
      }),
    )
    options.signal.throwIfAborted()
    this.#events.push(...envelopes)
    if (options.batchId !== undefined) this.#batchIds.add(options.batchId)
    return envelopes
  }

  async read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    this.#assertOpen()
    options.signal.throwIfAborted()
    return this.#events.slice()
  }

  async flush(options: SessionOperationOptions): Promise<void> {
    this.#assertOpen()
    options.signal.throwIfAborted()
  }

  async close(options: SessionOperationOptions): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    options.signal.throwIfAborted()
  }

  #assertOpen(): void {
    if (this.#closed) throw new SessionClosedError('会话句柄已关闭')
  }
}

const systemSessionClock: SessionClock = {
  now: () => new Date().toISOString(),
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key), seen)
  }
  return Object.freeze(value)
}

/** 从持久事件中重建下一次模型请求可见的完整消息历史。 */
export function deriveModelMessages(
  envelopes: readonly EventEnvelope[],
): readonly ModelMessage[] {
  const messages: ModelMessage[] = []
  let previousSequence = 0

  for (const envelope of envelopes) {
    if (envelope.sequence <= previousSequence) {
      throw new Error('session event sequence must be strictly increasing')
    }
    previousSequence = envelope.sequence

    switch (envelope.event.type) {
      case 'user.message':
        messages.push(envelope.event.message)
        break
      case 'assistant.settled':
        if (envelope.event.settlement.status === 'completed') {
          messages.push(envelope.event.settlement.message)
        }
        break
      case 'tool.completed':
        messages.push({
          role: 'tool',
          callId: envelope.event.result.callId,
          result: envelope.event.result,
        })
        break
      case 'turn.started':
      case 'step.started':
      case 'step.ended':
      case 'turn.ended':
        break
      default:
        assertNever(envelope.event)
    }
  }

  return messages
}

/** 描述恢复前必须作为一个原子批次追加的最小生命周期修复。 */
export interface SessionLifecycleRepairPlan {
  readonly expectedSequence: number
  readonly events: readonly SessionEvent[]
  readonly usedIds: SessionLifecycleIdNamespaces
}

/** 恢复历史中已经占用的 Agent 标识符命名空间。 */
export interface SessionLifecycleIdNamespaces {
  readonly turnIds: readonly TurnId[]
  readonly stepIds: readonly StepId[]
  readonly attemptIds: readonly AttemptId[]
  readonly messageIds: readonly MessageId[]
  readonly toolCallIds: readonly ToolCallId[]
}

/**
 * 验证完整事件日志的生命周期关系，并为唯一允许的尾部中断生成修复。
 * 已闭合生命周期中的缺失事实或任何非尾部损坏都会拒绝恢复。
 */
export function analyzeSessionLifecycle(
  envelopes: readonly EventEnvelope[],
): SessionLifecycleRepairPlan {
  const state: LifecycleAnalysisState = {
    sessionId: envelopes[0]?.sessionId,
    turn: undefined,
    usedTurnIds: new Set(),
    usedStepIds: new Set(),
    usedAttemptIds: new Set(),
    usedMessageIds: new Set(),
    usedToolCallIds: new Set(),
  }

  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index]!
    const expectedSequence = index + 1
    if (envelope.version !== 1) corrupt('event envelope version 无效', envelope.sequence)
    if (envelope.sequence !== expectedSequence) {
      corrupt(`event sequence 应为 ${expectedSequence}`, envelope.sequence)
    }
    if (state.sessionId !== envelope.sessionId) {
      corrupt('event envelope 的 sessionId 不一致', envelope.sequence)
    }
    applyLifecycleEvent(state, envelope)
  }

  return {
    expectedSequence: envelopes.length,
    events: buildRecoveryEvents(state.turn),
    usedIds: snapshotUsedIds(state),
  }
}

interface LifecycleAnalysisState {
  readonly sessionId: SessionId | undefined
  turn: OpenTurn | undefined
  readonly usedTurnIds: Set<TurnId>
  readonly usedStepIds: Set<StepId>
  readonly usedAttemptIds: Set<AttemptId>
  readonly usedMessageIds: Set<MessageId>
  readonly usedToolCallIds: Set<ToolCallId>
}

interface OpenTurn {
  readonly turnId: TurnId
  userMessageSeen: boolean
  stepCount: number
  lastClosedStep: ClosedStep | undefined
  step: OpenStep | undefined
}

interface OpenStep {
  readonly stepId: StepId
  settlement: AssistantSettlement | undefined
  toolCallIds: readonly ToolCallId[]
  readonly resultIds: Set<ToolCallId>
}

interface ClosedStep {
  readonly settlement: AssistantSettlement | undefined
  readonly outcome: StepOutcome
}

function applyLifecycleEvent(
  state: LifecycleAnalysisState,
  envelope: EventEnvelope,
): void {
  const event = envelope.event
  const sequence = envelope.sequence
  switch (event.type) {
    case 'turn.started': {
      if (state.turn !== undefined) corrupt('前一个 turn 尚未闭合', sequence)
      uniqueId(state.usedTurnIds, event.turnId, 'turnId 重复', sequence)
      state.turn = {
        turnId: event.turnId,
        userMessageSeen: false,
        stepCount: 0,
        lastClosedStep: undefined,
        step: undefined,
      }
      return
    }
    case 'user.message': {
      const turn = requireTurn(state, sequence)
      if (turn.stepCount > 0 || turn.step !== undefined) {
        corrupt('user.message 必须出现在第一个 step 之前', sequence)
      }
      if (turn.userMessageSeen) corrupt('一个 turn 只能接纳一条 user.message', sequence)
      uniqueId(state.usedMessageIds, event.message.id, 'messageId 重复', sequence)
      turn.userMessageSeen = true
      return
    }
    case 'step.started': {
      const turn = requireMatchingTurn(state, event.turnId, sequence)
      if (turn.step !== undefined) corrupt('前一个 step 尚未闭合', sequence)
      if (!turn.userMessageSeen) corrupt('step.started 之前缺少 user.message', sequence)
      if (
        turn.stepCount > 0
        && (
          turn.lastClosedStep?.outcome !== 'completed'
          || turn.lastClosedStep.settlement?.status !== 'completed'
          || turn.lastClosedStep.settlement.message.toolCalls.length === 0
        )
      ) {
        corrupt('只有产生工具调用并成功闭合的 step 才能继续下一 step', sequence)
      }
      uniqueId(state.usedStepIds, event.stepId, 'stepId 重复', sequence)
      turn.stepCount += 1
      turn.step = {
        stepId: event.stepId,
        settlement: undefined,
        toolCallIds: [],
        resultIds: new Set(),
      }
      return
    }
    case 'assistant.settled': {
      const step = requireMatchingStep(state, event.turnId, event.stepId, sequence)
      if (step.settlement !== undefined) corrupt('一个 step 只能有一次 assistant settlement', sequence)
      uniqueId(
        state.usedAttemptIds,
        event.settlement.attemptId,
        'attemptId 重复',
        sequence,
      )
      if (event.settlement.status === 'completed') {
        uniqueId(
          state.usedMessageIds,
          event.settlement.message.id,
          'messageId 重复',
          sequence,
        )
        const callIds: ToolCallId[] = []
        for (const call of event.settlement.message.toolCalls) {
          uniqueId(state.usedToolCallIds, call.id, 'tool call id 重复', sequence)
          callIds.push(call.id)
        }
        step.toolCallIds = callIds
      } else {
        for (const call of event.settlement.observedToolCalls) {
          uniqueId(state.usedToolCallIds, call.id, 'tool call id 重复', sequence)
        }
      }
      step.settlement = event.settlement
      return
    }
    case 'tool.completed': {
      const step = requireMatchingStep(state, event.turnId, event.stepId, sequence)
      if (step.settlement?.status !== 'completed') {
        corrupt('tool.completed 缺少已完成的 assistant settlement', sequence)
      }
      if (step.resultIds.has(event.result.callId)) {
        corrupt('同一 tool call 出现多个 result', sequence)
      }
      const expectedCallId = step.toolCallIds[step.resultIds.size]
      if (expectedCallId !== event.result.callId) {
        corrupt('tool result 必须按 assistant tool call 顺序构成连续前缀', sequence)
      }
      step.resultIds.add(event.result.callId)
      return
    }
    case 'step.ended': {
      const turn = requireMatchingTurn(state, event.turnId, sequence)
      const step = requireMatchingStep(state, event.turnId, event.stepId, sequence)
      if (event.outcome === 'completed' && step.settlement?.status !== 'completed') {
        corrupt('completed step 缺少 completed assistant settlement', sequence)
      }
      if (
        step.settlement?.status === 'completed'
        && step.toolCallIds.some(callId => !step.resultIds.has(callId))
      ) {
        corrupt('已闭合 step 缺少 tool result', sequence)
      }
      turn.lastClosedStep = { settlement: step.settlement, outcome: event.outcome }
      turn.step = undefined
      return
    }
    case 'turn.ended': {
      const turn = requireMatchingTurn(state, event.turnId, sequence)
      if (turn.step !== undefined) corrupt('turn.ended 之前 step 尚未闭合', sequence)
      if (
        event.outcome === 'completed'
        && (
          turn.lastClosedStep?.outcome !== 'completed'
          || turn.lastClosedStep.settlement?.status !== 'completed'
          || turn.lastClosedStep.settlement.message.toolCalls.length > 0
        )
      ) {
        corrupt('completed turn 缺少无工具调用的最终 assistant message', sequence)
      }
      state.turn = undefined
      return
    }
    default:
      assertNever(event)
  }
}

function buildRecoveryEvents(turn: OpenTurn | undefined): readonly SessionEvent[] {
  if (turn === undefined) return []
  const events: SessionEvent[] = []
  const step = turn.step
  if (step !== undefined) {
    if (step.settlement?.status === 'completed') {
      for (const callId of step.toolCallIds) {
        if (step.resultIds.has(callId)) continue
        events.push({
          type: 'tool.completed',
          turnId: turn.turnId,
          stepId: step.stepId,
          result: {
            status: 'unknown',
            callId,
            reason: '进程中断后无法确认工具是否已经执行，外部副作用状态未知',
          },
        })
      }
    }
    events.push({
      type: 'step.ended',
      turnId: turn.turnId,
      stepId: step.stepId,
      outcome: 'interrupted',
    })
  }
  events.push({
    type: 'turn.ended',
    turnId: turn.turnId,
    outcome: 'interrupted',
  })
  return events
}

function requireTurn(state: LifecycleAnalysisState, sequence: number): OpenTurn {
  if (state.turn === undefined) corrupt('事件不属于活动 turn', sequence)
  return state.turn
}

function requireMatchingTurn(
  state: LifecycleAnalysisState,
  turnId: TurnId,
  sequence: number,
): OpenTurn {
  const turn = requireTurn(state, sequence)
  if (turn.turnId !== turnId) corrupt('turnId 与活动 turn 不一致', sequence)
  return turn
}

function requireMatchingStep(
  state: LifecycleAnalysisState,
  turnId: TurnId,
  stepId: StepId,
  sequence: number,
): OpenStep {
  const turn = requireMatchingTurn(state, turnId, sequence)
  if (turn.step === undefined) corrupt('事件不属于活动 step', sequence)
  if (turn.step.stepId !== stepId) corrupt('stepId 与活动 step 不一致', sequence)
  return turn.step
}

function uniqueId<T>(
  values: Set<T>,
  value: T,
  message: string,
  sequence: number,
): void {
  if (values.has(value)) corrupt(message, sequence)
  values.add(value)
}

function corrupt(message: string, sequence?: number): never {
  throw new SessionLifecycleCorruptionError(message, sequence)
}

function snapshotUsedIds(
  state: LifecycleAnalysisState,
): SessionLifecycleIdNamespaces {
  return Object.freeze({
    turnIds: Object.freeze([...state.usedTurnIds]),
    stepIds: Object.freeze([...state.usedStepIds]),
    attemptIds: Object.freeze([...state.usedAttemptIds]),
    messageIds: Object.freeze([...state.usedMessageIds]),
    toolCallIds: Object.freeze([...state.usedToolCallIds]),
  })
}
