import type { ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { type SessionEventSnapshot, SessionEventStream } from '../src/events.ts';

describe('SessionEventStream', () => {
  it('先发送快照，再发送快照之后产生的缓冲事件', async () => {
    const output: string[] = [];
    const response = {
      destroyed: false,
      writeHead: vi.fn(),
      write(chunk: string) {
        output.push(chunk);
        return true;
      },
      end: vi.fn(),
    } as unknown as ServerResponse;
    let resolveSnapshot: ((snapshot: SessionEventSnapshot) => void) | undefined;
    const snapshot = new Promise<SessionEventSnapshot>((resolve) => {
      resolveSnapshot = resolve;
    });
    const events = new SessionEventStream();
    const subscribing = events.subscribe(response, () => snapshot);
    events.publish('session', { sequence: 1 }, 1);
    events.publish('stream', { text: '继续' });
    events.publish('session', { sequence: 3 }, 3);
    resolveSnapshot?.({ value: { messages: ['历史'] }, sequence: 2 });
    await subscribing;

    expect(output.join('')).toContain('event: snapshot');
    expect(output.join('')).not.toContain('"sequence":1');
    expect(output.join('')).toContain('"text":"继续"');
    expect(output.join('')).toContain('"sequence":3');
    expect(output.findIndex((item) => item.includes('snapshot'))).toBeLessThan(
      output.findIndex((item) => item.includes('"text":"继续"')),
    );
  });
});
