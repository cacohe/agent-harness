import type {
  ContextContributor,
  ContextContributorInput,
  ModelMessage,
  SkillCatalog,
  SkillDescriptor,
} from '@agent-harness/kernel';

const MAX_ENABLED_SKILLS = 128;
const MAX_SKILL_FIELD_BYTES = 2_048;
const MAX_SKILLS_SUMMARY_BYTES = 16_384;

/** 将已启用 Skills 的名称和描述加入请求，不读取或注入 Skill 正文。 */
export class EnabledSkillsContext implements ContextContributor {
  readonly #skills: SkillCatalog;

  constructor(skills: SkillCatalog) {
    this.#skills = skills;
  }

  contribute(_input: ContextContributorInput, _signal: AbortSignal): readonly ModelMessage[] {
    const descriptors = this.#skills.listEnabled();
    if (!Array.isArray(descriptors)) {
      throw new TypeError('SkillCatalog.listEnabled 必须返回数组');
    }
    if (descriptors.length > MAX_ENABLED_SKILLS) {
      throw new RangeError(`已启用 Skills 数量不能超过 ${MAX_ENABLED_SKILLS}`);
    }
    const names = new Set<string>();
    const ids = new Set<string>();
    const lines: string[] = [];
    let summaryBytes = 0;
    for (const skill of descriptors) {
      assertSkillDescriptor(skill);
      assertSkillFieldBytes(skill.id);
      assertSkillFieldBytes(skill.name);
      assertSkillFieldBytes(skill.description);
      if (ids.has(skill.id)) {
        throw new TypeError(`已启用 Skill ID 重复：${skill.id}`);
      }
      if (names.has(skill.name)) {
        throw new TypeError(`已启用 Skill 名称重复：${skill.name}`);
      }
      ids.add(skill.id);
      names.add(skill.name);
      const line = `- ${skill.name}（id: ${skill.id}）：${skill.description}`;
      summaryBytes += utf8ByteLength(line) + (lines.length === 0 ? 0 : 1);
      if (summaryBytes > MAX_SKILLS_SUMMARY_BYTES) {
        throw new RangeError(`Skill 摘要不能超过 ${MAX_SKILLS_SUMMARY_BYTES} UTF-8 字节`);
      }
      lines.push(line);
    }
    return lines.length === 0
      ? []
      : [{ role: 'system', content: `当前启用 Skills：\n${lines.join('\n')}` }];
  }
}

/** UTF-8 字节数不小于 UTF-16 code unit 数，先快速拒绝超长不可信字符串。 */
function assertSkillFieldBytes(value: string): void {
  if (value.length > MAX_SKILL_FIELD_BYTES || utf8ByteLength(value) > MAX_SKILL_FIELD_BYTES) {
    throw new RangeError(`Skill 字段不能超过 ${MAX_SKILL_FIELD_BYTES} UTF-8 字节`);
  }
}

/** 在模型输入边界校验 Host 返回的 Skill 摘要，避免把未验证配置拼入 prompt。 */
function assertSkillDescriptor(value: unknown): asserts value is SkillDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Skill 必须是对象');
  }
  const keys = Object.keys(value);
  const expected = ['description', 'id', 'name'];
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new TypeError('Skill 只能包含 id、name 与 description');
  }
  for (const key of expected) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field !== 'string' || field.length === 0) {
      throw new TypeError(`Skill.${key} 必须是非空字符串`);
    }
  }
}

const textEncoder = new TextEncoder();

function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}
