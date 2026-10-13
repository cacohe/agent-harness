import {
  type AssistantSettlement,
  type AttemptId,
  assertNever,
  type EventEnvelope,
  type MessageId,
  type SessionEvent,
  type SessionId,
  type StepId,
  type StepOutcome,
  type TurnId,
} from '../facts.js';
import type { ToolCallId } from '../tools/protocol.js';
import {
  SessionLifecycleCorruptionError,
  type SessionLifecycleIdNamespaces,
  type SessionLifecycleRepairPlan,
} from './protocol.js';

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
  };

  for (let index = 0; index < envelopes.length; index += 1) {
    const envelope = envelopes[index]!;
    const expectedSequence = index + 1;
    if (envelope.version !== 1) corrupt('event envelope version 无效', envelope.sequence);
    if (envelope.sequence !== expectedSequence) {
      corrupt(`event sequence 应为 ${expectedSequence}`, envelope.sequence);
    }
    if (state.sessionId !== envelope.sessionId) {
      corrupt('event envelope 的 sessionId 不一致', envelope.sequence);
    }
    applyLifecycleEvent(state, envelope);
  }

  return {
    expectedSequence: envelopes.length,
    events: buildRecoveryEvents(state.turn),
    usedIds: snapshotUsedIds(state),
  };
}

interface LifecycleAnalysisState {
  readonly sessionId: SessionId | undefined;
  turn: OpenTurn | undefined;
  readonly usedTurnIds: Set<TurnId>;
  readonly usedStepIds: Set<StepId>;
  readonly usedAttemptIds: Set<AttemptId>;
  readonly usedMessageIds: Set<MessageId>;
  readonly usedToolCallIds: Set<ToolCallId>;
}

interface OpenTurn {
  readonly turnId: TurnId;
  userMessageSeen: boolean;
  stepCount: number;
  lastClosedStep: ClosedStep | undefined;
  step: OpenStep | undefined;
}

interface OpenStep {
  readonly stepId: StepId;
  settlement: AssistantSettlement | undefined;
  toolCallIds: readonly ToolCallId[];
  readonly resultIds: Set<ToolCallId>;
}

interface ClosedStep {
  readonly settlement: AssistantSettlement | undefined;
  readonly outcome: StepOutcome;
}

function applyLifecycleEvent(state: LifecycleAnalysisState, envelope: EventEnvelope): void {
  const event = envelope.event;
  const sequence = envelope.sequence;
  switch (event.type) {
    case 'turn.started': {
      if (state.turn !== undefined) corrupt('前一个 turn 尚未闭合', sequence);
      uniqueId(state.usedTurnIds, event.turnId, 'turnId 重复', sequence);
      state.turn = {
        turnId: event.turnId,
        userMessageSeen: false,
        stepCount: 0,
        lastClosedStep: undefined,
        step: undefined,
      };
      return;
    }
    case 'user.message': {
      const turn = requireTurn(state, sequence);
      if (turn.stepCount > 0 || turn.step !== undefined) {
        corrupt('user.message 必须出现在第一个 step 之前', sequence);
      }
      if (turn.userMessageSeen) corrupt('一个 turn 只能接纳一条 user.message', sequence);
      uniqueId(state.usedMessageIds, event.message.id, 'messageId 重复', sequence);
      turn.userMessageSeen = true;
      return;
    }
    case 'step.started': {
      const turn = requireMatchingTurn(state, event.turnId, sequence);
      if (turn.step !== undefined) corrupt('前一个 step 尚未闭合', sequence);
      if (!turn.userMessageSeen) corrupt('step.started 之前缺少 user.message', sequence);
      if (
        turn.stepCount > 0 &&
        (turn.lastClosedStep?.outcome !== 'completed' ||
          turn.lastClosedStep.settlement?.status !== 'completed' ||
          turn.lastClosedStep.settlement.message.toolCalls.length === 0)
      ) {
        corrupt('只有产生工具调用并成功闭合的 step 才能继续下一 step', sequence);
      }
      uniqueId(state.usedStepIds, event.stepId, 'stepId 重复', sequence);
      turn.stepCount += 1;
      turn.step = {
        stepId: event.stepId,
        settlement: undefined,
        toolCallIds: [],
        resultIds: new Set(),
      };
      return;
    }
    case 'assistant.settled': {
      const step = requireMatchingStep(state, event.turnId, event.stepId, sequence);
      if (step.settlement !== undefined)
        corrupt('一个 step 只能有一次 assistant settlement', sequence);
      uniqueId(state.usedAttemptIds, event.settlement.attemptId, 'attemptId 重复', sequence);
      if (event.settlement.status === 'completed') {
        uniqueId(state.usedMessageIds, event.settlement.message.id, 'messageId 重复', sequence);
        const callIds: ToolCallId[] = [];
        for (const call of event.settlement.message.toolCalls) {
          uniqueId(state.usedToolCallIds, call.id, 'tool call id 重复', sequence);
          callIds.push(call.id);
        }
        step.toolCallIds = callIds;
      } else {
        for (const call of event.settlement.observedToolCalls) {
          uniqueId(state.usedToolCallIds, call.id, 'tool call id 重复', sequence);
        }
      }
      step.settlement = event.settlement;
      return;
    }
    case 'tool.completed': {
      const step = requireMatchingStep(state, event.turnId, event.stepId, sequence);
      if (step.settlement?.status !== 'completed') {
        corrupt('tool.completed 缺少已完成的 assistant settlement', sequence);
      }
      if (step.resultIds.has(event.result.callId)) {
        corrupt('同一 tool call 出现多个 result', sequence);
      }
      const expectedCallId = step.toolCallIds[step.resultIds.size];
      if (expectedCallId !== event.result.callId) {
        corrupt('tool result 必须按 assistant tool call 顺序构成连续前缀', sequence);
      }
      step.resultIds.add(event.result.callId);
      return;
    }
    case 'step.ended': {
      const turn = requireMatchingTurn(state, event.turnId, sequence);
      const step = requireMatchingStep(state, event.turnId, event.stepId, sequence);
      if (event.outcome === 'completed' && step.settlement?.status !== 'completed') {
        corrupt('completed step 缺少 completed assistant settlement', sequence);
      }
      if (
        step.settlement?.status === 'completed' &&
        step.toolCallIds.some((callId) => !step.resultIds.has(callId))
      ) {
        corrupt('已闭合 step 缺少 tool result', sequence);
      }
      turn.lastClosedStep = { settlement: step.settlement, outcome: event.outcome };
      turn.step = undefined;
      return;
    }
    case 'turn.ended': {
      const turn = requireMatchingTurn(state, event.turnId, sequence);
      if (turn.step !== undefined) corrupt('turn.ended 之前 step 尚未闭合', sequence);
      if (
        event.outcome === 'completed' &&
        (turn.lastClosedStep?.outcome !== 'completed' ||
          turn.lastClosedStep.settlement?.status !== 'completed' ||
          turn.lastClosedStep.settlement.message.toolCalls.length > 0)
      ) {
        corrupt('completed turn 缺少无工具调用的最终 assistant message', sequence);
      }
      state.turn = undefined;
      return;
    }
    default:
      assertNever(event);
  }
}

