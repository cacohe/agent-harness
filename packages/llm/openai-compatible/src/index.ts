import {
  assertJsonValue,
  assertNever,
  brandId,
  type JsonObject,
  type JsonValue,
  type ModelMessage,
  type ToolCall,
  type ToolCallId,
} from '@agent-harness/domain'
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  PreparedModelCall,
} from '@agent-harness/model'

type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

/** OpenAI-compatible provider 的显式连接配置。 */
export interface OpenAiCompatibleModelProviderOptions {
  readonly id: string
  readonly baseUrl: string
  readonly apiKey: string
  readonly model: string
  readonly headers?: Readonly<Record<string, string>>
  readonly fetch?: FetchImplementation
  /** 单个尚未完成 SSE 行的最大 UTF-8 字节数。 */
  readonly maxSseBufferBytes?: number
}

/** 配置在构造阶段不满足协议前提时抛出。 */
export class OpenAiCompatibleConfigurationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OpenAiCompatibleConfigurationError'
  }
}

/** HTTP 响应不是成功状态时抛出，保留供应商状态码供策略层分类。 */
export class OpenAiCompatibleHttpError extends Error {
  readonly status: number
  readonly statusText: string

  constructor(status: number, statusText: string) {
    super(`OpenAI-compatible 请求失败：HTTP ${status} ${statusText}`)
    this.name = 'OpenAiCompatibleHttpError'
    this.status = status
    this.statusText = statusText
  }
}

/** SSE 字节、事件或 Chat Completions 字段不能安全映射时抛出。 */
export class OpenAiCompatibleProtocolError extends Error {
  constructor(message: string) {
    super(`OpenAI-compatible SSE 协议错误：${message}`)
    this.name = 'OpenAiCompatibleProtocolError'
  }
}

/** 使用原生 fetch 的 OpenAI-compatible Chat Completions 流式模型实现。 */
export class OpenAiCompatibleModelProvider implements ModelProvider {
  readonly id: string
  readonly #endpoint: URL
  readonly #model: string
  readonly #headers: Readonly<Record<string, string>>
  readonly #fetch: FetchImplementation
  readonly #maxSseBufferBytes: number

  constructor(options: OpenAiCompatibleModelProviderOptions) {
    this.id = requireNonEmpty(options.id, 'provider id')
    this.#endpoint = resolveEndpoint(options.baseUrl)
    this.#model = requireNonEmpty(options.model, 'model')
    const apiKey = requireNonEmpty(options.apiKey, 'API key')
    this.#headers = buildHeaders(apiKey, options.headers)
    this.#fetch = options.fetch ?? fetch
    this.#maxSseBufferBytes = options.maxSseBufferBytes ?? 1_048_576
    if (!Number.isSafeInteger(this.#maxSseBufferBytes) || this.#maxSseBufferBytes < 1) {
      throw new OpenAiCompatibleConfigurationError('maxSseBufferBytes 必须是正整数')
    }
  }

  async prepare(signal: AbortSignal): Promise<PreparedModelCall> {
    signal.throwIfAborted()
    return new OpenAiCompatiblePreparedCall(
      this.#endpoint,
      this.#model,
      this.#headers,
      this.#fetch,
      this.#maxSseBufferBytes,
    )
  }
}

class OpenAiCompatiblePreparedCall implements PreparedModelCall {
  readonly #endpoint: URL
  readonly #model: string
  readonly #headers: Readonly<Record<string, string>>
  readonly #fetch: FetchImplementation
  readonly #maxSseBufferBytes: number

  constructor(
    endpoint: URL,
    model: string,
    headers: Readonly<Record<string, string>>,
    fetchImplementation: FetchImplementation,
    maxSseBufferBytes: number,
  ) {
    this.#endpoint = endpoint
    this.#model = model
    this.#headers = headers
    this.#fetch = fetchImplementation
    this.#maxSseBufferBytes = maxSseBufferBytes
  }

