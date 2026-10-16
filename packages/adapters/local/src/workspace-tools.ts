import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ExecutableTool, JsonObject, JsonValue } from '@agent-harness/kernel';
import { resolveInsideWorkspace } from './workspace.js';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_LIST_ENTRIES = 200;

/** 创建只能在固定工作目录内列目录和读写文件的工具。 */
export function createWorkspaceTools(workspace: string): readonly ExecutableTool[] {
  return [
    {
      name: 'list_dir',
      description: `列出工作目录 ${workspace} 内的文件和子目录。path 相对于工作目录，缺省为根。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', description: '相对工作目录的子路径' },
        },
      },
      parseInput: (input) => readOptionalPath(input, 'list_dir'),
      async execute(input) {
        const relative = pathField(input);
        const target = await resolveInsideWorkspace(workspace, relative ?? '.');
        const entries = await readdir(target, { withFileTypes: true });
        return {
          path: relative ?? '.',
          entries: entries.slice(0, MAX_LIST_ENTRIES).map((entry) => ({
            name: entry.name,
            type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          })),
          truncated: entries.length > MAX_LIST_ENTRIES,
        };
      },
    },
    {
      name: 'read_file',
      description: `读取工作目录 ${workspace} 内的文本文件。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径' },
        },
      },
      parseInput: (input) => readRequiredPath(input, 'read_file'),
      async execute(input) {
        const relative = pathField(input);
        if (relative === undefined) {
          throw new TypeError('read_file.path 必须是非空字符串');
        }
        const target = await resolveInsideWorkspace(workspace, relative);
        const bytes = await readFile(target);
        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new RangeError(`文件不能超过 ${MAX_FILE_BYTES} 字节`);
        }
        return { path: relative, content: bytes.toString('utf8') };
      },
    },
    {
      name: 'write_file',
      description: `把文本写入工作目录 ${workspace} 内的文件；必要时创建中间目录。`,
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: '相对工作目录的文件路径' },
          content: { type: 'string', description: '要写入的 UTF-8 文本' },
        },
      },
      parseInput: (input) => readWriteInput(input),
      async execute(input) {
        const fields = writeFields(input);
        const target = await resolveInsideWorkspace(workspace, fields.path);
        const bytes = Buffer.from(fields.content, 'utf8');
        if (bytes.byteLength > MAX_FILE_BYTES) {
          throw new RangeError(`写入内容不能超过 ${MAX_FILE_BYTES} 字节`);
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, bytes);
        return { path: fields.path, bytes: bytes.byteLength };
      },
    },
  ];
}

function readOptionalPath(input: JsonValue, name: string): JsonValue {
  const record = objectInput(input, name);
  if (record.path === undefined) {
    return input;
  }
  if (typeof record.path !== 'string' || record.path.trim().length === 0) {
    throw new TypeError(`${name}.path 必须是非空字符串`);
  }
  return input;
}

function readRequiredPath(input: JsonValue, name: string): JsonValue {
  const record = objectInput(input, name);
  if (typeof record.path !== 'string' || record.path.trim().length === 0) {
    throw new TypeError(`${name}.path 必须是非空字符串`);
  }
  return input;
}

function readWriteInput(input: JsonValue): JsonValue {
  const record = objectInput(input, 'write_file');
  if (typeof record.path !== 'string' || record.path.trim().length === 0) {
    throw new TypeError('write_file.path 必须是非空字符串');
  }
  if (typeof record.content !== 'string') {
    throw new TypeError('write_file.content 必须是字符串');
  }
  return input;
}

function objectInput(input: JsonValue, name: string): JsonObject {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError(`${name} 输入必须是对象`);
  }
  return input as JsonObject;
}

function pathField(input: JsonValue): string | undefined {
  const path = objectInput(input, 'path').path;
  return typeof path === 'string' ? path : undefined;
}

function writeFields(input: JsonValue): { path: string; content: string } {
  const record = objectInput(input, 'write_file');
  return { path: String(record.path), content: String(record.content) };
}
