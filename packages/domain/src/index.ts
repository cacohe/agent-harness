/** 带有编译期身份、不会与其他标识符混用的字符串。 */
export type BrandedString<Name extends string> = string & {
  readonly __brand: Name
}

/** 会话、消息、turn、step、attempt、工具调用的品牌标识符。 */
export type SessionId = BrandedString<'SessionId'>
export type MessageId = BrandedString<'MessageId'>
export type TurnId = BrandedString<'TurnId'>
export type StepId = BrandedString<'StepId'>
export type AttemptId = BrandedString<'AttemptId'>
export type ToolCallId = BrandedString<'ToolCallId'>
/** 标识一次持久化原子追加，供冲突检查与审计使用。 */
export type SessionBatchId = BrandedString<'SessionBatchId'>

/** 为已经校验的标识符字符串赋予品牌类型。 */
export function brandId<Name extends string>(value: string): BrandedString<Name> {
  if (value.length === 0) throw new Error('identifier must not be empty')
  return value as BrandedString<Name>
}

/** JSON 能够无损表示的递归值。 */
export type JsonPrimitive = string | number | boolean | null

/** JSON primitive、对象或数组的递归联合类型。 */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]

/** 键为字符串且值可由 JSON 无损表示的对象。 */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** 拒绝无法由 JSON 无损表示的值，包括循环引用与非有限数字。 */
export function assertJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValueAt(value, '$', new Set<object>())
}

/** 递归检查值是否可以被 JSON 无损表示。 */
function assertJsonValueAt(
  value: unknown,
  path: string,
  ancestors: Set<object>,
): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(`${path} 必须是有限数字`)
    return
  }
  if (typeof value !== 'object') throw new TypeError(`${path} 不是合法 JSON 值`)
  if (ancestors.has(value)) throw new TypeError(`${path} 包含循环引用`)
  ancestors.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new TypeError(`${path}[${index}] 不能是稀疏数组空位`)
        }
        assertJsonValueAt(value[index], `${path}[${index}]`, ancestors)
      }
      for (const key of Reflect.ownKeys(value)) {
        if (key === 'length') continue
        if (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key)) {
          throw new TypeError(`${path} 包含 JSON 不会保存的数组属性`)
        }
      }
      return
    }
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError(`${path} 必须是普通 JSON 对象`)
    }
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') {
        throw new TypeError(`${path} 包含 JSON 不会保存的 symbol 属性`)
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        throw new TypeError(`${path}.${key} 必须是可枚举的数据属性`)
      }
      assertJsonValueAt(descriptor.value, `${path}.${key}`, ancestors)
    }
  } finally {
    ancestors.delete(value)
  }
}

// ------------------------------------------------------------
// 可持久化错误
// ------------------------------------------------------------

/** 可写入会话事件的错误快照 */
export interface SerializedError {
  readonly name: string
  readonly message: string
}

/** 将未知的抛出值转换为可持久化的错误数据。 */
export function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return { name: error.name, message: error.message }
  }
  return { name: 'Error', message: String(error) }
}

/** 判断错误是否表示由中止信号触发的取消。 */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError'
}

// ------------------------------------------------------------
// 对话消息与工具结果
// ------------------------------------------------------------

/** 用户输入消息 */
export interface UserMessage {
  readonly id: MessageId
  readonly role: 'user'
  readonly content: string
}

/** 由组合方提供、不会写入会话历史的 system 指令。 */
export interface SystemMessage {
  readonly role: 'system'
  readonly content: string
}

/** 模型请求的一次工具调用 */
export interface ToolCall {
  readonly id: ToolCallId
  readonly name: string
  readonly input: JsonValue
}

/** LLM 输出消息 */
export interface AssistantMessage {
  readonly id: MessageId
  readonly role: 'assistant'
  readonly content: string
  readonly toolCalls: readonly ToolCall[]
}

/** 工具执行成功 */
export interface ToolSuccess {
  readonly status: 'success'
  readonly callId: ToolCallId
  readonly output: JsonValue
}

/** 工具执行失败 */
export interface ToolFailure {
  readonly status: 'failure'
  readonly callId: ToolCallId
  readonly error: SerializedError
}

