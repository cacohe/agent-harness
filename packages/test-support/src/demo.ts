import { BoundedPromptAssembler } from '@agent-harness/adapters/context';
import { InMemorySessionLog } from '@agent-harness/adapters/session-memory';
import { Agent } from '@agent-harness/core';
import { brandId, DirectToolSet } from '@agent-harness/kernel';
import { SequentialAgentIds } from './agent-ids.js';
import { ScriptedModelProvider } from './model-provider.js';
import { TestSettlementSignals } from './session.js';
import { fakeTool } from './tools.js';

export interface DemoRun {
  readonly response: string;
  readonly toolInput: unknown;
  readonly eventTypes: readonly string[];
  readonly executionEvents: readonly string[];
}

/** 执行一个无网络、无凭证依赖的完整 Agent 回合，供 README demo 与 CI 共同验证。 */
export async function runDemo(): Promise<DemoRun> {
  const sessionId = brandId<'SessionId'>('demo-session');
  const toolCallId = brandId<'ToolCallId'>('demo-tool-call');
  const session = new InMemorySessionLog(sessionId);
  const model = new ScriptedModelProvider([
    {
      events: [
        {
          type: 'tool.call',
          call: { id: toolCallId, name: 'lookup_release', input: { version: '0.1.0' } },
        },
      ],
    },
    {
      events: [
        { type: 'usage', inputTokens: 24, outputTokens: 12 },
        {
          type: 'text.delta',
          text: 'Agent Harness Lab 0.1.0 演示完成：会话、工具和续步均已结算。',
        },
      ],
    },
  ]);
  const lookupRelease = fakeTool('lookup_release', async (input) => ({
    version: (input as { readonly version: string }).version,
    status: 'preview',
  }));
  const executionEvents: string[] = [];
  const agent = new Agent({
    model,
    session,
    tools: new DirectToolSet([lookupRelease]),
    ids: new SequentialAgentIds(),
    maxSteps: 4,
    settlementSignals: new TestSettlementSignals(),
    prompts: new BoundedPromptAssembler({ maxInputBytes: 1_048_576 }),
    clock: { now: () => new Date('2026-10-13T00:00:00.000Z') },
    observers: [
      {
        onObservation: (observation) => {
          executionEvents.push(observation.type);
        },
      },
    ],
  });

  const response = await agent.run({
    id: brandId<'MessageId'>('demo-message'),
    role: 'user',
    content: '展示一个不需要 API key 的工具调用回合。',
  });
  const events = await session.read({ signal: new AbortController().signal });

  return {
    response: response.content,
    toolInput: lookupRelease.calls[0],
    eventTypes: events.map((envelope) => envelope.event.type),
    executionEvents,
  };
}
