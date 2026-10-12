import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import { SessionEventStream } from '../src/events.js';
import { LocalWebServer } from '../src/server.js';
import type { WebSessionController } from '../src/session-registry.js';

class FakeSessions implements WebSessionController {
  readonly submitted: Array<{ sessionId: string; content: string }> = [];
  readonly cancelled: string[] = [];
  readonly closed: string[] = [];
  readonly created: Array<{ sessionId: string; workspace: string }> = [];
  readonly opened: Array<{ sessionId: string; workspace: string }> = [];
  readonly #events = new Map<string, SessionEventStream>();

  async subscribe(sessionId: string, response: ServerResponse): Promise<() => void> {
    let events = this.#events.get(sessionId);
    if (events === undefined) {
      events = new SessionEventStream();
      this.#events.set(sessionId, events);
    }
    return await events.subscribe(response, async () => ({
      value: { messages: [] },
      sequence: 0,
    }));
  }

  async createSession(workspace: string) {
    const created = { sessionId: 'session-1', workspace };
    this.created.push({ sessionId: created.sessionId, workspace });
    return created;
  }

  async openSession(sessionId: string) {
    const workspace = 'F:\\work';
    this.opened.push({ sessionId, workspace });
    return {
      sessionId,
      workspace,
    };
  }

  async submit(sessionId: string, content: string): Promise<void> {
    this.submitted.push({ sessionId, content });
  }

  async cancel(sessionId: string): Promise<void> {
    this.cancelled.push(sessionId);
  }

  async closeSession(sessionId: string): Promise<void> {
    this.closed.push(sessionId);
  }

  async close(): Promise<void> {
    for (const events of this.#events.values()) events.close();
  }
}

describe('LocalWebServer', () => {
  it('仅接受受限会话路径中的 JSON 消息和取消请求', async () => {
    const sessions = new FakeSessions();
    let browseCount = 0;
    const server = new LocalWebServer(sessions, {
      pickWorkspace: async () => {
        browseCount += 1;
        return browseCount === 1 ? 'F:\\work' : undefined;
      },
    });
    const address = await server.listen(0);
    try {
      const page = await fetch(address);
      expect(page.status).toBe(200);
      const markup = await page.text();
      expect(markup).toContain('Agent Harness');
      expect(markup).toContain('选择工作目录');
      expect(markup).toContain('仅本机运行');
      expect(markup).toContain('href="/favicon.svg"');
      expect(markup).toContain('id="workspace-dialog"');
      expect(markup).toContain('id="workspace-browse"');
      expect(markup).not.toContain('workspace-input');
      expect(markup).toContain('id="workspace"');
      expect(markup).not.toContain('id="session"');

      const foreign = await fetch(address, { headers: { origin: 'https://example.com' } });
      expect(foreign.status).toBe(403);

      const css = await fetch(new URL('/assets/app.css', address));
      const styles = await css.text();
      expect(styles).toContain('.message.assistant .message-body');
      expect(styles).toContain('list-style:disc');
      expect(styles).toContain('html,body{height:100%;overflow:hidden}');
      expect(styles).toContain('.app-shell{height:100dvh');

      const script = await fetch(new URL('/assets/app.js', address));
      const scriptText = await script.text();
      expect(scriptText).toContain('function renderMarkdown');
      expect(scriptText).toContain('restoreSession');
      expect(scriptText).toContain('/open');

      const icon = await fetch(new URL('/favicon.svg', address));
      expect(icon.status).toBe(200);
      expect(icon.headers.get('content-type')).toContain('image/svg+xml');
      expect(await icon.text()).toContain('<svg');

      const legacyIcon = await fetch(new URL('/favicon.ico', address));
      expect(legacyIcon.status).toBe(200);
      expect(await legacyIcon.text()).toContain('<svg');

      const browse = await fetch(new URL('/workspace/browse', address), { method: 'POST' });
      expect(browse.status).toBe(200);
      expect(await browse.json()).toEqual({ workspace: 'F:\\work' });

      const cancelledBrowse = await fetch(new URL('/workspace/browse', address), {
        method: 'POST',
      });
      expect(cancelledBrowse.status).toBe(409);

      const created = await fetch(new URL('/sessions', address), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ workspace: 'F:\\work' }),
      });
      expect(created.status).toBe(201);
      expect(await created.json()).toEqual({
        sessionId: 'session-1',
        workspace: 'F:\\work',
      });
      expect(sessions.created).toEqual([{ sessionId: 'session-1', workspace: 'F:\\work' }]);

      const restored = await fetch(new URL('/sessions/session-1/open', address), {
        method: 'POST',
      });
      expect(restored.status).toBe(200);
      expect(await restored.json()).toEqual({
        sessionId: 'session-1',
        workspace: 'F:\\work',
      });
      expect(sessions.opened).toEqual([{ sessionId: 'session-1', workspace: 'F:\\work' }]);

      const sent = await fetch(new URL('/sessions/session-1/messages', address), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: '你好' }),
      });
      expect(sent.status).toBe(202);
      expect(sessions.submitted).toEqual([{ sessionId: 'session-1', content: '你好' }]);

      const malformed = await fetch(new URL('/sessions/session-1/messages', address), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ content: 'x', extra: true }),
      });
      expect(malformed.status).toBe(400);

      const cancelled = await fetch(new URL('/sessions/session-1/cancel', address), {
        method: 'POST',
      });
      expect(cancelled.status).toBe(202);
      expect(sessions.cancelled).toEqual(['session-1']);

      const closed = await fetch(new URL('/sessions/session-1/close', address), { method: 'POST' });
      expect(closed.status).toBe(202);
      expect(sessions.closed).toEqual(['session-1']);
    } finally {
      await server.close();
    }
  });
});
