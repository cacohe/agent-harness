import { createHash, randomUUID } from 'node:crypto'
import type { ModelRequest } from '@agent-harness/kernel'

interface MemoryGatewayDocumentImportRequest {
  readonly memorySpaceId: string
  readonly fileName: string
  readonly mediaType: string
  readonly bytes: Uint8Array
  readonly sizeBytes: number
  readonly contentSha256: string
}

interface MemoryGatewayDocumentDeleteRequest {
  readonly memorySpaceId: string
  readonly documentId: string
}

interface MemoryGatewayDocumentStatusRequest {
  readonly memorySpaceId: string
  readonly documentId: string
}

interface MemoryGatewaySearchRequest {
  readonly memorySpaceId: string
  readonly query: string
  readonly limit: number
}

interface MemoryGatewayWriteRequest {
  readonly memorySpaceId: string
  readonly statement: string
}

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
  /** 单次文档导入请求允许发送的最大字节数。 */
  readonly maxDocumentBytes?: number
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
const DEFAULT_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/

/**
 * 单实例 Host 可复用的 Platform HTTP client。
 *
 * 它以结构化方法同时满足 LLM Gateway、Memory Gateway 与工具许可 adapter 的注入接口。Platform
 * 服务端必须在接收幂等请求时原子写入计费、审计与可重试 outbox；Harness 不保存账务状态。
 */
export class PlatformHttpClient {
  readonly #modelCallsEndpoint: URL
  readonly #memorySearchesEndpoint: URL
  readonly #memoryStatementsEndpoint: URL
  readonly #documentImportsEndpoint: URL
  readonly #documentDeletionsEndpoint: URL
  readonly #documentStatusesEndpoint: URL
  readonly #toolPermitsEndpoint: URL
  readonly #authorization: string
  readonly #fetch: FetchImplementation
  readonly #requestIds: PlatformRequestIdGenerator
  readonly #maxResponseBytes: number
  readonly #maxDocumentBytes: number

