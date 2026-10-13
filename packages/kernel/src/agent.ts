import type { Clock, PromptAssembler } from './context/protocol.js';
import type {
  AttemptId,
  ExecutionId,
  MessageId,
  SessionId,
  StepId,
  TurnId,
} from './identifiers.js';
import type { ModelProvider, ModelStreamEvent } from './model.js';
import type { EventEnvelope, SessionLog, TurnOutcome } from './session/protocol.js';
import type { ToolCallId, ToolCapability } from './tools/protocol.js';

/** 当前 Agent 状态。 */
export type AgentPhase =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running'; readonly turnId: TurnId; readonly stepId?: StepId };

/** 为新建或恢复的 Agent 创建一组标识符。 */
export interface AgentIdGenerator {
  turn(): TurnId;
  step(): StepId;
  attempt(): AttemptId;
  message(): MessageId;
}

/** 观察 Agent 生命周期事件的回调。 */
export interface AgentObserver {
  onStream?(event: ModelStreamEvent): void | Promise<void>;
  onExecution?(event: AgentExecutionEvent): void | Promise<void>;
}

/** Agent 生命周期事件。 */
export type AgentExecutionEvent =
  | { readonly type: 'session.event'; readonly envelope: EventEnvelope }
  | {
      readonly type: 'model.started';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly stepId: StepId;
      readonly attemptId: AttemptId;
      readonly executionId?: ExecutionId;
      readonly startedAt: Date;
    }
  | {
      readonly type: 'model.completed' | 'model.failed' | 'model.cancelled';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly stepId: StepId;
      readonly attemptId: AttemptId;
      readonly executionId?: ExecutionId;
      /** 时钟不可用时省略，不能影响已开始的观测生命周期。 */
      readonly durationMs?: number;
      readonly errorName?: string;
    }
  | {
      readonly type: 'tool.started';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly stepId: StepId;
      readonly attemptId: AttemptId;
      readonly executionId?: ExecutionId;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      readonly startedAt: Date;
    }
  | {
      readonly type: 'tool.completed';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly stepId: StepId;
      readonly attemptId: AttemptId;
      readonly executionId?: ExecutionId;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      /** 时钟不可用时省略，不能影响已开始的观测生命周期。 */
      readonly durationMs?: number;
      readonly status: 'success' | 'failure' | 'cancelled' | 'unknown';
    }
  | {
      readonly type: 'tool.failed' | 'tool.cancelled';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly stepId: StepId;
      readonly attemptId: AttemptId;
      readonly executionId?: ExecutionId;
      readonly toolCallId: ToolCallId;
      readonly toolName: string;
      /** 时钟不可用时省略，不能影响已开始的观测生命周期。 */
      readonly durationMs?: number;
      readonly errorName?: string;
    }
  | {
      readonly type: 'model.usage';
      readonly sessionId: SessionId;
      readonly turnId: TurnId;
      readonly stepId: StepId;
      readonly attemptId: AttemptId;
      readonly executionId?: ExecutionId;
      readonly usageSequence: number;
      readonly inputTokensDelta: number;
      readonly outputTokensDelta: number;
    };

/** 创建一个用于结算的 AbortSignal。 */
export interface SettlementSignalFactory {
  create(): AbortSignal;
}

/** 用于初始化 Agent 标识符预留池的种子。 */
export interface AgentIdReservationSeed {
  readonly turnIds: readonly TurnId[];
  readonly stepIds: readonly StepId[];
  readonly attemptIds: readonly AttemptId[];
  readonly messageIds: readonly MessageId[];
  readonly toolCallIds: readonly ToolCallId[];
}

/** Agent 配置选项。 */
export interface AgentOptions {
  readonly model: ModelProvider;
  readonly session: SessionLog;
  readonly tools: ToolCapability;
  readonly ids: AgentIdGenerator;
  readonly maxSteps: number;
  readonly settlementSignals: SettlementSignalFactory;
  /** 由组合方注入；执行观测不读取进程全局时间。 */
  readonly clock?: Clock;
  /** 由 Runtime 或 Host 显式注入；Core 不拥有默认 prompt 策略。 */
  readonly prompts: PromptAssembler;
  readonly runTimeoutMs?: number;
  /** 单次模型 prepare 与流式调用的协作式 deadline。 */
  readonly modelAttemptTimeoutMs?: number;
  /** 单次工具调用的协作式 deadline。 */
  readonly toolTimeoutMs?: number;
  readonly maxModelOutputBytes?: number;
  /** 单个工具返回载荷写入会话前允许的最大 UTF-8 字节数；不含协议元数据。 */
  readonly maxToolResultBytes?: number;
  /** 等待 FIFO 领取的输入上限；不包含当前活动 turn。 */
  readonly maxQueuedRuns?: number;
  readonly observers?: readonly AgentObserver[];
  readonly reservedIds?: AgentIdReservationSeed;
}

/** Agent 运行选项。 */
export interface AgentRunOptions {
  readonly signal?: AbortSignal;
  readonly execution?: ExecutionMetadata;
}

/** 由 Host 或 Platform 选择的、版本化的 Agent 静态指令。 */
export interface AgentProfile {
  readonly id: string;
  readonly version: string;
  readonly instructions: string;
}

/** 一次 turn 已冻结执行身份的最小审计快照；不会投影给模型。 */
export interface ExecutionMetadata {
  readonly id: ExecutionId;
  readonly subject: string;
  readonly authorizationVersion: string;
}

/** Agent 已关闭错误。 */
export class AgentClosedError extends Error {
  override readonly name = 'AgentClosedError';
}

/** 表示会话的 FIFO 输入队列已经达到容量上限。 */
export class AgentBusyError extends Error {
  override readonly name = 'AgentBusyError';
}

/** Agent 标识符冲突错误。 */
export class AgentIdCollisionError extends Error {
  override readonly name = 'AgentIdCollisionError';
  readonly kind: 'turn' | 'step' | 'attempt' | 'message' | 'toolCall';
  readonly value: string;

  constructor(kind: AgentIdCollisionError['kind'], value: string) {
    super(`${kind} 标识符与会话历史或当前 Agent 已保留的值冲突：${value}`);
    this.kind = kind;
    this.value = value;
  }
}

type RuntimeFailureOutcome = Extract<TurnOutcome, 'failed' | 'cancelled'>;

/** 结算持久化错误。 */
export class SettlementPersistenceError extends Error {
  readonly originalError: unknown;
  readonly persistenceError: unknown;
  readonly outcome: RuntimeFailureOutcome;

  constructor(originalError: unknown, persistenceError: unknown, outcome: RuntimeFailureOutcome) {
    super(`failed to persist ${outcome} terminal settlement`, { cause: persistenceError });
    this.name = 'SettlementPersistenceError';
    this.originalError = originalError;
    this.persistenceError = persistenceError;
    this.outcome = outcome;
  }
}
