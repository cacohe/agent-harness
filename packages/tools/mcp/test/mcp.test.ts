import { brandId, type ToolCallId } from '@agent-harness/kernel'
import { describe, expect, it } from 'vitest'
import { McpToolAdapter, McpToolsNotStartedError, type McpClient } from '../src/index.ts'

function call(name: string, input: unknown = {}) {
  return { id: brandId<'ToolCallId'>('call-1') as ToolCallId, name, input }
}

function client(overrides: Partial<McpClient> = {}): McpClient {
  return {
    listTools: async () => [{
      name: 'lookup', description: '查询资料', inputSchema: { type: 'object' },
    }],
    callTool: async (_name, input) => ({ echoed: input }),
    close: async () => undefined,
    ...overrides,
  }
}

describe('McpToolAdapter', () => {
  it('启动后公开工具并转发调用', async () => {
    const calls: unknown[] = []
    const tools = new McpToolAdapter(client({
      callTool: async (name, input) => {
        calls.push({ name, input })
        return { result: true }
      },
    }))
    const signal = new AbortController().signal

    await tools.start(signal)
    expect(tools.list()).toEqual([{
      name: 'lookup', description: '查询资料', inputSchema: { type: 'object' },
    }])
    await expect(tools.execute(call('lookup', { q: 'agent' }), signal)).resolves.toEqual({
      status: 'success', callId: 'call-1', output: { result: true },
    })
    expect(calls).toEqual([{ name: 'lookup', input: { q: 'agent' } }])
  })

  it('未启动时拒绝公开和执行工具', async () => {
    const tools = new McpToolAdapter(client())
    expect(() => tools.list()).toThrow(McpToolsNotStartedError)
    await expect(tools.execute(call('lookup'), new AbortController().signal)).rejects.toThrow(McpToolsNotStartedError)
  })

  it('预先取消的 start 不开始远程发现', async () => {
    let listed = false
    const tools = new McpToolAdapter(client({ listTools: async () => { listed = true; return [] } }))
    const controller = new AbortController()
    controller.abort(new Error('取消'))

    await expect(tools.start(controller.signal)).rejects.toThrow('取消')
    expect(listed).toBe(false)
  })

  it('严格校验远程工具表并拒绝重复名称', async () => {
    const tools = new McpToolAdapter(client({
      listTools: async () => [
        { name: 'same', description: '一', inputSchema: {} },
        { name: 'same', description: '二', inputSchema: {} },
      ],
    }))
    await expect(tools.start(new AbortController().signal)).rejects.toThrow('重复注册')
  })

  it('启动时复制冻结远程 schema', async () => {
    const schema = { type: 'object', properties: { q: { type: 'string' } } }
    const tools = new McpToolAdapter(client({
      listTools: async () => [{ name: 'lookup', description: '查询', inputSchema: schema }],
    }))
    await tools.start(new AbortController().signal)
    schema.properties.q.type = 'number'

    expect(tools.list()[0]?.inputSchema).toEqual({
      type: 'object', properties: { q: { type: 'string' } },
    })
  })

  it('取消会传给远程调用并返回 cancelled', async () => {
    const controller = new AbortController()
    const tools = new McpToolAdapter(client({
      callTool: async (_name, _input, signal) => {
        controller.abort(new Error('停止'))
        expect(signal.aborted).toBe(true)
        return { ignored: true }
      },
    }))
    await tools.start(controller.signal)

    await expect(tools.execute(call('lookup'), controller.signal)).resolves.toEqual({
      status: 'cancelled', callId: 'call-1', reason: '停止',
    })
  })

  it('关闭 client 后不再暴露工具', async () => {
    const closed: string[] = []
    const tools = new McpToolAdapter(client({ close: async () => { closed.push('closed') } }))
    const signal = new AbortController().signal
    await tools.start(signal)
    await tools.close(signal)

    expect(closed).toEqual(['closed'])
    expect(() => tools.list()).toThrow(McpToolsNotStartedError)
    await expect(tools.close(signal)).resolves.toBeUndefined()
  })

  it('并发 close 只关闭一次 client，取消只中止调用方等待', async () => {
    let release!: () => void
    const closed = new Promise<void>(resolve => { release = resolve })
    let closeCalls = 0
    const tools = new McpToolAdapter(client({
      close: async () => {
        closeCalls += 1
        await closed
      },
    }))
    const cancelled = new AbortController()
    const waiting = tools.close(cancelled.signal)
    const concurrent = tools.close(new AbortController().signal)
    cancelled.abort(new Error('不等待'))

    await expect(waiting).rejects.toThrow('不等待')
    expect(closeCalls).toBe(1)
    release()
    await expect(concurrent).resolves.toBeUndefined()
    expect(closeCalls).toBe(1)
  })

  it('关闭期间完成的工具发现不会重新开放 adapter', async () => {
    let release!: () => void
    const listed = new Promise<readonly { name: string, description: string, inputSchema: {} }[]>(resolve => {
      release = () => resolve([{ name: 'lookup', description: '查询', inputSchema: {} }])
    })
    const tools = new McpToolAdapter(client({ listTools: async () => listed }))
    const started = tools.start(new AbortController().signal)
    await tools.close(new AbortController().signal)
    release()

    await expect(started).rejects.toThrow(McpToolsNotStartedError)
    expect(() => tools.list()).toThrow(McpToolsNotStartedError)
  })

  it('一个 start 调用取消不会取消其他调用方等待的发现', async () => {
    let release!: () => void
    const listed = new Promise<readonly { name: string, description: string, inputSchema: {} }[]>(resolve => {
      release = () => resolve([{ name: 'lookup', description: '查询', inputSchema: {} }])
    })
    const tools = new McpToolAdapter(client({ listTools: async () => listed }))
    const first = new AbortController()
    const firstStart = tools.start(first.signal)
    const secondStart = tools.start(new AbortController().signal)
    first.abort(new Error('第一个取消'))
    release()

    await expect(firstStart).rejects.toThrow('第一个取消')
    await expect(secondStart).resolves.toBeUndefined()
    expect(tools.list()).toHaveLength(1)
  })
})
