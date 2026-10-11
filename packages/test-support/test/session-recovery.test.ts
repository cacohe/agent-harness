import { describe, expect, it } from 'vitest'
import {
  brandId,
  type AttemptId,
  type EventEnvelope,
  type MessageId,
  type SessionEvent,
  type SessionId,
  type StepId,
  type ToolCallId,
  type TurnId,
  SessionLifecycleCorruptionError,
} from '@agent-harness/kernel'
import { analyzeSessionLifecycle } from '@agent-harness/session-lifecycle'
import { deriveModelMessages } from '@agent-harness/context-runtime'

const sessionId = brandId<'SessionId'>('recovery-session') as SessionId
const turnId = brandId<'TurnId'>('turn-1') as TurnId
const stepId = brandId<'StepId'>('step-1') as StepId
const attemptId = brandId<'AttemptId'>('attempt-1') as AttemptId
const assistantId = brandId<'MessageId'>('assistant-1') as MessageId
const userId = brandId<'MessageId'>('user-1') as MessageId
const firstCallId = brandId<'ToolCallId'>('call-1') as ToolCallId
const secondCallId = brandId<'ToolCallId'>('call-2') as ToolCallId

function envelopes(events: readonly SessionEvent[]): readonly EventEnvelope[] {
  return events.map((event, index) => ({
    version: 1,
    sessionId,
    sequence: index + 1,
    timestamp: '2026-09-21T00:00:00.000Z',
    event,
  }))
}

function turnStart(): SessionEvent {
  return { type: 'turn.started', turnId }
}

function userMessage(): SessionEvent {
  return {
    type: 'user.message',
    message: { id: userId, role: 'user', content: '继续' },
  }
}

function stepStart(id: StepId = stepId): SessionEvent {
  return { type: 'step.started', turnId, stepId: id }
}

function completedAssistant(callIds: readonly ToolCallId[]): SessionEvent {
  return {
    type: 'assistant.settled',
    turnId,
    stepId,
    settlement: {
      status: 'completed',
      attemptId,
      message: {
        id: assistantId,
        role: 'assistant',
        content: '',
        toolCalls: callIds.map((id, index) => ({
          id,
          name: `tool-${index + 1}`,
          input: {},
        })),
      },
    },
  }
}

function success(callId: ToolCallId): SessionEvent {
  return {
    type: 'tool.completed',
    turnId,
    stepId,
    result: { status: 'success', callId, output: 'ok' },
  }
}

