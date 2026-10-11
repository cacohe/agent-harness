import type { McpClient } from '@agent-harness/mcp'
import type { StdioMcpClientOptions } from './mcp-stdio.js'
import type { readBoundedDocumentFile } from './document-file.js'

export type FetchImplementation = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>

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
  readonly readDocumentFile?: typeof readBoundedDocumentFile
  readonly createMcpClient?: (options: StdioMcpClientOptions) => McpClient
  /** 多轮交互的行输入；缺省时从 process.stdin 读取。 */
  readonly lines?: AsyncIterable<string>
  /** shell 工具默认 cwd；缺省时使用 process.cwd()。 */
  readonly cwd?: string
}
