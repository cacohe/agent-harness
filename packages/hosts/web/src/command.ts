import { isAbsolute } from 'node:path'
import { WebUsageError } from './config.js'

export interface WebCommand {
  readonly configPath: string
  readonly port: number
}

/** 解析本地 Web Host 的最小启动参数。 */
export function parseCommand(argv: readonly string[]): WebCommand {
  let configPath: string | undefined
  let port = 3080
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === '--config' && value !== undefined) {
      configPath = value
      index += 1
      continue
    }
    if (argument === '--port' && value !== undefined) {
      port = parsePort(value)
      index += 1
      continue
    }
    throw new WebUsageError('用法：agent-harness-web --config 绝对路径 [--port 1-65535]')
  }
  if (configPath === undefined || !isAbsolute(configPath)) {
    throw new WebUsageError('必须通过 --config 提供绝对路径')
  }
  return { configPath, port }
}

function parsePort(value: string): number {
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new WebUsageError('--port 必须是 1 至 65535 的整数')
  }
  return port
}
