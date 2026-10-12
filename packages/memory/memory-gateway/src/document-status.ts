import { MEMORY_CONTEXT_LIMITS } from '@agent-harness/kernel';
import { boundedText } from './validation.js';

const MAX_FAILURE_CODE_BYTES = 128;
const FAILURE_CODE = /^[A-Z0-9][A-Z0-9_.-]*$/;

/** Host 已绑定的 memory space 与要查询的权威文档 ID。 */
export interface MemoryGatewayDocumentStatusRequest {
  readonly memorySpaceId: string;
  readonly documentId: string;
}

/** 由 Platform 或 Host 实现；身份、授权与索引状态存储均由 client 拥有。 */
export interface MemoryGatewayDocumentStatusClient {
  getDocumentStatus(
    request: MemoryGatewayDocumentStatusRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
}

/** Platform 对文档索引生命周期的受限投影。 */
export type DocumentStatus = DocumentNonFailedStatus | DocumentFailedStatus;

export interface DocumentNonFailedStatus {
  readonly documentId: string;
  readonly status: 'queued' | 'indexing' | 'ready' | 'deleting' | 'deleted';
}

export interface DocumentFailedStatus {
  readonly documentId: string;
  readonly status: 'failed';
  readonly failureCode: string;
}

export interface MemoryGatewayDocumentStatusReaderOptions {
  readonly memorySpaceId: string;
  readonly client: MemoryGatewayDocumentStatusClient;
}

/** 查询一个已导入文档的当前索引状态，不读取文件或索引内容。 */
export class MemoryGatewayDocumentStatusReader {
  readonly #memorySpaceId: string;
  readonly #client: MemoryGatewayDocumentStatusClient;

  constructor(options: MemoryGatewayDocumentStatusReaderOptions) {
    this.#memorySpaceId = boundedText(
      options.memorySpaceId,
      MEMORY_CONTEXT_LIMITS.maxFieldBytes,
      'memorySpaceId',
    );
    if (!isDocumentStatusClient(options.client)) {
      throw new TypeError('client 必须实现 getDocumentStatus');
    }
    this.#client = options.client;
  }

  async get(documentId: string, signal: AbortSignal): Promise<DocumentStatus> {
    signal.throwIfAborted();
    const request = Object.freeze({
      memorySpaceId: this.#memorySpaceId,
      documentId: boundedText(documentId, MEMORY_CONTEXT_LIMITS.maxFieldBytes, 'documentId'),
    });
    const response = await this.#client.getDocumentStatus(request, signal);
    signal.throwIfAborted();
    return normalizeDocumentStatus(response, request.documentId);
  }
}

function normalizeDocumentStatus(value: unknown, requestedDocumentId: string): DocumentStatus {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Document Gateway 状态响应必须是对象');
  }
  const fields = value as Record<string, unknown>;
  const documentId = boundedText(
    fields.documentId,
    MEMORY_CONTEXT_LIMITS.maxFieldBytes,
    'Document Gateway 状态响应.documentId',
  );
  if (documentId !== requestedDocumentId) {
    throw new TypeError('Document Gateway 状态响应.documentId 与请求不一致');
  }
  if (fields.status === 'failed') {
    assertExactKeys(fields, ['documentId', 'failureCode', 'status']);
    const failureCode = boundedText(
      fields.failureCode,
      MAX_FAILURE_CODE_BYTES,
      'Document Gateway 状态响应.failureCode',
    );
    if (!FAILURE_CODE.test(failureCode)) {
      throw new TypeError('Document Gateway 状态响应.failureCode 格式无效');
    }
    return Object.freeze({ documentId, status: 'failed', failureCode });
  }
  if (
    fields.status !== 'queued' &&
    fields.status !== 'indexing' &&
    fields.status !== 'ready' &&
    fields.status !== 'deleting' &&
    fields.status !== 'deleted'
  ) {
    throw new TypeError(
      'Document Gateway 状态响应.status 必须是 queued、indexing、ready、deleting、deleted 或 failed',
    );
  }
  assertExactKeys(fields, ['documentId', 'status']);
  return Object.freeze({ documentId, status: fields.status });
}

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new TypeError('Document Gateway 状态响应字段无效');
  }
}

function isDocumentStatusClient(value: unknown): value is MemoryGatewayDocumentStatusClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { getDocumentStatus?: unknown }).getDocumentStatus === 'function'
  );
}
