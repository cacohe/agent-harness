import {
  assertJsonValue,
  isAbortError,
  serializeError,
  type ToolCall,
  type ToolResult,
  type JsonValue,
} from '@agent-harness/domain'
import type { ModelToolDefinition } from '@agent-harness/model'

export interface ToolExecutionContext {
  readonly signal: AbortSignal
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>

  /** 在任何副作用前把不可信模型 JSON 解析为已验证输入。 */
  parseInput(input: JsonValue): JsonValue
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue>
}

/** 向模型公开当前可用工具，不暴露具体注册方式。 */
export interface ToolCatalog {
  list(): readonly ModelToolDefinition[]
}

/** 执行规范化工具调用，不暴露工具查找与调度实现。 */
export interface ToolExecutor {
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>
}

/** Agent loop 所需的最小工具 capability。 */
export interface ToolCapability extends ToolCatalog, ToolExecutor {}

/** 不可变的工具注册表，也是第一阶段的顺序工具执行器。 */
export class ToolRegistry implements ToolCapability {
  readonly #definitions: ReadonlyMap<string, ToolDefinition>

  constructor(definitions: readonly ToolDefinition[]) {
    const entries = new Map<string, ToolDefinition>()
    for (const definition of definitions) {
      if (entries.has(definition.name)) {
        throw new Error(`duplicate tool registration: ${definition.name}`)
      }
      entries.set(definition.name, definition)
    }
    this.#definitions = entries
  }

  list(): readonly ModelToolDefinition[] {
    return [...this.#definitions.values()].map(definition => ({
      name: definition.name,
      description: definition.description,
      inputSchema: definition.inputSchema,
    }))
  }

  async execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    if (signal.aborted) return cancelledResult(call, signal.reason)

    const definition = this.#definitions.get(call.name)
    if (definition === undefined) {
      return {
        status: 'failure',
        callId: call.id,
        error: {
          name: 'UnknownToolError',
          message: `unknown tool: ${call.name}`,
        },
      }
    }

    try {
      const input = definition.parseInput(call.input)
      const output = await definition.execute(input, { signal })
      if (signal.aborted) return cancelledResult(call, signal.reason)
      assertJsonValue(output)
      return { status: 'success', callId: call.id, output }
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        return cancelledResult(call, signal.reason ?? error)
      }
      return { status: 'failure', callId: call.id, error: serializeError(error) }
    }
  }
}

function cancelledResult(call: ToolCall, reason: unknown): ToolResult {
  return {
    status: 'cancelled',
    callId: call.id,
    reason: reason instanceof Error ? reason.message : String(reason ?? 'cancelled'),
  }
}
