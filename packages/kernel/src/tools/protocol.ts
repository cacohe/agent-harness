import type { ExecutionMetadata } from '../agent.js';
import type { BrandedString, StepId, TurnId } from '../identifiers.js';
import type { JsonValue, SerializedError } from '../serialization.js';

/** 工具调用的品牌标识符。 */
export type ToolCallId = BrandedString<'ToolCallId'>;

/** 模型请求的一次工具调用。 */
export interface ToolCall {
  readonly id: ToolCallId;
  readonly name: string;
  readonly input: JsonValue;
}

/** 暴露给模型的工具定义。它是工具契约的只读投影，不包含执行或输入校验行为。 */
export interface ModelToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
}

/** 模型流中报告的一次工具调用。 */
export interface ModelToolCallEvent {
  readonly type: 'tool.call';
  readonly call: ToolCall;
}

/** 工具执行成功。 */
export interface ToolSuccess {
  readonly status: 'success';
  readonly callId: ToolCallId;
  readonly output: JsonValue;
}

/** 工具执行失败。 */
export interface ToolFailure {
  readonly status: 'failure';
  readonly callId: ToolCallId;
  readonly error: SerializedError;
}

/** 工具取消执行。 */
export interface ToolCancelled {
  readonly status: 'cancelled';
  readonly callId: ToolCallId;
  readonly reason: string;
}

/** 表示崩溃恢复无法确认工具是否完成及是否已经产生副作用。 */
export interface ToolUnknown {
  readonly status: 'unknown';
  readonly callId: ToolCallId;
  readonly reason: string;
}

/** 工具调用的四种终态结果。 */
export type ToolResult = ToolSuccess | ToolFailure | ToolCancelled | ToolUnknown;

/** 投影给模型的工具结果消息，对应一次已结算的工具调用。 */
export interface ToolMessage {
  readonly role: 'tool';
  readonly callId: ToolCallId;
  readonly result: ToolResult;
}

/** 工具调用已得到终态结果。 */
export interface ToolCompleted {
  readonly type: 'tool.completed';
  readonly turnId: TurnId;
  readonly stepId: StepId;
  readonly result: ToolResult;
}

/** 工具执行上下文。 */
export interface ToolExecutionContext {
  readonly signal: AbortSignal;
  readonly execution?: ExecutionMetadata;
}

/**
 * 工具的调用契约。
 *
 * 它是工具领域的原始定义：名称用于本次运行内的模型调用与路由，schema 用于模型请求，
 * parseInput 则是执行前处理不可信模型输入的权威边界。
 */
export interface ToolContract {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  parseInput(input: JsonValue): JsonValue;
}

/** 直接附带执行器的工具。执行器可以访问任何由组合方显式注入的外部依赖。 */
export interface ExecutableTool extends ToolContract {
  execute(input: JsonValue, context: ToolExecutionContext): Promise<JsonValue>;
}

/** 一次 Agent 运行中固定的工具目录与执行路由。 */
export interface ToolSet {
  list(): readonly ModelToolDefinition[];
  execute(call: ToolCall, context: ToolExecutionContext): Promise<ToolResult>;
}

/** 从工具调用契约构造模型可见的只读定义。 */
export function toModelToolDefinition(tool: ToolContract): ModelToolDefinition {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: tool.inputSchema,
  };
}

/** 工具授权决策。 */
export type ToolAuthorizationDecision =
  | { readonly status: 'allowed' }
  | { readonly status: 'denied'; readonly reason: string };

/** 工具执行策略。 */
export interface ToolExecutionPolicy {
  authorize(
    call: ToolCall,
    context: ToolExecutionContext & { readonly execution: ExecutionMetadata },
  ): Promise<ToolAuthorizationDecision>;
}

/** 沙盒任务。 */
export interface SandboxTask {
  readonly call: ToolCall;
  readonly workspace?: string;
  readonly limits?: SandboxResourceLimits;
}

/** 沙盒资源限制。 */
export interface SandboxResourceLimits {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

/** 沙盒调度器。 */
export interface SandboxDispatcher {
  dispatch(
    task: SandboxTask,
    context: ToolExecutionContext & { readonly execution: ExecutionMetadata },
  ): Promise<JsonValue>;
}

/** 沙盒工具注册选项。 */
export interface SandboxToolSetOptions {
  readonly workspace?: string;
  readonly limits?: SandboxResourceLimits;
}
