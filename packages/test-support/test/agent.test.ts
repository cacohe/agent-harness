import { describe, expect, it } from 'vitest'
import {
  Agent,
  AgentIdCollisionError,
  SettlementPersistenceError,
} from '@agent-harness/agent'
import {
  brandId,
  type EventEnvelope,
  type MessageId,
  type SessionId,
  type ToolCallId,
  type UserMessage,
} from '@agent-harness/domain'
import {
  analyzeSessionLifecycle,
  InMemorySessionLog,
  type SessionLog,
} from '@agent-harness/session'
import {
  ScriptedModelProvider,
  ScriptedToolCapability,
  SequentialAgentIds,
  ControlledSessionLog,
  TestSettlementSignals,
  fakeTool,
} from '@agent-harness/test-support'
import { ToolRegistry } from '@agent-harness/tools'

const sessionId = brandId<'SessionId'>('session-1') as SessionId

function user(content = 'hello'): UserMessage {
  return {
    id: brandId<'MessageId'>('user-1') as MessageId,
    role: 'user',
    content,
  }
}

function eventTypes(events: readonly EventEnvelope[]): string[] {
  return events.map(envelope => envelope.event.type)
}

function readEvents(session: SessionLog): Promise<readonly EventEnvelope[]> {
  return session.read({ signal: new AbortController().signal })
}

function expectClosed(events: readonly EventEnvelope[]): void {
  const types = eventTypes(events)
  expect(types.filter(type => type === 'turn.started')).toHaveLength(1)
  expect(types.filter(type => type === 'turn.ended')).toHaveLength(1)
  expect(types.filter(type => type === 'step.started')).toHaveLength(
    types.filter(type => type === 'step.ended').length,
  )
}

