/** 带有编译期身份、不会与其他标识符混用的字符串。 */
export type BrandedString<Name extends string> = string & {
  readonly __brand: Name
}

export type SessionId = BrandedString<'SessionId'>
export type MessageId = BrandedString<'MessageId'>
export type TurnId = BrandedString<'TurnId'>
export type StepId = BrandedString<'StepId'>
export type AttemptId = BrandedString<'AttemptId'>
export type ToolCallId = BrandedString<'ToolCallId'>
/** 标识一次持久化原子追加，供冲突检查与审计使用。 */
export type SessionBatchId = BrandedString<'SessionBatchId'>

/** JSON 能够无损表示的递归值。 */
export type JsonPrimitive = string | number | boolean | null
/** JSON primitive、对象或数组的递归联合类型。 */
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[]
/** 键为字符串且值可由 JSON 无损表示的对象。 */
export interface JsonObject {
  readonly [key: string]: JsonValue
}

/** 为已经校验的标识符字符串赋予品牌类型。 */
export function brandId<Name extends string>(value: string): BrandedString<Name> {
  if (value.length === 0) throw new Error('identifier must not be empty')
  return value as BrandedString<Name>
}

export interface UserMessage {
  readonly id: MessageId
  readonly role: 'user'
  readonly content: string
}

export interface ToolCall {
  readonly id: ToolCallId
  readonly name: string
  readonly input: JsonValue
}

export interface AssistantMessage {
  readonly id: MessageId
  readonly role: 'assistant'
  readonly content: string
  readonly toolCalls: readonly ToolCall[]
}

export interface ToolSuccess {
  readonly status: 'success'
  readonly callId: ToolCallId
  readonly output: JsonValue
}

export interface ToolFailure {
  readonly status: 'failure'
  readonly callId: ToolCallId
  readonly error: SerializedError
}

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

export type ToolResult = ToolSuccess | ToolFailure | ToolCancelled | ToolUnknown

export interface SerializedError {
  readonly name: string
  readonly message: string
}

export type ModelMessage =
  | UserMessage
  | AssistantMessage
  | {
      readonly role: 'tool'
      readonly callId: ToolCallId
      readonly result: ToolResult
    }

export type AssistantSettlement =
  | {
      readonly status: 'completed'
      readonly attemptId: AttemptId
      readonly message: AssistantMessage
    }
  | {
      readonly status: 'failed'
      readonly attemptId: AttemptId
      readonly partialText: string
      readonly observedToolCalls: readonly ToolCall[]
      readonly error: SerializedError
    }
  | {
      readonly status: 'interrupted'
      readonly attemptId: AttemptId
      readonly partialText: string
      readonly observedToolCalls: readonly ToolCall[]
      readonly reason: string
    }

export type StepOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted'
export type TurnOutcome = 'completed' | 'failed' | 'cancelled' | 'interrupted'

export type SessionEvent =
  | { readonly type: 'turn.started'; readonly turnId: TurnId }
  | { readonly type: 'user.message'; readonly message: UserMessage }
  | {
      readonly type: 'step.started'
      readonly turnId: TurnId
      readonly stepId: StepId
    }
  | {
      readonly type: 'assistant.settled'
      readonly turnId: TurnId
      readonly stepId: StepId
      readonly settlement: AssistantSettlement
    }
  | {
      readonly type: 'tool.completed'
      readonly turnId: TurnId
      readonly stepId: StepId
      readonly result: ToolResult
    }
  | {
      readonly type: 'step.ended'
      readonly turnId: TurnId
      readonly stepId: StepId
      readonly outcome: StepOutcome
    }
  | {
      readonly type: 'turn.ended'
      readonly turnId: TurnId
      readonly outcome: TurnOutcome
      readonly error?: SerializedError
    }

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

/** 拒绝无法由 JSON 无损表示的值，包括循环引用与非有限数字。 */
export function assertJsonValue(value: unknown): asserts value is JsonValue {
  assertJsonValueAt(value, '$', new Set<object>())
}

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
