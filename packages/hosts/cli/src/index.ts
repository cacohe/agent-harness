import { createInterface } from 'node:readline'
import { readFile as nodeReadFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brandId, isAbortError, type MessageId, type SessionId } from '@agent-harness/domain'
import { OpenAiCompatibleModelProvider } from '@agent-harness/openai-compatible'
import { AgentRuntime } from '@agent-harness/runtime'
import { JsonlSessionRepository } from '@agent-harness/session-jsonl'
import { ToolRegistry, type ToolDefinition } from '@agent-harness/tools'
import { createShellTool } from './shell-tool.js'

type FetchImplementation = (input: string | URL, init?: RequestInit) => Promise<Response>

export interface CliOutput {
  write(text: string): unknown
}

export interface CliSignals {
  on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
  off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown
}

export interface CliDependencies {
  readonly argv: readonly string[]
  readonly env: Readonly<Record<string, string | undefined>>
  readonly stdout: CliOutput
  readonly stderr: CliOutput
  readonly signals: CliSignals
  readonly readFile?: (path: string, encoding: 'utf8') => Promise<string>
  readonly fetch?: FetchImplementation
  /** 多轮交互的行输入；缺省时从 process.stdin 读取。 */
  readonly lines?: AsyncIterable<string>
  /** shell 工具默认 cwd；缺省时使用 process.cwd()。 */
  readonly cwd?: string
}

/** 无论前一个资源是否失败都关闭全部资源，并返回所有关闭错误。 */
export async function closeCliResources(resources: readonly { close(): Promise<void> }[]): Promise<readonly unknown[]> {
  const settled = await Promise.allSettled(resources.map(resource => resource.close()))
  return settled.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason)
}

export { createShellTool } from './shell-tool.js'

