import type { AttemptId, ExecutionId, SessionId, StepId, TurnId } from '../identifiers.js';
import type { ModelStreamEvent } from '../model.js';
import type { EventEnvelope } from '../session/protocol.js';
import type { ToolCallId, ToolResult } from '../tools/protocol.js';

/** 观察 Agent 已提交的会话事实与瞬态执行信号。 */
export interface AgentObserver {
  onStream?(event: ModelStreamEvent): void | Promise<void>;
  onSessionEvent?(envelope: EventEnvelope): void | Promise<void>;
  onObservation?(observation: ExecutionObservation): void | Promise<void>;
}

/** 不进入会话日志的模型与工具调用观测信号。 */
export type ExecutionObservation =
  | ModelInvocationStarted
  | ModelInvocationFinished
  | ModelInvocationUsage
  | ToolInvocationStarted
  | ToolInvocationFinished;

interface InvocationScope {
  readonly sessionId: SessionId;
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly attemptId: AttemptId;
  readonly executionId?: ExecutionId;
}

interface FinishedInvocation extends InvocationScope {
  /** 时钟中途不可用时省略，不能影响已开始的观测生命周期。 */
  readonly durationMs?: number;
}

interface ModelInvocationStarted extends InvocationScope {
  readonly type: 'model.invocation.started';
  readonly startedAt: Date;
}

interface ModelInvocationFinished extends FinishedInvocation {
  readonly type: 'model.invocation.finished';
  readonly outcome: 'completed' | 'failed' | 'cancelled';
  readonly errorName?: string;
}

interface ModelInvocationUsage extends InvocationScope {
  readonly type: 'model.invocation.usage';
  readonly usageSequence: number;
  readonly inputTokensDelta: number;
  readonly outputTokensDelta: number;
}

interface ToolInvocationScope extends InvocationScope {
  readonly toolCallId: ToolCallId;
  readonly toolName: string;
}

interface ToolInvocationStarted extends ToolInvocationScope {
  readonly type: 'tool.invocation.started';
  readonly startedAt: Date;
}

type ToolInvocationFinished =
  | (FinishedInvocation &
      ToolInvocationScope & {
        readonly type: 'tool.invocation.finished';
        readonly termination: 'returned';
        readonly resultStatus: ToolResult['status'];
      })
  | (FinishedInvocation &
      ToolInvocationScope & {
        readonly type: 'tool.invocation.finished';
        readonly termination: 'failed' | 'cancelled';
        readonly errorName?: string;
      });
