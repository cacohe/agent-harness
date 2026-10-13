import {
  assertNever,
  type EventEnvelope,
  type ModelMessage,
  type ToolMessage,
} from '@agent-harness/kernel';

/** 从持久事件中重建下一次模型请求可见的完整消息历史。 */
export function deriveModelMessages(envelopes: readonly EventEnvelope[]): readonly ModelMessage[] {
  const messages: ModelMessage[] = [];
  let previousSequence = 0;

  for (const envelope of envelopes) {
    if (envelope.sequence <= previousSequence) {
      throw new Error('session event sequence must be strictly increasing');
    }
    previousSequence = envelope.sequence;

    switch (envelope.event.type) {
      case 'user.message':
        messages.push(envelope.event.message);
        break;
      case 'assistant.settled':
        if (envelope.event.settlement.status === 'completed') {
          messages.push(envelope.event.settlement.message);
        }
        break;
      case 'tool.completed': {
        const toolMessage: ToolMessage = {
          role: 'tool',
          callId: envelope.event.result.callId,
          result: envelope.event.result,
        };
        messages.push(toolMessage);
        break;
      }
      case 'turn.started':
      case 'step.started':
      case 'step.ended':
      case 'turn.ended':
        break;
      default:
        assertNever(envelope.event);
    }
  }

  return messages;
}
