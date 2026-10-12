import type { ServerResponse } from 'node:http'

/** 一个本地会话的 SSE 订阅集合。 */
export class SessionEventStream {
  readonly #subscribers = new Set<ServerResponse>()

  get subscriberCount(): number {
    return this.#subscribers.size
  }

  subscribe(response: ServerResponse): () => void {
    response.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    })
    response.write(': connected\n\n')
    this.#subscribers.add(response)
    return () => this.#subscribers.delete(response)
  }

  publish(type: string, value: unknown): void {
    const payload = `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`
    for (const response of this.#subscribers) {
      if (response.destroyed || !response.write(payload)) {
        response.end()
        this.#subscribers.delete(response)
      }
    }
  }

  close(): void {
    for (const response of this.#subscribers) response.end()
    this.#subscribers.clear()
  }
}
