import {
  brandId,
  type EventEnvelope,
  findSessionMessageSubmission,
  type MessageId,
  type SessionId,
  SessionMessageConflictError,
  type TurnId,
} from '@agent-harness/kernel';
import { describe, expect, it } from 'vitest';
import type { SubmittedMessage } from '../src/submission.ts';

const sessionId = brandId<'SessionId'>('session-1') as SessionId;
const turnId = brandId<'TurnId'>('turn-1') as TurnId;
const message: SubmittedMessage = {
  id: brandId<'MessageId'>('message-1') as MessageId,
  content: '你好',
};

function envelope(sequence: number, event: EventEnvelope['event']): EventEnvelope {
  return { version: 1, sessionId, sequence, timestamp: '2026-10-13T00:00:00.000Z', event };
}

describe('findPersistedSubmission', () => {
  it('从持久会话事实返回重复提交的终态', () => {
    expect(
      findSessionMessageSubmission(
        [
          envelope(1, { type: 'turn.started', turnId }),
          envelope(2, { type: 'user.message', message: { ...message, role: 'user' } }),
          envelope(3, { type: 'turn.ended', turnId, outcome: 'completed' }),
        ],
        { ...message, role: 'user' },
      ),
    ).toEqual({ status: 'completed' });
  });

  it('拒绝把相同 messageId 的不同内容当作重试', () => {
    expect(() =>
      findSessionMessageSubmission(
        [
          envelope(1, { type: 'turn.started', turnId }),
          envelope(2, { type: 'user.message', message: { ...message, role: 'user' } }),
        ],
        { ...message, role: 'user', content: '不同内容' },
      ),
    ).toThrow(SessionMessageConflictError);
  });
});
