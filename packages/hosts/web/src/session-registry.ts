import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { resolveWorkspaceDirectory } from '@agent-harness/adapters/local';
import {
  type AgentObserver,
  brandId,
  type EventEnvelope,
  findSessionMessageSubmission,
  type MessageId,
  SessionAlreadyExistsError,
  type SessionId,
  SessionMessageConflictError,
} from '@agent-harness/kernel';
import type { AgentRuntime, AgentRuntimeHandle } from '@agent-harness/runtime';
import { SessionEventStream } from './events.js';
import type { SubmissionReceipt, SubmittedMessage } from './submission.js';
import { projectChatTranscript } from './transcript.js';

interface ManagedSession {
  readonly workspace: string;
  readonly runtime: AgentRuntime;
  readonly handle: AgentRuntimeHandle;
  readonly events: SessionEventStream;
  readonly pendingSubmissions: Map<MessageId, string>;
}

export interface SessionRuntimeFactory {
  create(observer: AgentObserver, workspace: string): AgentRuntime;
}

/** 会话尚未选择工作目录或尚未创建。 */
export class WebSessionNotFoundError extends Error {
  override readonly name = 'WebSessionNotFoundError';
}

export interface OpenedWebSession {
  readonly sessionId: string;
  readonly workspace: string;
}

/** HTTP 路由所需的最小会话控制能力。 */
export interface WebSessionController {
  createSession(workspace: string): Promise<OpenedWebSession>;
  openSession(sessionId: string): Promise<OpenedWebSession>;
  subscribe(sessionId: string, response: ServerResponse): Promise<() => void>;
  submit(sessionId: string, message: SubmittedMessage): Promise<SubmissionReceipt>;
  cancel(sessionId: string): Promise<void>;
  closeSession(sessionId: string): Promise<void>;
  close(): Promise<void>;
}