/** 工具取消执行 */
export interface ToolCancelled {
  readonly status: 'cancelled'
  readonly callId: ToolCallId
  readonly reason: string
}

/** 表示崩溃恢复无法确认工具是否完成及是否已经产生副作用。 */
export interface ToolUnknown {
  readonly status: 'unknown'
  readonly callId: ToolCallId
  readonly reason: string
}

/** 工具调用的四种终态结果。 */
export type ToolResult = ToolSuccess | ToolFailure | ToolCancelled | ToolUnknown

/** 投影给模型的工具结果消息，对应一次已结算的工具调用。 */
export interface ToolMessage {
  readonly role: 'tool'
  readonly callId: ToolCallId
  readonly result: ToolResult
}

/** 投影给模型的消息序列成员 */
export type ModelMessage = SystemMessage | UserMessage | AssistantMessage | ToolMessage

// ------------------------------------------------------------
// LLM 调用结果
// ------------------------------------------------------------

/** 模型 attempt 成功完成，携带完整助手消息。 */
export interface AssistantCompleted {
  readonly status: 'completed'
  readonly attemptId: AttemptId
  readonly message: AssistantMessage
}

/** 模型 attempt 失败，保留部分文本与已观察到的工具调用。 */
export interface AssistantFailed {
  readonly status: 'failed'
  readonly attemptId: AttemptId
  readonly partialText: string
  readonly observedToolCalls: readonly ToolCall[]
  readonly error: SerializedError
}

/** 模型 attempt 被中断，保留部分文本与已观察到的工具调用。 */
export interface AssistantInterrupted {
  readonly status: 'interrupted'
  readonly attemptId: AttemptId
  readonly partialText: string
  readonly observedToolCalls: readonly ToolCall[]
  readonly reason: string
}

/** 一次LLM 调用结果 */
export type AssistantSettlement =
  | AssistantCompleted
  | AssistantFailed
  | AssistantInterrupted

/** step 结束时的状态 */
export type StepOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted'

/** turn 结束时的状态 */
export type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted'

// ------------------------------------------------------------
// 会话事件日志
// ------------------------------------------------------------

/** turn 开始。 */
export interface TurnStarted {
  readonly type: 'turn.started'
  readonly turnId: TurnId
}

/** 用户消息写入会话。 */
export interface UserMessageAppended {
  readonly type: 'user.message'
  readonly message: UserMessage
}

/** step 开始。 */
export interface StepStarted {
  readonly type: 'step.started'
  readonly turnId: TurnId
  readonly stepId: StepId
}

/** LLM 调用结果已结算并持久化。 */
export interface AssistantSettled {
  readonly type: 'assistant.settled'
  readonly turnId: TurnId
  readonly stepId: StepId
  readonly settlement: AssistantSettlement
}

/** 工具调用已得到终态结果。 */
export interface ToolCompleted {
  readonly type: 'tool.completed'
  readonly turnId: TurnId
  readonly stepId: StepId
  readonly result: ToolResult
}

/** step 已闭合。 */
export interface StepEnded {
  readonly type: 'step.ended'
  readonly turnId: TurnId
  readonly stepId: StepId
  readonly outcome: StepOutcome
}

/** turn 已闭合。 */
export interface TurnEnded {
  readonly type: 'turn.ended'
  readonly turnId: TurnId
  readonly outcome: TurnOutcome
  readonly error?: SerializedError
}

/**
 * 会话事件日志中的领域事件。
 * 是模型可见历史、重放、恢复与审计的事实源；流式 chunk 不在此列。
 */
export type SessionEvent =
  | TurnStarted
  | UserMessageAppended
  | StepStarted
  | AssistantSettled
  | ToolCompleted
  | StepEnded
  | TurnEnded

/**
 * 持久化时包裹 SessionEvent 统一格式
 * sequence 在会话内严格单调；timestamp 为 ISO-8601 字符串。
 */
export interface EventEnvelope {
  readonly version: 1
  readonly sessionId: SessionId
  readonly sequence: number
  readonly timestamp: string
  readonly event: SessionEvent
}

/** 当封闭联合类型出现未处理成员时抛出异常。 */
export function assertNever(value: never): never {
  throw new Error(`unhandled discriminant: ${JSON.stringify(value)}`)
}
