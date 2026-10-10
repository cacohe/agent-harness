import {
  MEMORY_CONTEXT_LIMITS,
  type MemoryMatch,
  type MemoryRetriever,
  type MemorySource,
} from '@agent-harness/agent'
import type { JsonValue } from '@agent-harness/domain'
import type { ToolDefinition } from '@agent-harness/tools'
import { documentFileName } from './document-importer.js'
import { boundedText, positiveInteger, utf8ByteLength } from './validation.js'

export {
  MemoryGatewayDocumentImporter,
  type DocumentImportResult,
  type DocumentImportSource,
  type MemoryGatewayDocumentClient,
  type MemoryGatewayDocumentImporterOptions,
  type MemoryGatewayDocumentImportRequest,
} from './document-importer.js'

export {
  MemoryGatewayDocumentDeleter,
  type DocumentDeleteResult,
  type MemoryGatewayDocumentDeleteClient,
  type MemoryGatewayDocumentDeleterOptions,
  type MemoryGatewayDocumentDeleteRequest,
} from './document-deleter.js'

export {
  MemoryGatewayDocumentStatusReader,
  type DocumentFailedStatus,
  type DocumentNonFailedStatus,
  type DocumentStatus,
  type MemoryGatewayDocumentStatusClient,
  type MemoryGatewayDocumentStatusReaderOptions,
  type MemoryGatewayDocumentStatusRequest,
} from './document-status.js'

const MAX_MEMORY_STATEMENT_BYTES = 4_096

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

/** Host 已解析的 memory space 与一条用户明确要求保存的长期陈述。 */
export interface MemoryGatewayWriteRequest {
  readonly memorySpaceId: string
  readonly statement: string
}

/** 由 Platform 或 Host 实现；写入授权、权威存储和向量化均由 client 拥有。 */
export interface MemoryGatewayWriterClient {
  writeMemory(request: MemoryGatewayWriteRequest, signal: AbortSignal): Promise<unknown>
}

export interface MemoryGatewayRetrieverOptions {
  readonly memorySpaceId: string
  readonly client: MemoryGatewayClient
  readonly limit?: number
}

export interface MemoryGatewayWriterToolOptions {
  readonly memorySpaceId: string
  readonly client: MemoryGatewayWriterClient
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

/** 创建只能保存用户显式长期陈述的 Platform Memory function tool。 */
export function createMemoryWriterTool(options: MemoryGatewayWriterToolOptions): ToolDefinition {
  const memorySpaceId = boundedText(
    options.memorySpaceId,
    MEMORY_CONTEXT_LIMITS.maxFieldBytes,
    'memorySpaceId',
  )
  if (!isMemoryGatewayWriterClient(options.client)) {
    throw new TypeError('client 必须实现 writeMemory')
  }
  return {
    name: 'remember_memory',
    description: '保存用户明确要求长期记住的偏好或事实。不要保存临时任务状态，也不要保存未经用户明确要求的推断。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['statement'],
      properties: {
        statement: { type: 'string', description: '用户明确要求长期记住的完整陈述' },
      },
    },
    parseInput(input): JsonValue {
      return { statement: readMemoryStatement(input) }
    },
    async execute(input, context): Promise<JsonValue> {
      const request = Object.freeze({
        memorySpaceId,
        statement: readMemoryStatement(input),
      })
      const response = await options.client.writeMemory(request, context.signal)
      context.signal.throwIfAborted()
      return normalizeWriteResponse(response)
    },
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
    if ((keys.length !== 2 && keys.length !== 3)
      || !keys.includes('id')
      || !keys.includes('content')
      || (keys.length === 3 && !keys.includes('source'))) {
      throw new TypeError(`Memory Gateway 结果 ${index} 只能包含 id、content 与可选 source`)
    }
    const id = boundedText(fields.id, MEMORY_CONTEXT_LIMITS.maxFieldBytes, `Memory Gateway 结果 ${index}.id`)
    const content = boundedText(
      fields.content,
      MEMORY_CONTEXT_LIMITS.maxFieldBytes,
      `Memory Gateway 结果 ${index}.content`,
    )
    if (ids.has(id)) throw new TypeError(`Memory Gateway 结果 ID 重复：${id}`)
    ids.add(id)
    const source = keys.includes('source') ? normalizeMemorySource(fields.source, index) : undefined
    return Object.freeze(source === undefined ? { id, content } : { id, content, source })
  })
  const summary = JSON.stringify(matches).replaceAll('<', '\\u003c')
  if (utf8ByteLength(summary) > MEMORY_CONTEXT_LIMITS.maxSummaryBytes) {
    throw new RangeError(
      `Memory Gateway 摘要不能超过 ${MEMORY_CONTEXT_LIMITS.maxSummaryBytes} UTF-8 字节`,
    )
  }
  return Object.freeze(matches)
}

function normalizeMemorySource(value: unknown, index: number): Readonly<MemorySource> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`Memory Gateway 结果 ${index}.source 必须是对象`)
  }
  const fields = value as Record<string, unknown>
  if (fields.type === 'statement') {
    if (Object.keys(fields).length !== 1) {
      throw new TypeError(`Memory Gateway 结果 ${index}.source 的 statement 只能包含 type`)
    }
    return Object.freeze({ type: 'statement' })
  }
  if (fields.type !== 'document') {
    throw new TypeError(`Memory Gateway 结果 ${index}.source.type 必须是 statement 或 document`)
  }
  const keys = Object.keys(fields)
  const expected = ['chunkId', 'documentId', 'fileName', 'type']
  if (keys.length !== expected.length || !expected.every(key => keys.includes(key))) {
    throw new TypeError(
      `Memory Gateway 结果 ${index}.source 的 document 只能包含 type、documentId、fileName 与 chunkId`,
    )
  }
  return Object.freeze({
    type: 'document',
    documentId: boundedText(
      fields.documentId,
      MEMORY_CONTEXT_LIMITS.maxFieldBytes,
      `Memory Gateway 结果 ${index}.source.documentId`,
    ),
    fileName: documentFileName(fields.fileName),
    chunkId: boundedText(
      fields.chunkId,
      MEMORY_CONTEXT_LIMITS.maxFieldBytes,
      `Memory Gateway 结果 ${index}.source.chunkId`,
    ),
  })
}

function readMemoryStatement(input: JsonValue): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('remember_memory 输入必须是对象')
  }
  const keys = Object.keys(input)
  if (keys.length !== 1 || keys[0] !== 'statement') {
    throw new TypeError('remember_memory 输入只能包含 statement')
  }
  return boundedText(
    Reflect.get(input, 'statement'),
    MAX_MEMORY_STATEMENT_BYTES,
    'remember_memory.statement',
  )
}

function normalizeWriteResponse(value: unknown): JsonValue {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Memory Gateway 写入响应必须是对象')
  }
  const fields = value as Record<string, unknown>
  const keys = Object.keys(fields)
  if (keys.length !== 1 || keys[0] !== 'id') {
    throw new TypeError('Memory Gateway 写入响应只能包含 id')
  }
  return Object.freeze({
    id: boundedText(fields.id, MEMORY_CONTEXT_LIMITS.maxFieldBytes, 'Memory Gateway 写入响应.id'),
  })
}

function isMemoryGatewayClient(value: unknown): value is MemoryGatewayClient {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { searchMemory?: unknown }).searchMemory === 'function'
}

function isMemoryGatewayWriterClient(value: unknown): value is MemoryGatewayWriterClient {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { writeMemory?: unknown }).writeMemory === 'function'
}
