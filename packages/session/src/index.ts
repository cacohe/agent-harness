import {
  assertNever,
  type EventEnvelope,
  type ModelMessage,
  type SessionEvent,
  type SessionId,
} from '@agent-harness/domain'

/** 定义可取消、append-only 且支持原子事件批次的会话日志。 */
export interface SessionLog {
  readonly sessionId: SessionId

  /** 原子追加一个事件批次；失败或取消时不得留下部分批次。 */
  append(
    events: readonly SessionEvent[],
    options: SessionOperationOptions,
  ): Promise<readonly EventEnvelope[]>
  read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]>
  flush(options: SessionOperationOptions): Promise<void>
  close(options: SessionOperationOptions): Promise<void>
}

export interface SessionOperationOptions {
  /** 控制当前存储操作，不代表 Agent 的 durable settlement 分类。 */
  readonly signal: AbortSignal
}

export interface SessionClock {
  now(): string
}

/** 面向测试和进程内运行时的 append-only 会话实现。 */
export class InMemorySessionLog implements SessionLog {
  readonly sessionId: SessionId
  readonly #clock: SessionClock
  readonly #events: EventEnvelope[] = []
  #closed = false

  constructor(sessionId: SessionId, clock: SessionClock = systemSessionClock) {
    this.sessionId = sessionId
    this.#clock = clock
  }

  async append(
    events: readonly SessionEvent[],
    options: SessionOperationOptions,
  ): Promise<readonly EventEnvelope[]> {
    this.#assertOpen()
    options.signal.throwIfAborted()
    const firstSequence = this.#events.length + 1
    const envelopes = events.map((event, index): EventEnvelope =>
      immutableSnapshot({
        version: 1,
        sessionId: this.sessionId,
        sequence: firstSequence + index,
        timestamp: this.#clock.now(),
        event,
      }),
    )
    options.signal.throwIfAborted()
    this.#events.push(...envelopes)
    return envelopes
  }

  async read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    options.signal.throwIfAborted()
    return this.#events.slice()
  }

  async flush(options: SessionOperationOptions): Promise<void> {
    this.#assertOpen()
    options.signal.throwIfAborted()
  }

  async close(options: SessionOperationOptions): Promise<void> {
    options.signal.throwIfAborted()
    this.#closed = true
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error('session log is closed')
  }
}

const systemSessionClock: SessionClock = {
  now: () => new Date().toISOString(),
}

function immutableSnapshot<T>(value: T): T {
  return deepFreeze(structuredClone(value))
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (typeof value !== 'object' || value === null || seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(Reflect.get(value, key), seen)
  }
  return Object.freeze(value)
}

/** 从持久事件中重建下一次模型请求可见的完整消息历史。 */
export function deriveModelMessages(
  envelopes: readonly EventEnvelope[],
): readonly ModelMessage[] {
  const messages: ModelMessage[] = []
  let previousSequence = 0

  for (const envelope of envelopes) {
    if (envelope.sequence <= previousSequence) {
      throw new Error('session event sequence must be strictly increasing')
    }
    previousSequence = envelope.sequence

    switch (envelope.event.type) {
      case 'user.message':
        messages.push(envelope.event.message)
        break
      case 'assistant.settled':
        if (envelope.event.settlement.status === 'completed') {
          messages.push(envelope.event.settlement.message)
        }
        break
      case 'tool.completed':
        messages.push({
          role: 'tool',
          callId: envelope.event.result.callId,
          result: envelope.event.result,
        })
        break
      case 'turn.started':
      case 'step.started':
      case 'step.ended':
      case 'turn.ended':
        break
      default:
        assertNever(envelope.event)
    }
  }

  return messages
}