  async *stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent> {
    signal.throwIfAborted()
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST',
      headers: this.#headers,
      body: JSON.stringify(toChatCompletionsRequest(this.#model, request)),
      signal,
    })
    signal.throwIfAborted()
    if (!response.ok) {
      throw new OpenAiCompatibleHttpError(response.status, response.statusText)
    }
    if (response.body === null) {
      throw new OpenAiCompatibleProtocolError('成功响应缺少 SSE body')
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder('utf-8', { fatal: true })
    const fragments = new ToolCallFragments()
    let lineBuffer = ''
    let dataLines: string[] = []
    let dataBytes = 0
    let receivedDone = false
    let streamFinished = false

    const processLine = (line: string): string | undefined => {
      if (line.length === 0) {
        if (dataLines.length === 0) return undefined
        const payload = dataLines.join('\n')
        dataLines = []
        dataBytes = 0
        return payload
      }
      if (line.startsWith(':')) return undefined
      const separator = line.indexOf(':')
      const field = separator === -1 ? line : line.slice(0, separator)
      let value = separator === -1 ? '' : line.slice(separator + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') {
        dataBytes += Buffer.byteLength(value, 'utf8') + 1
        if (dataBytes > this.#maxSseBufferBytes) {
          throw new OpenAiCompatibleProtocolError('SSE data 事件超过 maxSseBufferBytes')
        }
        dataLines.push(value)
      }
      return undefined
    }

    const processPayload = (payload: string): ModelStreamEvent[] => {
      if (receivedDone) {
        throw new OpenAiCompatibleProtocolError('[DONE] 后又收到 data 事件')
      }
      if (payload === '[DONE]') {
        receivedDone = true
        return []
      }
      const chunk = parseChunk(payload)
      return decodeChunk(chunk, fragments)
    }

    try {
      while (true) {
        const read = await readWithAbort(reader, signal)
        if (read.done) break
        let decoded: string
        try {
          decoded = decoder.decode(read.value, { stream: true })
        } catch (error) {
          throw new OpenAiCompatibleProtocolError(`SSE 不是有效 UTF-8：${errorMessage(error)}`)
        }
        lineBuffer += decoded
        if (Buffer.byteLength(lineBuffer, 'utf8') > this.#maxSseBufferBytes) {
          throw new OpenAiCompatibleProtocolError('SSE 行超过 maxSseBufferBytes')
        }
        for (let newline = lineBuffer.indexOf('\n'); newline !== -1; newline = lineBuffer.indexOf('\n')) {
          const rawLine = lineBuffer.slice(0, newline)
          lineBuffer = lineBuffer.slice(newline + 1)
          const payload = processLine(rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine)
          if (payload !== undefined) {
            for (const event of processPayload(payload)) yield event
          }
        }
      }

      let trailing: string
      try {
        trailing = decoder.decode()
      } catch (error) {
        throw new OpenAiCompatibleProtocolError(`SSE 不是有效 UTF-8：${errorMessage(error)}`)
      }
      lineBuffer += trailing
      if (lineBuffer.length > 0) {
        const payload = processLine(lineBuffer.endsWith('\r') ? lineBuffer.slice(0, -1) : lineBuffer)
        if (payload !== undefined) {
          for (const event of processPayload(payload)) yield event
        }
      }
      if (dataLines.length > 0) {
        for (const event of processPayload(dataLines.join('\n'))) yield event
      }
      if (!receivedDone) {
        throw new OpenAiCompatibleProtocolError('SSE 在 [DONE] 前结束')
      }
      for (const call of fragments.finish()) {
        yield { type: 'tool.call', call }
      }
      streamFinished = true
    } finally {
      if (!streamFinished) void reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }
}

function resolveEndpoint(baseUrl: string): URL {
  let base: URL
  try {
    base = new URL(baseUrl)
  } catch {
    throw new OpenAiCompatibleConfigurationError('base URL 必须是绝对 URL')
  }
  if (!base.protocol || !base.host) {
    throw new OpenAiCompatibleConfigurationError('base URL 必须包含协议与主机')
  }
  if (base.search || base.hash) {
    throw new OpenAiCompatibleConfigurationError('base URL 不得包含 query 或 fragment')
  }
  if (/\/chat\/completions\/?$/.test(base.pathname)) {
    throw new OpenAiCompatibleConfigurationError('base URL 必须是 API 根路径，不能是完整 chat/completions endpoint')
  }
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`
  return new URL('chat/completions', base)
}

function buildHeaders(
  apiKey: string,
  additionalHeaders: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(additionalHeaders ?? {})) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)
      || typeof value !== 'string'
      || /[\r\n]/.test(value)
    ) {
      throw new OpenAiCompatibleConfigurationError('额外请求头包含非法名称或值')
    }
    if (['authorization', 'content-type', 'accept'].includes(name.toLowerCase())) {
      throw new OpenAiCompatibleConfigurationError(`额外请求头不得覆盖 ${name}`)
    }
    headers[name] = value
  }
  return {
    ...headers,
    Accept: 'text/event-stream',
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }
}

function requireNonEmpty(value: string, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpenAiCompatibleConfigurationError(`${name} 必须是非空字符串`)
  }
  return value
}

function toChatCompletionsRequest(model: string, request: ModelRequest) {
  return {
    model,
    stream: true as const,
    messages: request.messages.map(toChatMessage),
    // 部分供应商拒绝空 tools；无工具时省略该字段。
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map(tool => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
  }
}

function toChatMessage(message: ModelMessage) {
  switch (message.role) {
    case 'system':
      return { role: 'system' as const, content: message.content }
    case 'user':
      return { role: 'user' as const, content: message.content }
    case 'assistant':
      return {
        role: 'assistant' as const,
        content: message.content,
        // 部分供应商拒绝空 tool_calls；无调用时省略该字段。
        ...(message.toolCalls.length === 0
          ? {}
          : {
              tool_calls: message.toolCalls.map(call => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: stableJson(call.input) },
              })),
            }),
      }
    case 'tool':
      return {
        role: 'tool' as const,
        tool_call_id: message.callId,
        content: stableJson(message.result),
      }
    default:
      return assertNever(message)
  }
}

function stableJson(value: unknown): string {
  assertJsonValue(value)
  return stableJsonValue(value)
}

function stableJsonValue(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(',')}]`
  const record = value as JsonObject
  return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJsonValue(record[key]!)}`).join(',')}}`
}

function parseChunk(payload: string): JsonObject {
  let value: unknown
  try {
    value = JSON.parse(payload)
  } catch (error) {
    throw new OpenAiCompatibleProtocolError(`data 不是 JSON：${errorMessage(error)}`)
  }
  return requireObject(value, 'chunk')
}

function decodeChunk(chunk: JsonObject, fragments: ToolCallFragments): ModelStreamEvent[] {
  const choices = chunk.choices
  if (!Array.isArray(choices)) throw new OpenAiCompatibleProtocolError('chunk.choices 必须是数组')
  if (choices.length > 1) {
    throw new OpenAiCompatibleProtocolError('非空 chunk.choices 必须只包含单一回复')
  }
  const events: ModelStreamEvent[] = []
  const usage = chunk.usage
  if (usage !== undefined) {
    const record = requireObject(usage, 'chunk.usage')
    const inputTokens = requireNonNegativeInteger(record.prompt_tokens, 'chunk.usage.prompt_tokens')
    const outputTokens = requireNonNegativeInteger(record.completion_tokens, 'chunk.usage.completion_tokens')
    events.push({ type: 'usage', inputTokens, outputTokens })
  }
  for (const choice of choices) {
    const record = requireObject(choice, 'chunk.choices[]')
    if (requireNonNegativeInteger(record.index, 'chunk.choices[].index') !== 0) {
      throw new OpenAiCompatibleProtocolError('只支持 choice index 为 0 的单一回复')
    }
    const delta = requireObject(record.delta, 'chunk.choices[].delta')
    if (delta.content !== undefined && typeof delta.content !== 'string' && delta.content !== null) {
      throw new OpenAiCompatibleProtocolError('chunk.choices[].delta.content 必须是字符串或 null')
    }
    if (typeof delta.content === 'string' && delta.content.length > 0) {
      events.push({ type: 'text.delta', text: delta.content })
    }
    if (delta.tool_calls !== undefined) {
      if (!Array.isArray(delta.tool_calls)) {
        throw new OpenAiCompatibleProtocolError('chunk.choices[].delta.tool_calls 必须是数组')
      }
      for (const call of delta.tool_calls) fragments.append(requireObject(call, 'tool call'))
    }
  }
  return events
}

class ToolCallFragments {
  readonly #calls = new Map<number, ToolCallFragment>()