interface ShellConfig {
  readonly enabled: boolean
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

interface CliConfig {
  readonly sessionRoot: string
  readonly maxSteps: number
  readonly settlementTimeoutMs: number
  readonly runTimeoutMs: number
  readonly maxModelOutputBytes: number
  readonly maxInputBytes: number
  readonly systemPrompt?: string
  readonly model: {
    readonly id: string
    readonly baseUrl: string
    readonly model: string
    readonly apiKeyEnv: string
  }
  readonly shell: ShellConfig
}

type CliCommand =
  | { readonly mode: 'run' | 'resume', readonly configPath: string, readonly session: string, readonly message: string }
  | { readonly mode: 'chat', readonly configPath: string, readonly session: string, readonly message: string | undefined }

class CliUsageError extends Error {
  override readonly name = 'CliUsageError'
}

/** 执行一次 CLI 命令，并返回适合进程退出码的结果。 */
export async function runCli(dependencies: CliDependencies): Promise<number> {
  let runtime: AgentRuntime | undefined
  let handle: Awaited<ReturnType<AgentRuntime['create']>> | undefined
  const processController = new AbortController()
  let turnController: AbortController | undefined
  const cancel = () => {
    if (turnController !== undefined && !turnController.signal.aborted) {
      turnController.abort(new DOMException('收到终止信号', 'AbortError'))
      return
    }
    processController.abort(new DOMException('收到终止信号', 'AbortError'))
  }
  dependencies.signals.on('SIGINT', cancel)
  dependencies.signals.on('SIGTERM', cancel)
  let code = 0
  let failure: unknown
  try {
    const command = parseArgv(dependencies.argv)
    const config = await readConfig(
      command.configPath,
      dependencies.readFile ?? nodeReadFile,
      dependencies.cwd ?? process.cwd(),
    )
    const apiKey = dependencies.env[config.model.apiKeyEnv]
    if (apiKey === undefined || apiKey.length === 0) {
      throw new CliUsageError(`环境变量 ${config.model.apiKeyEnv} 未设置`)
    }
    runtime = new AgentRuntime({
      sessions: new JsonlSessionRepository({ rootDirectory: config.sessionRoot }),
      model: new OpenAiCompatibleModelProvider({
        id: config.model.id,
        baseUrl: config.model.baseUrl,
        apiKey,
        model: config.model.model,
        ...(dependencies.fetch === undefined ? {} : { fetch: dependencies.fetch }),
      }),
      tools: new ToolRegistry(buildTools(config)),
      maxSteps: config.maxSteps,
      settlementTimeoutMs: config.settlementTimeoutMs,
      runTimeoutMs: config.runTimeoutMs,
      maxModelOutputBytes: config.maxModelOutputBytes,
      maxInputBytes: config.maxInputBytes,
      ...(config.systemPrompt === undefined ? {} : { systemPrompt: config.systemPrompt }),
      // chat 仅展示最终回复；run/resume 保持 JSONL stream。
      observers: command.mode === 'chat'
        ? []
        : [{ onStream: event => writeJson(dependencies.stdout, { type: 'stream', event }) }],
    })
    const sessionId = brandId<'SessionId'>(command.session) as SessionId
    if (command.mode === 'chat') {
      handle = await openChatSession(runtime, sessionId, processController.signal)
      await runChatLoop({
        handle,
        firstMessage: command.message,
        lines: dependencies.lines ?? createStdinLines(processController.signal),
        stderr: dependencies.stderr,
        processSignal: processController.signal,
        beginTurn: () => {
          turnController = new AbortController()
          return turnController
        },
        endTurn: () => {
          turnController = undefined
        },
      })
    } else {
      turnController = processController
      handle = command.mode === 'run'
        ? await runtime.create(sessionId, { signal: processController.signal })
        : await runtime.resume(sessionId, { signal: processController.signal })
      const message = await handle.agent.run({
        id: brandId<'MessageId'>(crypto.randomUUID()) as MessageId,
        role: 'user',
        content: command.message,
      }, processController.signal)
      writeJson(dependencies.stdout, { type: 'result', sessionId, message })
    }
  } catch (error) {
    failure = error
  } finally {
    const resources: { close(): Promise<void> }[] = []
    if (handle !== undefined) resources.push(handle)
    if (runtime !== undefined) resources.push(runtime)
    const closeErrors = await closeCliResources(resources)
    if (failure !== undefined || closeErrors.length > 0) {
      code = 1
      const error = closeErrors.length === 0 ? failure : new AggregateError([...(failure === undefined ? [] : [failure]), ...closeErrors], 'CLI 清理失败')
      writeJson(dependencies.stdout, { type: 'error', code: processController.signal.aborted ? 'cancelled' : 'failed' })
      dependencies.stderr.write(`${diagnostic(error, processController.signal)}\n`)
    }
    dependencies.signals.off('SIGINT', cancel)
    dependencies.signals.off('SIGTERM', cancel)
  }
  return code
}

async function openChatSession(
  runtime: AgentRuntime,
  sessionId: SessionId,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<AgentRuntime['create']>>> {
  try {
    return await runtime.create(sessionId, { signal })
  } catch (error) {
    if (error instanceof Error && error.name === 'SessionAlreadyExistsError') {
      return await runtime.resume(sessionId, { signal })
    }
    throw error
  }
}

async function runChatLoop(options: {
  readonly handle: Awaited<ReturnType<AgentRuntime['create']>>
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
      if (options.processSignal.aborted) break
      if (content === undefined) break
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
    const onAbort = (): void => {
      void finish().then(resolve)
    }
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

function buildTools(config: CliConfig): readonly ToolDefinition[] {
  if (!config.shell.enabled) return []
  return [
    createShellTool({
      cwd: config.shell.cwd,
      timeoutMs: config.shell.timeoutMs,
      maxOutputBytes: config.shell.maxOutputBytes,
    }),
  ]
}

/** 绑定进程取消信号：abort 时关闭 readline，使等待中的读解除阻塞。 */
function createStdinLines(signal: AbortSignal): AsyncIterable<string> {
  const readline = createInterface({ input: process.stdin, crlfDelay: Infinity })
  const onAbort = (): void => {
    readline.close()
  }
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

function parseArgv(argv: readonly string[]): CliCommand {
  const [mode, ...rest] = argv
  if (mode !== 'run' && mode !== 'resume' && mode !== 'chat') {
    throw new CliUsageError('用法：run|resume|chat --config 绝对路径 --session ID [--message 内容]')
  }
  if (rest.length % 2 !== 0) throw new CliUsageError('命令参数必须成对出现')
  const values = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (key === undefined || value === undefined || values.has(key)) {
      throw new CliUsageError('命令参数无效')
    }
    if (key !== '--config' && key !== '--session' && key !== '--message') {
      throw new CliUsageError(`未知参数 ${key}`)
    }
    values.set(key, value)
  }
  const configPath = values.get('--config')
  const session = values.get('--session')
  const message = values.get('--message')
  if (configPath === undefined || !isAbsolute(configPath)) throw new CliUsageError('--config 必须是绝对路径')
  if (session === undefined || session.length === 0) throw new CliUsageError('--session 必须是非空字符串')
  if (mode === 'chat') {
    if (message !== undefined && message.length === 0) {
      throw new CliUsageError('--message 若提供则不能为空')
    }
    return { mode, configPath, session, message }
  }
  if (message === undefined || message.length === 0) {
    throw new CliUsageError('run/resume 必须提供非空 --message')
  }
  return { mode, configPath, session, message }
}

async function readConfig(
  path: string,
  readFile: (path: string, encoding: 'utf8') => Promise<string>,
  defaultCwd: string,
): Promise<CliConfig> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch { throw new CliUsageError('配置文件必须是可解析的 JSON') }
  const root = object(value, '配置')
  exact(root, ['sessionRoot', 'maxSteps', 'settlementTimeoutMs', 'model'], '配置', ['shell', 'runTimeoutMs', 'maxModelOutputBytes', 'maxInputBytes', 'systemPrompt'])
  const model = object(root.model, 'model 配置')
  exact(model, ['id', 'baseUrl', 'model', 'apiKeyEnv'], 'model 配置')
  const sessionRoot = text(root.sessionRoot, 'sessionRoot')
  if (!isAbsolute(sessionRoot)) throw new CliUsageError('sessionRoot 必须是绝对路径')
  const apiKeyEnv = text(model.apiKeyEnv, 'model.apiKeyEnv')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) throw new CliUsageError('model.apiKeyEnv 必须是环境变量名')
  return {
    sessionRoot,
    maxSteps: positive(root.maxSteps, 'maxSteps'),
    settlementTimeoutMs: positive(root.settlementTimeoutMs, 'settlementTimeoutMs'),
    runTimeoutMs: root.runTimeoutMs === undefined ? 120_000 : positive(root.runTimeoutMs, 'runTimeoutMs'),
    maxModelOutputBytes: root.maxModelOutputBytes === undefined ? 1_048_576 : positive(root.maxModelOutputBytes, 'maxModelOutputBytes'),
    maxInputBytes: root.maxInputBytes === undefined ? 1_048_576 : positive(root.maxInputBytes, 'maxInputBytes'),
    ...(root.systemPrompt === undefined ? {} : { systemPrompt: text(root.systemPrompt, 'systemPrompt') }),
    model: modelConfig(model, apiKeyEnv),
    shell: readShellConfig(root.shell, defaultCwd),
  }
}

function readShellConfig(value: unknown, defaultCwd: string): ShellConfig {
  if (value === undefined) {
    return {
      enabled: false,
      cwd: resolve(defaultCwd),
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    }
  }
  const shell = object(value, 'shell 配置')
  exact(shell, [], 'shell 配置', ['enabled', 'cwd', 'timeoutMs', 'maxOutputBytes'])
  const enabled = shell.enabled === undefined ? false : boolean(shell.enabled, 'shell.enabled')
  const cwd = shell.cwd === undefined ? resolve(defaultCwd) : text(shell.cwd, 'shell.cwd')
  if (!isAbsolute(cwd)) throw new CliUsageError('shell.cwd 必须是绝对路径')
  return {
    enabled,
    cwd,
    timeoutMs: shell.timeoutMs === undefined ? 30_000 : positive(shell.timeoutMs, 'shell.timeoutMs'),
    maxOutputBytes: shell.maxOutputBytes === undefined
      ? 64 * 1024
      : positive(shell.maxOutputBytes, 'shell.maxOutputBytes'),
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CliUsageError(`${name} 必须是对象`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, names: readonly string[], label: string, optional: readonly string[] = []): void {
  const allowed = new Set([...names, ...optional])
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new CliUsageError(`${label} 包含未知字段 ${key}`)
  for (const key of names) if (!(key in value)) throw new CliUsageError(`${label} 缺少字段 ${key}`)
}
function text(value: unknown, name: string): string { if (typeof value !== 'string' || value.length === 0) throw new CliUsageError(`${name} 必须是非空字符串`); return value }
function positive(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new CliUsageError(`${name} 必须是正整数`); return value as number }
function boolean(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') throw new CliUsageError(`${name} 必须是布尔值`)
  return value
}
function modelConfig(value: Record<string, unknown>, apiKeyEnv: string): CliConfig['model'] { return { id: text(value.id, 'model.id'), baseUrl: text(value.baseUrl, 'model.baseUrl'), model: text(value.model, 'model.model'), apiKeyEnv } }
function writeJson(output: CliOutput, value: unknown): void { output.write(`${JSON.stringify(value)}\n`) }
function diagnostic(error: unknown, signal: AbortSignal): string {
  if (signal.aborted || isAbortError(error)) return '命令已取消'
  if (error instanceof CliUsageError) return `参数或配置错误：${error.message}`
  const session = describeSafeSessionError(error)
  if (session !== undefined) return session
  const provider = describeSafeProviderError(error)
  if (provider !== undefined) return `命令执行失败：${provider}`
  const system = describeSafeSystemError(error)
  if (system !== undefined) return `命令执行失败：${system}`
  return '命令执行失败；详情已被抑制以避免泄露敏感信息'
}

/** 模型 adapter 错误不含密钥，可直接展示。 */
function describeSafeProviderError(error: unknown): string | undefined {
  const candidates = error instanceof AggregateError ? error.errors : [error]
  for (const candidate of candidates) {
    if (!(candidate instanceof Error)) continue
    switch (candidate.name) {
      case 'OpenAiCompatibleHttpError':
      case 'OpenAiCompatibleProtocolError':
      case 'OpenAiCompatibleConfigurationError':
        return candidate.message
      default:
        break
    }
  }
  return undefined
}

/** 会话生命周期错误不含密钥，可直接展示以便区分 run / resume。 */
function describeSafeSessionError(error: unknown): string | undefined {
  const candidates = error instanceof AggregateError ? error.errors : [error]
  for (const candidate of candidates) {
    if (!(candidate instanceof Error)) continue
    switch (candidate.name) {
      case 'SessionAlreadyExistsError':
        return `${candidate.message}；已有会话请改用 resume 或 chat`
      case 'SessionNotFoundError':
        return `${candidate.message}；新会话请改用 run 或 chat`
      case 'SessionAlreadyOwnedError':
      case 'SessionCorruptionError':
      case 'SessionSequenceConflictError':
      case 'SessionClosedError':
      case 'SessionLifecycleCorruptionError':
      case 'SessionCreateUncertainError':
      case 'SessionPoisonedError':
      case 'SessionUncertainCommitError':
        return `命令执行失败：${candidate.message}`
      default:
        break
    }
  }
  return undefined
}

/** 仅暴露不含密钥的操作系统错误，便于本地诊断。 */
function describeSafeSystemError(error: unknown): string | undefined {
  const candidates = error instanceof AggregateError ? error.errors : [error]
  for (const candidate of candidates) {
    if (!(candidate instanceof Error)) continue
    const code = 'code' in candidate && typeof candidate.code === 'string'
      ? candidate.code
      : undefined
    if (
      code !== 'EPERM'
      && code !== 'EACCES'
      && code !== 'ENOSPC'
      && code !== 'ENOENT'
      && code !== 'EEXIST'
    ) {
      continue
    }
    const syscall = 'syscall' in candidate && typeof candidate.syscall === 'string'
      ? candidate.syscall
      : undefined
    return `${code}${syscall === undefined ? '' : ` (${syscall})`}: ${candidate.message}`
  }
  return undefined
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runCli({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr, signals: process })
  process.exitCode = code
}