/** 将浏览器会话映射到独占 Runtime handle，确保每个 JSONL session 只有一个 writer。 */
export class SessionRegistry implements WebSessionController {
  readonly #factory: SessionRuntimeFactory;
  readonly #idleTimeoutMs: number;
  readonly #onIdleCloseError: (error: unknown) => void;
  readonly #readEvents: SessionRegistryOptions['readEvents'];
  readonly #createWorkspace: SessionRegistryOptions['createWorkspace'];
  readonly #readWorkspace: SessionRegistryOptions['readWorkspace'];
  readonly #sessions = new Map<string, ManagedSession>();
  readonly #opening = new Map<string, Promise<ManagedSession>>();
  readonly #closingSessions = new Map<string, Promise<void>>();
  readonly #streams = new Map<string, SessionEventStream>();
  readonly #idleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(factory: SessionRuntimeFactory, options: SessionRegistryOptions) {
    this.#factory = factory;
    this.#idleTimeoutMs = options.idleTimeoutMs;
    this.#onIdleCloseError = options.onIdleCloseError;
    this.#readEvents = options.readEvents;
    this.#createWorkspace = options.createWorkspace;
    this.#readWorkspace = options.readWorkspace;
  }

  async createSession(workspacePath: string): Promise<OpenedWebSession> {
    if (this.#closing) throw new Error('Web Host 正在关闭，不能创建会话');
    const workspace = await resolveWorkspaceDirectory(workspacePath);
    const sessionId = randomUUID();
    const session = await this.#get(sessionId, workspace, 'create');
    try {
      await this.#createWorkspace(sessionId, session.workspace);
    } catch (error) {
      await this.closeSession(sessionId).catch(() => undefined);
      throw error;
    }
    return { sessionId, workspace: session.workspace };
  }

  async openSession(sessionId: string): Promise<OpenedWebSession> {
    if (this.#closing) throw new Error('Web Host 正在关闭，不能恢复会话');
    const workspacePath = await this.#readWorkspace(sessionId);
    if (workspacePath === undefined) {
      throw new WebSessionNotFoundError('会话没有已授权的工作目录');
    }
    const workspace = await resolveWorkspaceDirectory(workspacePath);
    const session = await this.#get(sessionId, workspace, 'resume');
    return { sessionId, workspace: session.workspace };
  }

  async subscribe(sessionId: string, response: ServerResponse): Promise<() => void> {
    if (this.#closing || this.#closingSessions.has(sessionId)) {
      response.writeHead(409, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('会话正在关闭');
      return () => undefined;
    }
    if (
      !this.#sessions.has(sessionId) &&
      !this.#opening.has(sessionId) &&
      !this.#streams.has(sessionId)
    ) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('会话不存在，请先选择工作目录');
      return () => undefined;
    }
    let events = this.#streams.get(sessionId);
    if (events === undefined) {
      events = new SessionEventStream();
      this.#streams.set(sessionId, events);
    }
    this.#cancelIdleClose(sessionId);
    let unsubscribe: () => void;
    try {
      unsubscribe = await events.subscribe(response, async () => {
        const envelopes = await this.#readEvents(sessionId, new AbortController().signal);
        return {
          value: { messages: projectChatTranscript(envelopes) },
          sequence: envelopes.at(-1)?.sequence ?? 0,
        };
      });
    } catch (error) {
      if (events.subscriberCount === 0) this.#scheduleIdleClose(sessionId);
      throw error;
    }
    return () => {
      unsubscribe();
      if (events.subscriberCount === 0) {
        if (this.#sessions.has(sessionId) || this.#opening.has(sessionId)) {
          this.#scheduleIdleClose(sessionId);
        } else if (this.#streams.get(sessionId) === events) {
          this.#streams.delete(sessionId);
        }
      }
    };
  }

  async submit(sessionId: string, message: SubmittedMessage): Promise<SubmissionReceipt> {
    const session = await this.#get(sessionId, undefined, 'resume');
    const pending = this.#pendingReceipt(session, message);
    if (pending !== undefined) return pending;
    const persisted = findSessionMessageSubmission(
      await this.#readEvents(sessionId, new AbortController().signal),
      { ...message, role: 'user' },
    );
    if (persisted !== undefined) return persisted;
    const pendingAfterRead = this.#pendingReceipt(session, message);
    if (pendingAfterRead !== undefined) return pendingAfterRead;
    session.pendingSubmissions.set(message.id, message.content);
    void session.handle.agent
      .run({
        id: message.id,
        role: 'user',
        content: message.content,
      })
      .then(
        (assistant) => session.events.publish('completed', { message: assistant }),
        (error) => session.events.publish('failed', { message: errorMessage(error) }),
      )
      .finally(() => session.pendingSubmissions.delete(message.id));
    return { status: 'accepted' };
  }

  async cancel(sessionId: string): Promise<void> {
    const session = await this.#get(sessionId, undefined, 'resume');
    session.handle.agent.cancel(new DOMException('用户取消当前执行', 'AbortError'));
  }

  closeSession(sessionId: string): Promise<void> {
    const closing = this.#closingSessions.get(sessionId);
    if (closing !== undefined) return closing;
    const created = this.#closeSession(sessionId).finally(() =>
      this.#closingSessions.delete(sessionId),
    );
    this.#closingSessions.set(sessionId, created);
    return created;
  }

  async close(): Promise<void> {
    if (this.#closePromise === undefined) {
      this.#closing = true;
      for (const timer of this.#idleTimers.values()) clearTimeout(timer);
      this.#idleTimers.clear();
      this.#closePromise = this.#closeAll();
    }
    return this.#closePromise;
  }

  async #closeAll(): Promise<void> {
    await Promise.allSettled(this.#closingSessions.values());
    const opening = [...this.#opening.values()];
    const opened = await Promise.allSettled(opening);
    const sessions = new Set(this.#sessions.values());
    for (const result of opened) {
      if (result.status === 'fulfilled') sessions.add(result.value);
    }
    this.#sessions.clear();
    this.#opening.clear();
    for (const events of this.#streams.values()) events.close();
    this.#streams.clear();
    const results = await Promise.allSettled(
      [...sessions].flatMap((session) => [session.handle.close(), session.runtime.close()]),
    );
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '关闭 Web 会话失败');
  }

  async #get(
    sessionId: string,
    workspace: string | undefined,
    mode: 'create' | 'resume',
  ): Promise<ManagedSession> {
    if (this.#closing) throw new Error('Web Host 正在关闭，不能接纳新消息');
    const closing = this.#closingSessions.get(sessionId);
    if (closing !== undefined) {
      await closing;
      return this.#get(sessionId, workspace, mode);
    }
    this.#cancelIdleClose(sessionId);
    const opened = this.#sessions.get(sessionId);
    if (opened !== undefined) return opened;
    const opening = this.#opening.get(sessionId);
    if (opening !== undefined) return opening;
    if (workspace === undefined) throw new WebSessionNotFoundError('会话不存在，请先选择工作目录');
    const created = this.#open(sessionId, workspace, mode);
    this.#opening.set(sessionId, created);
    try {
      const session = await created;
      if (this.#closing) {
        await Promise.allSettled([session.handle.close(), session.runtime.close()]);
        throw new Error('Web Host 正在关闭，不能接纳新消息');
      }
      this.#sessions.set(sessionId, session);
      if (session.events.subscriberCount === 0) this.#scheduleIdleClose(sessionId);
      return session;
    } finally {
      this.#opening.delete(sessionId);
    }
  }

  async #open(
    rawSessionId: string,
    workspace: string,
    mode: 'create' | 'resume',
  ): Promise<ManagedSession> {
    const sessionId = brandId<'SessionId'>(rawSessionId) as SessionId;
    const events = this.#events(rawSessionId);
    const runtime = this.#factory.create(
      {
        onStream: (event) => events.publish('stream', event),
        onExecution: (event) =>
          events.publish(
            'session',
            event,
            event.type === 'session.event' ? event.envelope.sequence : undefined,
          ),
      },
      workspace,
    );
    const signal = new AbortController().signal;
    try {
      const handle =
        mode === 'create'
          ? await this.#createOrResume(runtime, sessionId, signal)
          : await runtime.resume(sessionId, { signal });
      return { workspace, runtime, handle, events, pendingSubmissions: new Map() };
    } catch (error) {
      await runtime.close().catch(() => undefined);
      throw error;
    }
  }

  async #createOrResume(
    runtime: AgentRuntime,
    sessionId: SessionId,
    signal: AbortSignal,
  ): Promise<AgentRuntimeHandle> {
    try {
      return await runtime.create(sessionId, { signal });
    } catch (error) {
      if (!(error instanceof SessionAlreadyExistsError)) throw error;
      return await runtime.resume(sessionId, { signal });
    }
  }

  async #closeSession(sessionId: string): Promise<void> {
    this.#cancelIdleClose(sessionId);
    const opening = this.#opening.get(sessionId);
    if (opening !== undefined) await Promise.allSettled([opening]);
    const session = this.#sessions.get(sessionId);
    this.#sessions.delete(sessionId);
    const events = this.#streams.get(sessionId);
    this.#streams.delete(sessionId);
    events?.close();
    if (session === undefined) return;
    const results = await Promise.allSettled([session.handle.close(), session.runtime.close()]);
    const errors = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, '关闭 Web 会话失败');
  }

  #events(sessionId: string): SessionEventStream {
    let events = this.#streams.get(sessionId);
    if (events === undefined) {
      events = new SessionEventStream();
      this.#streams.set(sessionId, events);
    }
    return events;
  }

  #pendingReceipt(
    session: ManagedSession,
    message: SubmittedMessage,
  ): SubmissionReceipt | undefined {
    const content = session.pendingSubmissions.get(message.id);
    if (content === undefined) return undefined;
    if (content !== message.content) {
      throw new SessionMessageConflictError('messageId 已用于内容不同的消息');
    }
    return { status: 'accepted' };
  }

  #scheduleIdleClose(sessionId: string): void {
    this.#cancelIdleClose(sessionId);
    const timer = setTimeout(() => {
      this.#idleTimers.delete(sessionId);
      void this.closeSession(sessionId).catch((error) => this.#onIdleCloseError(error));
    }, this.#idleTimeoutMs);
    timer.unref();
    this.#idleTimers.set(sessionId, timer);
  }

  #cancelIdleClose(sessionId: string): void {
    const timer = this.#idleTimers.get(sessionId);
    if (timer !== undefined) clearTimeout(timer);
    this.#idleTimers.delete(sessionId);
  }
}

export interface SessionRegistryOptions {
  readonly idleTimeoutMs: number;
  readonly onIdleCloseError: (error: unknown) => void;
  readonly readEvents: (
    sessionId: string,
    signal: AbortSignal,
  ) => Promise<readonly EventEnvelope[]>;
  readonly createWorkspace: (sessionId: string, workspace: string) => Promise<void>;
  readonly readWorkspace: (sessionId: string) => Promise<string | undefined>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
