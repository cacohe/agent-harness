import type {
  AttemptId,
  EventEnvelope,
  ExecutionMetadata,
  MessageId,
  SessionId,
  StepId,
  ToolCallId,
  TurnId,
  TurnOutcome,
} from './facts.js'
import type { PromptAssembler } from './context.js'
import type { ModelProvider, ModelStreamEvent } from './model.js'
import type { SessionLog } from './session.js'
import type { ToolCapability } from './tools.js'

export type AgentPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running', readonly turnId: TurnId, readonly stepId?: StepId }

export interface AgentIdGenerator {
  turn(): TurnId
  step(): StepId
  attempt(): AttemptId
  message(): MessageId
}

export interface AgentObserver {
  onStream?(event: ModelStreamEvent): void | Promise<void>
  onExecution?(event: AgentExecutionEvent): void | Promise<void>
}

export type AgentExecutionEvent =
  | { readonly type: 'session.event', readonly envelope: EventEnvelope }
  | {
    readonly type: 'model.usage'
    readonly sessionId: SessionId
    readonly turnId: TurnId
    readonly stepId: StepId
    readonly attemptId: AttemptId
    readonly usageSequence: number
    readonly inputTokensDelta: number
    readonly outputTokensDelta: number
  }

export interface SettlementSignalFactory {
  create(): AbortSignal
}

export interface AgentIdReservationSeed {
  readonly turnIds: readonly TurnId[]
  readonly stepIds: readonly StepId[]
  readonly attemptIds: readonly AttemptId[]
  readonly messageIds: readonly MessageId[]
  readonly toolCallIds: readonly ToolCallId[]
}

export interface AgentOptions {
  readonly model: ModelProvider
  readonly session: SessionLog
  readonly tools: ToolCapability
  readonly ids: AgentIdGenerator
  readonly maxSteps: number
  readonly settlementSignals: SettlementSignalFactory
  /** 由 Runtime 或 Host 显式注入；Core 不拥有默认 prompt 策略。 */
  readonly prompts: PromptAssembler
  readonly runTimeoutMs?: number
  readonly maxModelOutputBytes?: number
  readonly observers?: readonly AgentObserver[]
  readonly reservedIds?: AgentIdReservationSeed
}

export interface AgentRunOptions {
  readonly signal?: AbortSignal
  readonly execution?: ExecutionMetadata
}

export class AgentClosedError extends Error {
  override readonly name = 'AgentClosedError'
}

export class AgentIdCollisionError extends Error {
  override readonly name = 'AgentIdCollisionError'
  readonly kind: 'turn' | 'step' | 'attempt' | 'message' | 'toolCall'
  readonly value: string

  constructor(kind: AgentIdCollisionError['kind'], value: string) {
    super(`${kind} 标识符与会话历史或当前 Agent 已保留的值冲突：${value}`)
    this.kind = kind
    this.value = value
  }
}

type RuntimeFailureOutcome = Extract<TurnOutcome, 'failed' | 'cancelled'>

export class SettlementPersistenceError extends Error {
  readonly originalError: unknown
  readonly persistenceError: unknown
  readonly outcome: RuntimeFailureOutcome

  constructor(originalError: unknown, persistenceError: unknown, outcome: RuntimeFailureOutcome) {
    super(`failed to persist ${outcome} terminal settlement`, { cause: persistenceError })
    this.name = 'SettlementPersistenceError'
    this.originalError = originalError
    this.persistenceError = persistenceError
    this.outcome = outcome
  }
}
