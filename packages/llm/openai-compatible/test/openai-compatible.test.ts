import { brandId, type MessageId, type ToolCallId } from '@agent-harness/domain'
import type { ModelRequest, ModelStreamEvent } from '@agent-harness/model'
import { describe, expect, it } from 'vitest'
import {
  OpenAiCompatibleConfigurationError,
  OpenAiCompatibleHttpError,
  OpenAiCompatibleModelProvider,
  OpenAiCompatibleProtocolError,
} from '../src/index.ts'

const encoder = new TextEncoder()

function request(): ModelRequest {
  return {
    messages: [
      { id: brandId<'MessageId'>('user-1') as MessageId, role: 'user', content: 'hello' },
      {
        id: brandId<'MessageId'>('assistant-1') as MessageId,
        role: 'assistant',
        content: '',
        toolCalls: [{
          id: brandId<'ToolCallId'>('previous-call') as ToolCallId,
          name: 'lookup',
          input: { z: 1, a: ['value'] },
        }],
      },
      {
        role: 'tool',
        callId: brandId<'ToolCallId'>('previous-call') as ToolCallId,
        result: {
          status: 'success',
          callId: brandId<'ToolCallId'>('previous-call') as ToolCallId,
          output: { z: 1, a: 'ok' },
        },
      },
    ],
    tools: [{ name: 'lookup', description: '查询', inputSchema: { type: 'object' } }],
  }
}

function response(parts: readonly (string | Uint8Array)[], status = 200): Response {
  let position = 0
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      const part = parts[position++]
      if (part === undefined) controller.close()
      else controller.enqueue(typeof part === 'string' ? encoder.encode(part) : part)
    },
  }), { status, statusText: status === 200 ? 'OK' : 'Bad Gateway' })
}

function provider(fetchImplementation: typeof fetch): OpenAiCompatibleModelProvider {
  return new OpenAiCompatibleModelProvider({
    id: 'deepseek',
    baseUrl: 'https://example.test/v1',
    apiKey: 'secret',
    model: 'deepseek-chat',
    headers: { 'X-Tenant': 'lab' },
    fetch: fetchImplementation,
  })
}

async function events(
  model: OpenAiCompatibleModelProvider,
  signal = new AbortController().signal,
): Promise<ModelStreamEvent[]> {
  const call = await model.prepare(signal)
  return Array.fromAsync(call.stream(request(), signal))
}