  constructor(options: PlatformHttpClientOptions) {
    const baseUrl = parseBaseUrl(options.baseUrl)
    this.#modelCallsEndpoint = new URL('agent/model-calls', baseUrl)
    this.#memorySearchesEndpoint = new URL('agent/memory-searches', baseUrl)
    this.#memoryStatementsEndpoint = new URL('agent/memory-statements', baseUrl)
    this.#documentImportsEndpoint = new URL('agent/document-imports', baseUrl)
    this.#documentDeletionsEndpoint = new URL('agent/document-deletions', baseUrl)
    this.#documentStatusesEndpoint = new URL('agent/document-statuses', baseUrl)
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
    this.#maxDocumentBytes = positiveSafeInteger(
      options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      'maxDocumentBytes',
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
    return this.#postJson(
      this.#toolPermitsEndpoint,
      { requestId, ...normalized },
      requestId,
      'Platform permit 响应',
      signal,
    )
  }

  /** 以与 MemoryGatewayClient 兼容的方法执行已绑定范围的长期记忆检索。 */
  async searchMemory(request: MemoryGatewaySearchRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const normalized = normalizeMemorySearchRequest(request)
    const requestId = this.#nextRequestId()
    return this.#postJson(
      this.#memorySearchesEndpoint,
      { requestId, ...normalized },
      requestId,
      'Platform memory search 响应',
      signal,
    )
  }

  /** 以与 MemoryGatewayWriterClient 兼容的方法保存一条显式长期陈述。 */
  async writeMemory(request: MemoryGatewayWriteRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const normalized = normalizeMemoryWriteRequest(request)
    const requestId = this.#nextRequestId()
    return this.#postJson(
      this.#memoryStatementsEndpoint,
      { requestId, ...normalized },
      requestId,
      'Platform memory write 响应',
      signal,
    )
  }

  /** 以与 MemoryGatewayDocumentClient 兼容的方法上传一个受限文档。 */
  async importDocument(
    request: MemoryGatewayDocumentImportRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted()
    const normalized = normalizeDocumentImportRequest(request, this.#maxDocumentBytes)
    const requestId = this.#nextRequestId()
    const metadata = Buffer.from(JSON.stringify({
      requestId,
      memorySpaceId: normalized.memorySpaceId,
      fileName: normalized.fileName,
      sizeBytes: normalized.sizeBytes,
      contentSha256: normalized.contentSha256,
    }), 'utf8').toString('base64url')
    const response = await this.#send(this.#documentImportsEndpoint, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: this.#authorization,
        'Content-Type': normalized.mediaType,
        'Idempotency-Key': requestId,
        'X-Agent-Document-Metadata': metadata,
      },
      body: normalized.bytes,
      signal,
    }, signal)
    try {
      requireContentType(response, 'application/json')
      return parseJson(
        await readUtf8Body(response, this.#maxResponseBytes, signal),
        'Platform document import 响应',
      )
    } catch (error) {
      await cancelResponseBody(response)
      throw error
    }
  }

  /** 以与 MemoryGatewayDocumentStatusClient 兼容的方法查询文档索引状态。 */
  async getDocumentStatus(
    request: MemoryGatewayDocumentStatusRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted()
    const normalized = normalizeDocumentStatusRequest(request)
    const requestId = this.#nextRequestId()
    return this.#postJson(
      this.#documentStatusesEndpoint,
      { requestId, ...normalized },
      requestId,
      'Platform document status 响应',
      signal,
    )
  }

  /** 以与 MemoryGatewayDocumentDeleteClient 兼容的方法请求删除文档。 */
  async deleteDocument(
    request: MemoryGatewayDocumentDeleteRequest,
    signal: AbortSignal,
  ): Promise<unknown> {
    signal.throwIfAborted()
    const normalized = normalizeDocumentIdentityRequest(request, 'delete')
    const requestId = this.#nextRequestId()
    return this.#postJson(
      this.#documentDeletionsEndpoint,
      { requestId, ...normalized },
      requestId,
      'Platform document deletion 响应',
      signal,
    )
  }

  async #postJson(
    endpoint: URL,
    body: unknown,
    requestId: string,
    label: string,
    signal: AbortSignal,
  ): Promise<unknown> {
    const response = await this.#post(endpoint, body, 'application/json', requestId, signal)
    try {
      requireContentType(response, 'application/json')
      return parseJson(await readUtf8Body(response, this.#maxResponseBytes, signal), label)
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
    return this.#send(endpoint, {
      method: 'POST',
      headers: {
        Accept: accept,
        Authorization: this.#authorization,
        'Content-Type': 'application/json',
        'Idempotency-Key': requestId,
      },
      body: JSON.stringify(body),
      signal,
    }, signal)
  }

  async #send(endpoint: URL, init: RequestInit, signal: AbortSignal): Promise<Response> {
    const response = await this.#fetch(endpoint, init)
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

interface NormalizedDocumentImportRequest {
  readonly memorySpaceId: string
  readonly fileName: string
  readonly mediaType: string
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly sizeBytes: number
  readonly contentSha256: string
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

function normalizeMemorySearchRequest(value: MemoryGatewaySearchRequest): MemoryGatewaySearchRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlatformHttpProtocolError('Platform memory search 请求必须是对象')
  }
  const request = value as unknown as Record<string, unknown>
  const expected = ['limit', 'memorySpaceId', 'query']
  const keys = Object.keys(request)
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new PlatformHttpProtocolError('Platform memory search 请求字段无效')
  }
  return Object.freeze({
    memorySpaceId: nonEmptyString(
      request.memorySpaceId,
      'memorySearch.memorySpaceId',
      PlatformHttpProtocolError,
    ),
    query: nonEmptyString(request.query, 'memorySearch.query', PlatformHttpProtocolError),
    limit: positiveSafeInteger(request.limit, 'memorySearch.limit', PlatformHttpProtocolError),
  })
}

