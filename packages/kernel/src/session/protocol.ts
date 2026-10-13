import type { ExecutionMetadata } from '../agent.js';
import type {
  AttemptId,
  MessageId,
  SessionBatchId,
  SessionId,
  StepId,
  TurnId,
} from '../identifiers.js';
import type { AssistantSettlement, UserMessage } from '../model.js';
import type { SerializedError } from '../serialization.js';
import type { ToolCallId, ToolCompleted } from '../tools/protocol.js';

/** step 结束时的状态。 */
export type StepOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** turn 结束时的状态。 */
export type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted';

/** turn 开始。 */
export interface TurnStarted {
  readonly type: 'turn.started';
  readonly turnId: TurnId;
  readonly execution?: ExecutionMetadata;
}

/** 用户消息写入会话。 */
export interface UserMessageAppended {
  readonly type: 'user.message';
  readonly message: UserMessage;
}

/** step 开始。 */
export interface StepStarted {
  readonly type: 'step.started';
  readonly turnId: TurnId;
  readonly stepId: StepId;
}

/** LLM 调用结果已结算并持久化。 */
export interface AssistantSettled {
  readonly type: 'assistant.settled';
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly settlement: AssistantSettlement;
}

/** step 已闭合。 */
export interface StepEnded {
  readonly type: 'step.ended';
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly outcome: StepOutcome;
}

/** turn 已闭合。 */
export interface TurnEnded {
  readonly type: 'turn.ended';
  readonly turnId: TurnId;
  readonly outcome: TurnOutcome;
  readonly error?: SerializedError;
}

/**
 * 会话事件日志中的领域事件。
 * 是模型可见历史、重放、恢复与审计的事实源；流式 chunk 不在此列。
 */
export type SessionEvent =
  | TurnStarted
  | UserMessageAppended
  | StepStarted
  | AssistantSettled
  | ToolCompleted
  | StepEnded
  | TurnEnded;

/**
 * 持久化时包裹 SessionEvent 的统一格式。
 * sequence 在会话内严格单调；timestamp 为 ISO-8601 字符串。
 */
export interface EventEnvelope {
  readonly version: 1;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: SessionEvent;
}

/** 提供不可变的会话事件快照。 */
export interface SessionReader {
  readonly sessionId: SessionId;

  read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]>;
  /** 开始释放资源；取消只停止本次等待，后台释放仍须继续。 */
  close(options: SessionOperationOptions): Promise<void>;
}

/** 定义可取消、append-only 且支持原子事件批次的会话 writer。 */
export interface SessionLog extends SessionReader {
  /** 原子追加一个事件批次；失败或取消时不得留下部分批次。 */
  append(
    events: readonly SessionEvent[],
    options: SessionAppendOptions,
  ): Promise<readonly EventEnvelope[]>;
  flush(options: SessionOperationOptions): Promise<void>;
}

export interface SessionOperationOptions {
  /** 控制当前存储操作，不代表 Agent 的 durable settlement 分类。 */
  readonly signal: AbortSignal;
}

/** 为原子追加提供取消、乐观 sequence 与可选批次身份。 */
export interface SessionAppendOptions extends SessionOperationOptions {
  /** 提供时必须等于追加前最后一个 sequence，首批为零。 */
  readonly expectedSequence?: number;
  /** 提供时成为持久批次身份；同一会话内不得重复。 */
  readonly batchId?: SessionBatchId;
}

/** 区分只读快照与独占 writer 的打开模式。 */
export type SessionOpenOptions =
  | { readonly mode: 'read'; readonly signal: AbortSignal }
  | { readonly mode: 'write'; readonly signal: AbortSignal };

/** 创建并按模式打开会话，不暴露具体存储布局。 */
export interface SessionRepository {
  create(sessionId: SessionId, options: SessionOperationOptions): Promise<SessionLog>;
  open(
    sessionId: SessionId,
    options: Extract<SessionOpenOptions, { mode: 'read' }>,
  ): Promise<SessionReader>;
  open(
    sessionId: SessionId,
    options: Extract<SessionOpenOptions, { mode: 'write' }>,
  ): Promise<SessionLog>;
}

