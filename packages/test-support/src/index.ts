import {
  brandId,
  type AttemptId,
  type EventEnvelope,
  type JsonValue,
  type MessageId,
  type SessionEvent,
  type SessionId,
  type StepId,
  type ToolCall,
  type ToolResult,
  type TurnId,
  type AgentIdGenerator,
  type SettlementSignalFactory,
  type SessionLog,
  type SessionOperationOptions,
  type ToolCapability,
  type ToolDefinition,
  type ToolExecutionContext,
} from '@agent-harness/kernel'
import type {
  ModelProvider,
  ModelRequest,
  ModelStreamEvent,
  PreparedModelCall,
} from '@agent-harness/kernel'
import {
  InMemorySessionLog,
} from '@agent-harness/session-memory'

export interface ModelScript {
  readonly events: readonly ModelStreamEvent[]
  readonly error?: Error
  readonly prepare?: (signal: AbortSignal) => Promise<void>
}

/** 按预设脚本产生确定性模型流，并保留每次请求供断言使用。 */
export class ScriptedModelProvider implements ModelProvider {
  readonly id = 'scripted'
  readonly requests: ModelRequest[] = []
  readonly #scripts: ModelScript[]

  constructor(scripts: readonly ModelScript[]) {
    this.#scripts = [...scripts]
  }

  async prepare(signal: AbortSignal): Promise<PreparedModelCall> {
    signal.throwIfAborted()
    const script = this.#scripts.shift()
    if (script === undefined) throw new Error('scripted model has no remaining response')
    await script.prepare?.(signal)
    signal.throwIfAborted()

    return {
      stream: (request, streamSignal) => {
        this.requests.push(request)
        return scriptedStream(script, streamSignal)
      },
    }
  }
}

async function* scriptedStream(
  script: ModelScript,
  signal: AbortSignal,
): AsyncIterable<ModelStreamEvent> {
  for (const event of script.events) {
    signal.throwIfAborted()
    yield event
  }
  if (script.error !== undefined) throw script.error
}

/** 生成测试可预测的品牌标识符。 */
export class SequentialAgentIds implements AgentIdGenerator {
  #next = 1
  #attemptsAllocated = 0

  get attemptsAllocated(): number {
    return this.#attemptsAllocated
  }

  turn(): TurnId {
    return brandId<"TurnId">(`turn-${this.#next++}`)
  }

  step(): StepId {
    return brandId<"StepId">(`step-${this.#next++}`)
  }

  attempt(): AttemptId {
    this.#attemptsAllocated += 1
    return brandId<"AttemptId">(`attempt-${this.#next++}`)
  }

  message(): MessageId {
    return brandId<"MessageId">(`message-${this.#next++}`)
  }
}

/** 每次结算创建独立、默认不会自行取消的测试信号。 */
export class TestSettlementSignals implements SettlementSignalFactory {
  readonly created: AbortSignal[] = []

  create(): AbortSignal {
    const signal = new AbortController().signal
    this.created.push(signal)
    return signal
  }
}

export interface ControlledSessionOperation {
  readonly type: 'append' | 'read' | 'flush' | 'close'
  readonly signal: AbortSignal
  readonly events?: readonly SessionEvent[]
}

/** 在内存日志前暴露可控 await 边界，用于验证取消和结算行为。 */
export class ControlledSessionLog implements SessionLog {
  readonly sessionId: SessionId
  readonly #delegate: InMemorySessionLog
  readonly #intercept: (
    operation: ControlledSessionOperation,
  ) => void | Promise<void>

  constructor(
    sessionId: SessionId,
    intercept: (
      operation: ControlledSessionOperation,
    ) => void | Promise<void>,
  ) {
    this.sessionId = sessionId
    this.#delegate = new InMemorySessionLog(sessionId)
    this.#intercept = intercept
  }

  async append(
    events: readonly SessionEvent[],
    options: SessionOperationOptions,
  ): Promise<readonly EventEnvelope[]> {
    await this.#intercept({ type: 'append', signal: options.signal, events })
    return this.#delegate.append(events, options)
  }

  async read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    await this.#intercept({ type: 'read', signal: options.signal })
    return this.#delegate.read(options)
  }

  async flush(options: SessionOperationOptions): Promise<void> {
    await this.#intercept({ type: 'flush', signal: options.signal })
    await this.#delegate.flush(options)
  }

  async close(options: SessionOperationOptions): Promise<void> {
    await this.#intercept({ type: 'close', signal: options.signal })
    await this.#delegate.close(options)
  }

  committed(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    return this.#delegate.read(options)
  }
}

/** 提供独立于 ToolRegistry 的可编程工具 capability。 */
export class ScriptedToolCapability implements ToolCapability {
  readonly #definitions: ReturnType<ToolCapability['list']>
  readonly #execute: ToolCapability['execute']

  constructor(
    definitions: ReturnType<ToolCapability['list']>,
    execute: ToolCapability['execute'],
  ) {
    this.#definitions = definitions
    this.#execute = execute
  }

  list(): ReturnType<ToolCapability['list']> {
    return this.#definitions
  }

  execute(call: ToolCall, signal: AbortSignal): Promise<ToolResult> {
    return this.#execute(call, signal)
  }
}

/** 创建可记录调用并由测试回调控制行为的工具。 */
export function fakeTool(
  name: string,
  execute: (input: JsonValue, context: ToolExecutionContext) => Promise<JsonValue>,
): ToolDefinition & { readonly calls: JsonValue[] } {
  const calls: JsonValue[] = []
  return {
    name,
    description: `${name} test tool`,
    inputSchema: { type: 'object' },
    parseInput: input => input,
    calls,
    async execute(input, context) {
      calls.push(input)
      return execute(input, context)
    },
  }
}
