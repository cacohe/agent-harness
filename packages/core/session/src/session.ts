import {
  assertJsonValue,
  SessionClosedError,
  SessionSequenceConflictError,
  type EventEnvelope,
  type SessionAppendOptions,
  type SessionBatchId,
  type SessionClock,
  type SessionEvent,
  type SessionId,
  type SessionLog,
  type SessionOperationOptions,
} from '@agent-harness/kernel'

/** 面向测试和进程内运行时的 append-only 会话实现。 */
export class InMemorySessionLog implements SessionLog {
  readonly sessionId: SessionId
  readonly #clock: SessionClock
  readonly #events: EventEnvelope[] = []
  readonly #batchIds = new Set<SessionBatchId>()
  #closed = false

  constructor(sessionId: SessionId, clock: SessionClock = systemSessionClock) {
    this.sessionId = sessionId
    this.#clock = clock
  }

  async append(
    events: readonly SessionEvent[],
    options: SessionAppendOptions,
  ): Promise<readonly EventEnvelope[]> {
    this.#assertOpen()
    options.signal.throwIfAborted()
    if (events.length === 0) return []
    if (
      options.expectedSequence !== undefined
      && options.expectedSequence !== this.#events.length
    ) {
      throw new SessionSequenceConflictError('expected sequence 与当前日志不一致')
    }
    if (options.batchId !== undefined && this.#batchIds.has(options.batchId)) {
      throw new SessionSequenceConflictError('batchId 已存在')
    }
    for (const event of events) assertJsonValue(event)
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
    if (options.batchId !== undefined) this.#batchIds.add(options.batchId)
    return envelopes
  }

  async read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    this.#assertOpen()
    options.signal.throwIfAborted()
    return this.#events.slice()
  }

  async flush(options: SessionOperationOptions): Promise<void> {
    this.#assertOpen()
    options.signal.throwIfAborted()
  }

  async close(options: SessionOperationOptions): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    options.signal.throwIfAborted()
  }

  #assertOpen(): void {
    if (this.#closed) throw new SessionClosedError('会话句柄已关闭')
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
