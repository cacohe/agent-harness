import { BoundedPromptAssembler, SystemClock } from '@agent-harness/adapters/context';
import { InMemorySessionLog } from '@agent-harness/adapters/session-memory';
import { Agent } from '@agent-harness/core';
import { brandId, ToolRegistry } from '@agent-harness/kernel';
import { SequentialAgentIds } from './agent-ids.js';
import { ScriptedModelProvider } from './model-provider.js';
import { TestSettlementSignals } from './session.js';
import { fakeTool } from './tools.js';

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
      { type: 'text.delta', text: 'Agent Harness Lab 0.1.0 演示完成：会话、工具和续步均已结算。' },
    ],
  },
]);
const lookupRelease = fakeTool('lookup_release', async (input) => ({
  version: (input as { readonly version: string }).version,
  status: 'preview',
}));
const agent = new Agent({
  model,
  session,
  tools: new ToolRegistry([lookupRelease]),
  ids: new SequentialAgentIds(),
  maxSteps: 4,
  settlementSignals: new TestSettlementSignals(),
  prompts: new BoundedPromptAssembler({ maxInputBytes: 1_048_576 }),
  clock: new SystemClock(),
  observers: [
    {
      onExecution: (event) => {
        if (event.type !== 'session.event') console.log(`观测：${event.type}`);
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

console.log(`回复：${response.content}`);
console.log(`工具调用：${JSON.stringify(lookupRelease.calls[0])}`);
console.log(`会话事实：${events.map((envelope) => envelope.event.type).join(' → ')}`);
