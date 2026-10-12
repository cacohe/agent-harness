import type { AgentRunOptions, ExecutionMetadata } from '@agent-harness/kernel';

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

export function isAbortSignal(value: AbortSignal | AgentRunOptions): value is AbortSignal {
  return 'aborted' in value && typeof value.aborted === 'boolean';
}

/** 在 Agent 边界拒绝不可信的执行审计字段，避免坏数据进入持久会话。 */
export function freezeExecutionMetadata(
  execution: ExecutionMetadata | undefined,
): ExecutionMetadata | undefined {
  if (execution === undefined) return undefined;
  if (typeof execution !== 'object' || execution === null || Array.isArray(execution)) {
    throw new TypeError('execution 必须是对象');
  }
  const keys = Object.keys(execution);
  const expected = ['authorizationVersion', 'id', 'subject'];
  if (keys.length !== expected.length || !expected.every((key) => keys.includes(key))) {
    throw new TypeError('execution 只能包含 id、subject 与 authorizationVersion');
  }
  const { id, subject, authorizationVersion } = execution;
  for (const [name, value] of Object.entries({ id, subject, authorizationVersion })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new TypeError(`execution.${name} 必须是非空字符串`);
    }
  }
  return Object.freeze({ id, subject, authorizationVersion });
}

/** 拒绝不符合模型 capability 累计语义的 usage，避免下游重复计费。 */
export function assertCumulativeUsage(
  inputTokens: number,
  outputTokens: number,
  previousInputTokens: number,
  previousOutputTokens: number,
): void {
  if (!Number.isSafeInteger(inputTokens) || inputTokens < previousInputTokens) {
    throw new TypeError('模型 inputTokens 必须是单调不减的非负安全整数');
  }
  if (!Number.isSafeInteger(outputTokens) || outputTokens < previousOutputTokens) {
    throw new TypeError('模型 outputTokens 必须是单调不减的非负安全整数');
  }
}

const textEncoder = new TextEncoder();

/** 计算字符串的 UTF-8 字节长度，避免依赖 Node Buffer。 */
export function utf8ByteLength(value: string): number {
  return textEncoder.encode(value).byteLength;
}

function cancellationError(signal: AbortSignal): Error {
  const reason = signal.reason;
  const message = reason instanceof Error ? reason.message : String(reason ?? 'cancelled');
  const error = new Error(message, { cause: reason });
  error.name = 'AbortError';
  return error;
}
