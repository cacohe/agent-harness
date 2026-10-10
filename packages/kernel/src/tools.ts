import type { ExecutionMetadata, JsonValue, ToolCall, ToolResult } from './facts.js'
import type { ModelToolDefinition } from './model.js'

export interface ToolExecutionContext {
  readonly signal: AbortSignal
  readonly execution?: ExecutionMetadata
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
  parseInput(input: JsonValue): JsonValue
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue>
}

export interface ToolCatalog {
  list(): readonly ModelToolDefinition[]
}

export interface ToolExecutor {
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>
}

export interface ToolCapability extends ToolCatalog, ToolExecutor {}

export interface ExecutionAwareToolCapability extends ToolCapability {
  executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>
}

export type ToolAuthorizationDecision =
  | { readonly status: 'allowed' }
  | { readonly status: 'denied', readonly reason: string }

export interface ToolExecutionPolicy {
  authorize(
    call: ToolCall,
    context: ToolExecutionContext & { readonly execution: ExecutionMetadata },
  ): Promise<ToolAuthorizationDecision>
}

export interface SandboxTask {
  readonly call: ToolCall
  readonly workspace?: string
  readonly limits?: SandboxResourceLimits
}

export interface SandboxResourceLimits {
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

export interface SandboxDispatcher {
  dispatch(task: SandboxTask, context: ToolExecutionContext): Promise<JsonValue>
}

export interface SandboxToolRegistryOptions {
  readonly workspace?: string
  readonly limits?: SandboxResourceLimits
}
