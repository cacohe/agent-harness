import { isAbortError } from '@agent-harness/kernel';
import { CliUsageError } from './config.js';

export function diagnostic(error: unknown, signal: AbortSignal): string {
  if (signal.aborted || isAbortError(error)) {
    return '命令已取消';
  }
  if (error instanceof CliUsageError) {
    return `参数或配置错误：${error.message}`;
  }
  const session = describeSafeSessionError(error);
  if (session !== undefined) {
    return session;
  }
  const provider = describeSafeProviderError(error);
  if (provider !== undefined) {
    return `命令执行失败：${provider}`;
  }
  const system = describeSafeSystemError(error);
  if (system !== undefined) {
    return `命令执行失败：${system}`;
  }
  return '命令执行失败；详情已被抑制以避免泄露敏感信息';
}

/** 模型 adapter 错误不含密钥，可直接展示。 */
function describeSafeProviderError(error: unknown): string | undefined {
  const candidates = error instanceof AggregateError ? error.errors : [error];
  for (const candidate of candidates) {
    if (!(candidate instanceof Error)) {
      continue;
    }
    switch (candidate.name) {
      case 'OpenAiCompatibleHttpError':
      case 'OpenAiCompatibleProtocolError':
      case 'OpenAiCompatibleConfigurationError':
      case 'LlmGatewayConfigurationError':
      case 'LlmGatewayProtocolError':
      case 'PlatformHttpConfigurationError':
      case 'PlatformHttpError':
      case 'PlatformHttpProtocolError':
        return candidate.message;
      default:
        break;
    }
  }
  return undefined;
}

/** 会话生命周期错误不含密钥，可直接展示以便区分 run / resume。 */
function describeSafeSessionError(error: unknown): string | undefined {
  const candidates = error instanceof AggregateError ? error.errors : [error];
  for (const candidate of candidates) {
    if (!(candidate instanceof Error)) {
      continue;
    }
    switch (candidate.name) {
      case 'SessionAlreadyExistsError':
        return `${candidate.message}；已有会话请改用 resume 或 chat`;
      case 'SessionNotFoundError':
        return `${candidate.message}；新会话请改用 run 或 chat`;
      case 'SessionAlreadyOwnedError':
      case 'SessionCorruptionError':
      case 'SessionSequenceConflictError':
      case 'SessionClosedError':
      case 'SessionLifecycleCorruptionError':
      case 'SessionCreateUncertainError':
      case 'SessionPoisonedError':
      case 'SessionUncertainCommitError':
        return `命令执行失败：${candidate.message}`;
      default:
        break;
    }
  }
  return undefined;
}

/** 仅暴露不含密钥的操作系统错误，便于本地诊断。 */
function describeSafeSystemError(error: unknown): string | undefined {
  const candidates = error instanceof AggregateError ? error.errors : [error];
  for (const candidate of candidates) {
    if (!(candidate instanceof Error)) {
      continue;
    }
    const code =
      'code' in candidate && typeof candidate.code === 'string' ? candidate.code : undefined;
    if (
      code !== 'EPERM' &&
      code !== 'EACCES' &&
      code !== 'ENOSPC' &&
      code !== 'ENOENT' &&
      code !== 'EEXIST'
    ) {
      continue;
    }
    const syscall =
      'syscall' in candidate && typeof candidate.syscall === 'string'
        ? candidate.syscall
        : undefined;
    return `${code}${syscall === undefined ? '' : ` (${syscall})`}: ${candidate.message}`;
  }
  return undefined;
}
