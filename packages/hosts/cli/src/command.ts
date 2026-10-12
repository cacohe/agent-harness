import { isAbsolute } from 'node:path';
import { CliUsageError } from './config.js';

export type CliCommand =
  | {
      readonly mode: 'run' | 'resume';
      readonly configPath: string;
      readonly session: string;
      readonly message: string;
    }
  | {
      readonly mode: 'chat';
      readonly configPath: string;
      readonly session: string;
      readonly message: string | undefined;
    }
  | {
      readonly mode: 'import';
      readonly configPath: string;
      readonly filePath: string;
      readonly mediaType: string;
    }
  | { readonly mode: 'document-status'; readonly configPath: string; readonly documentId: string }
  | { readonly mode: 'document-delete'; readonly configPath: string; readonly documentId: string };

export function parseArgv(argv: readonly string[]): CliCommand {
  const [mode, ...rest] = argv;
  if (mode === 'import') return parseImportCommand(rest);
  if (mode === 'document-status' || mode === 'document-delete') {
    return parseDocumentCommand(mode, rest);
  }
  if (mode !== 'run' && mode !== 'resume' && mode !== 'chat') throw usageError();
  const values = parseOptionPairs(rest, ['--config', '--session', '--message']);
  const configPath = absoluteOption(values, '--config');
  const session = requiredOption(values, '--session');
  const message = values.get('--message');
  if (mode === 'chat') {
    if (message !== undefined && message.length === 0) {
      throw new CliUsageError('--message 若提供则不能为空');
    }
    return { mode, configPath, session, message };
  }
  if (message === undefined || message.length === 0) {
    throw new CliUsageError('run/resume 必须提供非空 --message');
  }
  return { mode, configPath, session, message };
}

function parseDocumentCommand(
  mode: 'document-status' | 'document-delete',
  rest: readonly string[],
): CliCommand {
  const values = parseOptionPairs(rest, ['--config', '--document']);
  return {
    mode,
    configPath: absoluteOption(values, '--config'),
    documentId: requiredOption(values, '--document'),
  };
}

function parseImportCommand(rest: readonly string[]): CliCommand {
  const values = parseOptionPairs(rest, ['--config', '--file', '--media-type']);
  return {
    mode: 'import',
    configPath: absoluteOption(values, '--config'),
    filePath: absoluteOption(values, '--file'),
    mediaType: requiredOption(values, '--media-type'),
  };
}

function parseOptionPairs(
  rest: readonly string[],
  allowed: readonly string[],
): Map<string, string> {
  if (rest.length % 2 !== 0) throw new CliUsageError('命令参数必须成对出现');
  const values = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    if (key === undefined || value === undefined || values.has(key)) {
      throw new CliUsageError('命令参数无效');
    }
    if (!allowed.includes(key)) throw new CliUsageError(`未知参数 ${key}`);
    values.set(key, value);
  }
  return values;
}

function absoluteOption(values: ReadonlyMap<string, string>, name: string): string {
  const value = requiredOption(values, name);
  if (!isAbsolute(value)) throw new CliUsageError(`${name} 必须是绝对路径`);
  return value;
}

function requiredOption(values: ReadonlyMap<string, string>, name: string): string {
  const value = values.get(name);
  if (value === undefined || value.length === 0)
    throw new CliUsageError(`${name} 必须是非空字符串`);
  return value;
}

function usageError(): CliUsageError {
  return new CliUsageError(
    '用法：run|resume|chat --config 绝对路径 --session ID [--message 内容]；' +
      '或 import --config 绝对路径 --file 绝对路径 --media-type MIME；' +
      '或 document-status|document-delete --config 绝对路径 --document ID',
  );
}
