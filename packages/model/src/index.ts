import type { ModelMessage, ToolCall } from '@agent-harness/domain'

export interface ModelToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

export interface ModelRequest {
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
}

export type ModelStreamEvent =
  | { readonly type: 'text.delta'; readonly text: string }
  | { readonly type: 'tool.call'; readonly call: ToolCall }
  | {
      readonly type: 'usage'
      readonly inputTokens: number
      readonly outputTokens: number
    }

export interface PreparedModelCall {
  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent>
}

export interface ModelProvider {
  readonly id: string

  prepare(signal: AbortSignal): Promise<PreparedModelCall>
}
