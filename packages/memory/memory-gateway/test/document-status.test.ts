import { describe, expect, it } from 'vitest'
import {
  MemoryGatewayDocumentStatusReader,
  type MemoryGatewayDocumentStatusRequest,
} from '../src/index.ts'

describe('MemoryGatewayDocumentStatusReader', () => {
  it.each(['queued', 'indexing', 'ready', 'deleting', 'deleted'] as const)('读取并冻结 %s 状态', async status => {
    let observed: MemoryGatewayDocumentStatusRequest | undefined
    const reader = new MemoryGatewayDocumentStatusReader({
      memorySpaceId: 'space-1',
      client: {
        async getDocumentStatus(request) {
          observed = request
          expect(Object.isFrozen(request)).toBe(true)
          return { documentId: 'document-1', status }
        },
      },
    })
    const result = await reader.get('document-1', new AbortController().signal)

    expect(observed).toEqual({ memorySpaceId: 'space-1', documentId: 'document-1' })
    expect(result).toEqual({ documentId: 'document-1', status })
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('读取带稳定失败码的失败状态', async () => {
    const reader = new MemoryGatewayDocumentStatusReader({
      memorySpaceId: 'space-1',
      client: {
        getDocumentStatus: async () => ({
          documentId: 'document-1',
          status: 'failed',
          failureCode: 'DOCUMENT.PARSE_FAILED',
        }),
      },
    })
    await expect(reader.get('document-1', new AbortController().signal)).resolves.toEqual({
      documentId: 'document-1',
      status: 'failed',
      failureCode: 'DOCUMENT.PARSE_FAILED',
    })
  })

  it.each([
    ['非对象', [], '必须是对象'],
    ['未知状态', { documentId: 'document-1', status: 'complete' }, 'status 必须是'],
    ['成功状态多余字段', { documentId: 'document-1', status: 'ready', failureCode: 'X' }, '字段无效'],
    ['失败状态缺失败码', { documentId: 'document-1', status: 'failed' }, '字段无效'],
    ['失败码格式无效', { documentId: 'document-1', status: 'failed', failureCode: 'secret text' }, 'failureCode 格式无效'],
    ['响应 ID 不一致', { documentId: 'document-2', status: 'ready' }, '与请求不一致'],
  ])('拒绝%s响应', async (_name, response, message) => {
    const reader = new MemoryGatewayDocumentStatusReader({
      memorySpaceId: 'space',
      client: { getDocumentStatus: async () => response },
    })
    await expect(reader.get('document-1', new AbortController().signal)).rejects.toThrow(message)
  })

  it('限制构造配置与文档 ID', async () => {
    const client = { getDocumentStatus: async () => ({ documentId: 'id', status: 'ready' }) }
    expect(() => new MemoryGatewayDocumentStatusReader({ memorySpaceId: '', client }))
      .toThrow('memorySpaceId 必须是非空字符串')
    const reader = new MemoryGatewayDocumentStatusReader({ memorySpaceId: 'space', client })
    await expect(reader.get('', new AbortController().signal)).rejects.toThrow('documentId 必须是非空字符串')
  })

  it('在调用前和 Gateway 返回后传播取消', async () => {
    let calls = 0
    const before = new AbortController()
    before.abort(new Error('before'))
    const reader = new MemoryGatewayDocumentStatusReader({
      memorySpaceId: 'space',
      client: { async getDocumentStatus() { calls += 1; return { documentId: 'id', status: 'ready' } } },
    })
    await expect(reader.get('id', before.signal)).rejects.toThrow('before')
    expect(calls).toBe(0)

    const during = new AbortController()
    const cancelled = new MemoryGatewayDocumentStatusReader({
      memorySpaceId: 'space',
      client: {
        async getDocumentStatus(_request, signal) {
          expect(signal).toBe(during.signal)
          during.abort(new Error('during'))
          return { documentId: 'id', status: 'ready' }
        },
      },
    })
    await expect(cancelled.get('id', during.signal)).rejects.toThrow('during')
  })
})
