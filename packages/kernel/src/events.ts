import type { ExecutionMetadata } from './agent.js';
import type {
  AttemptId,
  ExecutionId,
  MessageId,
  SessionId,
  StepId,
  TurnId,
} from './identifiers.js';
import type {
  AssistantCompleted,
  AssistantFailed,
  AssistantInterrupted,
  AssistantMessage,
  UserMessage,
} from './model.js';
import type { JsonValue, SerializedError } from './serialization.js';
import type {
  ToolCall,
  ToolCallId,
  ToolCancelled,
  ToolFailure,
  ToolSuccess,
  ToolUnknown,
} from './tools/protocol.js';

/**
 * Agent 一次运行中的事件。
 * 调度、attempt、step、turn、tool 都是 `AgentRuntimeEvent` 的子集。
 * 流式输出单独放在 `StreamEvent`，不进入这套事件。
 *
 * 同一业务动作只保留一种事件。终态仍用不同的 `type` 区分。
 * 合并时保留原先会话事件和观测事件上的全部参数。
 */
export type AgentRuntimeEvent =
  | InboxEnqueuedEvent
  | InboxRemovedEvent
  | TurnStartedEvent
  | UserMessageEvent
  | StepStartedEvent
  | AttemptStartedEvent
  | AttemptCompletedEvent
  | AttemptFailedEvent
  | AttemptCancelledEvent
  | AttemptInterruptedEvent
  | AttemptUsageEvent
  | ToolCallStartedEvent
  | ToolCallCompletedEvent
  | ToolCallFailedEvent
  | ToolCallCancelledEvent
  | ToolCallUnknownEvent
  | StepCompletedEvent
  | StepFailedEvent
  | StepCancelledEvent
  | StepInterruptedEvent
  | TurnCompletedEvent
  | TurnFailedEvent
  | TurnCancelledEvent
  | TurnInterruptedEvent;

/** 用户输入已进入 inbox，等待 FIFO 领取。 */
export interface InboxEnqueuedEvent {
  readonly type: 'inbox.enqueued';
  readonly message: UserMessage;
}

/** 用户输入在被领取前离开 inbox。 */
export interface InboxRemovedEvent {
  readonly type: 'inbox.removed';
  readonly messageId: MessageId;
  readonly reason?: string;
}

interface TurnScope {
  readonly turnId: TurnId;
}

/** turn 已开始。 */
export interface TurnStartedEvent extends TurnScope {
  readonly type: 'turn.started';
  readonly execution?: ExecutionMetadata;
}

/** 用户消息已写入当前 turn。 */
export interface UserMessageEvent {
  readonly type: 'user.message';
  readonly message: UserMessage;
}

interface TurnEndScope extends TurnScope {
  readonly error?: SerializedError;
}

/** turn 正常闭合。 */
export interface TurnCompletedEvent extends TurnEndScope {
  readonly type: 'turn.completed';
  readonly outcome: 'completed';
}

/** turn 因错误闭合。 */
export interface TurnFailedEvent extends TurnEndScope {
  readonly type: 'turn.failed';
  readonly outcome: 'failed';
}

/** turn 因调用方取消而闭合。 */
export interface TurnCancelledEvent extends TurnEndScope {
  readonly type: 'turn.cancelled';
  readonly outcome: 'cancelled';
}

/** turn 因进程中断而闭合。 */
export interface TurnInterruptedEvent extends TurnEndScope {
  readonly type: 'turn.interrupted';
  readonly outcome: 'interrupted';
}

interface StepScope {
  readonly turnId: TurnId;
  readonly stepId: StepId;
}

/** step 已开始。 */
export interface StepStartedEvent extends StepScope {
  readonly type: 'step.started';
}

/** step 正常闭合。 */
export interface StepCompletedEvent extends StepScope {
  readonly type: 'step.completed';
  readonly outcome: 'completed';
}

/** step 因错误闭合。 */
export interface StepFailedEvent extends StepScope {
  readonly type: 'step.failed';
  readonly outcome: 'failed';
  readonly error: SerializedError;
}

/** step 因调用方取消而闭合。 */
export interface StepCancelledEvent extends StepScope {
  readonly type: 'step.cancelled';
  readonly outcome: 'cancelled';
  readonly error: SerializedError;
}

/** step 因进程中断而闭合。 */
export interface StepInterruptedEvent extends StepScope {
  readonly type: 'step.interrupted';
  readonly outcome: 'interrupted';
  readonly reason: string;
}

