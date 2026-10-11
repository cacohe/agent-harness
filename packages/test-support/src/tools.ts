import type {
  JsonValue,
  ToolCall,
  ToolCapability,
  ToolDefinition,
  ToolExecutionContext,
  ToolResult,
} from '@agent-harness/kernel'

/** 提供独立于 ToolRegistry 的可编程工具 capability。 */
export class ScriptedToolCapability implements ToolCapability {
  readonly #definitions: ReturnType<ToolCapability['list']>
  readonly #execute: ToolCapability['execute']

  constructor(
    definitions: ReturnType<ToolCapability['list']>,
    execute: ToolCapability['execute'],
  ) {
    this.#definitions = definitions
    this.#execute = execute
  }

  list(): ReturnType<ToolCapability['list']> { return this.#definitions }

  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.#execute(call, signal)
  }
}

/** 创建可记录调用并由测试回调控制行为的工具。 */
export function fakeTool(
  name: string,
  execute: (input: JsonValue, context: ToolExecutionContext) => Promise<JsonValue>,
): ToolDefinition & { readonly calls: JsonValue[] } {
  const calls: JsonValue[] = []
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object' },
    parseInput: input => input,
    calls,
    async execute(input, context) {
      calls.push(input)
      return execute(input, context)
    },
  }
}
