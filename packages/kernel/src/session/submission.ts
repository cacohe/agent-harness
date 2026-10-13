import type { TurnId } from '../identifiers.js';
import type { UserMessage } from '../model.js';
import type { EventEnvelope, TurnOutcome } from './protocol.js';

/** 已持久化用户消息对应的执行状态。 */
export type SessionMessageSubmission = { readonly status: 'accepted' | TurnOutcome };

/** 相同 messageId 对应不同内容，不能安全地视为同一次提交。 */
export class SessionMessageConflictError extends Error {
  override readonly name = 'SessionMessageConflictError';
}

/** 从会话事实中查找用户消息的接纳状态或 turn 终态。 */
export function findSessionMessageSubmission(
  envelopes: readonly EventEnvelope[],
  message: UserMessage,
): SessionMessageSubmission | undefined {
  let activeTurn: TurnId | undefined;
  let matchedTurn: TurnId | undefined;
  for (const envelope of envelopes) {
    switch (envelope.event.type) {
      case 'turn.started':
        activeTurn = envelope.event.turnId;
        break;
      case 'user.message':
        if (envelope.event.message.id !== message.id) break;
        if (envelope.event.message.content !== message.content) {
          throw new SessionMessageConflictError('messageId 已用于内容不同的消息');
        }
        matchedTurn = activeTurn;
        break;
      case 'turn.ended':
        if (envelope.event.turnId === matchedTurn) return { status: envelope.event.outcome };
        if (envelope.event.turnId === activeTurn) activeTurn = undefined;
        break;
      default:
        break;
    }
  }
  return matchedTurn === undefined ? undefined : { status: 'accepted' };
}
