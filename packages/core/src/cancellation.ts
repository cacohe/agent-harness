import type { AgentRunOptions } from '@agent-harness/kernel';

/** 如果信号被中止，抛出取消错误。 */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw cancellationError(signal);
}

/** 让不遵守 signal 的外部 capability 也不能阻塞 Agent 的取消与结算路径。 */
export function waitForSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void operation.catch(() => undefined);
    return Promise.reject(cancellationError(signal));
  }

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(cancellationError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

/** 区分简写取消信号与完整 run 选项。 */
export function isAbortSignal(value: AbortSignal | AgentRunOptions): value is AbortSignal {
  return 'aborted' in value && typeof value.aborted === 'boolean';
}

function cancellationError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : String(reason ?? 'cancelled');
  const error = new Error(message, { cause: reason });
  error.name = 'AbortError';
  return error;
}
