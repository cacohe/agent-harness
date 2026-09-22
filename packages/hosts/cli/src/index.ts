import { readFile as nodeReadFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { brandId, isAbortError, type MessageId, type SessionId } from '@agent-harness/domain'
import { OpenAiCompatibleModelProvider } from '@agent-harness/openai-compatible'
import { AgentRuntime } from '@agent-harness/runtime'
import { JsonlSessionRepository } from '@agent-harness/session-jsonl'
import { ToolRegistry } from '@agent-harness/tools'

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
}

/** 无论前一个资源是否失败都关闭全部资源，并返回所有关闭错误。 */
export async function closeCliResources(resources: readonly { close(): Promise<void> }[]): Promise<readonly unknown[]> {
  const settled = await Promise.allSettled(resources.map(resource => resource.close()))
  return settled.filter((value): value is PromiseRejectedResult => value.status === 'rejected').map(value => value.reason)
}

interface CliConfig {
  readonly sessionRoot: string
  readonly maxSteps: number
  readonly settlementTimeoutMs: number
  readonly model: {
    readonly id: string
    readonly baseUrl: string
    readonly model: string
    readonly apiKeyEnv: string
  }
}

class CliUsageError extends Error {
  override readonly name = 'CliUsageError'
}

/** 执行一次 CLI 命令，并返回适合进程退出码的结果。 */
export async function runCli(dependencies: CliDependencies): Promise<number> {
  let runtime: AgentRuntime | undefined
  let handle: Awaited<ReturnType<AgentRuntime['create']>> | undefined
  const controller = new AbortController()
  const cancel = () => controller.abort(new DOMException('收到终止信号', 'AbortError'))
  dependencies.signals.on('SIGINT', cancel)
  dependencies.signals.on('SIGTERM', cancel)
  let code = 0
  let failure: unknown
  try {
    const command = parseArgv(dependencies.argv)
    const config = await readConfig(command.configPath, dependencies.readFile ?? nodeReadFile)
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
      tools: new ToolRegistry([]),
      maxSteps: config.maxSteps,
      settlementTimeoutMs: config.settlementTimeoutMs,
      observers: [{ onStream: event => writeJson(dependencies.stdout, { type: 'stream', event }) }],
    })
    const sessionId = brandId<'SessionId'>(command.session) as SessionId
    handle = command.mode === 'run'
      ? await runtime.create(sessionId, { signal: controller.signal })
      : await runtime.resume(sessionId, { signal: controller.signal })
    const message = await handle.agent.run({
      id: brandId<'MessageId'>(crypto.randomUUID()) as MessageId,
      role: 'user',
      content: command.message,
    }, controller.signal)
    writeJson(dependencies.stdout, { type: 'result', sessionId, message })
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
      writeJson(dependencies.stdout, { type: 'error', code: controller.signal.aborted ? 'cancelled' : 'failed' })
      dependencies.stderr.write(`${diagnostic(error, controller.signal)}\n`)
    }
    dependencies.signals.off('SIGINT', cancel)
    dependencies.signals.off('SIGTERM', cancel)
  }
  return code
}

function parseArgv(argv: readonly string[]): { mode: 'run' | 'resume', configPath: string, session: string, message: string } {
  const [mode, ...rest] = argv
  if (mode !== 'run' && mode !== 'resume') throw new CliUsageError('用法：run|resume --config 绝对路径 --session ID --message 内容')
  if (rest.length !== 6) throw new CliUsageError('必须提供 --config、--session 和 --message')
  const values = new Map<string, string>()
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index]
    const value = rest[index + 1]
    if (key === undefined || value === undefined || !['--config', '--session', '--message'].includes(key) || values.has(key)) {
      throw new CliUsageError('命令参数无效')
    }
    values.set(key, value)
  }
  const configPath = values.get('--config')
  const session = values.get('--session')
  const message = values.get('--message')
  if (configPath === undefined || !isAbsolute(configPath)) throw new CliUsageError('--config 必须是绝对路径')
  if (session === undefined || session.length === 0 || message === undefined || message.length === 0) throw new CliUsageError('--session 和 --message 必须是非空字符串')
  return { mode, configPath, session, message }
}

async function readConfig(path: string, readFile: (path: string, encoding: 'utf8') => Promise<string>): Promise<CliConfig> {
  let value: unknown
  try { value = JSON.parse(await readFile(path, 'utf8')) } catch { throw new CliUsageError('配置文件必须是可解析的 JSON') }
  const root = object(value, '配置')
  exact(root, ['sessionRoot', 'maxSteps', 'settlementTimeoutMs', 'model'], '配置')
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
    model: modelConfig(model, apiKeyEnv),
  }
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new CliUsageError(`${name} 必须是对象`)
  return value as Record<string, unknown>
}
function exact(value: Record<string, unknown>, names: readonly string[], label: string, optional: readonly string[] = []): void {
  for (const key of Object.keys(value)) if (!names.includes(key)) throw new CliUsageError(`${label} 包含未知字段 ${key}`)
  for (const key of names) if (!optional.includes(key) && !(key in value)) throw new CliUsageError(`${label} 缺少字段 ${key}`)
}
function text(value: unknown, name: string): string { if (typeof value !== 'string' || value.length === 0) throw new CliUsageError(`${name} 必须是非空字符串`); return value }
function positive(value: unknown, name: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new CliUsageError(`${name} 必须是正整数`); return value as number }
function modelConfig(value: Record<string, unknown>, apiKeyEnv: string): CliConfig['model'] { return { id: text(value.id, 'model.id'), baseUrl: text(value.baseUrl, 'model.baseUrl'), model: text(value.model, 'model.model'), apiKeyEnv } }
function writeJson(output: CliOutput, value: unknown): void { output.write(`${JSON.stringify(value)}\n`) }
function diagnostic(error: unknown, signal: AbortSignal): string { if (signal.aborted || isAbortError(error)) return '命令已取消'; if (error instanceof CliUsageError) return `参数或配置错误：${error.message}`; return '命令执行失败；详情已被抑制以避免泄露敏感信息' }

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const code = await runCli({ argv: process.argv.slice(2), env: process.env, stdout: process.stdout, stderr: process.stderr, signals: process })
  process.exitCode = code
}
