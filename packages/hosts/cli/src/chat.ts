import { createInterface } from 'node:readline'
import { brandId, isAbortError, type MessageId, type SessionId } from '@agent-harness/kernel'
import type { AgentRuntime, AgentRuntimeHandle } from '@agent-harness/runtime'
import type { CliOutput } from './contracts.js'

export async function openChatSession(
  runtime: AgentRuntime,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<AgentRuntimeHandle> {
  try {
    return await runtime.create(sessionId, { signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'SessionAlreadyExistsError') {
      return await runtime.resume(sessionId, { signal })
    }
    throw error
  }
}

export async function runChatLoop(options: {
  readonly handle: AgentRuntimeHandle
  readonly firstMessage: string | undefined
  readonly lines: AsyncIterable<string>
  readonly stderr: CliOutput
  readonly processSignal: AbortSignal
  readonly beginTurn: () => AbortController
  readonly endTurn: () => void
}): Promise<void> {
  options.stderr.write('进入多轮交互；输入 /exit 或 /quit 结束，空行跳过。\n')
  const pending: string[] = []
  if (options.firstMessage !== undefined) pending.push(options.firstMessage)

  const iterator = options.lines[Symbol.asyncIterator]()
  try {
    while (!options.processSignal.aborted) {
      let content: string | undefined
      let echoUser = false
      if (pending.length > 0) {
        content = pending.shift()
        echoUser = true
      } else {
        options.stderr.write('你: ')
        const next = await readLineOrAbort(iterator, options.processSignal)
        if (next.done === true || options.processSignal.aborted) break
        content = next.value
      }
      if (options.processSignal.aborted || content === undefined) break
      const trimmed = content.trim()
      if (trimmed.length === 0) continue
      if (trimmed === '/exit' || trimmed === '/quit') break
      if (echoUser) options.stderr.write(`你: ${trimmed}\n`)

      const turn = options.beginTurn()
      try {
        const message = await options.handle.agent.run({
          id: brandId<'MessageId'>(crypto.randomUUID()) as MessageId,
          role: 'user',
          content: trimmed,
        }, turn.signal)
        if (options.processSignal.aborted) break
        options.stderr.write(`\n助手:\n${message.content}\n\n`)
      } catch (error) {
        if (turn.signal.aborted || isAbortError(error)) {
          options.stderr.write('当前回合已取消；可继续输入，或再次中断以退出。\n')
          if (options.processSignal.aborted) break
          continue
        }
        throw error
      } finally {
        options.endTurn()
      }
    }
  } finally {
    await iterator.return?.()
  }
}

/** 绑定进程取消信号：abort 时关闭 readline，使等待中的读解除阻塞。 */
export function createStdinLines(signal: AbortSignal): AsyncIterable<string> {
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const onAbort = (): void => { readline.close() }
  signal.addEventListener('abort', onAbort, { once: true })
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for await (const line of readline) {
          if (signal.aborted) break
          yield line
        }
      } finally {
        signal.removeEventListener('abort', onAbort)
        readline.close()
      }
    },
  }
}

/** 等待下一行；若进程信号已取消则结束迭代并关闭输入源。 */
function readLineOrAbort(
  iterator: AsyncIterator<string>,
  signal: AbortSignal,
): Promise<IteratorResult<string, undefined>> {
  const finish = async (): Promise<IteratorResult<string, undefined>> => {
    await iterator.return?.().catch(() => undefined)
    return { done: true, value: undefined }
  }
  if (signal.aborted) return finish()
  return new Promise((resolve, reject) => {
    const onAbort = (): void => { void finish().then(resolve) }
    signal.addEventListener('abort', onAbort, { once: true })
    iterator.next().then(
      result => {
        signal.removeEventListener('abort', onAbort)
        resolve(signal.aborted ? { done: true, value: undefined } : result)
      },
      error => {
        signal.removeEventListener('abort', onAbort)
        if (signal.aborted) {
          resolve({ done: true, value: undefined })
          return
        }
        reject(error)
      },
    )
  })
}
