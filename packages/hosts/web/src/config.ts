import { isAbsolute } from 'node:path';
import type { AgentProfile } from '@agent-harness/kernel';

/** Web Host 配置错误。 */
export class WebUsageError extends Error {
  override readonly name = 'WebUsageError';
}

export interface WebHostConfig {
  readonly sessionRoot: string;
  readonly maxSteps: number;
  readonly settlementTimeoutMs: number;
  readonly runTimeoutMs: number;
  readonly maxModelOutputBytes: number;
  readonly maxInputBytes: number;
  readonly sessionIdleTimeoutMs: number;
  readonly agentProfile?: AgentProfile;
  readonly model: {
    readonly id: string;
    readonly baseUrl: string;
    readonly model: string;
    readonly apiKeyEnv: string;
  };
}

/** 读取 Web Host 所需的最小本地配置；密钥始终从环境变量取得。 */
export async function readWebConfig(
  path: string,
  readFile: (path: string, encoding: 'utf8') => Promise<string>,
): Promise<WebHostConfig> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new WebUsageError('配置文件必须是可解析的 JSON');
  }
  const root = object(value, '配置');
  exact(
    root,
    ['sessionRoot', 'maxSteps', 'settlementTimeoutMs', 'model'],
    [
      'runTimeoutMs',
      'maxModelOutputBytes',
      'maxInputBytes',
      'sessionIdleTimeoutMs',
      'agentProfile',
    ],
  );
  const model = object(root.model, 'model 配置');
  exact(model, ['id', 'baseUrl', 'model', 'apiKeyEnv'], []);
  const sessionRoot = text(root.sessionRoot, 'sessionRoot');
  if (!isAbsolute(sessionRoot)) throw new WebUsageError('sessionRoot 必须是绝对路径');
  return {
    sessionRoot,
    maxSteps: positive(root.maxSteps, 'maxSteps'),
    settlementTimeoutMs: positive(root.settlementTimeoutMs, 'settlementTimeoutMs'),
    runTimeoutMs: optionalPositive(root.runTimeoutMs, 'runTimeoutMs', 120_000),
    maxModelOutputBytes: optionalPositive(
      root.maxModelOutputBytes,
      'maxModelOutputBytes',
      1_048_576,
    ),
    maxInputBytes: optionalPositive(root.maxInputBytes, 'maxInputBytes', 1_048_576),
    sessionIdleTimeoutMs: optionalPositive(
      root.sessionIdleTimeoutMs,
      'sessionIdleTimeoutMs',
      60_000,
    ),
    ...(root.agentProfile === undefined ? {} : { agentProfile: agentProfile(root.agentProfile) }),
    model: {
      id: text(model.id, 'model.id'),
      baseUrl: text(model.baseUrl, 'model.baseUrl'),
      model: text(model.model, 'model.model'),
      apiKeyEnv: environmentName(model.apiKeyEnv, 'model.apiKeyEnv'),
    },
  };
}

function agentProfile(value: unknown): AgentProfile {
  const profile = object(value, 'agentProfile');
  exact(profile, ['id', 'version', 'instructions'], []);
  return {
    id: text(profile.id, 'agentProfile.id'),
    version: text(profile.version, 'agentProfile.version'),
    instructions: text(profile.instructions, 'agentProfile.instructions'),
  };
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebUsageError(`${name} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new WebUsageError(`配置包含未知字段 ${key}`);
  }
  for (const key of required) {
    if (!(key in value)) throw new WebUsageError(`配置缺少字段 ${key}`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new WebUsageError(`${name} 必须是非空字符串`);
  return value;
}

function positive(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new WebUsageError(`${name} 必须是正整数`);
  }
  return value;
}

function optionalPositive(value: unknown, name: string, fallback: number): number {
  return value === undefined ? fallback : positive(value, name);
}

function environmentName(value: unknown, name: string): string {
  const result = text(value, name);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new WebUsageError(`${name} 必须是环境变量名`);
  return result;
}
