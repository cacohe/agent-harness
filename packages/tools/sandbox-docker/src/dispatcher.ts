import { randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { assertJsonValue, type JsonValue } from '@agent-harness/kernel'
import type { SandboxDispatcher, SandboxTask, ToolExecutionContext } from '@agent-harness/kernel'

export interface DockerSandboxOptions {
  readonly image: string
  readonly dockerPath?: string
  readonly memoryBytes: number
  readonly cpus: number
  readonly pidsLimit: number
}

export class DockerSandboxConfigurationError extends Error { override readonly name = 'DockerSandboxConfigurationError' }
export class DockerSandboxError extends Error { override readonly name = 'DockerSandboxError' }

/**
 * 通过受限 OCI 容器执行 Sandbox worker 协议。
 * worker 从 stdin 读取一个 SandboxTask JSON，并在 stdout 仅输出一个 JSON 结果。
 */
export class DockerSandboxDispatcher implements SandboxDispatcher {
  readonly #options: Required<DockerSandboxOptions>
  constructor(options: DockerSandboxOptions) {
    if (!options.image || !Number.isSafeInteger(options.memoryBytes) || options.memoryBytes < 1
      || !Number.isFinite(options.cpus) || options.cpus <= 0 || !Number.isSafeInteger(options.pidsLimit) || options.pidsLimit < 1) {
      throw new DockerSandboxConfigurationError('Docker Sandbox 配置无效')
    }
    this.#options = { ...options, dockerPath: options.dockerPath ?? 'docker' }
  }
  async dispatch(task: SandboxTask, context: ToolExecutionContext): Promise<JsonValue> {
    context.signal.throwIfAborted()
    const timeoutMs = task.limits?.timeoutMs ?? 30_000
    const maxOutputBytes = task.limits?.maxOutputBytes ?? 65_536
    const name = `agent-harness-${randomUUID()}`
    const args = ['run', '--rm', '--name', name, '--interactive', '--network', 'none', '--read-only', '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m', '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--user', '65532:65532', '--pids-limit', String(this.#options.pidsLimit), '--memory', String(this.#options.memoryBytes), '--cpus', String(this.#options.cpus), '--workdir', '/workspace', this.#options.image]
    return runDocker(this.#options.dockerPath, name, args, JSON.stringify(task), timeoutMs, maxOutputBytes, context.signal)
  }
}

const executeFile = promisify(execFile)
function runDocker(command: string, name: string, args: readonly string[], input: string, timeoutMs: number, maxOutputBytes: number, signal: AbortSignal): Promise<JsonValue> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' })
    let stdout = Buffer.alloc(0); let stderr = Buffer.alloc(0); let settled = false; let terminalError: unknown
    const finish = (error?: unknown): void => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); if (error !== undefined) { reject(error); return } try { resolve(parseOutput(new TextDecoder('utf-8', { fatal: true }).decode(stdout))) } catch (parseError) { reject(parseError) } }
    const stop = (error: unknown): void => {
      if (terminalError !== undefined || settled) return
      terminalError = error
      kill(child)
      void removeContainer(command, name).then(
        () => finish(error),
        cleanupError => finish(new AggregateError([error, cleanupError], `Sandbox 容器 ${name} 回收失败`)),
      )
    }
    const abort = (): void => stop(signal.reason ?? new DOMException('已取消', 'AbortError'))
    const timer = setTimeout(() => stop(new DockerSandboxError(`Sandbox 超时：${timeoutMs}ms`)), timeoutMs)
    signal.addEventListener('abort', abort, { once: true })
    child.stdout?.on('data', chunk => { stdout = Buffer.concat([stdout, chunk]); if (stdout.length > maxOutputBytes) stop(new DockerSandboxError('Sandbox 输出超过限制')) })
    child.stderr?.on('data', chunk => { stderr = Buffer.concat([stderr, chunk]).subarray(0, maxOutputBytes) })
    child.once('error', error => { if (terminalError === undefined) finish(new DockerSandboxError(`无法启动 Docker：${error.message}`)) })
    child.once('close', code => { if (terminalError === undefined) finish(code === 0 ? undefined : new DockerSandboxError(`Docker Sandbox 退出码 ${code ?? '未知'}：${stderr.toString('utf8')}`)) })
    child.stdin?.once('error', error => { if (terminalError === undefined) finish(new DockerSandboxError(`Sandbox 输入失败：${error.message}`)) })
    child.stdin?.end(input)
    if (signal.aborted) abort()
  })
}
function parseOutput(text: string): JsonValue { try { const value: unknown = JSON.parse(text); assertJsonValue(value); return value } catch { throw new DockerSandboxError('Sandbox worker 必须输出单个 JSON 结果') } }
function kill(child: ChildProcess): void { if (process.platform !== 'win32' && child.pid !== undefined) { try { process.kill(-child.pid, 'SIGKILL') } catch {} } else child.kill('SIGKILL') }
async function removeContainer(command: string, name: string): Promise<void> {
  let lastError: unknown
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try { await executeFile(command, ['rm', '--force', name], { timeout: 1_000 }); return } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 100)) }
  }
  throw new DockerSandboxError(`无法确认 Sandbox 容器 ${name} 已删除：${String(lastError)}`)
}
