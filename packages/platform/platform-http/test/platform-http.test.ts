import type { ModelRequest } from '@agent-harness/kernel'
import { describe, expect, it } from 'vitest'
import {
  PlatformHttpClient,
  PlatformHttpConfigurationError,
  PlatformHttpError,
  PlatformHttpProtocolError,
} from '../src/index.ts'

const encoder = new TextEncoder()

function response(parts: readonly string[], options: { readonly status?: number, readonly contentType?: string } = {}): Response {
  let index = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[index++]
      if (part === undefined) controller.close()
      else controller.enqueue(encoder.encode(part))
    },
  }), {
    status: options.status ?? 200,
    statusText: options.status === undefined || options.status === 200 ? 'OK' : 'Bad Gateway',
    headers: { 'Content-Type': options.contentType ?? 'application/json' },
  })
}

function request(): ModelRequest {
  return {
    messages: [{ id: 'user-1' as never, role: 'user', content: '你好' }],
    tools: [],
  }
}

function client(fetch: typeof globalThis.fetch): PlatformHttpClient {
  let sequence = 0
  return new PlatformHttpClient({
    baseUrl: 'https://platform.test/v1',
    authorization: 'Bearer service-token',
    fetch,
    requestIds: { next: () => `model-${++sequence}` },
  })
}

