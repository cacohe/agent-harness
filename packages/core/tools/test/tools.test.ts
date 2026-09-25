import { brandId, type ToolCallId } from '@agent-harness/domain'
import { describe, expect, it } from 'vitest'
import { ToolRegistry } from '../src/index.ts'

function call(name: string, input: unknown = {}) {
  return {
    id: brandId<'ToolCallId'>('call-1') as ToolCallId,
    name,
    input,
  }
}

describe('ToolRegistry', () => {
  it('拒绝重复工具注册', () => {
    const definition = {
      name: 'lookup',
      description: '查询',
      inputSchema: { type: 'object' },
      parseInput: input => input,
      execute: async () => ({ ok: true }),
    }
    expect(() => new ToolRegistry([definition, definition])).toThrow(
      'duplicate tool registration: lookup',
    )
  })

  it('list 暴露模型可见 schema 且不含执行函数', () => {
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        execute: async () => ({ ok: true }),
      },
    ])

    expect(registry.list()).toEqual([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
      },
    ])
  })

  it('成功执行并校验输出为 JSON', async () => {
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        execute: async input => ({ echoed: input }),
      },
    ])

    await expect(
      registry.execute(call('lookup', { q: 1 }), new AbortController().signal),
    ).resolves.toEqual({
      status: 'success',
      callId: 'call-1',
      output: { echoed: { q: 1 } },
    })
  })

  it('未知工具与执行抛错都返回 failure', async () => {
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        execute: async () => {
          throw new Error('boom')
        },
      },
    ])
    const signal = new AbortController().signal

    await expect(registry.execute(call('missing'), signal)).resolves.toMatchObject({
      status: 'failure',
      error: { name: 'UnknownToolError' },
    })
    await expect(registry.execute(call('lookup'), signal)).resolves.toEqual({
      status: 'failure',
      callId: 'call-1',
      error: { name: 'Error', message: 'boom' },
    })
  })

  it('在执行副作用前拒绝未通过输入解析的模型 JSON', async () => {
    let executed = false
    const registry = new ToolRegistry([{
      name: 'lookup',
      description: '查询',
      inputSchema: { type: 'object' },
      parseInput: () => { throw new TypeError('q 必须是字符串') },
      execute: async () => {
        executed = true
        return { ok: true }
      },
    }])

    await expect(registry.execute(call('lookup'), new AbortController().signal)).resolves.toMatchObject({
      status: 'failure',
      error: { name: 'TypeError', message: 'q 必须是字符串' },
    })
    expect(executed).toBe(false)
  })

  it('拒绝非 JSON 输出', async () => {
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        execute: async () => () => undefined,
      },
    ])

    await expect(
      registry.execute(call('lookup'), new AbortController().signal),
    ).resolves.toMatchObject({
      status: 'failure',
      error: { name: 'TypeError' },
    })
  })

  it('已中止或执行中取消时返回 cancelled', async () => {
    const controller = new AbortController()
    const registry = new ToolRegistry([
      {
        name: 'lookup',
        description: '查询',
        inputSchema: { type: 'object' },
        parseInput: input => input,
        async execute() {
          controller.abort(new Error('stop'))
          return { ok: true }
        },
      },
    ])

    await expect(
      registry.execute(call('lookup'), controller.signal),
    ).resolves.toEqual({
      status: 'cancelled',
      callId: 'call-1',
      reason: 'stop',
    })

    const preAborted = new AbortController()
    preAborted.abort(new Error('already'))
    await expect(
      registry.execute(call('lookup'), preAborted.signal),
    ).resolves.toEqual({
      status: 'cancelled',
      callId: 'call-1',
      reason: 'already',
    })
  })
})
