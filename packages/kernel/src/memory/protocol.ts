/** 记忆检索器 —— 根据输入检索相关记忆。 */
export interface MemoryRetriever {
  search(query: string, signal: AbortSignal): Promise<readonly MemoryMatch[]>;
}

/** 记忆匹配 —— 匹配到的记忆。 */
export interface MemoryMatch {
  readonly id: string;
  readonly content: string;
  readonly source?: MemorySource;
}

/** 记忆来源 —— 记忆的来源。 */
export type MemorySource = StatementMemorySource | DocumentMemorySource;

/** 陈述性记忆。 */
export interface StatementMemorySource {
  readonly type: 'statement';
}

/** 文档记忆来源 —— 文档分块的可归因信息。 */
export interface DocumentMemorySource {
  readonly type: 'document';
  readonly documentId: string;
  readonly fileName: string;
  readonly chunkId: string;
}

/** 长期记忆上下文限制。 */
export const MEMORY_CONTEXT_LIMITS = Object.freeze({
  maxQueryBytes: 4_096,
  maxMatches: 8,
  maxFieldBytes: 2_048,
  maxFileNameBytes: 512,
  maxSummaryBytes: 8_192,
});
