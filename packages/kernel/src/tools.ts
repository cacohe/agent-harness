import type { ExecutionMetadata, JsonValue, ToolCall, ToolResult } from './facts.js';
import type { ModelToolDefinition } from './model.js';

/** 工具执行上下文 —— 工具执行所需的上下文。 */
export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly execution?: ExecutionMetadata;
}

/** 工具定义 —— 工具的定义。 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  parseInput(input: JsonValue): JsonValue;
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue>;
}

/** 工具目录 —— 列出所有可用的工具。 */
export interface ToolCatalog {
  list(): readonly ModelToolDefinition[];
}

/** 工具执行器 —— 执行一个工具调用。 */
export interface ToolExecutor {
  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult>;
}

/** 工具能力 —— 工具的执行能力和目录。 */
export interface ToolCapability extends ToolCatalog, ToolExecutor {}

/** 执行上下文 aware 工具能力 —— 执行一个工具调用，并提供执行上下文。 */
export interface ExecutionAwareToolCapability extends ToolCapability {
  executeWithContext(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
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
  dispatch(task: SandboxTask, context: ToolExecutionContext): Promise<JsonValue>;
}

/** 沙盒工具注册选项 —— 沙盒工具注册选项。 */
export interface SandboxToolRegistryOptions {
  readonly workspace?: string;
  readonly limits?: SandboxResourceLimits;
}
