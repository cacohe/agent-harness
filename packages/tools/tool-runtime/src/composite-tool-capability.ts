import {
  assertJsonValue,
  type ExecutionAwareToolCapability,
  type JsonValue,
  type ModelToolDefinition,
  type ToolCall,
  type ToolCapability,
  type ToolExecutionContext,
  type ToolResult,
} from '@agent-harness/kernel'
import { freezeJson } from './json-snapshot.js'
import { executeWithContext } from './tool-execution.js'
import { cancelledResult, unknownToolResult } from './tool-results.js'

/** 工具来源在组合时暴露了重复名称。 */
export class DuplicateToolNameError extends Error {
  override readonly name = 'DuplicateToolNameError'

  constructor(readonly toolName: string) {
    super(`duplicate tool registration: ${toolName}`)
  }
}

/** 将多个已就绪的工具来源合并为单一目录，并按工具名路由执行。 */
export class CompositeToolCapability implements ExecutionAwareToolCapability {
  readonly #definitions: readonly ModelToolDefinition[]
  readonly #routes: ReadonlyMap<string, ToolCapability>

  constructor(capabilities: readonly ToolCapability[]) {
    const definitions: ModelToolDefinition[] = []
    const routes = new Map<string, ToolCapability>()
    for (const capability of capabilities) {
      for (const definition of capability.list()) {
        if (routes.has(definition.name)) throw new DuplicateToolNameError(definition.name)
        assertJsonValue(definition.inputSchema)
        routes.set(definition.name, capability)
        definitions.push(Object.freeze({
          name: definition.name,
          description: definition.description,
          inputSchema: freezeJson(definition.inputSchema as JsonValue) as Readonly<Record<string, unknown>>,
        }))
      }
    }
    this.#definitions = Object.freeze(definitions)
    this.#routes = routes
  }

  list(): readonly ModelToolDefinition[] { return this.#definitions }

  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.executeWithContext(call, { signal })
  }

  executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    if (context.signal.aborted) return Promise.resolve(cancelledResult(call, context.signal.reason))
    const capability = this.#routes.get(call.name)
    if (capability === undefined) return Promise.resolve(unknownToolResult(call))
    return executeWithContext(capability, call, context)
  }
}
