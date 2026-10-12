import type { EventEnvelope } from '@agent-harness/kernel';

/** 浏览器对话区可渲染的一条历史消息。 */
export interface ChatTranscriptMessage {
  readonly kind: 'user' | 'assistant' | 'tool';
  readonly content: string;
}

/** 从持久会话事件重建聊天记录；流式 delta 不在事件日志中。 */
export function projectChatTranscript(
  envelopes: readonly EventEnvelope[],
): readonly ChatTranscriptMessage[] {
  const messages: ChatTranscriptMessage[] = [];
  for (const envelope of envelopes) {
    const event = envelope.event;
    if (event.type === 'user.message') {
      messages.push({ kind: 'user', content: event.message.content });
      continue;
    }
    if (event.type === 'assistant.settled' && event.settlement.status === 'completed') {
      messages.push({ kind: 'assistant', content: event.settlement.message.content });
      continue;
    }
    if (event.type === 'tool.completed') {
      messages.push({ kind: 'tool', content: `工具执行完成：${event.result.status}` });
    }
  }
  return messages;
}
