import type { ServerResponse } from 'node:http';

interface BufferedEvent {
  readonly payload: string;
  readonly sequence?: number;
}

interface Subscriber {
  readonly response: ServerResponse;
  pending: BufferedEvent[] | undefined;
}

export interface SessionEventSnapshot {
  readonly value: unknown;
  readonly sequence: number;
}

/** 一个本地会话的 SSE 订阅集合。 */
export class SessionEventStream {
  readonly #subscribers = new Set<Subscriber>();

  get subscriberCount(): number {
    return this.#subscribers.size;
  }

  async subscribe(
    response: ServerResponse,
    snapshot: () => Promise<SessionEventSnapshot>,
  ): Promise<() => void> {
    response.writeHead(200, {
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    response.write(': connected\n\n');
    const subscriber: Subscriber = { response, pending: [] };
    this.#subscribers.add(subscriber);
    try {
      const initial = await snapshot();
      if (response.destroyed) {
        this.#subscribers.delete(subscriber);
        return () => undefined;
      }
      response.write(serialize('snapshot', initial.value));
      const pending = subscriber.pending ?? [];
      subscriber.pending = undefined;
      for (const event of pending) {
        if (event.sequence !== undefined && event.sequence <= initial.sequence) continue;
        if (!response.write(event.payload)) {
          response.end();
          this.#subscribers.delete(subscriber);
          break;
        }
      }
    } catch (error) {
      this.#subscribers.delete(subscriber);
      response.end();
      throw error;
    }
    return () => this.#subscribers.delete(subscriber);
  }

  publish(type: string, value: unknown, sequence?: number): void {
    const event: BufferedEvent = {
      payload: serialize(type, value),
      ...(sequence === undefined ? {} : { sequence }),
    };
    for (const subscriber of this.#subscribers) {
      if (subscriber.pending !== undefined) {
        subscriber.pending.push(event);
        continue;
      }
      const { response } = subscriber;
      if (response.destroyed || !response.write(event.payload)) {
        response.end();
        this.#subscribers.delete(subscriber);
      }
    }
  }

  close(): void {
    for (const subscriber of this.#subscribers) subscriber.response.end();
    this.#subscribers.clear();
  }
}

function serialize(type: string, value: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;
}
