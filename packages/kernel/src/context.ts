import type { EventEnvelope, ModelMessage } from './facts.js'
import type { ModelRequest, ModelToolDefinition } from './model.js'

/** 提示词组装器 —— 组装完整的 Agent 请求。 */
export interface PromptAssembler {
  assemble(
    events: readonly EventEnvelope[],
    tools: readonly ModelToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelRequest>
}

/** 上下文贡献者 —— 贡献上下文内容，可选插件。 */
export interface ContextContributor {
  contribute(
    input: ContextContributorInput,
    signal: AbortSignal,
  ): readonly ModelMessage[] | Promise<readonly ModelMessage[]>
}

/** 上下文贡献者输入 —— 上下文贡献者所需的输入。 */
export interface ContextContributorInput {
  readonly events: readonly EventEnvelope[]
  readonly tools: readonly ModelToolDefinition[]
}

/** 时钟 —— 提供当前时间。 */
export interface Clock {
  now(): Date
}

/** 技能目录 —— 列出所有可用的技能。 */
export interface SkillCatalog {
  listEnabled(): readonly SkillDescriptor[]
  read(skillId: string, signal: AbortSignal): Promise<string>
}

/** 技能描述符 —— 描述一个技能。 */
export interface SkillDescriptor {
  readonly id: string
  readonly name: string
  readonly description: string
}

/** 记忆检索器 —— 根据输入检索相关记忆。 */
export interface MemoryRetriever {
  search(query: string, signal: AbortSignal): Promise<readonly MemoryMatch[]>
}

/** 记忆匹配 —— 匹配到的记忆。 */
export interface MemoryMatch {
  readonly id: string
  readonly content: string
  readonly source?: MemorySource
}

/** 记忆来源 —— 记忆的来源。 */
export type MemorySource = StatementMemorySource | DocumentMemorySource

/** 陈述性记忆 */
export interface StatementMemorySource {
  readonly type: 'statement'
}

/** 文档记忆来源 —— 文档记忆的来源。 */
export interface DocumentMemorySource {
  readonly type: 'document'
  readonly documentId: string
  readonly fileName: string
  readonly chunkId: string
}

/** 长期记忆上下文限制 —— 记忆上下文的最大限制。 */
export const MEMORY_CONTEXT_LIMITS = Object.freeze({
  maxQueryBytes: 4_096,
  maxMatches: 8,
  maxFieldBytes: 2_048,
  maxFileNameBytes: 512,
  maxSummaryBytes: 8_192,
})
