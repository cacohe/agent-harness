import { deriveModelMessages } from '@agent-harness/context-runtime';
import {
  brandId,
  type EventEnvelope,
  type MessageId,
  type SessionEvent,
  type SessionId,
  type StepId,
  type ToolCallId,
  type TurnId,
} from '@agent-harness/kernel';
import { InMemorySessionLog } from '@agent-harness/session-memory';
import { describe, expect, it } from 'vitest';

describe('InMemorySessionLog', () => {
  it('保存不可变快照，不受输入和读取结果修改影响', async () => {
    const session = new InMemorySessionLog(brandId<'SessionId'>('immutable-session') as SessionId);
    const mutableMessage = {
      id: brandId<'MessageId'>('mutable-message') as MessageId,
      role: 'user' as const,
      content: 'original',
    };
    const event: SessionEvent = { type: 'user.message', message: mutableMessage };

    const appended = await session.append([event], {
      signal: new AbortController().signal,
    });
    mutableMessage.content = 'changed after append';
    (appended as EventEnvelope[]).push(appended[0]!);

    const firstRead = await session.read({
      signal: new AbortController().signal,
    });
    expect(() => {
      const messageEvent = firstRead[0]?.event;
      if (messageEvent?.type === 'user.message') {
        (messageEvent.message as { content: string }).content = 'changed after read';
      }
    }).toThrow(TypeError);
    (firstRead as EventEnvelope[]).splice(0, firstRead.length);

    const secondRead = await session.read({
      signal: new AbortController().signal,
    });
    expect(secondRead).toHaveLength(1);
    expect(deriveModelMessages(secondRead)).toEqual([
      {
        id: mutableMessage.id,
        role: 'user',
        content: 'original',
      },
    ]);
  });

  it('事件批次快照失败时不追加部分事件', async () => {
    const session = new InMemorySessionLog(brandId<'SessionId'>('atomic-session') as SessionId);
    const messageEvent: SessionEvent = {
      type: 'user.message',
      message: {
        id: brandId<'MessageId'>('atomic-message') as MessageId,
        role: 'user',
        content: 'must not commit',
      },
    };
    const invalidEvent: SessionEvent = {
      type: 'tool.completed',
      turnId: brandId<'TurnId'>('atomic-turn') as TurnId,
      stepId: brandId<'StepId'>('atomic-step') as StepId,
      result: {
        status: 'success',
        callId: brandId<'ToolCallId'>('atomic-call') as ToolCallId,
        output: () => undefined,
      },
    };

    await expect(
      session.append([messageEvent, invalidEvent], {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();

    await expect(
      session.read({
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual([]);
  });
});
