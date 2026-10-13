import type { AttemptId, MessageId } from './identifiers.js';
import type { SerializedError } from './serialization.js';
import type {
  ModelToolCallEvent,
  ModelToolDefinition,
  ToolCall,
  ToolMessage,
} from './tools/protocol.js';

/** 用户输入消息。 */
export interface UserMessage {
  readonly id: MessageId;
  readonly role: 'user';
  readonly content: string;
}

/** 由组合方提供、不会写入会话历史的 system 指令。 */
export interface SystemMessage {
  readonly role: 'system';
  readonly content: string;
}

/** LLM 输出消息。 */
export interface AssistantMessage {
  readonly id: MessageId;
  readonly role: 'assistant';
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
}

/** 投影给模型的消息序列成员。 */
export type ModelMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage;

/** 模型 attempt 成功完成，携带完整助手消息。 */
export interface AssistantCompleted {
  readonly status: 'completed';
  readonly attemptId: AttemptId;
  readonly message: AssistantMessage;
}

/** 模型 attempt 失败，保留部分文本与已观察到的工具调用。 */
export interface AssistantFailed {
  readonly status: 'failed';
  readonly attemptId: AttemptId;
  readonly partialText: string;
  readonly observedToolCalls: readonly ToolCall[];
  readonly error: SerializedError;
}

/** 模型 attempt 被中断，保留部分文本与已观察到的工具调用。 */
export interface AssistantInterrupted {
  readonly status: 'interrupted';
  readonly attemptId: AttemptId;
  readonly partialText: string;
  readonly observedToolCalls: readonly ToolCall[];
  readonly reason: string;
}

/** 一次 LLM 调用结果。 */
export type AssistantSettlement = AssistantCompleted | AssistantFailed | AssistantInterrupted;

/** 一次模型调用的请求 */
export interface ModelRequest {
  readonly messages: readonly ModelMessage[];
  readonly tools: readonly ModelToolDefinition[];
}

/**
 * 模型流式通知事件 —— 一次模型调用的流式输出。
 * 临时数据，不写入会话日志；完整 assistant 结算由 Agent 另行持久化。
 */
export type ModelStreamEvent =
  | { readonly type: 'text.delta'; readonly text: string } // 文本增量
  | ModelToolCallEvent
  | { readonly type: 'usage'; readonly inputTokens: number; readonly outputTokens: number }; // 使用量

/** 已准备好的模型调用 —— 可按请求流式产出事件。 */
export interface PreparedModelCall {
  stream(request: ModelRequest, signal: AbortSignal): AsyncIterable<ModelStreamEvent>;
}

/**
 * 模型 provider。
 * `prepare` 完成连接或鉴权等前置工作后返回可流式调用的句柄。
 */
export interface ModelProvider {
  readonly id: string;

  prepare(signal: AbortSignal): Promise<PreparedModelCall>;
}