describe('analyzeSessionLifecycle', () => {
  it('完整日志不生成修复事件', () => {
    const history = envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([]),
      { type: 'step.ended', turnId, stepId, outcome: 'completed' },
      { type: 'turn.ended', turnId, outcome: 'completed' },
    ])

    expect(analyzeSessionLifecycle(history)).toEqual({
      expectedSequence: history.length,
      events: [],
      usedIds: {
        turnIds: [turnId],
        stepIds: [stepId],
        attemptIds: [attemptId],
        messageIds: [userId, assistantId],
        toolCallIds: [],
      },
    })
  })

  it('修复仅开始 turn 的日志', () => {
    expect(analyzeSessionLifecycle(envelopes([turnStart()])).events).toEqual([
      { type: 'turn.ended', turnId, outcome: 'interrupted' },
    ])
  })

  it('修复尚未创建 attempt 的活动 step', () => {
    expect(analyzeSessionLifecycle(envelopes([
      turnStart(), userMessage(), stepStart(),
    ])).events).toEqual([
      { type: 'step.ended', turnId, stepId, outcome: 'interrupted' },
      { type: 'turn.ended', turnId, outcome: 'interrupted' },
    ])
  })

  it('按 tool call 顺序为全部缺失结果写入 unknown', () => {
    const plan = analyzeSessionLifecycle(envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([firstCallId, secondCallId]),
    ]))

    expect(plan.events.map(event => event.type)).toEqual([
      'tool.completed',
      'tool.completed',
      'step.ended',
      'turn.ended',
    ])
    expect(plan.events.slice(0, 2)).toMatchObject([
      { result: { status: 'unknown', callId: firstCallId } },
      { result: { status: 'unknown', callId: secondCallId } },
    ])
  })

  it('只为缺失的 tool result 写入 unknown', () => {
    const plan = analyzeSessionLifecycle(envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([firstCallId, secondCallId]),
      success(firstCallId),
    ]))

    expect(plan.events[0]).toMatchObject({
      type: 'tool.completed',
      result: { status: 'unknown', callId: secondCallId },
    })
    expect(plan.usedIds.toolCallIds).toEqual([firstCallId, secondCallId])
  })

  it('拒绝跳过前序 tool call 的结果', () => {
    expect(() => analyzeSessionLifecycle(envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([firstCallId, secondCallId]),
      success(secondCallId),
    ]))).toThrow(SessionLifecycleCorruptionError)
  })

  it('只有完成工具 step 后才能开始下一 step', () => {
    const secondStepId = brandId<'StepId'>('step-2') as StepId
    const plan = analyzeSessionLifecycle(envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([firstCallId]),
      success(firstCallId),
      { type: 'step.ended', turnId, stepId, outcome: 'completed' },
      stepStart(secondStepId),
    ]))

    expect(plan.events).toEqual([
      {
        type: 'step.ended',
        turnId,
        stepId: secondStepId,
        outcome: 'interrupted',
      },
      { type: 'turn.ended', turnId, outcome: 'interrupted' },
    ])
  })

  it.each([
    { name: '失败 step', outcome: 'failed' as const },
    { name: '取消 step', outcome: 'cancelled' as const },
    { name: '中断 step', outcome: 'interrupted' as const },
  ])('拒绝在$name 后继续下一 step', ({ outcome }) => {
    const secondStepId = brandId<'StepId'>('forbidden-step-2') as StepId
    expect(() => analyzeSessionLifecycle(envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([firstCallId]),
      success(firstCallId),
      { type: 'step.ended', turnId, stepId, outcome },
      stepStart(secondStepId),
    ]))).toThrow(SessionLifecycleCorruptionError)
  })

  it('拒绝在无工具的最终回复后继续下一 step', () => {
    const secondStepId = brandId<'StepId'>('forbidden-final-step') as StepId
    expect(() => analyzeSessionLifecycle(envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([]),
      { type: 'step.ended', turnId, stepId, outcome: 'completed' },
      stepStart(secondStepId),
    ]))).toThrow(SessionLifecycleCorruptionError)
  })

  it('返回不可变的历史 ID 命名空间快照', () => {
    const plan = analyzeSessionLifecycle(envelopes([
      turnStart(), userMessage(), stepStart(),
    ]))

    expect(() => {
      ;(plan.usedIds.turnIds as TurnId[]).push(
        brandId<'TurnId'>('mutated') as TurnId,
      )
    }).toThrow(TypeError)
    expect(plan.usedIds.turnIds).toEqual([turnId])
  })

  it('step 已闭合时只修复 turn', () => {
    const plan = analyzeSessionLifecycle(envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([]),
      { type: 'step.ended', turnId, stepId, outcome: 'completed' },
    ]))
    expect(plan.events).toEqual([
      { type: 'turn.ended', turnId, outcome: 'interrupted' },
    ])
  })

  it('允许 completed step 后以非 completed outcome 闭合 turn', () => {
    const history = envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([]),
      { type: 'step.ended', turnId, stepId, outcome: 'completed' },
      {
        type: 'turn.ended',
        turnId,
        outcome: 'failed',
        error: { name: 'Error', message: 'turn settlement failed' },
      },
    ])

    expect(analyzeSessionLifecycle(history).events).toEqual([])
  })

  it.each([
    {
      name: '嵌套 turn',
      events: [turnStart(), turnStart()],
    },
    {
      name: 'turnId 错配',
      events: [
        turnStart(),
        userMessage(),
        {
          type: 'step.started' as const,
          turnId: brandId<'TurnId'>('wrong-turn') as TurnId,
          stepId,
        },
      ],
    },
    {
      name: '重复 tool result',
      events: [
        turnStart(),
        userMessage(),
        stepStart(),
        completedAssistant([firstCallId]),
        success(firstCallId),
        success(firstCallId),
      ],
    },
    {
      name: '已闭合 step 后继续追加',
      events: [
        turnStart(),
        userMessage(),
        stepStart(),
        completedAssistant([]),
        { type: 'step.ended' as const, turnId, stepId, outcome: 'completed' as const },
        completedAssistant([]),
      ],
    },
  ])('拒绝$name', ({ events }) => {
    expect(() => analyzeSessionLifecycle(envelopes(events)))
      .toThrow(SessionLifecycleCorruptionError)
  })

  it('unknown tool result 会进入下一次模型请求投影', () => {
    const history = envelopes([
      turnStart(),
      userMessage(),
      stepStart(),
      completedAssistant([firstCallId]),
      {
        type: 'tool.completed',
        turnId,
        stepId,
        result: {
          status: 'unknown',
          callId: firstCallId,
          reason: '副作用状态未知',
        },
      },
    ])

    expect(deriveModelMessages(history).at(-1)).toMatchObject({
      role: 'tool',
      result: { status: 'unknown', callId: firstCallId },
    })
  })
})
