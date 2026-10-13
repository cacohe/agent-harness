/** 技能目录 —— 列出明确启用的技能，并按 ID 读取正文。 */
export interface SkillCatalog {
  listEnabled(): readonly SkillDescriptor[];
  read(skillId: string, signal: AbortSignal): Promise<string>;
}

/** 技能描述符 —— 描述模型可见的已启用技能。 */
export interface SkillDescriptor {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}
