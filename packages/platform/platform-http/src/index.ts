import { createHash, randomUUID } from 'node:crypto'
import type { ModelRequest } from '@agent-harness/model'

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>

/** 为模型调用生成可在传输重试中复用的幂等标识符。 */
export interface PlatformRequestIdGenerator {
  next(): string
}

/** Platform 工具许可 HTTP 请求的稳定字段。 */
export interface PlatformHttpPermitRequest {
  readonly executionId: string
  readonly subject: string
  readonly authorizationVersion: string
  readonly toolCallId: string
  readonly toolName: string
  readonly inputDigest: string
}

/** Platform HTTP 传输的显式配置；密钥和身份由 Host 或 Platform 提供。 */
export interface PlatformHttpClientOptions {
  /** Platform API 根路径，例如 `https://platform.example/v1`。 */
  readonly baseUrl: string
  /** 已解析的认证头完整值，例如 `Bearer <service-token>`。 */
  readonly authorization: string
  readonly fetch?: FetchImplementation
  readonly requestIds?: PlatformRequestIdGenerator
  /** 单次 JSON 或 NDJSON 响应允许接收的最大 UTF-8 字节数。 */
  readonly maxResponseBytes?: number
}

/** Platform HTTP 配置在构造阶段不满足前提时抛出。 */
export class PlatformHttpConfigurationError extends Error {
  override readonly name = 'PlatformHttpConfigurationError'
}

/** Platform 返回非成功 HTTP 状态时抛出，保留状态码供 Host 分类。 */
export class PlatformHttpError extends Error {
  readonly status: number
  readonly statusText: string

  constructor(endpoint: URL, status: number, statusText: string) {
    super(`Platform 请求失败：${endpoint.pathname} 返回 HTTP ${status} ${statusText}`)
    this.name = 'PlatformHttpError'
    this.status = status
    this.statusText = statusText
  }
}

/** Platform HTTP body、Content-Type 或 NDJSON 语法不能安全映射时抛出。 */
export class PlatformHttpProtocolError extends Error {
  override readonly name = 'PlatformHttpProtocolError'
}

const DEFAULT_MAX_RESPONSE_BYTES = 1_048_576

/**
 * 单实例 Host 可复用的 Platform HTTP client。
 *
 * 它以结构化方法同时满足 LLM Gateway 与工具许可 adapter 的注入接口。Platform
 * 服务端必须在接收幂等请求时原子写入计费、审计与可重试 outbox；Harness 不保存账务状态。
 */
export class PlatformHttpClient {
  readonly #modelCallsEndpoint: URL
  readonly #toolPermitsEndpoint: URL
  readonly #authorization: string
  readonly #fetch: FetchImplementation
  readonly #requestIds: PlatformRequestIdGenerator
  readonly #maxResponseBytes: number

  constructor(options: PlatformHttpClientOptions) {
    const baseUrl = parseBaseUrl(options.baseUrl)
    this.#modelCallsEndpoint = new URL('agent/model-calls', baseUrl)
    this.#toolPermitsEndpoint = new URL('agent/tool-permits', baseUrl)
    this.#authorization = headerValue(options.authorization, 'authorization', PlatformHttpConfigurationError)
    this.#fetch = options.fetch ?? fetch
    this.#requestIds = options.requestIds ?? { next: () => randomUUID() }
    if (!isRequestIdGenerator(this.#requestIds)) {
      throw new PlatformHttpConfigurationError('requestIds 必须提供 next 方法')
    }
    this.#maxResponseBytes = positiveSafeInteger(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      'maxResponseBytes',
      PlatformHttpConfigurationError,
    )
  }

  /** 为指定模型创建与 LlmGatewayClient 结构兼容的调用句柄。 */
  async prepare(
    selection: { readonly modelId: string },
    signal: AbortSignal,
  ): Promise<{ stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<unknown> }> {
    signal.throwIfAborted()
    const modelId = nonEmptyString(selection.modelId, 'modelId', PlatformHttpProtocolError)
    return Object.freeze({
      stream: (request: ModelRequest, streamSignal: AbortSignal) =>
        this.#streamModelCall(modelId, request, streamSignal),
    })
  }

  /** 以与 PlatformPermitClient 结构兼容的方法领取一次工具执行许可。 */
  async authorizeTool(request: PlatformHttpPermitRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const normalized = normalizePermitRequest(request)
    const requestId = permitRequestId(normalized)
    const response = await this.#post(
      this.#toolPermitsEndpoint,
      { requestId, ...normalized },
      'application/json',
      requestId,
      signal,
    )
    try {
      requireContentType(response, 'application/json')
      return parseJson(await readUtf8Body(response, this.#maxResponseBytes, signal), 'Platform permit 响应')
    } catch (error) {
      await cancelResponseBody(response)
      throw error
    }
  }

  async *#streamModelCall(
    modelId: string,
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<unknown> {
    signal.throwIfAborted()
    const requestId = this.#nextRequestId()
    const response = await this.#post(
      this.#modelCallsEndpoint,
      { requestId, modelId, request },
      'application/x-ndjson',
      requestId,
      signal,
    )
    try {
      requireContentType(response, 'application/x-ndjson')
      yield* readNdjson(response, this.#maxResponseBytes, signal)
    } catch (error) {
      await cancelResponseBody(response)
      throw error
    }
  }

  async #post(
    endpoint: URL,
    body: unknown,
    accept: string,
    requestId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    const response = await this.#fetch(endpoint, {
      method: 'POST',
      headers: {
        Accept: accept,
        Authorization: this.#authorization,
        'Content-Type': 'application/json',
        'Idempotency-Key': requestId,
      },
      body: JSON.stringify(body),
      signal,
    })
    if (signal.aborted) {
      await cancelResponseBody(response)
      signal.throwIfAborted()
    }
    if (!response.ok) {
      await cancelResponseBody(response)
      throw new PlatformHttpError(endpoint, response.status, response.statusText)
    }
    if (response.body === null) throw new PlatformHttpProtocolError('Platform 成功响应缺少 body')
    return response
  }

  #nextRequestId(): string {
    return headerValue(this.#requestIds.next(), 'requestIds.next()', PlatformHttpProtocolError)
  }
}

