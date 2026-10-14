import type { ExecutionMetadata } from '@agent-harness/kernel';

/** 在 Agent 边界拒绝不可信的执行审计字段，避免坏数据进入持久会话。 */
export function freezeExecutionMetadata(
  execution: ExecutionMetadata | undefined,
): ExecutionMetadata | undefined {
  if (execution === undefined) {
    return undefined;
  }
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
