import type { ModelMessage, ModelRequest } from '../model.js';
import type { EventEnvelope } from '../session/protocol.js';
import type { ModelToolDefinition } from '../tools/protocol.js';

/** 提示词组装器 —— 组装完整的 Agent 请求。 */
export interface PromptAssembler {
  assemble(
    events: readonly EventEnvelope[],
    tools: readonly ModelToolDefinition[],
    signal: AbortSignal,
  ): Promise<ModelRequest>;
}

/** 上下文贡献者 —— 贡献上下文内容，可选插件。 */
export interface ContextContributor {
  contribute(
    input: ContextContributorInput,
    signal: AbortSignal,
  ): readonly ModelMessage[] | Promise<readonly ModelMessage[]>;
}

/** 上下文贡献者输入 —— 上下文贡献者所需的输入。 */
export interface ContextContributorInput {
  readonly events: readonly EventEnvelope[];
  readonly tools: readonly ModelToolDefinition[];
}

/** 时钟 —— 提供当前时间。 */
export interface Clock {
  now(): Date;
}
