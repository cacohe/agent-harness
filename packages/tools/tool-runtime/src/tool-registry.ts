import {
  assertJsonValue,
  isAbortError,
  serializeError,
  type ModelToolDefinition,
  type ToolCall,
  type ToolCapability,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolResult,
} from '@agent-harness/kernel'
import { indexToolDefinitions, toModelToolDefinitions } from './tool-definitions.js'
import { cancelledResult, unknownToolResult } from './tool-results.js'

/** 不可变的工具注册表，也是第一阶段的顺序工具执行器。 */
export class ToolRegistry implements ToolCapability {
  readonly #definitions: ReadonlyMap<string, ToolDefinition>

  constructor(definitions: readonly ToolDefinition[]) {
    this.#definitions = indexToolDefinitions(definitions)
  }

  list(): readonly ModelToolDefinition[] { return toModelToolDefinitions(this.#definitions) }

  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.executeWithContext(call, { signal })
  }

  async executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    const { signal } = context
    if (signal.aborted) return cancelledResult(call, signal.reason)
    const definition = this.#definitions.get(call.name)
    if (definition === undefined) return unknownToolResult(call)
    try {
      const input = definition.parseInput(call.input)
      const output = await definition.execute(input, context)
      if (signal.aborted) return cancelledResult(call, signal.reason)
      assertJsonValue(output)
      return { status: 'success', callId: call.id, output }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) return cancelledResult(call, signal.reason ?? error)
      return { status: 'failure', callId: call.id, error: serializeError(error) }
    }
  }
}
