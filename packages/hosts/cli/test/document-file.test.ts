import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readBoundedDocumentFile } from '../src/document-file.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'agent-document-'))
  roots.push(root)
  return root
}

describe('readBoundedDocumentFile', () => {
  it('读取普通文件并返回 basename 与独立字节', async () => {
    const root = await temporaryRoot()
    const path = join(root, 'guide.txt')
    await writeFile(path, 'hello')
    const result = await readBoundedDocumentFile(path, 5, new AbortController().signal)
    expect(result.fileName).toBe('guide.txt')
    expect(new TextDecoder().decode(result.bytes)).toBe('hello')
    expect(Object.isFrozen(result)).toBe(true)
  })

  it('在分配读取缓冲区前拒绝目录、空文件与超限文件', async () => {
    const root = await temporaryRoot()
    const empty = join(root, 'empty.txt')
    const large = join(root, 'large.txt')
    await writeFile(empty, '')
    await writeFile(large, '1234')
    const signal = new AbortController().signal
    await expect(readBoundedDocumentFile(root, 10, signal)).rejects.toThrow('普通文件')
    await expect(readBoundedDocumentFile(empty, 10, signal)).rejects.toThrow('必须非空')
    await expect(readBoundedDocumentFile(large, 3, signal)).rejects.toThrow('不能超过 3 字节')
  })

  it('在打开文件前传播取消', async () => {
    const controller = new AbortController()
    controller.abort(new Error('停止导入'))
    await expect(readBoundedDocumentFile('/not-opened', 10, controller.signal))
      .rejects.toThrow('停止导入')
  })
})
