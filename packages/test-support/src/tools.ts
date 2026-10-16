import type {
  JsonValue,
  ToolCall,
  ToolSet,
  ExecutableTool,
  ToolExecutionContext,
  ToolResult,
} from '@agent-harness/kernel';

/** 提供独立于 ToolRegistry 的可编程工具集。 */
export class ScriptedToolSet implements ToolSet {
  readonly #definitions: ReturnType<ToolSet['list']>;
  readonly #execute: ToolSet['execute'];

  constructor(definitions: ReturnType<ToolSet['list']>, execute: ToolSet['execute']) {
    this.#definitions = definitions;
    this.#execute = execute;
  }

  list(): ReturnType<ToolSet['list']> {
    return this.#definitions;
  }

  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult> {
    return this.#execute(call, context);
  }
}

/** 创建可记录调用并由测试回调控制行为的工具。 */
export function fakeTool(
  name: string,
  execute: (input: JsonValue, context: ToolExecutionContext) => Promise<JsonValue>,
): ExecutableTool & { readonly calls: JsonValue[] } {
  const calls: JsonValue[] = [];
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object' },
    parseInput: (input) => input,
    calls,
    async execute(input, context) {
      calls.push(input);
      return execute(input, context);
    },
  };
}
