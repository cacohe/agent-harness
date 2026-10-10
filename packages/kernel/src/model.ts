import type { ModelMessage, ToolCall } from './facts.js'

/** 暴露给模型的工具定义 */
export interface ModelToolDefinition {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

/** 一次模型调用的请求 */
export interface ModelRequest {
  readonly messages: readonly ModelMessage[]
  readonly tools: readonly ModelToolDefinition[]
}

/**
 * 模型流式通知事件。
 * 临时数据，不写入会话日志；完整 assistant 结算由 Agent 另行持久化。
 */
export type ModelStreamEvent =
  | { readonly type: 'text.delta'; readonly text: string }
  | { readonly type: 'tool.call'; readonly call: ToolCall }
  | {
      /** 截至当前流事件的累计 token；同一调用内必须为非负安全整数且单调不减。 */
      readonly type: 'usage'
      readonly inputTokens: number
      readonly outputTokens: number
    }

/** 已准备好的模型调用，可按请求流式产出事件。 */
export interface PreparedModelCall {
  stream(
    request: ModelRequest,
    signal: AbortSignal,
  ): AsyncIterable<ModelStreamEvent>
}

/**
 * 模型 provider capability。
 * `prepare` 完成连接或鉴权等前置工作后返回可流式调用的句柄。
 */
export interface ModelProvider {
  readonly id: string

  prepare(signal: AbortSignal): Promise<PreparedModelCall>
}