  append(chunk: JsonObject): void {
    const index = requireNonNegativeInteger(chunk.index, 'tool call index')
    let fragment = this.#calls.get(index)
    if (fragment === undefined) {
      fragment = new ToolCallFragment(index)
      this.#calls.set(index, fragment)
    }
    fragment.append(chunk)
  }

  finish(): readonly ToolCall[] {
    const calls = [...this.#calls.values()].sort((left, right) => left.index - right.index)
    const ids = new Set<string>()
    return calls.map((fragment, expectedIndex) => {
      if (fragment.index !== expectedIndex) {
        throw new OpenAiCompatibleProtocolError('tool call index 必须从 0 连续')
      }
      const call = fragment.finish()
      if (ids.has(call.id)) {
        throw new OpenAiCompatibleProtocolError('不同 tool call index 不得重复 id')
      }
      ids.add(call.id)
      return call
    })
  }
}

class ToolCallFragment {
  readonly index: number
  #id: string | undefined
  #name: string | undefined
  #arguments = ''
  #sawArguments = false

  constructor(index: number) {
    this.index = index
  }

  append(chunk: JsonObject): void {
    if (chunk.id !== undefined) this.#id = mergeRequiredString(this.#id, chunk.id, 'tool call id')
    if (chunk.type !== undefined && chunk.type !== 'function') {
      throw new OpenAiCompatibleProtocolError('tool call type 必须是 function')
    }
    if (chunk.function === undefined) return
    const functionValue = requireObject(chunk.function, 'tool call function')
    if (functionValue.name !== undefined) {
      this.#name = mergeRequiredString(this.#name, functionValue.name, 'tool call name')
    }
    if (functionValue.arguments !== undefined) {
      if (typeof functionValue.arguments !== 'string') {
        throw new OpenAiCompatibleProtocolError('tool call arguments 必须是字符串')
      }
      this.#arguments += functionValue.arguments
      this.#sawArguments = true
    }
  }