/** 一次 attempt 或工具调用的关联身份。 */
interface ExecutionScope {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly attemptId: AttemptId;
  readonly executionId?: ExecutionId;
}

/** 时钟中途不可用时省略耗时。 */
interface TimedExecution {
  readonly durationMs?: number;
}

/** attempt 开始，对应原先的 `model.started`。 */
export interface AttemptStartedEvent extends ExecutionScope {
  readonly type: 'attempt.started';
  readonly startedAt: Date;
}

/** attempt 正常结束，对应原先的 `model.completed` 与成功的助手结算。 */
export interface AttemptCompletedEvent extends ExecutionScope, TimedExecution {
  readonly type: 'attempt.completed';
  readonly errorName?: string;
  readonly message: AssistantMessage;
  readonly settlement: AssistantCompleted;
}

/** attempt 失败，对应原先的 `model.failed` 与失败的助手结算。 */
export interface AttemptFailedEvent extends ExecutionScope, TimedExecution {
  readonly type: 'attempt.failed';
  readonly errorName?: string;
  readonly partialText: string;
  readonly observedToolCalls: readonly ToolCall[];
  readonly error: SerializedError;
  readonly settlement: AssistantFailed;
}

/** attempt 被调用方取消，对应原先的 `model.cancelled`。 */
export interface AttemptCancelledEvent extends ExecutionScope, TimedExecution {
  readonly type: 'attempt.cancelled';
  readonly errorName?: string;
  readonly partialText: string;
  readonly observedToolCalls: readonly ToolCall[];
  readonly reason: string;
  readonly settlement: AssistantInterrupted;
}

/** attempt 因进程中断而无法按成功或失败闭合。 */
export interface AttemptInterruptedEvent {
  readonly type: 'attempt.interrupted';
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly attemptId: AttemptId;
  readonly partialText: string;
  readonly observedToolCalls: readonly ToolCall[];
  readonly reason: string;
  readonly settlement: AssistantInterrupted;
}

/** 一次 attempt 内可累加的 token 增量。它不是流式 `usage`。 */
export interface AttemptUsageEvent extends ExecutionScope {
  readonly type: 'model.usage';
  readonly usageSequence: number;
  readonly inputTokensDelta: number;
  readonly outputTokensDelta: number;
}

interface ToolScope extends ExecutionScope {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
}

/** 开始执行一次工具调用，对应原先的 `tool.started`。 */
export interface ToolCallStartedEvent extends ToolScope {
  readonly type: 'tool.started';
  readonly startedAt: Date;
}

/** 工具调用成功。保留会话中的 `result` 和观测中的 `status`。 */
export interface ToolCallCompletedEvent extends ToolScope, TimedExecution {
  readonly type: 'tool.completed';
  readonly output: JsonValue;
  readonly result: ToolSuccess;
  readonly status: 'success';
}

/** 工具调用失败。 */
export interface ToolCallFailedEvent extends ToolScope, TimedExecution {
  readonly type: 'tool.failed';
  readonly errorName?: string;
  readonly error: SerializedError;
  readonly result: ToolFailure;
  readonly status: 'failure';
}

/** 工具调用被取消。 */
export interface ToolCallCancelledEvent extends ToolScope, TimedExecution {
  readonly type: 'tool.cancelled';
  readonly errorName?: string;
  readonly reason: string;
  readonly result: ToolCancelled;
  readonly status: 'cancelled';
}

/** 无法确认工具是否执行及其外部副作用。 */
export interface ToolCallUnknownEvent extends ToolScope, TimedExecution {
  readonly type: 'tool.unknown';
  readonly reason: string;
  readonly result: ToolUnknown;
  readonly status: 'unknown';
}

/**
 * 持久化时包裹一次运行事件的统一格式。
 * sequence 在会话内严格单调；timestamp 为 ISO-8601 字符串。
 */
export interface EventEnvelope {
  readonly version: 1;
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: AgentRuntimeEvent;
}

/** 模型输出的文本增量。 */
export interface TextDeltaEvent {
  readonly type: 'text.delta';
  readonly text: string;
}

/** 模型输出中观察到的一次工具调用。此时尚未执行工具。 */
export interface ToolCallStreamEvent {
  readonly type: 'tool.call';
  readonly call: ToolCall;
}

/** 模型报告的累计 token 用量。 */
export interface ModelUsageStreamEvent {
  readonly type: 'usage';
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type StreamEvent = TextDeltaEvent | ToolCallStreamEvent | ModelUsageStreamEvent;
