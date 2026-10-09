import { describe, expect, it } from 'vitest'
import { MemoryGatewayRetriever } from '../src/index.ts'

describe('MemoryGatewayRetriever', () => {
  it('发送冻结的已选 memory space，并复制冻结检索结果', async () => {
    const source = [{ id: 'memory-1', content: '用户喜欢简洁回答' }]
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
    expect(observed).toEqual({ memorySpaceId: 'space-1', query: '回答偏好', limit: 3 })
    expect(matches).toEqual([{ id: 'memory-1', content: '用户喜欢简洁回答' }])
    expect(Object.isFrozen(matches)).toBe(true)
    expect(Object.isFrozen(matches[0])).toBe(true)
  })

  it.each([
    ['非数组', {}, '必须是数组', 1],
    ['超出 limit', [{ id: '1', content: 'a' }, { id: '2', content: 'b' }], '不能超过请求 limit', 1],
    ['未知字段', [{ id: '1', content: 'a', score: 1 }], '只能包含 id 与 content', 1],
    ['重复 ID', [{ id: '1', content: 'a' }, { id: '1', content: 'b' }], 'ID 重复', 2],
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
