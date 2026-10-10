import { describe, expect, it } from 'vitest'
import {
  MemoryGatewayDocumentDeleter,
  type MemoryGatewayDocumentDeleteRequest,
} from '../src/index.ts'

describe('MemoryGatewayDocumentDeleter', () => {
  it.each(['deleting', 'deleted'] as const)('提交冻结请求并接受 %s 状态', async status => {
    let observed: MemoryGatewayDocumentDeleteRequest | undefined
    const deleter = new MemoryGatewayDocumentDeleter({
      memorySpaceId: 'space-1',
      client: {
        async deleteDocument(request) {
          observed = request
          expect(Object.isFrozen(request)).toBe(true)
          return { documentId: 'document-1', status }
        },
      },
    })
    const result = await deleter.delete('document-1', new AbortController().signal)

    expect(observed).toEqual({ memorySpaceId: 'space-1', documentId: 'document-1' })
    expect(result).toEqual({ documentId: 'document-1', status })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it.each([
    ['非对象', [], '必须是对象'],
    ['未知字段', { documentId: 'document-1', status: 'deleting', extra: true }, '只能包含'],
    ['未知状态', { documentId: 'document-1', status: 'ready' }, 'deleting 或 deleted'],
    ['响应 ID 不一致', { documentId: 'document-2', status: 'deleted' }, '与请求不一致'],
  ])('拒绝%s响应', async (_name, response, message) => {
    const deleter = new MemoryGatewayDocumentDeleter({
      memorySpaceId: 'space',
      client: { deleteDocument: async () => response },
    })
    await expect(deleter.delete('document-1', new AbortController().signal)).rejects.toThrow(message)
  })

  it('限制构造配置与文档 ID', async () => {
    const client = { deleteDocument: async () => ({ documentId: 'id', status: 'deleted' }) }
    expect(() => new MemoryGatewayDocumentDeleter({ memorySpaceId: '', client }))
      .toThrow('memorySpaceId 必须是非空字符串')
    const deleter = new MemoryGatewayDocumentDeleter({ memorySpaceId: 'space', client })
    await expect(deleter.delete('', new AbortController().signal))
      .rejects.toThrow('documentId 必须是非空字符串')
  })

  it('在调用前和 Gateway 返回后传播取消', async () => {
    let calls = 0
    const before = new AbortController()
    before.abort(new Error('before'))
    const deleter = new MemoryGatewayDocumentDeleter({
      memorySpaceId: 'space',
      client: { async deleteDocument() { calls += 1; return { documentId: 'id', status: 'deleted' } } },
    })
    await expect(deleter.delete('id', before.signal)).rejects.toThrow('before')
    expect(calls).toBe(0)

    const during = new AbortController()
    const cancelled = new MemoryGatewayDocumentDeleter({
      memorySpaceId: 'space',
      client: {
        async deleteDocument(_request, signal) {
          expect(signal).toBe(during.signal)
          during.abort(new Error('during'))
          return { documentId: 'id', status: 'deleted' }
        },
      },
    })
    await expect(cancelled.delete('id', during.signal)).rejects.toThrow('during')
  })
})
