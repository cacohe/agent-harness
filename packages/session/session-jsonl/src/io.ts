import {
  mkdir,
  open,
  realpath,
  rename,
  rm,
  stat,
  type FileHandle,
} from 'node:fs/promises'

/** Adapter 实际需要的最小文件打开模式。 */
export type JsonlOpenFlags = 'r' | 'r+' | 'w+'

/** JSONL adapter 使用的最小文件句柄，仅由 package 内部与故障测试实现。 */
export interface JsonlFile {
  readFile(): Promise<Buffer>
  write(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ readonly bytesWritten: number }>
  datasync(): Promise<void>
  sync(): Promise<void>
  truncate(length: number): Promise<void>
  close(): Promise<void>
}

/** JSONL adapter 使用的最小文件系统操作集合。 */
export interface JsonlIo {
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ readonly isDirectory: boolean }>
  open(path: string, flags: JsonlOpenFlags): Promise<JsonlFile>
  rename(source: string, destination: string): Promise<void>
  removeTree(path: string): Promise<void>
}

function asJsonlFile(file: FileHandle): JsonlFile {
  return {
    readFile: () => file.readFile(),
    write: async (buffer, offset, length, position) => {
      const result = await file.write(buffer, offset, length, position)
      return { bytesWritten: result.bytesWritten }
    },
    datasync: () => file.datasync(),
    sync: () => file.sync(),
    truncate: length => file.truncate(length),
    close: () => file.close(),
  }
}

/** 创建一份独立的 Node.js 文件系统操作表。 */
export function createNodeJsonlIo(): JsonlIo {
  return {
    mkdir: async (path, options) => {
      await mkdir(path, options)
    },
    realpath,
    stat: async path => ({ isDirectory: (await stat(path)).isDirectory() }),
    open: async (path, flags) => asJsonlFile(await open(path, flags)),
    rename,
    removeTree: path => rm(path, { recursive: true, force: true }),
  }
}

/** 生产入口独占的冻结 Node.js 文件系统实现。 */
export const nodeJsonlIo: JsonlIo = Object.freeze(createNodeJsonlIo())
