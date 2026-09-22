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
function config(sessionRoot: string): string { return JSON.stringify({ sessionRoot, maxSteps: 2, settlementTimeoutMs: 1000, model: { id: 'test', baseUrl: 'https://example.test/v1', model: 'test-model', apiKeyEnv: 'TEST_KEY' } }) }
function sse(text: string): Response { return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: {"choices":[{"index":0,"delta":{"content":"${text}"}}]}\n\ndata: [DONE]\n\n`)); controller.close() } })) }

describe('CLI Host', () => {
  it('显式组合 run，并把 stream 和结果写为 stdout JSONL', async () => {
    const output: string[] = []; const errors: string[] = []; const sessionRoot = await root()
    const code = await runCli({ argv: ['run', '--config', '/config.json', '--session', 's1', '--message', 'hello'], env: { TEST_KEY: 'secret' }, stdout: { write: value => output.push(value) }, stderr: { write: value => errors.push(value) }, signals: new Signals(), readFile: async () => config(sessionRoot), fetch: async () => sse('done') })
    expect(code).toBe(0); expect(errors).toEqual([])
    expect(output.map(line => JSON.parse(line))).toMatchObject([{ type: 'stream', event: { type: 'text.delta', text: 'done' } }, { type: 'result', sessionId: 's1', message: { content: 'done' } }])
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
})