  finish(): ToolCall {
    if (this.#id === undefined || this.#name === undefined || !this.#sawArguments) {
      throw new OpenAiCompatibleProtocolError(`tool call index ${this.index} 缺少 id、name 或 arguments`)
    }
    let input: unknown
    try {
      input = JSON.parse(this.#arguments)
    } catch (error) {
      throw new OpenAiCompatibleProtocolError(`tool call index ${this.index} 的 arguments 不是 JSON：${errorMessage(error)}`)
    }
    try {
      assertJsonValue(input)
    } catch (error) {
      throw new OpenAiCompatibleProtocolError(`tool call index ${this.index} 的 arguments 不可表示为 JSON：${errorMessage(error)}`)
    }
    return {
      id: brandId<'ToolCallId'>(this.#id) as ToolCallId,
      name: this.#name,
      input,
    }
  }
}

function mergeRequiredString(
  current: string | undefined,
  value: unknown,
  field: string,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new OpenAiCompatibleProtocolError(`${field} 必须是非空字符串`)
  }
  if (current !== undefined && current !== value) {
    throw new OpenAiCompatibleProtocolError(`${field} 在同一 index 中冲突`)
  }
  return value
}

function requireObject(value: unknown, name: string): JsonObject {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenAiCompatibleProtocolError(`${name} 必须是对象`)
  }
  return value as JsonObject
}

function requireNonNegativeInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new OpenAiCompatibleProtocolError(`${name} 必须是非负安全整数`)
  }
  return value
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  signal.throwIfAborted()
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => {
      reject(signal.reason ?? new DOMException('operation aborted', 'AbortError'))
      void reader.cancel(signal.reason).catch(() => undefined)
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([reader.read(), aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
