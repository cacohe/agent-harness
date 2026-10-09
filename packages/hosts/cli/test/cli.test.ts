import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { closeCliResources, runCli, type CliSignals } from '../src/index.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

class Signals implements CliSignals {
  readonly listeners = new Map<string, () => void>()
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): void { this.listeners.set(signal, listener) }
  off(signal: 'SIGINT' | 'SIGTERM'): void { this.listeners.delete(signal) }
}

async function root(): Promise<string> { const value = await mkdtemp(join(tmpdir(), 'agent-cli-')); roots.push(value); return value }
function config(sessionRoot: string, shell?: Record<string, unknown>): string {
  return JSON.stringify({
    sessionRoot,
    maxSteps: 4,
    settlementTimeoutMs: 1000,
    model: { id: 'test', baseUrl: 'https://example.test/v1', model: 'test-model', apiKeyEnv: 'TEST_KEY' },
    ...(shell === undefined ? {} : { shell }),
  })
}
function platformConfig(sessionRoot: string): string {
  return JSON.stringify({
    sessionRoot,
    maxSteps: 4,
    settlementTimeoutMs: 1000,
    model: {
      id: 'platform-gateway',
      platformBaseUrl: 'https://platform.example/v1',
      modelId: 'approved-model',
      authorizationEnv: 'PLATFORM_AUTHORIZATION',
    },
  })
}
function sse(text: string): Response {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`))
      controller.close()
    },
  }))
}
function ndjson(text: string): Response {
  return new Response(`${JSON.stringify({ type: 'text.delta', text })}\n`, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8' },
  })
}
function toolCallSse(): Response {
  const payload = JSON.stringify({
    choices: [{
      index: 0,
      delta: {
        tool_calls: [{
          index: 0,
          id: 'call-shell',
          type: 'function',
          function: { name: 'run_shell', arguments: '{"command":"echo hi"}' },
        }],
      },
    }],
  })
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${payload}\n\ndata: [DONE]\n\n`))
      controller.close()
    },
  }))
}

