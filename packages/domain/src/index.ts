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
  readonly input: unknown
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
  readonly output: unknown
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

export type ToolResult = ToolSuccess | ToolFailure | ToolCancelled

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

export type StepOutcome = 'completed' | 'failed' | 'cancelled'
export type TurnOutcome = 'completed' | 'failed' | 'cancelled'

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