function parseBaseUrl(value: string): URL {
  let base: URL
  try {
    base = new URL(value)
  } catch {
    throw new PlatformHttpConfigurationError('baseUrl 必须是绝对 URL')
  }
  if (base.protocol !== 'https:') {
    throw new PlatformHttpConfigurationError('baseUrl 必须使用 https')
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  return base
}

function isRequestIdGenerator(value: unknown): value is PlatformRequestIdGenerator {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { next?: unknown }).next === 'function'
}

function nonEmptyString<T extends Error>(value: unknown, name: string, ErrorType: new (message: string) => T): string {
  if (typeof value !== 'string' || value.length === 0) throw new ErrorType(`${name}必须是非空字符串`)
  return value
}

function positiveSafeInteger<T extends Error>(
  value: unknown,
  name: string,
  ErrorType: new (message: string) => T,
): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ErrorType(`${name}必须是正安全整数`)
  }
  return value
}

function permitRequestId(request: PlatformHttpPermitRequest): string {
  const payload = JSON.stringify([
    request.executionId,
    request.subject,
    request.authorizationVersion,
    request.toolCallId,
    request.toolName,
    request.inputDigest,
  ])
  return `permit:${createHash('sha256').update(payload).digest('hex')}`
}

function requireContentType(response: Response, expected: string): void {
  const contentType = response.headers.get('content-type')
  const normalized = contentType?.toLowerCase()
  if (normalized === undefined || (normalized !== expected && !normalized.startsWith(`${expected};`))) {
    throw new PlatformHttpProtocolError(`Platform 响应 Content-Type 必须是 ${expected}`)
  }
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

function normalizePermitRequest(value: PlatformHttpPermitRequest): PlatformHttpPermitRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlatformHttpProtocolError('Platform permit 请求必须是对象')
  }
  const request = value as unknown as Record<string, unknown>
  const expected = ['authorizationVersion', 'executionId', 'inputDigest', 'subject', 'toolCallId', 'toolName']
  const keys = Object.keys(request)
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new PlatformHttpProtocolError('Platform permit 请求字段无效')
  }
  return Object.freeze({
    executionId: nonEmptyString(request.executionId, 'permit.executionId', PlatformHttpProtocolError),
    subject: nonEmptyString(request.subject, 'permit.subject', PlatformHttpProtocolError),
    authorizationVersion: nonEmptyString(
      request.authorizationVersion,
      'permit.authorizationVersion',
      PlatformHttpProtocolError,
    ),
    toolCallId: nonEmptyString(request.toolCallId, 'permit.toolCallId', PlatformHttpProtocolError),
    toolName: nonEmptyString(request.toolName, 'permit.toolName', PlatformHttpProtocolError),
    inputDigest: nonEmptyString(request.inputDigest, 'permit.inputDigest', PlatformHttpProtocolError),
  })
}

function headerValue<T extends Error>(value: unknown, name: string, ErrorType: new (message: string) => T): string {
  const header = nonEmptyString(value, name, ErrorType)
  if (/\r|\n/.test(header)) throw new ErrorType(`${name}不能包含换行符`)
  return header
}

async function readUtf8Body(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let complete = false
  try {
    let text = ''
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) {
        complete = true
        return text + decoder.decode()
      }
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new PlatformHttpProtocolError(`Platform 响应超过 maxResponseBytes (${maxBytes})`)
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch (error) {
    if (error instanceof TypeError) throw new PlatformHttpProtocolError(`Platform 响应不是有效 UTF-8：${error.message}`)
    throw error
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function* readNdjson(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): AsyncIterable<unknown> {
  const reader = response.body!.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytes = 0
  let buffer = ''
  let complete = false
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new PlatformHttpProtocolError(`Platform 响应超过 maxResponseBytes (${maxBytes})`)
      buffer += decoder.decode(chunk.value, { stream: true })
      yield* parseCompleteLines(buffer, line => { buffer = line })
    }
    buffer += decoder.decode()
    yield* parseCompleteLines(buffer, line => { buffer = line })
    if (buffer.length > 0) throw new PlatformHttpProtocolError('Platform NDJSON 响应末尾缺少换行')
    complete = true
  } catch (error) {
    if (error instanceof TypeError) throw new PlatformHttpProtocolError(`Platform 响应不是有效 UTF-8：${error.message}`)
    throw error
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

function* parseCompleteLines(input: string, setRemainder: (value: string) => void): Generator<unknown> {
  let start = 0
  while (true) {
    const end = input.indexOf('\n', start)
    if (end === -1) {
      setRemainder(input.slice(start))
      return
    }
    const line = input.slice(start, end).replace(/\r$/, '')
    start = end + 1
    if (line.length > 0) yield parseJson(line, 'Platform NDJSON 事件')
  }
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new PlatformHttpProtocolError(`${name}不是有效 JSON`)
  }
}
