import { createHash } from 'node:crypto';
import { MEMORY_CONTEXT_LIMITS } from '@agent-harness/kernel';
import { boundedText, positiveInteger } from './validation.js';

const DEFAULT_MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
const MAX_MEDIA_TYPE_BYTES = 255;
const MEDIA_TYPE = /^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/;

/** Host 从可信文件入口读取并提交的受限文档。 */
export interface DocumentImportSource {
  readonly fileName: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

/** Platform 接纳文档后的权威身份与索引状态。 */
export interface DocumentImportResult {
  readonly documentId: string;
  readonly status: 'queued' | 'ready';
}

/** 发给 Platform 的完整、可校验文档导入请求。 */
export interface MemoryGatewayDocumentImportRequest extends DocumentImportSource {
  readonly memorySpaceId: string;
  readonly sizeBytes: number;
  readonly contentSha256: string;
}

/** 由 Host 或 Platform 实现；上传协议、认证、对象存储与索引任务均由 client 拥有。 */
export interface MemoryGatewayDocumentClient {
  importDocument(
    request: MemoryGatewayDocumentImportRequest,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface MemoryGatewayDocumentImporterOptions {
  readonly memorySpaceId: string;
  readonly client: MemoryGatewayDocumentClient;
  readonly maxDocumentBytes?: number;
}

/** 将已绑定 Platform 范围的 Gateway client 转换为受限文档导入 capability。 */
export class MemoryGatewayDocumentImporter {
  readonly #memorySpaceId: string;
  readonly #client: MemoryGatewayDocumentClient;
  readonly #maxDocumentBytes: number;

  constructor(options: MemoryGatewayDocumentImporterOptions) {
    this.#memorySpaceId = boundedText(
      options.memorySpaceId,
      MEMORY_CONTEXT_LIMITS.maxFieldBytes,
      'memorySpaceId',
    );
    if (!isDocumentClient(options.client)) {
      throw new TypeError('client 必须实现 importDocument');
    }
    this.#client = options.client;
    this.#maxDocumentBytes = positiveInteger(
      options.maxDocumentBytes ?? DEFAULT_MAX_DOCUMENT_BYTES,
      'maxDocumentBytes',
    );
  }

  async import(source: DocumentImportSource, signal: AbortSignal): Promise<DocumentImportResult> {
    signal.throwIfAborted();
    const { fileName, mediaType, bytes } = normalizeSource(source, this.#maxDocumentBytes);
    const request = Object.freeze({
      memorySpaceId: this.#memorySpaceId,
      fileName,
      mediaType,
      bytes,
      sizeBytes: bytes.byteLength,
      contentSha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
    signal.throwIfAborted();
    const response = await this.#client.importDocument(request, signal);
    signal.throwIfAborted();
    return normalizeResult(response);
  }
}

function normalizeSource(value: unknown, maxBytes: number): DocumentImportSource {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('document 必须是对象');
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  const expected = ['bytes', 'fileName', 'mediaType'];
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new TypeError('document 只能包含 fileName、mediaType 与 bytes');
  }
  return {
    fileName: documentFileName(fields.fileName),
    mediaType: mediaTypeValue(fields.mediaType),
    bytes: documentBytes(fields.bytes, maxBytes),
  };
}

/** 校验导入与检索来源共享的、不会被解释为路径的展示文件名。 */
export function documentFileName(value: unknown): string {
  const fileName = boundedText(value, MEMORY_CONTEXT_LIMITS.maxFileNameBytes, 'document.fileName');
  if (fileName === '.' || fileName === '..' || containsPathOrControlChars(fileName)) {
    throw new TypeError('document.fileName 必须是不含路径或控制字符的文件名');
  }
  return fileName;
}

function mediaTypeValue(value: unknown): string {
  const mediaType = boundedText(value, MAX_MEDIA_TYPE_BYTES, 'document.mediaType');
  if (!MEDIA_TYPE.test(mediaType)) throw new TypeError('document.mediaType 必须是规范 MIME type');
  return mediaType.toLowerCase();
}

function documentBytes(value: unknown, maxBytes: number): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new TypeError('document.bytes 必须是 Uint8Array');
  if (value.byteLength === 0) throw new TypeError('document.bytes 不能为空');
  if (value.byteLength > maxBytes) {
    throw new RangeError(`document.bytes 不能超过 ${maxBytes} 字节`);
  }
  return Uint8Array.from(value);
}

function normalizeResult(value: unknown): DocumentImportResult {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Document Gateway 响应必须是对象');
  }
  const fields = value as Record<string, unknown>;
  const keys = Object.keys(fields);
  if (keys.length !== 2 || !keys.includes('documentId') || !keys.includes('status')) {
    throw new TypeError('Document Gateway 响应只能包含 documentId 与 status');
  }
  const status = fields.status;
  if (status !== 'queued' && status !== 'ready') {
    throw new TypeError('Document Gateway 响应 status 必须是 queued 或 ready');
  }
  return Object.freeze({
    documentId: boundedText(
      fields.documentId,
      MEMORY_CONTEXT_LIMITS.maxFieldBytes,
      'Document Gateway 响应.documentId',
    ),
    status,
  });
}

function isDocumentClient(value: unknown): value is MemoryGatewayDocumentClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { importDocument?: unknown }).importDocument === 'function'
  );
}

function containsPathOrControlChars(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === '/' || char === '\\' || code < 32 || code === 127) return true;
  }
  return false;
}
