import type { ModelToolDefinition, ToolSpecification } from '@agent-harness/kernel';

/** 两种注册表共享同一注册不变量，避免模型可见目录与执行目录出现分叉。 */
export function indexToolDefinitions<T extends ToolSpecification>(
  definitions: readonly T[],
): ReadonlyMap<string, T> {
  const entries = new Map<string, T>();
  for (const definition of definitions) {
    if (entries.has(definition.name))
      throw new Error(`duplicate tool registration: ${definition.name}`);
    entries.set(definition.name, definition);
  }
  return entries;
}

/** 只投影模型调用所需字段，执行函数和输入 parser 保持在注册表内部。 */
export function toModelToolDefinitions(
  definitions: ReadonlyMap<string, ToolSpecification>,
): readonly ModelToolDefinition[] {
  return [...definitions.values()].map((definition) => ({
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
  }));
}
