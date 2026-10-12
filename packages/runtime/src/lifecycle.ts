import type { SessionLog } from '@agent-harness/kernel';

/** 使用独立 deadline 刷新并关闭 writer，保证两步错误都能被 Runtime 观察。 */
export async function flushAndClose(session: SessionLog, timeoutMs: number): Promise<void> {
  const signal = AbortSignal.timeout(timeoutMs);
  const errors: unknown[] = [];
  try {
    await session.flush({ signal });
  } catch (error) {
    errors.push(error);
  }
  try {
    await session.close({ signal });
  } catch (error) {
    errors.push(error);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, '刷新和关闭会话时发生多个错误');
}

/** 取消调用方等待，不取消已经开始的后台生命周期操作。 */
export function waitFor<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(signal.reason);
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
