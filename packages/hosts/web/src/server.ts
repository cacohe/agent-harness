import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { WorkspaceError } from '@agent-harness/adapters/local';
import {
  brandId,
  type MessageId,
  SessionMessageConflictError,
  SessionNotFoundError,
} from '@agent-harness/kernel';
import { type WebSessionController, WebSessionNotFoundError } from './session-registry.js';
import type { SubmittedMessage } from './submission.js';
import { uiScript } from './ui/client.js';
import { uiFavicon } from './ui/favicon.js';
import { uiHtml } from './ui/index-html.js';
import { uiCss } from './ui/styles.js';
import { pickWorkspaceDirectory } from './workspace-picker.js';

const MAX_MESSAGE_BYTES = 64 * 1024;
const sessionIdPattern = /^[A-Za-z0-9_-]{1,128}$/;

export interface LocalWebServerOptions {
  readonly pickWorkspace?: () => Promise<string | undefined>;
}

/** 仅绑定 loopback 的本地 Web Host。 */
export class LocalWebServer {
  readonly #sessions: WebSessionController;
  readonly #pickWorkspace: () => Promise<string | undefined>;
  readonly #server: Server;
  #closing = false;
  #browsing = false;
  #closePromise: Promise<void> | undefined;

  constructor(sessions: WebSessionController, options: LocalWebServerOptions = {}) {
    this.#sessions = sessions;
    this.#pickWorkspace = options.pickWorkspace ?? pickWorkspaceDirectory;
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
    assertLocalRequest(request);
    const method = request.method ?? 'GET';
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (method === 'GET' && url.pathname === '/')
      return sendAsset(response, 'text/html; charset=utf-8', uiHtml);
    if (method === 'GET' && (url.pathname === '/favicon.svg' || url.pathname === '/favicon.ico'))
      return sendAsset(response, 'image/svg+xml; charset=utf-8', uiFavicon);
    if (method === 'GET' && url.pathname === '/assets/app.css')
      return sendAsset(response, 'text/css; charset=utf-8', uiCss);
    if (method === 'GET' && url.pathname === '/assets/app.js')
      return sendAsset(response, 'text/javascript; charset=utf-8', uiScript);
    if (method === 'POST' && url.pathname === '/workspace/browse') {
      if (this.#browsing) return sendJson(response, 409, { cancelled: true, busy: true });
      this.#browsing = true;
      try {
        const workspace = await this.#pickWorkspace();
        if (workspace === undefined) return sendJson(response, 409, { cancelled: true });
        return sendJson(response, 200, { workspace });
      } finally {
        this.#browsing = false;
      }
    }
    if (method === 'POST' && url.pathname === '/sessions') {
      const workspace = await readWorkspace(request);
      const created = await this.#sessions.createSession(workspace);
      return sendJson(response, 201, created);
    }

    const match = /^\/sessions\/([A-Za-z0-9_-]{1,128})\/(events|messages|cancel|close|open)$/.exec(
      url.pathname,
    );
    if (match === null) return sendText(response, 404, '未找到路径');
    const sessionId = match[1];
    const operation = match[2];
    if (sessionId === undefined || operation === undefined || !sessionIdPattern.test(sessionId)) {
      return sendText(response, 400, '无效会话 ID');
    }
    if (method === 'GET' && operation === 'events') {
      const unsubscribe = await this.#sessions.subscribe(sessionId, response);
      request.once('close', unsubscribe);
      return;
    }
    if (method === 'POST' && operation === 'open') {
      const opened = await this.#sessions.openSession(sessionId);
      return sendJson(response, 200, opened);
    }
    if (method === 'POST' && operation === 'messages') {
      const message = await readMessage(request);
      const receipt = await this.#sessions.submit(sessionId, message);
      return sendJson(response, receipt.status === 'accepted' ? 202 : 200, receipt);
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

function assertLocalRequest(request: IncomingMessage): void {
  const port = request.socket.localPort;
  if (port === undefined) throw new HttpError(400, '请求缺少本地端口');
  const authority = port === 80 ? '127.0.0.1' : `127.0.0.1:${port}`;
  if (request.headers.host !== authority) throw new HttpError(403, '拒绝非本机来源');
  const origin = request.headers.origin;
  if (origin !== undefined && origin !== `http://${authority}`) {
    throw new HttpError(403, '拒绝跨来源请求');
  }
}

async function readMessage(request: IncomingMessage): Promise<SubmittedMessage> {
  const record = await readJsonObject(request);
  if (
    Object.keys(record).length !== 2 ||
    typeof record.content !== 'string' ||
    typeof record.messageId !== 'string'
  ) {
    throw new HttpError(400, '消息只能包含字符串 content 与 messageId');
  }
  const content = record.content.trim();
  if (content.length === 0) throw new HttpError(400, '消息不能为空');
  if (!sessionIdPattern.test(record.messageId)) {
    throw new HttpError(400, 'messageId 无效');
  }
  return { id: brandId<'MessageId'>(record.messageId) as MessageId, content };
}

async function readWorkspace(request: IncomingMessage): Promise<string> {
  const record = await readJsonObject(request);
  if (Object.keys(record).length !== 1 || typeof record.workspace !== 'string') {
    throw new HttpError(400, '创建会话只能包含字符串 workspace');
  }
  const workspace = record.workspace.trim();
  if (workspace.length === 0) throw new HttpError(400, '工作目录不能为空');
  return workspace;
}

async function readJsonObject(request: IncomingMessage): Promise<Record<string, unknown>> {
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
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, '请求体必须是对象');
  }
  return value as Record<string, unknown>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function status(error: unknown): number {
  if (error instanceof HttpError) return error.status;
  if (error instanceof WebSessionNotFoundError) return 404;
  if (error instanceof SessionMessageConflictError) return 409;
  if (error instanceof SessionNotFoundError) return 404;
  if (error instanceof WorkspaceError) return 400;
  return 500;
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
