import { InMemorySessionLog } from '@agent-harness/adapters/session-memory';
import type {
  EventEnvelope,
  SessionEvent,
  SessionId,
  SessionLog,
  SessionOperationOptions,
  SettlementSignalFactory,
} from '@agent-harness/kernel';

/** 每次结算创建独立、默认不会自行取消的测试信号。 */
export class TestSettlementSignals implements SettlementSignalFactory {
  readonly created: AbortSignal[] = [];

  create(): AbortSignal {
    const signal = new AbortController().signal;
    this.created.push(signal);
    return signal;
  }
}

export interface ControlledSessionOperation {
  readonly type: 'append' | 'read' | 'flush' | 'close';
  readonly signal: AbortSignal;
  readonly events?: readonly SessionEvent[];
}

/** 在内存日志前暴露可控 await 边界，用于验证取消和结算行为。 */
export class ControlledSessionLog implements SessionLog {
  readonly sessionId: SessionId;
  readonly #delegate: InMemorySessionLog;
  readonly #intercept: (operation: ControlledSessionOperation) => void | Promise<void>;

  constructor(
    sessionId: SessionId,
    intercept: (operation: ControlledSessionOperation) => void | Promise<void>,
  ) {
    this.sessionId = sessionId;
    this.#delegate = new InMemorySessionLog(sessionId);
    this.#intercept = intercept;
  }

  async append(
    events: readonly SessionEvent[],
    options: SessionOperationOptions,
  ): Promise<readonly EventEnvelope[]> {
    await this.#intercept({ type: 'append', signal: options.signal, events });
    return this.#delegate.append(events, options);
  }

  async read(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    await this.#intercept({ type: 'read', signal: options.signal });
    return this.#delegate.read(options);
  }

  async flush(options: SessionOperationOptions): Promise<void> {
    await this.#intercept({ type: 'flush', signal: options.signal });
    await this.#delegate.flush(options);
  }

  async close(options: SessionOperationOptions): Promise<void> {
    await this.#intercept({ type: 'close', signal: options.signal });
    await this.#delegate.close(options);
  }

  committed(options: SessionOperationOptions): Promise<readonly EventEnvelope[]> {
    return this.#delegate.read(options);
  }
}
