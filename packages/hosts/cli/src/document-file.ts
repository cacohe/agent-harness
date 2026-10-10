import { open } from 'node:fs/promises'
import { basename } from 'node:path'

const READ_CHUNK_BYTES = 64 * 1024

/** CLI 文件在读取期间发生替换、缩短或增长时抛出。 */
export class DocumentFileChangedError extends Error {
  override readonly name = 'DocumentFileChangedError'
}

/** 只读取大小已知且在上限内的普通文件，并检测读取期间的长度变化。 */
export async function readBoundedDocumentFile(
  path: string,
  maxBytes: number,
  signal: AbortSignal,
): Promise<{ readonly fileName: string, readonly bytes: Uint8Array }> {
  signal.throwIfAborted()
  const handle = await open(path, 'r')
  let failure: unknown
  try {
    const stat = await handle.stat()
    signal.throwIfAborted()
    if (!stat.isFile()) throw new TypeError('导入路径必须是普通文件')
    if (!Number.isSafeInteger(stat.size) || stat.size < 1) {
      throw new TypeError('导入文件必须非空且大小可表示')
    }
    if (stat.size > maxBytes) throw new RangeError(`导入文件不能超过 ${maxBytes} 字节`)

    const bytes = new Uint8Array(stat.size)
    let offset = 0
    while (offset < bytes.byteLength) {
      signal.throwIfAborted()
      const length = Math.min(READ_CHUNK_BYTES, bytes.byteLength - offset)
      const result = await handle.read(bytes, offset, length, offset)
      if (result.bytesRead === 0) throw new DocumentFileChangedError('导入文件在读取期间缩短')
      offset += result.bytesRead
    }
    const probe = new Uint8Array(1)
    const trailing = await handle.read(probe, 0, 1, bytes.byteLength)
    if (trailing.bytesRead !== 0) throw new DocumentFileChangedError('导入文件在读取期间增长')
    signal.throwIfAborted()
    return Object.freeze({ fileName: basename(path), bytes })
  } catch (error) {
    failure = error
    throw error
  } finally {
    try {
      await handle.close()
    } catch (closeError) {
      if (failure !== undefined) {
        throw new AggregateError([failure, closeError], '读取失败且文件关闭失败')
      }
      throw closeError
    }
  }
}