describe('PlatformHttpClient', () => {
  it('以已选模型、幂等键和 NDJSON 调用 Gateway', async () => {
    let captured: { readonly input: string | URL, readonly init: RequestInit | undefined } | undefined
    const platform = client(async (input, init) => {
      captured = { input, init }
      return response([
        '{"type":"text.delta","text":"你"}\n',
        '{"type":"usage","inputTokens":3,"outputTokens":2}\n',
      ], { contentType: 'application/x-ndjson; charset=utf-8' })
    })
    const prepared = await platform.prepare({ modelId: 'deepseek-v3' }, new AbortController().signal)

    await expect(Array.fromAsync(prepared.stream(request(), new AbortController().signal))).resolves.toEqual([
      { type: 'text.delta', text: '你' },
      { type: 'usage', inputTokens: 3, outputTokens: 2 },
    ])
    expect(captured?.input.toString()).toBe('https://platform.test/v1/agent/model-calls')
    expect(captured?.init?.headers).toEqual({
      Accept: 'application/x-ndjson',
      Authorization: 'Bearer service-token',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'model-1',
    })
    expect(JSON.parse(captured?.init?.body as string)).toEqual({
      requestId: 'model-1', modelId: 'deepseek-v3', request: request(),
    })
  })

  it('以稳定幂等键请求工具许可，并透传未解释的响应', async () => {
    let captured: { readonly input: string | URL, readonly init: RequestInit | undefined } | undefined
    const platform = client(async (input, init) => {
      captured = { input, init }
      return response(['{"status":"denied","reason":"需要审批"}'])
    })
    const permit = {
      executionId: 'execution-1', subject: 'user-1', authorizationVersion: 'v1',
      toolCallId: 'call-1', toolName: 'write', inputDigest: 'sha256:abc',
    }

    await expect(platform.authorizeTool(permit, new AbortController().signal)).resolves.toEqual({
      status: 'denied', reason: '需要审批',
    })
    expect(captured?.input.toString()).toBe('https://platform.test/v1/agent/tool-permits')
    const headers = captured?.init?.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers['Idempotency-Key']).toMatch(/^permit:[0-9a-f]{64}$/)
    expect(JSON.parse(captured?.init?.body as string)).toMatchObject({ ...permit, requestId: headers['Idempotency-Key'] })
  })

  it('以已绑定 memory space 和 JSON 命令调用长期记忆检索', async () => {
    let captured: { readonly input: string | URL, readonly init: RequestInit | undefined } | undefined
    const platform = client(async (input, init) => {
      captured = { input, init }
      return response(['[{"id":"memory-1","content":"偏好简洁回答"}]'])
    })
    await expect(platform.searchMemory({
      memorySpaceId: 'space-1', query: '回答偏好', limit: 4,
    }, new AbortController().signal)).resolves.toEqual([
      { id: 'memory-1', content: '偏好简洁回答' },
    ])
    expect(captured?.input.toString()).toBe('https://platform.test/v1/agent/memory-searches')
    const headers = captured?.init?.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers['Idempotency-Key']).toBe('model-1')
    expect(JSON.parse(captured?.init?.body as string)).toEqual({
      requestId: 'model-1', memorySpaceId: 'space-1', query: '回答偏好', limit: 4,
    })
  })

  it('以已绑定 memory space 和幂等命令保存长期记忆陈述', async () => {
    let captured: { readonly input: string | URL, readonly init: RequestInit | undefined } | undefined
    const platform = client(async (input, init) => {
      captured = { input, init }
      return response(['{"id":"memory-1"}'])
    })
    await expect(platform.writeMemory({
      memorySpaceId: 'space-1', statement: '用户喜欢简洁回答',
    }, new AbortController().signal)).resolves.toEqual({ id: 'memory-1' })
    expect(captured?.input.toString()).toBe('https://platform.test/v1/agent/memory-statements')
    const headers = captured?.init?.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers['Idempotency-Key']).toBe('model-1')
    expect(JSON.parse(captured?.init?.body as string)).toEqual({
      requestId: 'model-1', memorySpaceId: 'space-1', statement: '用户喜欢简洁回答',
    })
  })

  it('以二进制 body 和安全编码元数据导入文档', async () => {
    let captured: { readonly input: string | URL, readonly init: RequestInit | undefined } | undefined
    const platform = client(async (input, init) => {
      captured = { input, init }
      return response(['{"documentId":"document-1","status":"queued"}'])
    })
    const bytes = encoder.encode('hello')
    await expect(platform.importDocument({
      memorySpaceId: 'space-1',
      fileName: '用户指南.txt',
      mediaType: 'text/plain',
      bytes,
      sizeBytes: 5,
      contentSha256: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    }, new AbortController().signal)).resolves.toEqual({
      documentId: 'document-1', status: 'queued',
    })
    bytes[0] = 0
    expect(captured?.input.toString()).toBe('https://platform.test/v1/agent/document-imports')
    const headers = captured?.init?.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers.Authorization).toBe('Bearer service-token')
    expect(headers['Content-Type']).toBe('text/plain')
    expect(headers['Idempotency-Key']).toBe('model-1')
    expect(JSON.parse(Buffer.from(headers['X-Agent-Document-Metadata']!, 'base64url').toString('utf8')))
      .toEqual({
        requestId: 'model-1',
        memorySpaceId: 'space-1',
        fileName: '用户指南.txt',
        sizeBytes: 5,
        contentSha256: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
      })
    expect(new TextDecoder().decode(captured?.init?.body as Uint8Array)).toBe('hello')
  })

  it('在发出请求前拒绝不一致文档元数据', async () => {
    let calls = 0
    const platform = client(async () => { calls += 1; return response(['{}']) })
    await expect(platform.importDocument({
      memorySpaceId: 'space',
      fileName: 'file.txt',
      mediaType: 'text/plain',
      bytes: encoder.encode('hello'),
      sizeBytes: 4,
      contentSha256: 'sha256:invalid',
    }, new AbortController().signal)).rejects.toThrow('sizeBytes 与 bytes 长度不一致')
    expect(calls).toBe(0)
  })

  it('以已绑定 memory space 和 JSON 命令查询文档索引状态', async () => {
    let captured: { readonly input: string | URL, readonly init: RequestInit | undefined } | undefined
    const platform = client(async (input, init) => {
      captured = { input, init }
      return response(['{"documentId":"document-1","status":"indexing"}'])
    })
    await expect(platform.getDocumentStatus({
      memorySpaceId: 'space-1', documentId: 'document-1',
    }, new AbortController().signal)).resolves.toEqual({
      documentId: 'document-1', status: 'indexing',
    })
    expect(captured?.input.toString()).toBe('https://platform.test/v1/agent/document-statuses')
    const headers = captured?.init?.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers['Idempotency-Key']).toBe('model-1')
    expect(JSON.parse(captured?.init?.body as string)).toEqual({
      requestId: 'model-1', memorySpaceId: 'space-1', documentId: 'document-1',
    })
  })

  it('在发出状态请求前拒绝未知字段与空文档 ID', async () => {
    let calls = 0
    const platform = client(async () => { calls += 1; return response(['{}']) })
    await expect(platform.getDocumentStatus({
      memorySpaceId: 'space', documentId: '',
    }, new AbortController().signal)).rejects.toBeInstanceOf(PlatformHttpProtocolError)
    await expect(platform.getDocumentStatus({
      memorySpaceId: 'space', documentId: 'document-1', extra: true,
    } as never, new AbortController().signal)).rejects.toThrow('请求字段无效')
    expect(calls).toBe(0)
  })

  it('以已绑定 memory space 和幂等 JSON 命令删除文档', async () => {
    let captured: { readonly input: string | URL, readonly init: RequestInit | undefined } | undefined
    const platform = client(async (input, init) => {
      captured = { input, init }
      return response(['{"documentId":"document-1","status":"deleting"}'])
    })
    await expect(platform.deleteDocument({
      memorySpaceId: 'space-1', documentId: 'document-1',
    }, new AbortController().signal)).resolves.toEqual({
      documentId: 'document-1', status: 'deleting',
    })
    expect(captured?.input.toString()).toBe('https://platform.test/v1/agent/document-deletions')
    const headers = captured?.init?.headers as Record<string, string>
    expect(headers.Accept).toBe('application/json')
    expect(headers['Idempotency-Key']).toBe('model-1')
    expect(JSON.parse(captured?.init?.body as string)).toEqual({
      requestId: 'model-1', memorySpaceId: 'space-1', documentId: 'document-1',
    })
  })

  it('在发出删除请求前拒绝未知字段与空 memory space', async () => {
    let calls = 0
    const platform = client(async () => { calls += 1; return response(['{}']) })
    await expect(platform.deleteDocument({
      memorySpaceId: '', documentId: 'document-1',
    }, new AbortController().signal)).rejects.toBeInstanceOf(PlatformHttpProtocolError)
    await expect(platform.deleteDocument({
      memorySpaceId: 'space', documentId: 'document-1', extra: true,
    } as never, new AbortController().signal)).rejects.toThrow('请求字段无效')
    expect(calls).toBe(0)
  })

  it('在发出请求前限制文档 MIME 字节数', async () => {
    let calls = 0
    const platform = client(async () => { calls += 1; return response(['{}']) })
    await expect(platform.importDocument({
      memorySpaceId: 'space',
      fileName: 'file.bin',
      mediaType: `application/${'x'.repeat(245)}`,
      bytes: encoder.encode('hello'),
      sizeBytes: 5,
      contentSha256: 'sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    }, new AbortController().signal)).rejects.toThrow('不能超过 255 UTF-8 字节')
    expect(calls).toBe(0)
  })

  it('拒绝无效 Memory 写入请求并在响应取消竞态释放 body', async () => {
    const platform = client(async () => response(['{}']))
    await expect(platform.writeMemory({
      memorySpaceId: 'space', statement: '',
    }, new AbortController().signal)).rejects.toBeInstanceOf(PlatformHttpProtocolError)

    let cancelled = false
    const controller = new AbortController()
    const cancelling = client(async () => {
      controller.abort(new Error('停止写入'))
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true },
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    await expect(cancelling.writeMemory({
      memorySpaceId: 'space', statement: '偏好',
    }, controller.signal)).rejects.toThrow('停止写入')
    expect(cancelled).toBe(true)
  })

  it('拒绝无效 Memory 请求并在响应取消竞态释放 body', async () => {
    const platform = client(async () => response(['[]']))
    await expect(platform.searchMemory({
      memorySpaceId: '', query: 'q', limit: 1,
    }, new AbortController().signal)).rejects.toBeInstanceOf(PlatformHttpProtocolError)

    let cancelled = false
    const controller = new AbortController()
    const cancelling = client(async () => {
      controller.abort(new Error('停止检索'))
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { cancelled = true },
      }), { headers: { 'Content-Type': 'application/json' } })
    })
    await expect(cancelling.searchMemory({
      memorySpaceId: 'space', query: 'q', limit: 1,
    }, controller.signal)).rejects.toThrow('停止检索')
    expect(cancelled).toBe(true)
  })

  it.each([
    ['空认证', { authorization: '' }],
    ['明文 HTTP 根地址', { baseUrl: 'http://platform.test/v1' }],
    ['非 HTTPS 根地址', { baseUrl: 'file:///tmp/platform' }],
    ['零响应上限', { maxResponseBytes: 0 }],
    ['零文档上限', { maxDocumentBytes: 0 }],
    ['无效幂等键生成器', { requestIds: {} }],
  ])('拒绝%s配置', (_name, override) => {
    expect(() => new PlatformHttpClient({
      baseUrl: 'https://platform.test/v1', authorization: 'Bearer token', ...override,
    })).toThrow(PlatformHttpConfigurationError)
  })

  it('在 HTTP 失败与 Content-Type 失败时取消未读取的响应 body', async () => {
    let failedStatusCancelled = false
    const failedStatus = client(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        failedStatusCancelled = true
      },
    }), { status: 502, statusText: 'Bad Gateway', headers: { 'Content-Type': 'application/json' } }))
    await expect(failedStatus.authorizeTool({
      executionId: 'e', subject: 's', authorizationVersion: 'v', toolCallId: 'c', toolName: 't', inputDigest: 'd',
    }, new AbortController().signal)).rejects.toBeInstanceOf(PlatformHttpError)
    expect(failedStatusCancelled).toBe(true)

    let contentTypeCancelled = false
    const failedContentType = client(async () => new Response(new ReadableStream<Uint8Array>({
      cancel() {
        contentTypeCancelled = true
      },
    }), { headers: { 'Content-Type': 'text/plain' } }))
    await expect(failedContentType.authorizeTool({
      executionId: 'e', subject: 's', authorizationVersion: 'v', toolCallId: 'c', toolName: 't', inputDigest: 'd',
    }, new AbortController().signal)).rejects.toBeInstanceOf(PlatformHttpProtocolError)
    expect(contentTypeCancelled).toBe(true)
  })

  it.each([
    ['非成功状态', () => response([], { status: 502 }), PlatformHttpError],
    ['错误 Content-Type', () => response(['{}'], { contentType: 'text/plain' }), PlatformHttpProtocolError],
    ['畸形 NDJSON', () => response(['{bad}\n'], { contentType: 'application/x-ndjson' }), PlatformHttpProtocolError],
    ['无换行的 NDJSON 结尾', () => response(['{}'], { contentType: 'application/x-ndjson' }), PlatformHttpProtocolError],
  ])('拒绝 Gateway %s', async (_name, makeResponse, ErrorType) => {
    const platform = client(async () => makeResponse())
    const prepared = await platform.prepare({ modelId: 'model' }, new AbortController().signal)
    await expect(Array.fromAsync(prepared.stream(request(), new AbortController().signal))).rejects.toBeInstanceOf(ErrorType)
  })

  it('限制 Permit 与 Gateway 响应大小', async () => {
    const platform = new PlatformHttpClient({
      baseUrl: 'https://platform.test/v1', authorization: 'Bearer token', maxResponseBytes: 4,
      fetch: async () => response(['12345']),
    })
    await expect(platform.authorizeTool({
      executionId: 'e', subject: 's', authorizationVersion: 'v', toolCallId: 'c', toolName: 't', inputDigest: 'd',
    }, new AbortController().signal)).rejects.toThrow('Platform 响应超过 maxResponseBytes (4)')
  })

  it('Permit 响应失败时取消底层 reader', async () => {
    let cancelled = false
    const platform = new PlatformHttpClient({
      baseUrl: 'https://platform.test/v1', authorization: 'Bearer token', maxResponseBytes: 4,
      fetch: async () => new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(encoder.encode('12345'))
        },
        cancel() {
          cancelled = true
        },
      }), { headers: { 'Content-Type': 'application/json' } }),
    })
    await expect(platform.authorizeTool({
      executionId: 'e', subject: 's', authorizationVersion: 'v', toolCallId: 'c', toolName: 't', inputDigest: 'd',
    }, new AbortController().signal)).rejects.toThrow('Platform 响应超过 maxResponseBytes (4)')
    expect(cancelled).toBe(true)
  })

  it('在 prepare 后与读取流时检查取消', async () => {
    const preparedController = new AbortController()
    const platform = client(async () => response(['{}\n'], { contentType: 'application/x-ndjson' }))
    preparedController.abort(new Error('停止准备'))
    await expect(platform.prepare({ modelId: 'model' }, preparedController.signal)).rejects.toThrow('停止准备')

    const streamingController = new AbortController()
    const streamingPlatform = client(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        streamingController.abort(new Error('停止读取'))
        controller.enqueue(encoder.encode('{}\n'))
      },
    }), { headers: { 'Content-Type': 'application/x-ndjson' } }))
    const prepared = await streamingPlatform.prepare({ modelId: 'model' }, streamingController.signal)
    await expect(Array.fromAsync(prepared.stream(request(), streamingController.signal))).rejects.toThrow('停止读取')
  })

  it('fetch 返回响应后的取消竞争会释放 body', async () => {
    let cancelled = false
    const controller = new AbortController()
    const platform = client(async () => {
      controller.abort(new Error('响应已到达但调用已取消'))
      return new Response(new ReadableStream<Uint8Array>({
        cancel() {
          cancelled = true
        },
      }), { headers: { 'Content-Type': 'application/x-ndjson' } })
    })
    const prepared = await platform.prepare({ modelId: 'model' }, controller.signal)
    await expect(Array.fromAsync(prepared.stream(request(), controller.signal)))
      .rejects.toThrow('响应已到达但调用已取消')
    expect(cancelled).toBe(true)
  })
})
