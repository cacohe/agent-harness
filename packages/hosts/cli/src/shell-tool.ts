import { spawn, type ChildProcess } from 'node:child_process'
import { isAbsolute } from 'node:path'
import type { JsonValue } from '@agent-harness/domain'
import type { ToolDefinition } from '@agent-harness/tools'

/** kill 后等待 close 的宽限；超时则强制结束等待。 */
const DEFAULT_KILL_GRACE_MS = 1000

/** 可注入的子进程启动函数，便于测试。 */
export type ShellSpawn = (
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly windowsHide: boolean
    readonly detached: boolean
  },
) => ChildProcess

export interface ShellToolOptions {
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
  readonly env?: NodeJS.ProcessEnv
  readonly spawn?: ShellSpawn
  readonly platform?: NodeJS.Platform
  /** 测试或调优用：kill 后仍无 close 时强制结算的毫秒数。 */
  readonly killGraceMs?: number
}

/** 创建在固定 cwd 下执行 shell 命令的 Host 侧工具。 */
export function createShellTool(options: ShellToolOptions): ToolDefinition {
  if (!isAbsolute(options.cwd)) {
    throw new TypeError('shell cwd 必须是绝对路径')
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    throw new TypeError('shell timeoutMs 必须是正整数')
  }
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1) {
    throw new TypeError('shell maxOutputBytes 必须是正整数')
  }
  const killGraceMs = options.killGraceMs ?? DEFAULT_KILL_GRACE_MS
  if (!Number.isSafeInteger(killGraceMs) || killGraceMs < 1) {
    throw new TypeError('shell killGraceMs 必须是正整数')
  }

  const spawnImpl = options.spawn ?? defaultSpawn
  const platform = options.platform ?? process.platform
  const env = options.env ?? safeShellEnvironment(process.env, platform)

  return {
    name: 'run_shell',
    description:
      '在配置的工作目录下执行一条 shell 命令，返回 exitCode、stdout、stderr。输出可能被截断；取消或超时会终止子进程。',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['command'],
      properties: {
        command: {
          type: 'string',
          description: '交给系统 shell 执行的完整命令字符串',
        },
      },
    },
    parseInput(input): JsonValue {
      readCommand(input)
      return input
    },
    async execute(input, context): Promise<JsonValue> {
      const command = readCommand(input)
      return await runShellCommand(command, {
        cwd: options.cwd,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxOutputBytes,
        killGraceMs,
        env,
        platform,
        spawn: spawnImpl,
        signal: context.signal,
      })
    },
  }
}

function readCommand(input: JsonValue): string {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('run_shell 输入必须是对象')
  }
  const command = Reflect.get(input, 'command')
  if (typeof command !== 'string' || command.trim().length === 0) {
    throw new TypeError('run_shell.command 必须是非空字符串')
  }
  if (Reflect.ownKeys(input).some(key => key !== 'command')) {
    throw new TypeError('run_shell 输入包含未知字段')
  }
  return command
}