function buildRecoveryEvents(turn: OpenTurn | undefined): readonly SessionEvent[] {
  if (turn === undefined) return [];
  const events: SessionEvent[] = [];
  const step = turn.step;
  if (step !== undefined) {
    if (step.settlement?.status === 'completed') {
      for (const callId of step.toolCallIds) {
        if (step.resultIds.has(callId)) continue;
        events.push({
          type: 'tool.completed',
          turnId: turn.turnId,
          stepId: step.stepId,
          result: {
            status: 'unknown',
            callId,
            reason: '进程中断后无法确认工具是否已经执行，外部副作用状态未知',
          },
        });
      }
    }
    events.push({
      type: 'step.ended',
      turnId: turn.turnId,
      stepId: step.stepId,
      outcome: 'interrupted',
    });
  }
  events.push({
    type: 'turn.ended',
    turnId: turn.turnId,
    outcome: 'interrupted',
  });
  return events;
}

function requireTurn(state: LifecycleAnalysisState, sequence: number): OpenTurn {
  if (state.turn === undefined) corrupt('事件不属于活动 turn', sequence);
  return state.turn;
}

function requireMatchingTurn(
  state: LifecycleAnalysisState,
  turnId: TurnId,
  sequence: number,
): OpenTurn {
  const turn = requireTurn(state, sequence);
  if (turn.turnId !== turnId) corrupt('turnId 与活动 turn 不一致', sequence);
  return turn;
}

function requireMatchingStep(
  state: LifecycleAnalysisState,
  turnId: TurnId,
  stepId: StepId,
  sequence: number,
): OpenStep {
  const turn = requireMatchingTurn(state, turnId, sequence);
  if (turn.step === undefined) corrupt('事件不属于活动 step', sequence);
  if (turn.step.stepId !== stepId) corrupt('stepId 与活动 step 不一致', sequence);
  return turn.step;
}

function uniqueId<T>(values: Set<T>, value: T, message: string, sequence: number): void {
  if (values.has(value)) corrupt(message, sequence);
  values.add(value);
}

function corrupt(message: string, sequence?: number): never {
  throw new SessionLifecycleCorruptionError(message, sequence);
}

function snapshotUsedIds(state: LifecycleAnalysisState): SessionLifecycleIdNamespaces {
  return Object.freeze({
    turnIds: Object.freeze([...state.usedTurnIds]),
    stepIds: Object.freeze([...state.usedStepIds]),
    attemptIds: Object.freeze([...state.usedAttemptIds]),
    messageIds: Object.freeze([...state.usedMessageIds]),
    toolCallIds: Object.freeze([...state.usedToolCallIds]),
  });
}
