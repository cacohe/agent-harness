import type { JsonValue, SkillCatalog, ToolDefinition } from '@agent-harness/kernel';

const DEFAULT_MAX_CONTENT_BYTES = 256 * 1024;
const MAX_SKILL_ID_BYTES = 2_048;

export interface SkillLoaderToolOptions {
  readonly maxContentBytes?: number;
}

/** 创建按已启用 ID 读取 Skill 正文的 function tool。 */
export function createSkillLoaderTool(
  skills: SkillCatalog,
  options: SkillLoaderToolOptions = {},
): ToolDefinition {
  const maxContentBytes = positiveInteger(
    options.maxContentBytes ?? DEFAULT_MAX_CONTENT_BYTES,
    'maxContentBytes',
  );
  const enabledIds = snapshotEnabledIds(skills);
  return {
    name: 'load_skill',
    description: '按 id 加载一个当前已启用 Skill 的完整正文。仅在任务需要该 Skill 时调用。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['id'],
      properties: {
        id: { type: 'string', description: '当前启用 Skill 摘要中显示的 id' },
      },
    },
    parseInput(input): JsonValue {
      return { id: readSkillId(input) };
    },
    async execute(input, context): Promise<JsonValue> {
      const id = readSkillId(input);
      if (!enabledIds.has(id)) throw new SkillNotEnabledError(id);
      const content = await skills.read(id, context.signal);
      context.signal.throwIfAborted();
      if (typeof content !== 'string') throw new TypeError('SkillCatalog.read 必须返回字符串');
      if (utf8ByteLength(content) > maxContentBytes) {
        throw new RangeError(`Skill 正文不能超过 ${maxContentBytes} UTF-8 字节`);
      }
      return { id, content };
    },
  };
}

class SkillNotEnabledError extends Error {
  override readonly name = 'SkillNotEnabledError';

  constructor(id: string) {
    super(`Skill 未启用：${id}`);
  }
}

function snapshotEnabledIds(skills: SkillCatalog): ReadonlySet<string> {
  const descriptors = skills.listEnabled();
  if (!Array.isArray(descriptors)) throw new TypeError('SkillCatalog.listEnabled 必须返回数组');
  const ids = new Set<string>();
  for (const descriptor of descriptors) {
    if (typeof descriptor !== 'object' || descriptor === null || Array.isArray(descriptor)) {
      throw new TypeError('SkillCatalog.listEnabled 项必须是对象');
    }
    const id = Reflect.get(descriptor, 'id');
    assertSkillId(id, 'SkillCatalog.listEnabled id');
    if (ids.has(id)) throw new TypeError(`已启用 Skill ID 重复：${id}`);
    ids.add(id);
  }
  return ids;
}

function readSkillId(input: JsonValue): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('load_skill 输入必须是对象');
  }
  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== 'id') {
    throw new TypeError('load_skill 输入只能包含 id');
  }
  const id = Reflect.get(input, 'id');
  assertSkillId(id, 'load_skill.id');
  return id;
}

function assertSkillId(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${field} 必须是非空字符串`);
  }
  if (utf8ByteLength(value) > MAX_SKILL_ID_BYTES) {
    throw new RangeError(`${field} 不能超过 ${MAX_SKILL_ID_BYTES} UTF-8 字节`);
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} 必须是正整数`);
  return value;
}

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