describe('CLI Host', () => {
  it('显式组合 run，并把 stream 和结果写为 stdout JSONL', async () => {
    const output: string[] = []; const errors: string[] = []; const sessionRoot = await root()
    const code = await runCli({ argv: ['run', '--config', '/config.json', '--session', 's1', '--message', 'hello'], env: { TEST_KEY: 'secret' }, stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) }, signals: new Signals(), readFile: async () => config(sessionRoot), fetch: async () => sse('done') })
    expect(code).toBe(0); expect(errors).toEqual([])
    expect(output.map(line => JSON.parse(line))).toMatchObject([{ type: 'stream', event: { type: 'text.delta', text: 'done' } }, { type: 'result', sessionId: 's1', message: { content: 'done' } }])
  })

  it('组合 Platform Gateway 的已选模型，并且不泄露认证头', async () => {
    const output: string[] = []
    const errors: string[] = []
    const sessionRoot = await root()
    let request: Request | undefined
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'platform-1', '--message', 'hello'],
      env: { PLATFORM_AUTHORIZATION: 'Bearer platform-secret' },
      stdout: { write: value => output.push(value) },
      stderr: { write: value => errors.push(value) },
      signals: new Signals(),
      readFile: async () => platformConfig(sessionRoot),
      fetch: async (input, init) => {
        request = new Request(input, init)
        return ndjson('from-platform')
      },
    })
    expect(code).toBe(0)
    expect(errors).toEqual([])
    expect(request?.url).toBe('https://platform.example/v1/agent/model-calls')
    expect(request?.headers.get('authorization')).toBe('Bearer platform-secret')
    expect(await request?.json()).toMatchObject({ modelId: 'approved-model', request: { messages: [{ role: 'user', content: 'hello' }] } })
    expect(output.map(line => JSON.parse(line))).toMatchObject([
      { type: 'stream', event: { type: 'text.delta', text: 'from-platform' } },
      { type: 'result', sessionId: 'platform-1', message: { content: 'from-platform' } },
    ])
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('platform-secret')
  })

  it('将参数和密钥失败写为不含密钥的 JSONL error', async () => {
    const output: string[] = []; const errors: string[] = []
    const relative = await runCli({ argv: ['run', '--config', 'config.json', '--session', 's', '--message', 'x'], env: { TEST_KEY: 'top-secret' }, stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) }, signals: new Signals() })
    expect(relative).toBe(1); expect(errors.join('')).not.toContain('top-secret')
    const missing = await runCli({ argv: ['run', '--config', '/config.json', '--session', 's', '--message', 'x'], env: {}, stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) }, signals: new Signals(), readFile: async () => config(await root()) })
    expect(missing).toBe(1); expect(errors.join('')).not.toContain('top-secret')
    expect(output.map(line => JSON.parse(line))).toEqual([{ type: 'error', code: 'failed' }, { type: 'error', code: 'failed' }])
  })

  it('拒绝空消息和包含未知字段的配置', async () => {
    const output: string[] = []; const errors: string[] = []; const sessionRoot = await root()
    const emptyMessage = await runCli({ argv: ['run', '--config', '/config.json', '--session', 's', '--message', ''], env: { TEST_KEY: 'secret' }, stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) }, signals: new Signals() })
    const unknownField = await runCli({ argv: ['run', '--config', '/config.json', '--session', 's', '--message', 'x'], env: { TEST_KEY: 'secret' }, stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) }, signals: new Signals(), readFile: async () => JSON.stringify({ ...JSON.parse(config(sessionRoot)), model: { id: 'test', baseUrl: 'https://example.test/v1', model: 'test-model', apiKeyEnv: 'TEST_KEY', headers: { 'X-Api-Key': 'forbidden' } } }) })
    expect(emptyMessage).toBe(1); expect(unknownField).toBe(1)
    expect(output.map(line => JSON.parse(line))).toEqual([{ type: 'error', code: 'failed' }, { type: 'error', code: 'failed' }])
    expect(errors.join('')).not.toContain('forbidden')
  })

  it('拒绝混合模型配置，并对缺失的 Platform 认证保持诊断安全', async () => {
    const output: string[] = []
    const errors: string[] = []
    const sessionRoot = await root()
    const mixed = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'mixed', '--message', 'x'],
      env: { PLATFORM_AUTHORIZATION: 'Bearer not-for-output' },
      stdout: { write: value => output.push(value) },
      stderr: { write: value => errors.push(value) },
      signals: new Signals(),
      readFile: async () => JSON.stringify({
        ...JSON.parse(platformConfig(sessionRoot)),
        model: {
          id: 'platform-gateway',
          platformBaseUrl: 'https://platform.example/v1',
          modelId: 'approved-model',
          authorizationEnv: 'PLATFORM_AUTHORIZATION',
          baseUrl: 'https://forbidden.example/v1',
        },
      }),
    })
    const missing = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'missing', '--message', 'x'],
      env: {},
      stdout: { write: value => output.push(value) },
      stderr: { write: value => errors.push(value) },
      signals: new Signals(),
      readFile: async () => platformConfig(sessionRoot),
    })
    expect(mixed).toBe(1)
    expect(missing).toBe(1)
    expect(errors.join('')).toContain('PLATFORM_AUTHORIZATION 未设置')
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('not-for-output')
  })

  it('拒绝同时启用 MCP 与本机 shell，且不输出 MCP 环境变量值', async () => {
    const output: string[] = []
    const errors: string[] = []
    const sessionRoot = await root()
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'mcp-shell', '--message', 'x'],
      env: { TEST_KEY: 'secret', MCP_TOKEN: 'mcp-secret' },
      stdout: { write: value => output.push(value) },
      stderr: { write: value => errors.push(value) },
      signals: new Signals(),
      readFile: async () => JSON.stringify({
        ...JSON.parse(config(sessionRoot, { enabled: true })),
        mcp: { command: 'unused', environment: { TOKEN: 'MCP_TOKEN' } },
      }),
    })
    expect(code).toBe(1)
    expect(errors.join('')).toContain('mcp 与 shell 不能同时启用')
    expect(`${errors.join('')} ${output.join(' ')}`).not.toContain('mcp-secret')
  })

  it('SIGINT 取消运行，并在 finally 释放 reader 与信号监听器', async () => {
    const sessionRoot = await root(); const signals = new Signals(); let cancelled = false
    let startFetch: (() => void) | undefined; let startRead: (() => void) | undefined
    const fetched = new Promise<void>(resolve => { startFetch = resolve })
    const reading = new Promise<void>(resolve => { startRead = resolve })
    const running = runCli({ argv: ['run', '--config', '/config.json', '--session', 'cancel', '--message', 'x'], env: { TEST_KEY: 'secret' }, stdout: { write() {} }, stderr: { write() {} }, signals, readFile: async () => config(sessionRoot), fetch: async () => {
      startFetch?.()
      return new Response(new ReadableStream({ pull() { startRead?.(); return new Promise<void>(() => undefined) }, cancel() { cancelled = true } }))
    } })
    await fetched
    await reading
    signals.listeners.get('SIGINT')?.()
    await expect(running).resolves.toBe(1)
    expect(cancelled).toBe(true)
    expect(signals.listeners).toEqual(new Map())
  })

  it('关闭失败不会阻止其余资源关闭，并保留全部错误', async () => {
    const calls: string[] = []
    const errors = await closeCliResources([
      { async close() { calls.push('handle'); throw new Error('handle failure') } },
      { async close() { calls.push('runtime'); throw new Error('runtime failure') } },
    ])
    expect(calls).toEqual(['handle', 'runtime'])
    expect(errors).toHaveLength(2)
  })

  it('对已存在会话的 run 提示改用 resume', async () => {
    const output: string[] = []
    const errors: string[] = []
    const sessionRoot = await root()
    const first = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'dup', '--message', 'one'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: value => output.push(value) },
      stderr: { write: value => errors.push(value) },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
      fetch: async () => sse('ok'),
    })
    expect(first).toBe(0)
    const second = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'dup', '--message', 'two'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: value => output.push(value) },
      stderr: { write: value => errors.push(value) },
      signals: new Signals(),
      readFile: async () => config(sessionRoot),
      fetch: async () => sse('ok'),
    })
    expect(second).toBe(1)
    expect(errors.at(-1)).toContain('已有会话请改用 resume')
  })

  it('chat 在同一进程内处理多轮输入并自动打开已有会话', async () => {
    const output: string[] = []
    const errors: string[] = []
    const sessionRoot = await root()
    const cwd = await root()
    const replies = ['first-reply', 'second-reply']
    let call = 0
    const first = await runCli({
      argv: ['chat', '--config', '/config.json', '--session', 'chat-1', '--message', 'hello'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: value => output.push(value) },
      stderr: { write: value => errors.push(value) },
      signals: new Signals(),
      cwd,
      readFile: async () => config(sessionRoot, { enabled: true, cwd, timeoutMs: 5000, maxOutputBytes: 1024 }),
      fetch: async () => sse(replies[call++] ?? 'extra'),
      lines: (async function* () {
        yield 'again'
        yield '/exit'
      })(),
    })
    expect(first).toBe(0)
    expect(output).toEqual([])
    expect(errors.join('')).toContain('你: hello')
    expect(errors.join('')).toContain('助手:\nfirst-reply')
    expect(errors.join('')).toContain('助手:\nsecond-reply')

    const resumeChat = await runCli({
      argv: ['chat', '--config', '/config.json', '--session', 'chat-1'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: value => output.push(value) },
      stderr: { write: value => errors.push(value) },
      signals: new Signals(),
      cwd,
      readFile: async () => config(sessionRoot, { enabled: false }),
      fetch: async () => sse('resumed'),
      lines: (async function* () {
        yield 'third'
        yield '/quit'
      })(),
    })
    expect(resumeChat).toBe(0)
    expect(output).toEqual([])
    expect(errors.join('')).toContain('助手:\nresumed')
  })

  it('chat 空闲时 SIGINT 结束交互并关闭行迭代器', async () => {
    const errors: string[] = []
    const sessionRoot = await root()
    const signals = new Signals()
    let waiting: (() => void) | undefined
    const startedWaiting = new Promise<void>(resolve => { waiting = resolve })
    let closed = false
    let resolveNext: ((value: IteratorResult<string>) => void) | undefined
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            waiting?.()
            return new Promise(resolve => {
              resolveNext = resolve
            })
          },
          async return() {
            closed = true
            resolveNext?.({ done: true, value: undefined })
            return { done: true, value: undefined }
          },
        }
      },
    }
    const running = runCli({
      argv: ['chat', '--config', '/config.json', '--session', 'chat-sigint'],
      env: { TEST_KEY: 'secret' },
      stdout: { write() {} },
      stderr: { write: value => errors.push(value) },
      signals,
      readFile: async () => config(sessionRoot, { enabled: false }),
      fetch: async () => sse('should-not-run'),
      lines,
    })
    await startedWaiting
    signals.listeners.get('SIGINT')?.()
    await expect(running).resolves.toBe(0)
    expect(closed).toBe(true)
    expect(errors.join('')).not.toContain('助手:')
    expect(signals.listeners).toEqual(new Map())
  })

  it('chat 在读取到行后若进程已取消则不开始新回合', async () => {
    const errors: string[] = []
    const sessionRoot = await root()
    const signals = new Signals()
    let fetchCount = 0
    const lines: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        let delivered = false
        return {
          next() {
            if (delivered) return Promise.resolve({ done: true as const, value: undefined })
            delivered = true
            signals.listeners.get('SIGINT')?.()
            return Promise.resolve({ done: false as const, value: 'should-skip' })
          },
          async return() {
            return { done: true, value: undefined }
          },
        }
      },
    }
    const code = await runCli({
      argv: ['chat', '--config', '/config.json', '--session', 'chat-skip'],
      env: { TEST_KEY: 'secret' },
      stdout: { write() {} },
      stderr: { write: value => errors.push(value) },
      signals,
      readFile: async () => config(sessionRoot, { enabled: false }),
      fetch: async () => {
        fetchCount += 1
        return sse('nope')
      },
      lines,
    })
    expect(code).toBe(0)
    expect(fetchCount).toBe(0)
    expect(errors.join('')).not.toContain('助手:')
  })

  it('注册 run_shell 后可完成工具调用回合', async () => {
    const output: string[] = []
    const sessionRoot = await root()
    const cwd = await root()
    let step = 0
    const code = await runCli({
      argv: ['run', '--config', '/config.json', '--session', 'shell-1', '--message', 'run echo'],
      env: { TEST_KEY: 'secret' },
      stdout: { write: value => output.push(value) },
      stderr: { write() {} },
      signals: new Signals(),
      cwd,
      readFile: async () => config(sessionRoot, { enabled: true, cwd, timeoutMs: 10_000, maxOutputBytes: 4096 }),
      fetch: async () => {
        step += 1
        if (step === 1) return toolCallSse()
        return sse('shell-done')
      },
    })
    expect(code).toBe(0)
    const events = output.map(line => JSON.parse(line))
    expect(events.some(event => event.type === 'stream' && event.event?.type === 'tool.call')).toBe(true)
    expect(events.at(-1)).toMatchObject({
      type: 'result',
      sessionId: 'shell-1',
      message: { content: 'shell-done' },
    })
  })
})