/** 表示请求的会话不存在。 */
export class SessionNotFoundError extends Error {
  override readonly name = 'SessionNotFoundError';
}
/** 表示 create 的会话身份已经存在。 */
export class SessionAlreadyExistsError extends Error {
  override readonly name = 'SessionAlreadyExistsError';
}
/** 表示当前进程已有该会话的 writer。 */
export class SessionAlreadyOwnedError extends Error {
  override readonly name = 'SessionAlreadyOwnedError';
}
/** 表示完整持久记录无法通过协议校验。 */
export class SessionCorruptionError extends Error {
  override readonly name = 'SessionCorruptionError';
}
/** 表示调用方预期的日志尾部或 batch 身份冲突。 */
export class SessionSequenceConflictError extends Error {
  override readonly name = 'SessionSequenceConflictError';
}
/** 表示会话句柄已经关闭。 */
export class SessionClosedError extends Error {
  override readonly name = 'SessionClosedError';
}

/** 表示事件顺序或生命周期关联无法安全恢复。 */
export class SessionLifecycleCorruptionError extends Error {
  override readonly name = 'SessionLifecycleCorruptionError';
  readonly sequence: number | undefined;

  constructor(message: string, sequence?: number) {
    super(sequence === undefined ? message : `sequence ${sequence}：${message}`);
    this.sequence = sequence;
  }
}

/** 表示 create 已发布完整会话目录，但根目录同步失败。 */
export class SessionCreateUncertainError extends Error {
  override readonly name = 'SessionCreateUncertainError';
  readonly sessionId: SessionId;
  readonly published = true;

  constructor(sessionId: SessionId, cause: unknown) {
    super('会话已经发布，但 create 的 durability 结果不确定', { cause });
    this.sessionId = sessionId;
  }
}

/** 表示 writer 曾发生不确定提交，关闭前不得继续观察或写入。 */
export class SessionPoisonedError extends Error {
  override readonly name = 'SessionPoisonedError';
  readonly poisonReason: SessionUncertainCommitError;

  constructor(poisonReason: SessionUncertainCommitError) {
    super('会话 writer 因不确定提交而不可继续使用', { cause: poisonReason });
    this.poisonReason = poisonReason;
  }
}

/** 表示写入失败且回滚也失败，调用方不能推断批次是否提交。 */
export class SessionUncertainCommitError extends Error {
  readonly writeError: unknown;
  readonly rollbackError: unknown;

  constructor(writeError: unknown, rollbackError: unknown) {
    super('会话批次提交结果不确定', { cause: rollbackError });
    this.name = 'SessionUncertainCommitError';
    this.writeError = writeError;
    this.rollbackError = rollbackError;
  }
}

/** 释放单 writer 所有权；重复释放必须安全。 */
export interface SessionWriteLease {
  release(): void;
}

/** 为规范存储路径提供单 writer 所有权。 */
export interface SessionWriteLeaseProvider {
  acquire(key: string, signal: AbortSignal): Promise<SessionWriteLease>;
}

/** 为事件信封提供可替换且可测试的时间。 */
export interface SessionClock {
  now(): string;
}

/** 描述恢复前必须作为一个原子批次追加的最小生命周期修复。 */
export interface SessionLifecycleRepairPlan {
  readonly expectedSequence: number;
  readonly events: readonly SessionEvent[];
  readonly usedIds: SessionLifecycleIdNamespaces;
}

/** 恢复历史中已经占用的 Agent 标识符命名空间。 */
export interface SessionLifecycleIdNamespaces {
  readonly turnIds: readonly TurnId[];
  readonly stepIds: readonly StepId[];
  readonly attemptIds: readonly AttemptId[];
  readonly messageIds: readonly MessageId[];
  readonly toolCallIds: readonly ToolCallId[];
}
