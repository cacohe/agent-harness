import type { AgentRunOptions, AssistantMessage, UserMessage } from '@agent-harness/kernel';

/** 尚未开始的 turn；每个调用者只会收到自己消息对应的结果。 */
export interface QueuedRun {
  readonly message: UserMessage;
  readonly options: AbortSignal | AgentRunOptions;
  readonly resolve: (message: AssistantMessage) => void;
  readonly reject: (error: unknown) => void;
  readonly clearAbortListener: () => void;
}

/** 串行领取用户输入，保证同一会话在任意时刻只有一个 writer。 */
export class AgentInbox {
  readonly #runs: QueuedRun[] = [];

  /** 加入 FIFO 队列。 */
  enqueue(run: QueuedRun): void {
    this.#runs.push(run);
  }

  /** 领取最早尚未执行的输入。 */
  claim(): QueuedRun | undefined {
    return this.#runs.shift();
  }

  /** 移除一条尚未开始的输入。 */
  remove(run: QueuedRun): boolean {
    const index = this.#runs.indexOf(run);
    if (index < 0) return false;
    this.#runs.splice(index, 1);
    return true;
  }

  /** 拒绝全部尚未开始的输入。 */
  rejectAll(error: unknown): void {
    for (const run of this.#runs.splice(0)) {
      run.clearAbortListener();
      run.reject(error);
    }
  }

  /** 是否仍有尚未开始的输入。 */
  get hasPending(): boolean {
    return this.#runs.length > 0;
  }
}
