import { describe, expect, it } from 'vitest';
import { runDemo } from '../src/demo.js';

describe('public demo', () => {
  it('executes a complete durable tool turn without credentials or network access', async () => {
    await expect(runDemo()).resolves.toEqual({
      response: 'Agent Harness Lab 0.1.0 演示完成：会话、工具和续步均已结算。',
      toolInput: { version: '0.1.0' },
      executionEvents: [
        'model.invocation.started',
        'model.invocation.finished',
        'tool.invocation.started',
        'tool.invocation.finished',
        'model.invocation.started',
        'model.invocation.usage',
        'model.invocation.finished',
      ],
      eventTypes: [
        'turn.started',
        'user.message',
        'step.started',
        'assistant.settled',
        'tool.completed',
        'step.ended',
        'step.started',
        'assistant.settled',
        'step.ended',
        'turn.ended',
      ],
    });
  });
});
