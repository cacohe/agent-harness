import { MEMORY_CONTEXT_LIMITS } from '@agent-harness/kernel'
import { boundedText } from './validation.js'

/** Host 已绑定的 memory space 与要删除的权威文档 ID。 */
export interface MemoryGatewayDocumentDeleteRequest {
  readonly memorySpaceId: string
  readonly documentId: string
}

/** 由 Platform 或 Host 实现；授权、墓碑事务与物理清理均由 client 拥有。 */
export interface MemoryGatewayDocumentDeleteClient {
  deleteDocument(
    request: MemoryGatewayDocumentDeleteRequest,
    signal: AbortSignal,
  ): Promise<unknown>
}

/** Platform 接纳删除命令后的权威文档状态。 */
export interface DocumentDeleteResult {
  readonly documentId: string
  readonly status: 'deleting' | 'deleted'
}

export interface MemoryGatewayDocumentDeleterOptions {
  readonly memorySpaceId: string
  readonly client: MemoryGatewayDocumentDeleteClient
}

/** 请求 Platform 删除文档；不在 Harness 中直接操作 PG、Qdrant 或 OSS。 */
export class MemoryGatewayDocumentDeleter {
  readonly #memorySpaceId: string
  readonly #client: MemoryGatewayDocumentDeleteClient

  constructor(options: MemoryGatewayDocumentDeleterOptions) {
    this.#memorySpaceId = boundedText(
      options.memorySpaceId,
      MEMORY_CONTEXT_LIMITS.maxFieldBytes,
      'memorySpaceId',
    )
    if (!isDocumentDeleteClient(options.client)) {
      throw new TypeError('client 必须实现 deleteDocument')
    }
    this.#client = options.client
  }

  async delete(documentId: string, signal: AbortSignal): Promise<DocumentDeleteResult> {
    signal.throwIfAborted()
    const request = Object.freeze({
      memorySpaceId: this.#memorySpaceId,
      documentId: boundedText(
        documentId,
        MEMORY_CONTEXT_LIMITS.maxFieldBytes,
        'documentId',
      ),
    })
    const response = await this.#client.deleteDocument(request, signal)
    signal.throwIfAborted()
    return normalizeDeleteResult(response, request.documentId)
  }
}

function normalizeDeleteResult(value: unknown, requestedDocumentId: string): DocumentDeleteResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Document Gateway 删除响应必须是对象')
  }
  const fields = value as Record<string, unknown>
  const keys = Object.keys(fields)
  if (keys.length !== 2 || !keys.includes('documentId') || !keys.includes('status')) {
    throw new TypeError('Document Gateway 删除响应只能包含 documentId 与 status')
  }
  const documentId = boundedText(
    fields.documentId,
    MEMORY_CONTEXT_LIMITS.maxFieldBytes,
    'Document Gateway 删除响应.documentId',
  )
  if (documentId !== requestedDocumentId) {
    throw new TypeError('Document Gateway 删除响应.documentId 与请求不一致')
  }
  if (fields.status !== 'deleting' && fields.status !== 'deleted') {
    throw new TypeError('Document Gateway 删除响应.status 必须是 deleting 或 deleted')
  }
  return Object.freeze({ documentId, status: fields.status })
}

function isDocumentDeleteClient(value: unknown): value is MemoryGatewayDocumentDeleteClient {
  return typeof value === 'object'
    && value !== null
    && typeof (value as { deleteDocument?: unknown }).deleteDocument === 'function'
}
