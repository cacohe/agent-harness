import { brandId, type EventEnvelope, type SessionId } from '@agent-harness/kernel';
import { describe, expect, it } from 'vitest';
import { projectChatTranscript } from '../src/transcript.ts';

function envelope(sequence: number, event: EventEnvelope['event']): EventEnvelope {
  return {
    version: 1,
    sessionId: brandId<'SessionId'>('session') as SessionId,
    sequence,
    timestamp: '2026-01-01T00:00:00.000Z',
    event,
  };
}

describe('projectChatTranscript', () => {
  it('只投影用户消息、已完成助手回复和工具结果', () => {
    const messages = projectChatTranscript([
      envelope(1, { type: 'turn.started', turnId: brandId('turn-1') }),
      envelope(2, {
        type: 'user.message',
        message: { id: brandId('m1'), role: 'user', content: '列出目录' },
      }),
      envelope(3, {
        type: 'assistant.settled',
        turnId: brandId('turn-1'),
        stepId: brandId('step-1'),
        settlement: {
          status: 'completed',
          attemptId: brandId('a1'),
          message: {
            id: brandId('m2'),
            role: 'assistant',
            content: '目录如下',
            toolCalls: [],
          },
        },
      }),
      envelope(4, {
        type: 'tool.completed',
        turnId: brandId('turn-1'),
        stepId: brandId('step-1'),
        result: {
          status: 'success',
          callId: brandId('c1'),
          output: { ok: true },
        },
      }),
      envelope(5, {
        type: 'assistant.settled',
        turnId: brandId('turn-1'),
        stepId: brandId('step-2'),
        settlement: {
          status: 'interrupted',
          attemptId: brandId('a2'),
          partialText: '半句',
          observedToolCalls: [],
          reason: 'cancelled',
        },
      }),
    ]);
    expect(messages).toEqual([
      { kind: 'user', content: '列出目录' },
      { kind: 'assistant', content: '目录如下' },
      { kind: 'tool', content: '工具执行完成：success' },
    ]);
  });
});
