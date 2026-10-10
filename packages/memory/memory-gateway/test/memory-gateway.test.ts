import { describe, expect, it } from 'vitest'
import { brandId, type ToolCallId } from '@agent-harness/kernel'
import { ToolRegistry } from '@agent-harness/tools'
import { createMemoryWriterTool, MemoryGatewayRetriever } from '../src/index.ts'

const callId = brandId<'ToolCallId'>('memory-call') as ToolCallId

describe('MemoryGatewayRetriever', () => {
  it('发送冻结的已选 memory space，并复制冻结检索结果', async () => {
    const source = [{
      id: 'memory-1',
      content: '用户喜欢简洁回答',
      source: {
        type: 'document',
        documentId: 'document-1',
        fileName: 'preferences.md',
        chunkId: 'chunk-1',
      },
    }]
    let observed: unknown
    const retriever = new MemoryGatewayRetriever({
      memorySpaceId: 'space-1',
      limit: 3,
      client: {
        async searchMemory(request) {
          observed = request
          expect(Object.isFrozen(request)).toBe(true)
          return source
        },
      },
    })
    const matches = await retriever.search('回答偏好', new AbortController().signal)
    source[0]!.content = '被事后修改'
    source[0]!.source.fileName = '被事后修改.md'
    expect(observed).toEqual({ memorySpaceId: 'space-1', query: '回答偏好', limit: 3 })
    expect(matches).toEqual([{
      id: 'memory-1',
      content: '用户喜欢简洁回答',
      source: {
        type: 'document',
        documentId: 'document-1',
        fileName: 'preferences.md',
        chunkId: 'chunk-1',
      },
    }])
    expect(Object.isFrozen(matches)).toBe(true)
    expect(Object.isFrozen(matches[0])).toBe(true)
    expect(Object.isFrozen(matches[0]?.source)).toBe(true)
  })

  it.each([
    ['非数组', {}, '必须是数组', 1],
    ['超出 limit', [{ id: '1', content: 'a' }, { id: '2', content: 'b' }], '不能超过请求 limit', 1],
    ['未知字段', [{ id: '1', content: 'a', score: 1 }], '只能包含 id、content 与可选 source', 1],
    ['重复 ID', [{ id: '1', content: 'a' }, { id: '1', content: 'b' }], 'ID 重复', 2],
    ['未知 source 类型', [{ id: '1', content: 'a', source: { type: 'web' } }], 'source.type 必须是 statement 或 document', 1],
    ['source 多余字段', [{ id: '1', content: 'a', source: { type: 'statement', extra: true } }], 'statement 只能包含 type', 1],
    ['document source 缺字段', [{ id: '1', content: 'a', source: { type: 'document', documentId: 'd', fileName: 'f' } }], 'document 只能包含', 1],
    ['document source 路径文件名', [{ id: '1', content: 'a', source: { type: 'document', documentId: 'd', fileName: '../f', chunkId: 'c' } }], '必须是不含路径', 1],
    ['显式 undefined source', [{ id: '1', content: 'a', source: undefined }], 'source 必须是对象', 1],
  ])('拒绝%s响应', async (_name, response, message, limit) => {
    const retriever = new MemoryGatewayRetriever({
      memorySpaceId: 'space-1',
      limit,
      client: { searchMemory: async () => response },
    })
    await expect(retriever.search('query', new AbortController().signal)).rejects.toThrow(message)
  })

  it('限制构造配置与查询字节数', async () => {
    expect(() => new MemoryGatewayRetriever({
      memorySpaceId: '', client: { searchMemory: async () => [] },
    })).toThrow('memorySpaceId 必须是非空字符串')
    expect(() => new MemoryGatewayRetriever({
      memorySpaceId: 'space', limit: 9, client: { searchMemory: async () => [] },
    })).toThrow('limit 不能超过 8')
    const retriever = new MemoryGatewayRetriever({
      memorySpaceId: 'space', client: { searchMemory: async () => [] },
    })
    await expect(retriever.search('x'.repeat(4_097), new AbortController().signal))
      .rejects.toThrow('query 不能超过 4096')
  })

  it('兼容无来源结果并规范化显式陈述来源', async () => {
    const retriever = new MemoryGatewayRetriever({
      memorySpaceId: 'space',
      client: {
        searchMemory: async () => [
          { id: 'legacy', content: '旧协议结果' },
          { id: 'statement', content: '显式陈述', source: { type: 'statement' } },
        ],
      },
    })
    await expect(retriever.search('query', new AbortController().signal)).resolves.toEqual([
      { id: 'legacy', content: '旧协议结果' },
      { id: 'statement', content: '显式陈述', source: { type: 'statement' } },
    ])
  })

  it('在 adapter 边界限制 Context 的完整 JSON 摘要预算', async () => {
    const retriever = new MemoryGatewayRetriever({
      memorySpaceId: 'space',
      limit: 4,
      client: {
        searchMemory: async () => Array.from({ length: 4 }, (_value, index) => ({
          id: `memory-${index}`,
          content: 'x'.repeat(2_048),
        })),
      },
    })
    await expect(retriever.search('query', new AbortController().signal))
      .rejects.toThrow('摘要不能超过 8192')
  })

  it('在调用前和 Gateway 返回后传播取消', async () => {
    let calls = 0
    const preAborted = new AbortController()
    preAborted.abort(new Error('before'))
    const retriever = new MemoryGatewayRetriever({
      memorySpaceId: 'space',
      client: { async searchMemory() { calls += 1; return [] } },
    })
    await expect(retriever.search('query', preAborted.signal)).rejects.toThrow('before')
    expect(calls).toBe(0)

    const during = new AbortController()
    const cancelled = new MemoryGatewayRetriever({
      memorySpaceId: 'space',
      client: {
        async searchMemory(_request, signal) {
          expect(signal).toBe(during.signal)
          during.abort(new Error('during'))
          return []
        },
      },
    })
    await expect(cancelled.search('query', during.signal)).rejects.toThrow('during')
  })
})