describe('OpenAiCompatibleModelProvider', () => {
  it('映射请求、固定鉴权头和稳定工具 JSON', async () => {
    let captured: { readonly input: string | URL, readonly init: RequestInit | undefined } | undefined
    const model = provider(async (input, init) => {
      captured = { input, init }
      return response(['data: [DONE]\n\n'])
    })

    await expect(events(model)).resolves.toEqual([])
    expect(captured?.input.toString()).toBe('https://example.test/v1/chat/completions')
    expect(captured?.init?.headers).toEqual({
      'X-Tenant': 'lab',
      Accept: 'text/event-stream',
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    })
    expect(JSON.parse(captured?.init?.body as string)).toMatchObject({
      model: 'deepseek-chat',
      stream: true,
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          tool_calls: [{ function: { arguments: '{"a":["value"],"z":1}' } }],
        },
        { role: 'tool', content: '{"callId":"previous-call","output":{"a":"ok","z":1},"status":"success"}' },
      ],
      tools: [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object' } } }],
    })
  })

  it('增量解析文本、usage、跨字节 SSE 与分段 tool arguments', async () => {
    const model = provider(async () => response([
      'data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"好","tool_calls":[{"index":0,"id":"call-1","type":"function","function":{"name":"lookup","arguments":"{\\"q\\":"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x\\"}"}}]}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\n',
      'data: [DONE]\n\n',
    ]))

    await expect(events(model)).resolves.toEqual([
      { type: 'text.delta', text: '你' },
      { type: 'text.delta', text: '好' },
      { type: 'usage', inputTokens: 3, outputTokens: 5 },
      {
        type: 'tool.call',
        call: { id: 'call-1', name: 'lookup', input: { q: 'x' } },
      },
    ])
  })

  it('在 UTF-8 多字节字符中间分片时保持文本', async () => {
    const payload = encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"你"}}]}\n\ndata: [DONE]\n\n')
    const characterStart = payload.findIndex((byte, index) =>
      byte === 0xe4 && payload[index + 1] === 0xbd && payload[index + 2] === 0xa0,
    )
    const model = provider(async () => response([
      payload.slice(0, characterStart + 1),
      payload.slice(characterStart + 1),
    ]))

    await expect(events(model)).resolves.toEqual([{ type: 'text.delta', text: '你' }])
  })

  it('按 SSE 的 CRLF 和多行 data 规则组装 JSON', async () => {
    const model = provider(async () => response([
      'data: {"choices":[]\r\n',
      'data: }\r\n\r\n',
      'data: [DONE]\r\n\r\n',
    ]))

    await expect(events(model)).resolves.toEqual([])
  })

  it('按 tool call index 而非收到顺序发布多个调用', async () => {
    const model = provider(async () => response([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"second","function":{"name":"two","arguments":"{}"}},{"index":0,"id":"first","function":{"name":"one","arguments":"[]"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    await expect(events(model)).resolves.toEqual([
      { type: 'tool.call', call: { id: 'first', name: 'one', input: [] } },
      { type: 'tool.call', call: { id: 'second', name: 'two', input: {} } },
    ])
  })

  it.each([
    ['非成功 HTTP', async () => response([], 502), OpenAiCompatibleHttpError],
    ['畸形 data JSON', async () => response(['data: {bad}\n\n']), OpenAiCompatibleProtocolError],
    ['缺少 DONE', async () => response(['data: {"choices":[]}\n\n']), OpenAiCompatibleProtocolError],
    ['无效 tool arguments', async () => response([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"bad","arguments":"{"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]), OpenAiCompatibleProtocolError],
    ['冲突 tool id', async () => response([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"one","function":{"name":"x","arguments":"{}"}}]}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"two"}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]), OpenAiCompatibleProtocolError],
    ['间断 tool index', async () => response([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":1,"id":"call","function":{"name":"bad","arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]), OpenAiCompatibleProtocolError],
    ['跨 index 重复 tool id', async () => response([
      'data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"same","function":{"name":"one","arguments":"{}"}},{"index":1,"id":"same","function":{"name":"two","arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]), OpenAiCompatibleProtocolError],
    ['DONE 后额外 data', async () => response([
      'data: [DONE]\n\n',
      'data: {"choices":[]}\n\n',
    ]), OpenAiCompatibleProtocolError],
    ['无效 UTF-8', async () => response([
      encoder.encode('data: '),
      new Uint8Array([0xff, 0x0a, 0x0a]),
    ]), OpenAiCompatibleProtocolError],
  ])('拒绝%s', async (_name, makeResponse, error) => {
    const model = provider(makeResponse)
    await expect(events(model)).rejects.toBeInstanceOf(error)
  })

  it('拒绝同一 chunk 的多个 choice，且不发布其中的工具调用', async () => {
    const model = provider(async () => response([
      'data: {"choices":[{"index":0,"delta":{"content":"text"}},{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call","function":{"name":"unsafe","arguments":"{}"}}]}}]}\n\n',
      'data: [DONE]\n\n',
    ]))
    const prepared = await model.prepare(new AbortController().signal)
    const observed: ModelStreamEvent[] = []
    await expect((async () => {
      for await (const event of prepared.stream(request(), new AbortController().signal)) {
        observed.push(event)
      }
    })()).rejects.toBeInstanceOf(OpenAiCompatibleProtocolError)
    expect(observed).toEqual([])
  })

  it('拒绝成功响应缺少 body', async () => {
    const model = provider(async () => new Response(null, { status: 204 }))
    await expect(events(model)).rejects.toBeInstanceOf(OpenAiCompatibleProtocolError)
  })

  it('prepare 和 stream 保留取消语义', async () => {
    const controller = new AbortController()
    controller.abort(new DOMException('停止', 'AbortError'))
    const fetchImplementation = async (): Promise<Response> => {
      throw new Error('不应发起请求')
    }
    const model = provider(fetchImplementation)
    await expect(model.prepare(controller.signal)).rejects.toThrow('停止')
    const prepared = await model.prepare(new AbortController().signal)
    await expect(Array.fromAsync(prepared.stream(request(), controller.signal))).rejects.toThrow('停止')
  })

  it('在等待 reader 时取消 stream 并取消底层 body', async () => {
    let cancelled = false
    const model = provider(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"index":0,"delta":{"content":"first"}}]}\n\n'))
      },
      pull() {
        return new Promise<void>(() => undefined)
      },
      cancel() {
        cancelled = true
      },
    })))
    const controller = new AbortController()
    const prepared = await model.prepare(controller.signal)
    const iterator = prepared.stream(request(), controller.signal)[Symbol.asyncIterator]()
    await expect(iterator.next()).resolves.toMatchObject({ value: { type: 'text.delta', text: 'first' } })
    const pending = iterator.next()
    controller.abort(new DOMException('停止读取', 'AbortError'))
    await expect(pending).rejects.toThrow('停止读取')
    expect(cancelled).toBe(true)
  })

  it('配置拒绝相对 URL、空值和受保护请求头覆盖', () => {
    expect(() => new OpenAiCompatibleModelProvider({
      id: '', baseUrl: '/v1', apiKey: '', model: '',
    })).toThrow(OpenAiCompatibleConfigurationError)
    expect(() => new OpenAiCompatibleModelProvider({
      id: 'x', baseUrl: 'https://example.test/v1', apiKey: 'key', model: 'm',
      headers: { Authorization: 'other' },
    })).toThrow(OpenAiCompatibleConfigurationError)
    expect(() => new OpenAiCompatibleModelProvider({
      id: 'x', baseUrl: 'https://example.test/v1?query=1', apiKey: 'key', model: 'm',
    })).toThrow(OpenAiCompatibleConfigurationError)
    expect(() => new OpenAiCompatibleModelProvider({
      id: 'x', baseUrl: 'https://example.test/v1/chat/completions', apiKey: 'key', model: 'm',
    })).toThrow(OpenAiCompatibleConfigurationError)
  })
})