describe('Agent', () => {
  it('模型输出超过预算时取消并持久化 terminal settlement', async () => {
    const session = new InMemorySessionLog(sessionId)
    const agent = new Agent({
      model: new ScriptedModelProvider([{ events: [{ type: 'text.delta', text: 'too large' }] }]),
      session,
      tools: new ToolRegistry([]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      maxModelOutputBytes: 1,
      settlementSignals: new TestSettlementSignals(),
    })

    await expect(agent.run(user())).rejects.toThrow('模型输出超过 maxModelOutputBytes')
    const events = await readEvents(session)
    expect(events.at(-1)?.event).toMatchObject({ type: 'turn.ended', outcome: 'failed' })
    expectClosed(events)
  })

  it('提交普通回复并完整闭合 turn 和 step', async () => {
    const session = new InMemorySessionLog(sessionId)
    const model = new ScriptedModelProvider([
      { events: [{ type: 'text.delta', text: 'done' }] },
    ])
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
    })

    const response = await agent.run(user())

    expect(response.content).toBe('done')
    const events = await readEvents(session)
    expect(eventTypes(events)).toEqual([
      'turn.started',
      'user.message',
      'step.started',
      'assistant.settled',
      'step.ended',
      'turn.ended',
    ])
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6])
    expectClosed(events)
  })

  it('顺序执行工具，并从日志投影下一次模型请求', async () => {
    const callId = brandId<'ToolCallId'>('call-1') as ToolCallId
    const session = new InMemorySessionLog(sessionId)
    const model = new ScriptedModelProvider([
      {
        events: [
          {
            type: 'tool.call',
            call: { id: callId, name: 'lookup', input: { value: 2 } },
          },
        ],
      },
      { events: [{ type: 'text.delta', text: 'result is 4' }] },
    ])
    const tool = fakeTool('lookup', async input => ({
      doubled: (input as { value: number }).value * 2,
    }))
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([tool]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
    })

    const response = await agent.run(user('double it'))

    expect(response.content).toBe('result is 4')
    expect(tool.calls).toEqual([{ value: 2 }])
    expect(model.requests).toHaveLength(2)
    expect(model.requests[1]?.messages.map(message => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
    ])
    const events = await readEvents(session)
    expect(eventTypes(events)).toEqual([
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
    ])
    expectClosed(events)
  })

  it('通过最小工具 capability 使用非 ToolRegistry 实现', async () => {
    const callId = brandId<'ToolCallId'>('call-capability') as ToolCallId
    const session = new InMemorySessionLog(sessionId)
    const model = new ScriptedModelProvider([
      {
        events: [{
          type: 'tool.call',
          call: { id: callId, name: 'custom', input: { value: 1 } },
        }],
      },
      { events: [{ type: 'text.delta', text: 'custom complete' }] },
    ])
    const executed: string[] = []
    const tools = new ScriptedToolCapability(
      [{ name: 'custom', description: '自定义工具', inputSchema: {} }],
      async call => {
        executed.push(call.name)
        return { status: 'success', callId: call.id, output: 'ok' }
      },
    )
    const agent = new Agent({
      model,
      session,
      tools,
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
    })

    await expect(agent.run(user())).resolves.toMatchObject({
      content: 'custom complete',
    })
    expect(executed).toEqual(['custom'])
    expectClosed(await readEvents(session))
  })

  it('同一 Agent 重复接纳 user message ID 时在持久化前拒绝', async () => {
    const session = new InMemorySessionLog(sessionId)
    const model = new ScriptedModelProvider([
      { events: [{ type: 'text.delta', text: 'first' }] },
      { events: [{ type: 'text.delta', text: '不应调用' }] },
    ])
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
    })
    await agent.run(user('first'))

    await expect(agent.run(user('duplicate'))).rejects.toMatchObject({
      name: 'AgentIdCollisionError',
      kind: 'message',
      value: 'user-1',
    })

    expect(model.requests).toHaveLength(1)
    const events = await readEvents(session)
    expect(() => analyzeSessionLifecycle(events)).not.toThrow()
  })

  it('跨 turn 重复模型 tool call ID 时在 settlement 前拒绝', async () => {
    const callId = brandId<'ToolCallId'>('repeated-call') as ToolCallId
    const session = new InMemorySessionLog(sessionId)
    const model = new ScriptedModelProvider([
      {
        events: [{
          type: 'tool.call',
          call: { id: callId, name: 'missing', input: {} },
        }],
      },
      { events: [{ type: 'text.delta', text: 'first complete' }] },
      {
        events: [{
          type: 'tool.call',
          call: { id: callId, name: 'missing', input: {} },
        }],
      },
    ])
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
    })
    await agent.run({
      id: brandId<'MessageId'>('first-user') as MessageId,
      role: 'user',
      content: 'first',
    })

    await expect(agent.run({
      id: brandId<'MessageId'>('second-user') as MessageId,
      role: 'user',
      content: 'second',
    })).rejects.toBeInstanceOf(AgentIdCollisionError)

    const events = await readEvents(session)
    expect(events.filter(envelope =>
      envelope.event.type === 'assistant.settled'
      && envelope.event.settlement.status === 'completed'
      && envelope.event.settlement.message.toolCalls.some(call => call.id === callId),
    )).toHaveLength(1)
    expect(() => analyzeSessionLifecycle(events)).not.toThrow()
  })

  it('持久化模型流失败及其已经输出的文本', async () => {
    const appendBatches: string[][] = []
    const session = new ControlledSessionLog(sessionId, operation => {
      if (operation.type === 'append') {
        appendBatches.push(operation.events?.map(event => event.type) ?? [])
      }
    })
    const model = new ScriptedModelProvider([
      {
        events: [{ type: 'text.delta', text: 'partial' }],
        error: new Error('provider disconnected'),
      },
    ])
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
    })

    await expect(agent.run(user())).rejects.toThrow('provider disconnected')

    const events = await readEvents(session)
    const settlement = events.find(
      envelope => envelope.event.type === 'assistant.settled',
    )?.event
    expect(settlement).toMatchObject({
      type: 'assistant.settled',
      settlement: { status: 'failed', partialText: 'partial' },
    })
    expect(events.at(-1)?.event).toMatchObject({
      type: 'turn.ended',
      outcome: 'failed',
    })
    expect(appendBatches.at(-1)).toEqual([
      'assistant.settled',
      'step.ended',
      'turn.ended',
    ])
    expectClosed(events)
  })

  it('prepare 失败时不创建 assistant attempt', async () => {
    const session = new InMemorySessionLog(sessionId)
    const model = new ScriptedModelProvider([
      {
        events: [],
        prepare: async () => {
          throw new Error('prepare failed')
        },
      },
    ])
    const ids = new SequentialAgentIds()
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([]),
      ids,
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
    })

    await expect(agent.run(user())).rejects.toThrow('prepare failed')

    const events = await readEvents(session)
    expect(ids.attemptsAllocated).toBe(0)
    expect(eventTypes(events)).not.toContain('assistant.settled')
    expect(events.at(-2)?.event).toMatchObject({
      type: 'step.ended',
      outcome: 'failed',
    })
    expect(events.at(-1)?.event).toMatchObject({
      type: 'turn.ended',
      outcome: 'failed',
    })
    expectClosed(events)
  })

  it('prepare 取消时不创建 assistant attempt', async () => {
    const session = new InMemorySessionLog(sessionId)
    let signalPrepareStarted: (() => void) | undefined
    const prepareStarted = new Promise<void>(resolve => {
      signalPrepareStarted = resolve
    })
    const model = new ScriptedModelProvider([
      {
        events: [],
        prepare: async signal => {
          signalPrepareStarted?.()
          await new Promise<never>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), {
              once: true,
            })
          })
        },
      },
    ])
    const ids = new SequentialAgentIds()
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([]),
      ids,
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
    })
    const controller = new AbortController()

    const run = agent.run(user(), controller.signal)
    await prepareStarted
    controller.abort(new Error('cancel prepare'))

    await expect(run).rejects.toThrow('cancel prepare')
    const events = await readEvents(session)
    expect(ids.attemptsAllocated).toBe(0)
    expect(eventTypes(events)).not.toContain('assistant.settled')
    expect(events.at(-2)?.event).toMatchObject({
      type: 'step.ended',
      outcome: 'cancelled',
    })
    expect(events.at(-1)?.event).toMatchObject({
      type: 'turn.ended',
      outcome: 'cancelled',
    })
    expectClosed(events)
  })

  it('取消工具执行后记录结果并闭合生命周期', async () => {
    const callId = brandId<'ToolCallId'>('call-1') as ToolCallId
    const session = new InMemorySessionLog(sessionId)
    const model = new ScriptedModelProvider([
      {
        events: [
          {
            type: 'tool.call',
            call: { id: callId, name: 'wait', input: {} },
          },
        ],
      },
    ])
    let signalToolStarted: (() => void) | undefined
    const toolStarted = new Promise<void>(resolve => {
      signalToolStarted = resolve
    })
    const tool = fakeTool('wait', async (_input, context) => {
      signalToolStarted?.()
      await new Promise<never>((_resolve, reject) => {
        context.signal.addEventListener(
          'abort',
          () => reject(context.signal.reason),
          { once: true },
        )
      })
    })
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([tool]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
    })
    const controller = new AbortController()

    const run = agent.run(user(), controller.signal)
    await toolStarted
    controller.abort(new Error('stop requested'))

    await expect(run).rejects.toThrow('stop requested')
    const events = await readEvents(session)
    expect(events.find(envelope => envelope.event.type === 'tool.completed')?.event)
      .toMatchObject({
        type: 'tool.completed',
        result: { status: 'cancelled', reason: 'stop requested' },
      })
    expect(events.at(-2)?.event).toMatchObject({
      type: 'step.ended',
      outcome: 'cancelled',
    })
    expect(events.at(-1)?.event).toMatchObject({
      type: 'turn.ended',
      outcome: 'cancelled',
    })
    expectClosed(events)
  })

  it('普通会话 I/O 响应 run signal，并用一个独立信号提交 terminal batch', async () => {
    let signalReadStarted: (() => void) | undefined
    const readStarted = new Promise<void>(resolve => {
      signalReadStarted = resolve
    })
    const operations: Array<{
      readonly types: readonly string[]
      readonly signal: AbortSignal
    }> = []
    const session = new ControlledSessionLog(sessionId, async operation => {
      if (operation.type === 'read') {
        signalReadStarted?.()
        await rejectWhenAborted(operation.signal)
      }
      if (operation.type === 'append') {
        operations.push({
          types: operation.events?.map(event => event.type) ?? [],
          signal: operation.signal,
        })
      }
    })
    const settlementSignals = new TestSettlementSignals()
    const agent = new Agent({
      model: new ScriptedModelProvider([]),
      session,
      tools: new ToolRegistry([]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals,
    })
    const controller = new AbortController()

    const run = agent.run(user(), controller.signal)
    await readStarted
    controller.abort(new Error('cancel blocked read'))

    await expect(run).rejects.toThrow('cancel blocked read')
    expect(settlementSignals.created).toHaveLength(1)
    expect(settlementSignals.created[0]).not.toBe(controller.signal)
    expect(settlementSignals.created[0]?.aborted).toBe(false)
    expect(operations.at(-1)?.types).toEqual(['step.ended', 'turn.ended'])
    expect(operations.at(-1)?.signal).toBe(settlementSignals.created[0])
    const events = await session.committed({
      signal: new AbortController().signal,
    })
    expect(events.at(-2)?.event).toMatchObject({
      type: 'step.ended',
      outcome: 'cancelled',
    })
    expect(events.at(-1)?.event).toMatchObject({
      type: 'turn.ended',
      outcome: 'cancelled',
    })
    expectClosed(events)
  })

  it('terminal settlement 失败时聚合错误并保留取消分类', async () => {
    let signalReadStarted: (() => void) | undefined
    const readStarted = new Promise<void>(resolve => {
      signalReadStarted = resolve
    })
    const persistenceError = new Error('settlement storage failed')
    const session = new ControlledSessionLog(sessionId, async operation => {
      if (operation.type === 'read') {
        signalReadStarted?.()
        await rejectWhenAborted(operation.signal)
      }
      if (
        operation.type === 'append'
        && operation.events?.some(event => event.type === 'turn.ended') === true
      ) {
        throw persistenceError
      }
    })
    const settlementSignals = new TestSettlementSignals()
    const agent = new Agent({
      model: new ScriptedModelProvider([]),
      session,
      tools: new ToolRegistry([]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals,
    })
    const controller = new AbortController()

    const run = agent.run(user(), controller.signal)
    await readStarted
    const cancellation = new Error('cancel before settlement')
    controller.abort(cancellation)

    let received: unknown
    try {
      await run
    } catch (error) {
      received = error
    }
    expect(received).toBeInstanceOf(SettlementPersistenceError)
    expect(received).toMatchObject({
      outcome: 'cancelled',
      originalError: cancellation,
      persistenceError,
    })
    expect(settlementSignals.created).toHaveLength(1)
  })

  it('触及 maxSteps 时失败并闭合已打开的生命周期', async () => {
    const callId = brandId<'ToolCallId'>('call-max') as ToolCallId
    const session = new InMemorySessionLog(sessionId)
    const model = new ScriptedModelProvider([
      {
        events: [
          {
            type: 'tool.call',
            call: { id: callId, name: 'lookup', input: {} },
          },
        ],
      },
    ])
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([
        fakeTool('lookup', async () => ({ ok: true })),
      ]),
      ids: new SequentialAgentIds(),
      maxSteps: 1,
      settlementSignals: new TestSettlementSignals(),
    })

    await expect(agent.run(user())).rejects.toThrow('agent exceeded maxSteps (1)')

    const events = await readEvents(session)
    expect(eventTypes(events)).toEqual([
      'turn.started',
      'user.message',
      'step.started',
      'assistant.settled',
      'tool.completed',
      'step.ended',
      'turn.ended',
    ])
    expect(events.at(-2)?.event).toMatchObject({
      type: 'step.ended',
      outcome: 'completed',
    })
    expect(events.at(-1)?.event).toMatchObject({
      type: 'turn.ended',
      outcome: 'failed',
    })
    expectClosed(events)
  })

  it('observer 同步与异步失败不影响 Agent 成功完成', async () => {
    const session = new InMemorySessionLog(sessionId)
    const model = new ScriptedModelProvider([
      { events: [{ type: 'text.delta', text: 'ok' }] },
    ])
    const seen: string[] = []
    const agent = new Agent({
      model,
      session,
      tools: new ToolRegistry([]),
      ids: new SequentialAgentIds(),
      maxSteps: 4,
      settlementSignals: new TestSettlementSignals(),
      observers: [
        {
          onStream() {
            throw new Error('sync observer failed')
          },
        },
        {
          async onStream(event) {
            seen.push(event.type)
            throw new Error('async observer failed')
          },
        },
      ],
    })

    const response = await agent.run(user())

    expect(response.content).toBe('ok')
    expect(seen).toContain('text.delta')
    expectClosed(await readEvents(session))
  })
})

function rejectWhenAborted(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise<never>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}
