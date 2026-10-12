import { randomUUID } from 'node:crypto'
import type { ServerResponse } from 'node:http'
import {
  brandId,
  SessionAlreadyExistsError,
  type AgentObserver,
  type MessageId,
  type SessionId,
} from '@agent-harness/kernel'
import { AgentRuntime, type AgentRuntimeHandle } from '@agent-harness/runtime'
import { SessionEventStream } from './events.js'

interface ManagedSession {
  readonly runtime: AgentRuntime
  readonly handle: AgentRuntimeHandle
  readonly events: SessionEventStream
}

export interface SessionRuntimeFactory {
  create(observer: AgentObserver): AgentRuntime
}

/** HTTP 路由所需的最小会话控制能力。 */
export interface WebSessionController {
  subscribe(sessionId: string, response: ServerResponse): () => void
  submit(sessionId: string, content: string): Promise<void>
  cancel(sessionId: string): Promise<void>
  closeSession(sessionId: string): Promise<void>
  close(): Promise<void>
}

/** 将浏览器会话映射到独占 Runtime handle，确保每个 JSONL session 只有一个 writer。 */
export class SessionRegistry implements WebSessionController {
  readonly #factory: SessionRuntimeFactory
  readonly #idleTimeoutMs: number
  readonly #onIdleCloseError: (error: unknown) => void
  readonly #sessions = new Map<string, ManagedSession>()
  readonly #opening = new Map<string, Promise<ManagedSession>>()
  readonly #closingSessions = new Map<string, Promise<void>>()
  readonly #streams = new Map<string, SessionEventStream>()
  readonly #idleTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #closing = false
  #closePromise: Promise<void> | undefined

  constructor(factory: SessionRuntimeFactory, options: SessionRegistryOptions) {
    this.#factory = factory
    this.#idleTimeoutMs = options.idleTimeoutMs
    this.#onIdleCloseError = options.onIdleCloseError
  }

  subscribe(sessionId: string, response: ServerResponse): () => void {
    if (this.#closing || this.#closingSessions.has(sessionId)) {
      response.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('会话正在关闭')
      return () => undefined
    }
    let events = this.#streams.get(sessionId)
    if (events === undefined) {
      events = new SessionEventStream()
      this.#streams.set(sessionId, events)
    }
    this.#cancelIdleClose(sessionId)
    const unsubscribe = events.subscribe(response)
    return () => {
      unsubscribe()
      if (events.subscriberCount === 0) {
        if (this.#sessions.has(sessionId) || this.#opening.has(sessionId)) {
          this.#scheduleIdleClose(sessionId)
        } else if (this.#streams.get(sessionId) === events) {
          this.#streams.delete(sessionId)
        }
      }
    }
  }

  async submit(sessionId: string, content: string): Promise<void> {
    const session = await this.#get(sessionId)
    void session.handle.agent.run({
      id: brandId<'MessageId'>(randomUUID()) as MessageId,
      role: 'user',
      content,
    }).then(
      message => session.events.publish('completed', { message }),
      error => session.events.publish('failed', { message: message(error) }),
    )
  }

  async cancel(sessionId: string): Promise<void> {
    const session = await this.#get(sessionId)
    session.handle.agent.cancel(new DOMException('用户取消当前执行', 'AbortError'))
  }

  closeSession(sessionId: string): Promise<void> {
    const closing = this.#closingSessions.get(sessionId)
    if (closing !== undefined) return closing
    const created = this.#closeSession(sessionId).finally(() => this.#closingSessions.delete(sessionId))
    this.#closingSessions.set(sessionId, created)
    return created
  }

