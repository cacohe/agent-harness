import {
  MEMORY_CONTEXT_LIMITS,
  type MemoryMatch,
  type MemoryRetriever,
} from '@agent-harness/agent'

/** Host 已解析的 memory space 与一次受限检索请求。 */
export interface MemoryGatewaySearchRequest {
  readonly memorySpaceId: string
  readonly query: string
  readonly limit: number
}

/** 由 Platform 或 Host 实现；身份、授权、向量库和计费均由 client 拥有。 */
export interface MemoryGatewayClient {
  searchMemory(request: MemoryGatewaySearchRequest, signal: AbortSignal): Promise<unknown>
}

export interface MemoryGatewayRetrieverOptions {
  readonly memorySpaceId: string
  readonly client: MemoryGatewayClient
  readonly limit?: number
}

/** 将已绑定 Platform 范围的 Gateway client 转换为 Agent MemoryRetriever。 */
export class MemoryGatewayRetriever implements MemoryRetriever {
  readonly #memorySpaceId: string
  readonly #client: MemoryGatewayClient
  readonly #limit: number

  constructor(options: MemoryGatewayRetrieverOptions) {
    this.#memorySpaceId = boundedText(
      options.memorySpaceId,
      MEMORY_CONTEXT_LIMITS.maxFieldBytes,
      'memorySpaceId',
    )
    if (!isMemoryGatewayClient(options.client)) {
      throw new TypeError('client 必须实现 searchMemory')
    }
    this.#client = options.client
    this.#limit = positiveInteger(options.limit ?? MEMORY_CONTEXT_LIMITS.maxMatches, 'limit')
    if (this.#limit > MEMORY_CONTEXT_LIMITS.maxMatches) {
      throw new RangeError(`limit 不能超过 ${MEMORY_CONTEXT_LIMITS.maxMatches}`)
    }
  }

  async search(query: string, signal: AbortSignal): Promise<readonly MemoryMatch[]> {
    signal.throwIfAborted()
    const request = Object.freeze({
      memorySpaceId: this.#memorySpaceId,
      query: boundedText(query, MEMORY_CONTEXT_LIMITS.maxQueryBytes, 'query'),
      limit: this.#limit,
    })
    const response = await this.#client.searchMemory(request, signal)
    signal.throwIfAborted()
    return normalizeMatches(response, this.#limit)
  }
}

function normalizeMatches(value: unknown, limit: number): readonly MemoryMatch[] {
  if (!Array.isArray(value)) throw new TypeError('Memory Gateway 响应必须是数组')
  if (value.length > limit) throw new RangeError(`Memory Gateway 结果不能超过请求 limit (${limit})`)
  const ids = new Set<string>()
  const matches = value.map((candidate, index) => {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)) {
      throw new TypeError(`Memory Gateway 结果 ${index} 必须是对象`)
    }
    const fields = candidate as Record<string, unknown>
    const keys = Object.keys(fields)
    if (keys.length !== 2 || !keys.includes('id') || !keys.includes('content')) {
      throw new TypeError(`Memory Gateway 结果 ${index} 只能包含 id 与 content`)
    }
    const id = boundedText(fields.id, MEMORY_CONTEXT_LIMITS.maxFieldBytes, `Memory Gateway 结果 ${index}.id`)
    const content = boundedText(
      fields.content,
      MEMORY_CONTEXT_LIMITS.maxFieldBytes,
      `Memory Gateway 结果 ${index}.content`,
    )
    if (ids.has(id)) throw new TypeError(`Memory Gateway 结果 ID 重复：${id}`)
    ids.add(id)
    return Object.freeze({ id, content })
  })
  const summary = JSON.stringify(matches).replaceAll('<', '\\u003c')
  if (utf8ByteLength(summary) > MEMORY_CONTEXT_LIMITS.maxSummaryBytes) {
    throw new RangeError(
      `Memory Gateway 摘要不能超过 ${MEMORY_CONTEXT_LIMITS.maxSummaryBytes} UTF-8 字节`,
    )
  }
  return Object.freeze(matches)
}

function boundedText(value: unknown, maxBytes: number, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${name} 必须是非空字符串`)
  if (value.length > maxBytes || utf8ByteLength(value) > maxBytes) {
    throw new RangeError(`${name} 不能超过 ${maxBytes} UTF-8 字节`)
  }
  return value
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function positiveInteger(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} 必须是正安全整数`)
  }
  return value
}

function isMemoryGatewayClient(value: unknown): value is MemoryGatewayClient {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { searchMemory?: unknown }).searchMemory === 'function'
}
