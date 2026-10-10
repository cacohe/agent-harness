import type { EventEnvelope, ModelMessage } from './facts.js'
import type { ModelRequest, ModelToolDefinition } from './model.js'

export interface PromptAssembler {
  assemble(
    events: readonly EventEnvelope[],
    tools: readonly ModelToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelRequest>
}

export interface ContextContributor {
  contribute(
    input: ContextContributorInput,
    signal: AbortSignal,
  ): readonly ModelMessage[] | Promise<readonly ModelMessage[]>
}

export interface ContextContributorInput {
  readonly events: readonly EventEnvelope[]
  readonly tools: readonly ModelToolDefinition[]
}

export interface Clock {
  now(): Date
}

export interface SkillCatalog {
  listEnabled(): readonly SkillDescriptor[]
  read(skillId: string, signal: AbortSignal): Promise<string>
}

export interface SkillDescriptor {
  readonly id: string
  readonly name: string
  readonly description: string
}

export interface MemoryRetriever {
  search(query: string, signal: AbortSignal): Promise<readonly MemoryMatch[]>
}

export interface MemoryMatch {
  readonly id: string
  readonly content: string
  readonly source?: MemorySource
}

export type MemorySource = StatementMemorySource | DocumentMemorySource

export interface StatementMemorySource {
  readonly type: 'statement'
}

export interface DocumentMemorySource {
  readonly type: 'document'
  readonly documentId: string
  readonly fileName: string
  readonly chunkId: string
}

export const MEMORY_CONTEXT_LIMITS = Object.freeze({
  maxQueryBytes: 4_096,
  maxMatches: 8,
  maxFieldBytes: 2_048,
  maxFileNameBytes: 512,
  maxSummaryBytes: 8_192,
})