async function runShellCommand(
  command: string,
  options: {
    readonly cwd: string
    readonly timeoutMs: number
    readonly maxOutputBytes: number
    readonly killGraceMs: number
    readonly env: NodeJS.ProcessEnv
    readonly platform: NodeJS.Platform
    readonly spawn: ShellSpawn
    readonly signal: AbortSignal
  },
): Promise<JsonValue> {
  options.signal.throwIfAborted()

  const { file, args } = shellInvocation(command, options.platform)
  const child = options.spawn(file, args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    detached: options.platform !== 'win32',
  })
  if (child.stdout === null || child.stderr === null) {
    throw new Error('run_shell 需要 stdout/stderr 管道')
  }

  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  let stdoutBytes = 0
  let stderrBytes = 0
  let truncated = false
  let timedOut = false
  let cancelled = false
  let waitSettled = false
  let forceTimer: ReturnType<typeof setTimeout> | undefined

  const collect = (stream: 'stdout' | 'stderr', chunk: Buffer): void => {
    const chunks = stream === 'stdout' ? stdoutChunks : stderrChunks
    let size = stream === 'stdout' ? stdoutBytes : stderrBytes
    if (size >= options.maxOutputBytes) {
      truncated = true
      return
    }
    const remaining = options.maxOutputBytes - size
    if (chunk.length > remaining) {
      chunks.push(chunk.subarray(0, remaining))
      size += remaining
      truncated = true
    } else {
      chunks.push(chunk)
      size += chunk.length
    }
    if (stream === 'stdout') stdoutBytes = size
    else stderrBytes = size
  }

  child.stdout.on('data', (chunk: Buffer | string) => {
    collect('stdout', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })
  child.stderr.on('data', (chunk: Buffer | string) => {
    collect('stderr', Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  })

  let resolveWait: ((code: number | null) => void) | undefined
  let rejectWait: ((error: unknown) => void) | undefined

  const settleWait = (code: number | null): void => {
    if (waitSettled) return
    waitSettled = true
    if (forceTimer !== undefined) clearTimeout(forceTimer)
    resolveWait?.(code)
  }

  const failWait = (error: unknown): void => {
    if (waitSettled) return
    waitSettled = true
    if (forceTimer !== undefined) clearTimeout(forceTimer)
    rejectWait?.(error)
  }

  const armForceSettle = (): void => {
    if (forceTimer !== undefined || waitSettled) return
    forceTimer = setTimeout(() => {
      killProcessTree(child, options.platform, 'SIGKILL')
      destroyStream(child.stdout)
      destroyStream(child.stderr)
      settleWait(null)
    }, options.killGraceMs)
  }

  const killChild = (): void => {
    if (waitSettled) return
    killProcessTree(child, options.platform, 'SIGTERM')
    armForceSettle()
  }

  const onAbort = (): void => {
    cancelled = true
    killChild()
  }
  options.signal.addEventListener('abort', onAbort, { once: true })

  const timeout = setTimeout(() => {
    timedOut = true
    killChild()
  }, options.timeoutMs)

  try {
    const exitCode = await new Promise<number | null>((resolve, reject) => {
      resolveWait = resolve
      rejectWait = reject
      child.once('error', failWait)
      child.once('close', settleWait)
    })
    options.signal.throwIfAborted()
    return {
      exitCode,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
      truncated,
      timedOut,
      cancelled,
    }
  } catch (error) {
    if (options.signal.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new DOMException('run_shell 已取消', 'AbortError')
    }
    throw error
  } finally {
    clearTimeout(timeout)
    if (forceTimer !== undefined) clearTimeout(forceTimer)
    options.signal.removeEventListener('abort', onAbort)
  }
}

function destroyStream(stream: ChildProcess['stdout'] | ChildProcess['stderr']): void {
  if (stream !== null && typeof stream.destroy === 'function') {
    stream.destroy()
  }
}

function shellInvocation(
  command: string,
  platform: NodeJS.Platform,
): { readonly file: string, readonly args: readonly string[] } {
  if (platform === 'win32') {
    const comspec = process.env.ComSpec
    return {
      file: typeof comspec === 'string' && comspec.length > 0 ? comspec : 'cmd.exe',
      args: ['/d', '/s', '/c', command],
    }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

function defaultSpawn(
  file: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    readonly env: NodeJS.ProcessEnv
    readonly windowsHide: boolean
    readonly detached: boolean
  },
): ChildProcess {
  return spawn(file, [...args], {
    cwd: options.cwd,
    env: options.env,
    windowsHide: options.windowsHide,
    detached: options.detached,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

/** 仅保留 shell 运行所需变量，避免把宿主机密钥交给模型控制的进程。 */
function safeShellEnvironment(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  const names = platform === 'win32'
    ? ['ComSpec', 'SystemRoot', 'WINDIR', 'PATH', 'Path', 'PATHEXT', 'TEMP', 'TMP']
    : ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR']
  return Object.fromEntries(names.flatMap(name => {
    const value = env[name]
    return value === undefined ? [] : [[name, value]]
  }))
}

/** Unix 以独立进程组启动，取消时终止整组；Windows 仍由 Job Object/沙箱承担生产隔离。 */
function killProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform,
  signal: NodeJS.Signals,
): void {
  if (platform !== 'win32' && typeof child.pid === 'number') {
    try {
      process.kill(-child.pid, signal)
      return
    } catch {
      // 进程可能已退出，退回对子进程本身的 best-effort kill。
    }
  }
  child.kill(signal)
  if (platform === 'win32' && signal === 'SIGTERM') child.kill()
}
