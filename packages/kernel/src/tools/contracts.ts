import type { ExecutionMetadata, JsonValue, ToolCall, ToolResult } from '../facts.js';
import type { ModelToolDefinition } from '../model.js';

/** 工具执行上下文 —— 工具执行所需的上下文。 */
export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly execution?: ExecutionMetadata;
}

/** 工具规格 —— 模型可见描述与 Host 侧输入规范化。 */
export interface ToolSpecification {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  parseInput(input: JsonValue): JsonValue;
}

/** 本地工具定义 —— 在工具规格上附加进程内执行函数。 */
export interface ToolDefinition extends ToolSpecification {
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue>;
}

/** 工具目录 —— 列出所有可用的工具。 */
export interface ToolCatalog {
  list(): readonly ModelToolDefinition[];
}

/** 工具能力 —— 工具的执行能力和目录。 */
export interface ToolCapability extends ToolCatalog {
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
}

/** 工具授权决策 —— 工具授权决策。 */
export type ToolAuthorizationDecision =
  | { readonly status: 'allowed' }
  | { readonly status: 'denied'; readonly reason: string };

/** 工具执行策略 —— 工具执行策略。 */
export interface ToolExecutionPolicy {
  authorize(
    call: ToolCall,
    context: ToolExecutionContext & { readonly execution: ExecutionMetadata },
  ): Promise<ToolAuthorizationDecision>;
}

/** 沙盒任务 —— 沙盒任务。 */
export interface SandboxTask {
  readonly call: ToolCall;
  readonly workspace?: string;
  readonly limits?: SandboxResourceLimits;
}

/** 沙盒资源限制 —— 沙盒资源限制。 */
export interface SandboxResourceLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** 沙盒调度器 —— 调度一个沙盒任务。 */
export interface SandboxDispatcher {
  dispatch(
    task: SandboxTask,
    context: ToolExecutionContext & { readonly execution: ExecutionMetadata },
  ): Promise<JsonValue>;
}

/** 沙盒工具注册选项 —— 沙盒工具注册选项。 */
export interface SandboxToolRegistryOptions {
  readonly workspace?: string;
  readonly limits?: SandboxResourceLimits;
}
