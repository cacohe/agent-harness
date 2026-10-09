import { isAbsolute, resolve } from 'node:path'

/** CLI 参数与配置校验失败。 */
export class CliUsageError extends Error {
  override readonly name = 'CliUsageError'
}

interface ShellConfig {
  readonly enabled: boolean
  readonly cwd: string
  readonly timeoutMs: number
  readonly maxOutputBytes: number
}

interface McpConfig {
  readonly command: string
  readonly args: readonly string[]
  readonly cwd?: string
  /** 子进程变量名映射到 Host 环境变量名；配置文件不保存密钥值。 */
  readonly environment: Readonly<Record<string, string>>
}
interface SkillsConfig {
  readonly root: string
  readonly enabled: readonly string[]
  readonly maxSkillBytes: number
}

interface OpenAiCompatibleCliModelConfig {
  readonly id: string
  readonly baseUrl: string
  readonly model: string
  readonly apiKeyEnv: string
}

interface PlatformGatewayCliModelConfig {
  readonly id: string
  readonly platformBaseUrl: string
  readonly modelId: string
  readonly authorizationEnv: string
}

export type CliModelConfig = OpenAiCompatibleCliModelConfig | PlatformGatewayCliModelConfig

export interface CliConfig {
  readonly sessionRoot: string
  readonly maxSteps: number
  readonly settlementTimeoutMs: number
  readonly runTimeoutMs: number
  readonly maxModelOutputBytes: number
  readonly maxInputBytes: number
  readonly systemPrompt?: string
  readonly model: CliModelConfig
  readonly shell: ShellConfig
  readonly mcp?: McpConfig
  readonly skills?: SkillsConfig
}

/** 读取并严格校验 CLI 配置文件。 */
export async function readConfig(
  path: string,
  readFile: (path: string, encoding: 'utf8') => Promise<string>,
  defaultCwd: string,
): Promise<CliConfig> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new CliUsageError('配置文件必须是可解析的 JSON')
  }
  const root = object(value, '配置')
  exact(root, ['sessionRoot', 'maxSteps', 'settlementTimeoutMs', 'model'], '配置', [
    'shell', 'mcp', 'skills', 'runTimeoutMs', 'maxModelOutputBytes', 'maxInputBytes', 'systemPrompt',
  ])
  const model = object(root.model, 'model 配置')
  const sessionRoot = text(root.sessionRoot, 'sessionRoot')
  if (!isAbsolute(sessionRoot)) throw new CliUsageError('sessionRoot 必须是绝对路径')
  return {
    sessionRoot,
    maxSteps: positive(root.maxSteps, 'maxSteps'),
    settlementTimeoutMs: positive(root.settlementTimeoutMs, 'settlementTimeoutMs'),
    runTimeoutMs: root.runTimeoutMs === undefined ? 120_000 : positive(root.runTimeoutMs, 'runTimeoutMs'),
    maxModelOutputBytes: root.maxModelOutputBytes === undefined
      ? 1_048_576
      : positive(root.maxModelOutputBytes, 'maxModelOutputBytes'),
    maxInputBytes: root.maxInputBytes === undefined ? 1_048_576 : positive(root.maxInputBytes, 'maxInputBytes'),
    ...(root.systemPrompt === undefined ? {} : { systemPrompt: text(root.systemPrompt, 'systemPrompt') }),
    model: modelConfig(model),
    shell: readShellConfig(root.shell, defaultCwd),
    ...(root.mcp === undefined ? {} : { mcp: readMcpConfig(root.mcp) }),
    ...(root.skills === undefined ? {} : { skills: readSkillsConfig(root.skills) }),
  }
}

function readSkillsConfig(value: unknown): SkillsConfig {
  const skills = object(value, 'skills 配置')
  exact(skills, ['root', 'enabled'], 'skills 配置', ['maxSkillBytes'])
  const root = text(skills.root, 'skills.root')
  if (!isAbsolute(root)) throw new CliUsageError('skills.root 必须是绝对路径')
  return {
    root,
    enabled: textArray(skills.enabled, 'skills.enabled'),
    maxSkillBytes: skills.maxSkillBytes === undefined
      ? 256 * 1024
      : positive(skills.maxSkillBytes, 'skills.maxSkillBytes'),
  }
}

function readMcpConfig(value: unknown): McpConfig {
  const mcp = object(value, 'mcp 配置')
  exact(mcp, ['command'], 'mcp 配置', ['args', 'cwd', 'environment'])
  const command = text(mcp.command, 'mcp.command')
  const args = mcp.args === undefined ? [] : textArray(mcp.args, 'mcp.args')
  const cwd = mcp.cwd === undefined ? undefined : text(mcp.cwd, 'mcp.cwd')
  if (cwd !== undefined && !isAbsolute(cwd)) throw new CliUsageError('mcp.cwd 必须是绝对路径')
  const environment = mcp.environment === undefined ? {} : environmentMap(mcp.environment)
  return {
    command,
    args,
    ...(cwd === undefined ? {} : { cwd }),
    environment,
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
function modelConfig(value: Record<string, unknown>): CliModelConfig {
  if ('baseUrl' in value || 'model' in value || 'apiKeyEnv' in value) {
    exact(value, ['id', 'baseUrl', 'model', 'apiKeyEnv'], 'model 配置')
    return {
      id: text(value.id, 'model.id'),
      baseUrl: text(value.baseUrl, 'model.baseUrl'),
      model: text(value.model, 'model.model'),
      apiKeyEnv: environmentName(value.apiKeyEnv, 'model.apiKeyEnv'),
    }
  }
  exact(value, ['id', 'platformBaseUrl', 'modelId', 'authorizationEnv'], 'model 配置')
  return {
    id: text(value.id, 'model.id'),
    platformBaseUrl: text(value.platformBaseUrl, 'model.platformBaseUrl'),
    modelId: text(value.modelId, 'model.modelId'),
    authorizationEnv: environmentName(value.authorizationEnv, 'model.authorizationEnv'),
  }
}

function environmentName(value: unknown, name: string): string {
  const result = text(value, name)
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(result)) throw new CliUsageError(`${name} 必须是环境变量名`)
  return result
}
function textArray(value: unknown, name: string): readonly string[] {
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new CliUsageError(`${name} 必须是字符串数组`)
  }
  return Object.freeze([...value])
}
function environmentMap(value: unknown): Readonly<Record<string, string>> {
  const map = object(value, 'mcp.environment')
  const result: Record<string, string> = {}
  for (const [target, source] of Object.entries(map)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(target)) throw new CliUsageError('mcp.environment 键必须是环境变量名')
    result[target] = environmentName(source, `mcp.environment.${target}`)
  }
  return Object.freeze(result)
}