describe('createMemoryWriterTool', () => {
  it('保存冻结的显式陈述并只返回权威记录 ID', async () => {
    let observed: unknown
    const tools = new ToolRegistry([createMemoryWriterTool({
      memorySpaceId: 'space-1',
      client: {
        async writeMemory(request) {
          observed = request
          expect(Object.isFrozen(request)).toBe(true)
          return { id: 'memory-1' }
        },
      },
    })])
    await expect(tools.execute({
      id: callId,
      name: 'remember_memory',
      input: { statement: '用户喜欢简洁回答' },
    }, new AbortController().signal)).resolves.toEqual({
      status: 'success', callId, output: { id: 'memory-1' },
    })
    expect(observed).toEqual({ memorySpaceId: 'space-1', statement: '用户喜欢简洁回答' })
  })

  it('在网络调用前拒绝未知字段、空陈述和超长陈述', async () => {
    let writes = 0
    const tools = new ToolRegistry([createMemoryWriterTool({
      memorySpaceId: 'space-1',
      client: { async writeMemory() { writes += 1; return { id: 'memory-1' } } },
    })])
    const signal = new AbortController().signal
    for (const input of [
      { statement: '偏好', extra: true },
      { statement: '' },
      { statement: 'x'.repeat(4_097) },
    ]) {
      await expect(tools.execute({ id: callId, name: 'remember_memory', input }, signal))
        .resolves.toMatchObject({ status: 'failure' })
    }
    expect(writes).toBe(0)
  })

  it.each([
    ['非对象', [], '必须是对象'],
    ['未知字段', { id: 'memory-1', extra: true }, '只能包含 id'],
    ['空 ID', { id: '' }, '必须是非空字符串'],
  ])('拒绝%s写入响应', async (_name, response, message) => {
    const tools = new ToolRegistry([createMemoryWriterTool({
      memorySpaceId: 'space-1',
      client: { writeMemory: async () => response },
    })])
    await expect(tools.execute({
      id: callId, name: 'remember_memory', input: { statement: '偏好' },
    }, new AbortController().signal)).resolves.toMatchObject({
      status: 'failure', error: { message: expect.stringContaining(message) },
    })
  })

  it('透传取消并将写入后的取消结算为 cancelled', async () => {
    const controller = new AbortController()
    let observedSignal: AbortSignal | undefined
    const tools = new ToolRegistry([createMemoryWriterTool({
      memorySpaceId: 'space-1',
      client: {
        async writeMemory(_request, signal) {
          observedSignal = signal
          controller.abort(new Error('停止写入'))
          return { id: 'memory-1' }
        },
      },
    })])
    await expect(tools.execute({
      id: callId, name: 'remember_memory', input: { statement: '偏好' },
    }, controller.signal)).resolves.toEqual({ status: 'cancelled', callId, reason: '停止写入' })
    expect(observedSignal).toBe(controller.signal)
  })
})
