import type { ModelRequest } from '@agent-harness/model'
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

  it.each([
    ['空认证', { authorization: '' }],
    ['明文 HTTP 根地址', { baseUrl: 'http://platform.test/v1' }],
    ['非 HTTPS 根地址', { baseUrl: 'file:///tmp/platform' }],
    ['零响应上限', { maxResponseBytes: 0 }],
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
