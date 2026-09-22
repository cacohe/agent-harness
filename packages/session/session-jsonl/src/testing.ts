import type { SessionRepository } from '@agent-harness/session'
import { createNodeJsonlIo, type JsonlFile, type JsonlIo } from './io.js'
import {
  JsonlSessionRepositoryImplementation,
  encodePathSegment,
  type JsonlSessionRepositoryOptions,
} from './repository.js'

export type { JsonlFile, JsonlIo } from './io.js'
export { encodePathSegment }

/** 为单个测试创建可修改且不影响生产入口的 I/O 操作表。 */
export function createNodeJsonlIoForTesting(): JsonlIo {
  return createNodeJsonlIo()
}

/** 仅供 adapter 测试注入可控文件系统故障。 */
export function createJsonlRepositoryForTesting(
  options: JsonlSessionRepositoryOptions,
  io: JsonlIo,
): SessionRepository {
  return new JsonlSessionRepositoryImplementation(options, io)
}

/** 在保留未覆盖操作的前提下包装测试文件句柄。 */
export function wrapJsonlFile(
  file: JsonlFile,
  overrides: Partial<JsonlFile>,
): JsonlFile {
  return {
    readFile: overrides.readFile ?? (() => file.readFile()),
    write: overrides.write ?? ((...args) => file.write(...args)),
    datasync: overrides.datasync ?? (() => file.datasync()),
    sync: overrides.sync ?? (() => file.sync()),
    truncate: overrides.truncate ?? (length => file.truncate(length)),
    close: overrides.close ?? (() => file.close()),
  }
}
