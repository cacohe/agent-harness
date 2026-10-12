import {
  type AssistantSettlement,
  type AttemptId,
  type SessionEvent,
  type StepId,
  serializeError,
  type ToolCall,
  type ToolCallId,
  type ToolResult,
  type TurnId,
  type TurnOutcome,
} from '@agent-harness/kernel';

type RuntimeFailureOutcome = Extract<TurnOutcome, 'failed' | 'cancelled'>;

/** 跟踪单次模型 attempt 的流式累积、结算与工具结果，供失败路径补写事件。 */
export interface Attempt {
  readonly attemptId: AttemptId;
  partialText: string; // 模型生成时的中间输出
  readonly observedToolCalls: ToolCall[]; // 模型生成时观察到的工具调用
  settlement?: AssistantSettlement; // 模型生成后的结算结果
  settlementPersisted: boolean; // 结算结果是否已持久化
  readonly toolResults: Map<ToolCallId, ToolResult>;
  readonly persistedToolResults: Set<ToolCallId>; // 工具调用结果是否已持久化
}

/** 跟踪 step 是否已开始/结束，以及其中的 attempt，供 terminal settlement 使用。 */
export interface Step {
  readonly stepId: StepId;
  started: boolean;
  ended: boolean;
  attempt?: Attempt;
}

/** 创建一次 step。 */
export function createStep(stepId: StepId): Step {
  return { stepId, started: false, ended: false };
}

/** 构建 terminal settlement 事件。 */
export function buildTerminalEvents(options: {
  readonly error: unknown;
  readonly outcome: RuntimeFailureOutcome;
  readonly turnId: TurnId;
  readonly turnStarted: boolean;
  readonly turnEnded: boolean;
  readonly step: Step | undefined;
}): SessionEvent[] {
  const events: SessionEvent[] = [];
  const { error, outcome, turnId, step } = options;

  if (step?.started === true && !step.ended) {
    const attempt = step.attempt;
    if (attempt !== undefined) {
      const settlement =
        attempt.settlement ?? buildUnsuccessfulAttemptSettlement(attempt, outcome, error);
      if (!attempt.settlementPersisted) {
        events.push({
          type: 'assistant.settled',
          turnId,
          stepId: step.stepId,
          settlement,
        });
      }
      if (settlement.status === 'completed') {
        for (const call of settlement.message.toolCalls) {
          if (attempt.persistedToolResults.has(call.id)) continue;
          events.push({
            type: 'tool.completed',
            turnId,
            stepId: step.stepId,
            result:
              attempt.toolResults.get(call.id) ?? buildUnexecutedToolResult(call, outcome, error),
          });
        }
      }
    }
    events.push({
      type: 'step.ended',
      turnId,
      stepId: step.stepId,
      outcome,
    });
  }

  if (options.turnStarted && !options.turnEnded) {
    events.push({
      type: 'turn.ended',
      turnId,
      outcome,
      error: serializeError(error),
    });
  }
  return events;
}

/** 根据失败或取消结果构建未成功 attempt 的结算。 */
function buildUnsuccessfulAttemptSettlement(
  attempt: Attempt,
  outcome: RuntimeFailureOutcome,
  error: unknown,
): AssistantSettlement {
  if (outcome === 'cancelled') {
    return {
      status: 'interrupted',
      attemptId: attempt.attemptId,
      partialText: attempt.partialText,
      observedToolCalls: attempt.observedToolCalls,
      reason: formatErrorMessage(error),
    };
  }
  return {
    status: 'failed',
    attemptId: attempt.attemptId,
    partialText: attempt.partialText,
    observedToolCalls: attempt.observedToolCalls,
    error: serializeError(error),
  };
}

/** 构建未执行的工具调用结果（模型生成失败时，工具调用结果为未执行）。 */
function buildUnexecutedToolResult(
  call: ToolCall,
  outcome: RuntimeFailureOutcome,
  error: unknown,
): ToolResult {
  if (outcome === 'cancelled') {
    return { status: 'cancelled', callId: call.id, reason: formatErrorMessage(error) };
  }
  return {
    status: 'failure',
    callId: call.id,
    error: {
      name: 'ToolNotExecutedError',
      message: `tool was not executed because the step failed: ${formatErrorMessage(error)}`,
    },
  };
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