  async close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closing = true
      for (const timer of this.#idleTimers.values()) clearTimeout(timer)
      this.#idleTimers.clear()
      this.#closePromise = this.#closeAll()
    }
    return this.#closePromise
  }

  async #closeAll(): Promise<void> {
    await Promise.allSettled(this.#closingSessions.values())
    const opening = [...this.#opening.values()]
    const opened = await Promise.allSettled(opening)
    const sessions = new Set(this.#sessions.values())
    for (const result of opened) {
      if (result.status === 'fulfilled') sessions.add(result.value)
    }
    this.#sessions.clear()
    this.#opening.clear()
    for (const events of this.#streams.values()) events.close()
    this.#streams.clear()
    const results = await Promise.allSettled([...sessions].flatMap(session => [
      session.handle.close(),
      session.runtime.close(),
    ]))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, '关闭 Web 会话失败')
  }

  async #get(sessionId: string): Promise<ManagedSession> {
    if (this.#closing) throw new Error('Web Host 正在关闭，不能接纳新消息')
    const closing = this.#closingSessions.get(sessionId)
    if (closing !== undefined) {
      await closing
      return this.#get(sessionId)
    }
    this.#cancelIdleClose(sessionId)
    const opened = this.#sessions.get(sessionId)
    if (opened !== undefined) return opened
    const opening = this.#opening.get(sessionId)
    if (opening !== undefined) return opening
    const created = this.#open(sessionId)
    this.#opening.set(sessionId, created)
    try {
      const session = await created
      if (this.#closing) {
        await Promise.allSettled([session.handle.close(), session.runtime.close()])
        throw new Error('Web Host 正在关闭，不能接纳新消息')
      }
      this.#sessions.set(sessionId, session)
      if (session.events.subscriberCount === 0) this.#scheduleIdleClose(sessionId)
      return session
    } finally {
      this.#opening.delete(sessionId)
    }
  }

  async #open(rawSessionId: string): Promise<ManagedSession> {
    const sessionId = brandId<'SessionId'>(rawSessionId) as SessionId
    const events = this.#events(rawSessionId)
    const runtime = this.#factory.create({
      onStream: event => events.publish('stream', event),
      onExecution: event => events.publish('session', event),
    })
    const signal = new AbortController().signal
    try {
      const handle = await runtime.create(sessionId, { signal })
      return { runtime, handle, events }
    } catch (error) {
      if (!(error instanceof SessionAlreadyExistsError)) {
        await runtime.close().catch(() => undefined)
        throw error
      }
      const handle = await runtime.resume(sessionId, { signal })
      return { runtime, handle, events }
    }
  }

  async #closeSession(sessionId: string): Promise<void> {
    this.#cancelIdleClose(sessionId)
    const opening = this.#opening.get(sessionId)
    if (opening !== undefined) await Promise.allSettled([opening])
    const session = this.#sessions.get(sessionId)
    this.#sessions.delete(sessionId)
    const events = this.#streams.get(sessionId)
    this.#streams.delete(sessionId)
    events?.close()
    if (session === undefined) return
    const results = await Promise.allSettled([session.handle.close(), session.runtime.close()])
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length === 1) throw errors[0]
    if (errors.length > 1) throw new AggregateError(errors, '关闭 Web 会话失败')
  }

  #events(sessionId: string): SessionEventStream {
    let events = this.#streams.get(sessionId)
    if (events === undefined) {
      events = new SessionEventStream()
      this.#streams.set(sessionId, events)
    }
    return events
  }

  #scheduleIdleClose(sessionId: string): void {
    this.#cancelIdleClose(sessionId)
    const timer = setTimeout(() => {
      this.#idleTimers.delete(sessionId)
      void this.closeSession(sessionId).catch(error => this.#onIdleCloseError(error))
    }, this.#idleTimeoutMs)
    timer.unref()
    this.#idleTimers.set(sessionId, timer)
  }

  #cancelIdleClose(sessionId: string): void {
    const timer = this.#idleTimers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    this.#idleTimers.delete(sessionId)
  }
}

export interface SessionRegistryOptions {
  readonly idleTimeoutMs: number
  readonly onIdleCloseError: (error: unknown) => void
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