function normalizeMemoryWriteRequest(value: MemoryGatewayWriteRequest): MemoryGatewayWriteRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlatformHttpProtocolError('Platform memory write 请求必须是对象')
  }
  const request = value as unknown as Record<string, unknown>
  const expected = ['memorySpaceId', 'statement']
  const keys = Object.keys(request)
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new PlatformHttpProtocolError('Platform memory write 请求字段无效')
  }
  return Object.freeze({
    memorySpaceId: nonEmptyString(
      request.memorySpaceId,
      'memoryWrite.memorySpaceId',
      PlatformHttpProtocolError,
    ),
    statement: nonEmptyString(
      request.statement,
      'memoryWrite.statement',
      PlatformHttpProtocolError,
    ),
  })
}

function normalizeDocumentImportRequest(
  value: MemoryGatewayDocumentImportRequest,
  maxDocumentBytes: number,
): NormalizedDocumentImportRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlatformHttpProtocolError('Platform document import 请求必须是对象')
  }
  const request = value as unknown as Record<string, unknown>
  const expected = [
    'bytes', 'contentSha256', 'fileName', 'mediaType', 'memorySpaceId', 'sizeBytes',
  ]
  const keys = Object.keys(request)
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new PlatformHttpProtocolError('Platform document import 请求字段无效')
  }
  const bytes = request.bytes
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new PlatformHttpProtocolError('documentImport.bytes 必须是非空 Uint8Array')
  }
  if (bytes.byteLength > maxDocumentBytes) {
    throw new PlatformHttpProtocolError(`documentImport.bytes 不能超过 ${maxDocumentBytes} 字节`)
  }
  const sizeBytes = positiveSafeInteger(
    request.sizeBytes,
    'documentImport.sizeBytes',
    PlatformHttpProtocolError,
  )
  if (sizeBytes !== bytes.byteLength) {
    throw new PlatformHttpProtocolError('documentImport.sizeBytes 与 bytes 长度不一致')
  }
  const contentSha256 = nonEmptyString(
    request.contentSha256,
    'documentImport.contentSha256',
    PlatformHttpProtocolError,
  )
  const copiedBytes = Uint8Array.from(bytes)
  const expectedDigest = `sha256:${createHash('sha256').update(copiedBytes).digest('hex')}`
  if (contentSha256 !== expectedDigest) {
    throw new PlatformHttpProtocolError('documentImport.contentSha256 与 bytes 不一致')
  }
  const mediaType = boundedProtocolText(
    request.mediaType,
    255,
    'documentImport.mediaType',
  ).toLowerCase()
  if (!MEDIA_TYPE.test(mediaType)) {
    throw new PlatformHttpProtocolError('documentImport.mediaType 必须是规范 MIME type')
  }
  return Object.freeze({
    memorySpaceId: boundedProtocolText(request.memorySpaceId, 2_048, 'documentImport.memorySpaceId'),
    fileName: boundedProtocolText(request.fileName, 512, 'documentImport.fileName'),
    mediaType,
    bytes: copiedBytes,
    sizeBytes,
    contentSha256,
  })
}

function normalizeDocumentStatusRequest(
  value: MemoryGatewayDocumentStatusRequest,
): MemoryGatewayDocumentStatusRequest {
  return normalizeDocumentIdentityRequest(value, 'status')
}

function normalizeDocumentIdentityRequest(
  value: MemoryGatewayDocumentStatusRequest,
  operation: 'delete' | 'status',
): MemoryGatewayDocumentStatusRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new PlatformHttpProtocolError(`Platform document ${operation} 请求必须是对象`)
  }
  const request = value as unknown as Record<string, unknown>
  const expected = ['documentId', 'memorySpaceId']
  const keys = Object.keys(request)
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new PlatformHttpProtocolError(`Platform document ${operation} 请求字段无效`)
  }
  return Object.freeze({
    memorySpaceId: boundedProtocolText(
      request.memorySpaceId,
      2_048,
      `document${operation}.memorySpaceId`,
    ),
    documentId: boundedProtocolText(request.documentId, 2_048, `document${operation}.documentId`),
  })
}

function boundedProtocolText(value: unknown, maxBytes: number, name: string): string {
  const result = nonEmptyString(value, name, PlatformHttpProtocolError)
  if (result.length > maxBytes || new TextEncoder().encode(result).byteLength > maxBytes) {
    throw new PlatformHttpProtocolError(`${name} 不能超过 ${maxBytes} UTF-8 字节`)
  }
  return result
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
