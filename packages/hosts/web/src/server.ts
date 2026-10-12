import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { WebSessionController } from './session-registry.js';
import { uiScript } from './ui/client.js';
import { uiHtml } from './ui/index-html.js';
import { uiCss } from './ui/styles.js';

const MAX_MESSAGE_BYTES = 64 * 1024;
const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

/** 仅绑定 loopback 的本地 Web Host。 */
export class LocalWebServer {
  readonly #sessions: WebSessionController;
  readonly #server: Server;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(sessions: WebSessionController) {
    this.#sessions = sessions;
    this.#server = createServer((request, response) => {
      void this.#route(request, response).catch((error) => {
        if (!response.headersSent) sendText(response, status(error), diagnostic(error));
        else response.end();
      });
    });
  }

  async listen(port: number): Promise<URL> {
    await new Promise<void>((resolve, reject) => {
      this.#server.once('error', reject);
      this.#server.listen({ host: '127.0.0.1', port }, () => {
        this.#server.off('error', reject);
        resolve();
      });
    });
    const address = this.#server.address();
    if (address === null || typeof address === 'string') throw new Error('Web 服务未返回 TCP 地址');
    return new URL(`http://127.0.0.1:${address.port}/`);
  }

  close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closing = true;
      this.#closePromise = this.#closeAll();
    }
    return this.#closePromise;
  }

  async #closeAll(): Promise<void> {
    const stopped = new Promise<void>((resolve, reject) => {
      this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
    });
    await this.#sessions.close();
    await stopped;
  }

  async #route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.#closing) return sendText(response, 503, 'Web Host 正在关闭');
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (method === 'GET' && url.pathname === '/')
      return sendAsset(response, 'text/html; charset=utf-8', uiHtml);
    if (method === 'GET' && url.pathname === '/assets/app.css')
      return sendAsset(response, 'text/css; charset=utf-8', uiCss);
    if (method === 'GET' && url.pathname === '/assets/app.js')
      return sendAsset(response, 'text/javascript; charset=utf-8', uiScript);

    const match = /^\/sessions\/([A-Za-z0-9_-]{1,128})\/(events|messages|cancel|close)$/.exec(
      url.pathname,
    );
    if (match === null) return sendText(response, 404, '未找到路径');
    const sessionId = match[1];
    const operation = match[2];
    if (sessionId === undefined || operation === undefined || !sessionIdPattern.test(sessionId)) {
      return sendText(response, 400, '无效会话 ID');
    }
    if (method === 'GET' && operation === 'events') {
      const unsubscribe = this.#sessions.subscribe(sessionId, response);
      request.once('close', unsubscribe);
      return;
    }
    if (method === 'POST' && operation === 'messages') {
      const content = await readMessage(request);
      await this.#sessions.submit(sessionId, content);
      return sendJson(response, 202, { accepted: true });
    }
    if (method === 'POST' && operation === 'cancel') {
      await this.#sessions.cancel(sessionId);
      return sendJson(response, 202, { accepted: true });
    }
    if (method === 'POST' && operation === 'close') {
      await this.#sessions.closeSession(sessionId);
      return sendJson(response, 202, { accepted: true });
    }
    return sendText(response, 405, '不支持的方法');
  }
}

async function readMessage(request: IncomingMessage): Promise<string> {
  if (request.headers['content-type'] !== 'application/json')
    throw new HttpError(415, 'Content-Type 必须是 application/json');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_MESSAGE_BYTES) throw new HttpError(413, '消息超过大小限制');
    chunks.push(bytes);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, '消息必须是有效 JSON');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new HttpError(400, '消息必须是对象');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 1 || typeof record.content !== 'string') {
    throw new HttpError(400, '消息只能包含字符串 content');
  }
  const content = record.content.trim();
  if (content.length === 0) throw new HttpError(400, '消息不能为空');
  return content;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function status(error: unknown): number {
  return error instanceof HttpError ? error.status : 500;
}

function diagnostic(error: unknown): string {
  return error instanceof HttpError
    ? error.message
    : error instanceof Error
      ? error.message
      : '服务器内部错误';
}

function sendAsset(response: ServerResponse, contentType: string, content: string): void {
  response.writeHead(200, { 'cache-control': 'no-store', 'content-type': contentType });
  response.end(content);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(value));
}

function sendText(response: ServerResponse, status: number, content: string): void {
  response.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(content);
}
