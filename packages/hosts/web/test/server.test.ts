import { describe, expect, it } from 'vitest'
import type { WebSessionController } from '../src/session-registry.js'
import { LocalWebServer } from '../src/server.js'
import { SessionEventStream } from '../src/events.js'
import type { ServerResponse } from 'node:http'

class FakeSessions implements WebSessionController {
  readonly submitted: Array<{ sessionId: string, content: string }> = []
  readonly cancelled: string[] = []
  readonly closed: string[] = []
  readonly #events = new Map<string, SessionEventStream>()

  subscribe(sessionId: string, response: ServerResponse): () => void {
    let events = this.#events.get(sessionId)
    if (events === undefined) {
      events = new SessionEventStream()
      this.#events.set(sessionId, events)
    }
    return events.subscribe(response)
  }

  async submit(sessionId: string, content: string): Promise<void> {
    this.submitted.push({ sessionId, content })
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId)
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closed.push(sessionId)
  }

  async close(): Promise<void> {
    for (const events of this.#events.values()) events.close()
  }
}

describe('LocalWebServer', () => {
  it('仅接受受限会话路径中的 JSON 消息和取消请求', async () => {
    const sessions = new FakeSessions()
    const server = new LocalWebServer(sessions)
    const address = await server.listen(0)
    try {
      const page = await fetch(address)
      expect(page.status).toBe(200)
      expect(await page.text()).toContain('Agent Harness')

      const sent = await fetch(new URL('/sessions/session-1/messages', address), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '你好' }),
      })
      expect(sent.status).toBe(202)
      expect(sessions.submitted).toEqual([{ sessionId: 'session-1', content: '你好' }])

      const malformed = await fetch(new URL('/sessions/session-1/messages', address), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x', extra: true }),
      })
      expect(malformed.status).toBe(400)

      const cancelled = await fetch(new URL('/sessions/session-1/cancel', address), { method: 'POST' })
      expect(cancelled.status).toBe(202)
      expect(sessions.cancelled).toEqual(['session-1'])

      const closed = await fetch(new URL('/sessions/session-1/close', address), { method: 'POST' })
      expect(closed.status).toBe(202)
      expect(sessions.closed).toEqual(['session-1'])
    } finally {
      await server.close()
    }
  })
})
